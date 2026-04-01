function generateRunId(engine) {
  const random = Math.random().toString(36).slice(2, 8);
  return `${engine}-run-${Date.now().toString(36)}-${random}`;
}

const ENGINE_CAPABILITY_MATRIX = {
  codex: {
    supportsStructuredReview: true,
    resumeKind: "thread",
    interruptKind: "cooperative",
    streamingLevel: "rich",
    modelControl: "passthrough",
    effortControl: "native"
  },
  gemini: {
    supportsStructuredReview: true,
    resumeKind: "session",
    interruptKind: "process",
    streamingLevel: "basic",
    modelControl: "passthrough",
    effortControl: "unsupported"
  },
  droid: {
    supportsStructuredReview: true,
    resumeKind: "session",
    interruptKind: "process",
    streamingLevel: "basic",
    modelControl: "passthrough",
    effortControl: "mapped"
  }
};

function cloneCapabilities(capabilities) {
  return { ...capabilities };
}

function normalizeEvent(event) {
  const source = event && typeof event === "object" && !Array.isArray(event) ? event : {};
  return {
    type: typeof source.type === "string" && source.type.trim() ? source.type.trim() : "progress",
    timestamp: typeof source.timestamp === "string" && source.timestamp.trim() ? source.timestamp.trim() : new Date().toISOString(),
    phase: typeof source.phase === "string" && source.phase.trim() ? source.phase.trim() : null,
    message: typeof source.message === "string" ? source.message.trim() : "",
    sessionRef: typeof source.sessionRef === "string" && source.sessionRef.trim() ? source.sessionRef.trim() : null,
    threadId: typeof source.threadId === "string" && source.threadId.trim() ? source.threadId.trim() : null,
    turnId: typeof source.turnId === "string" && source.turnId.trim() ? source.turnId.trim() : null,
    stderrMessage: source.stderrMessage == null ? null : String(source.stderrMessage).trim(),
    logTitle: typeof source.logTitle === "string" && source.logTitle.trim() ? source.logTitle.trim() : null,
    logBody: source.logBody == null ? null : String(source.logBody).trimEnd(),
    payload: source.payload ?? null
  };
}

function createEventIterator(state) {
  return {
    [Symbol.asyncIterator]() {
      return {
        next() {
          if (state.queue.length > 0) {
            return Promise.resolve({ value: state.queue.shift(), done: false });
          }
          if (state.closed) {
            return Promise.resolve({ value: undefined, done: true });
          }
          return new Promise((resolve) => {
            state.waiters.push(resolve);
          });
        }
      };
    }
  };
}

function flushWaiters(state) {
  while (state.waiters.length > 0) {
    const resolve = state.waiters.shift();
    if (state.queue.length > 0) {
      resolve({ value: state.queue.shift(), done: false });
      continue;
    }
    if (state.closed) {
      resolve({ value: undefined, done: true });
      continue;
    }
    state.waiters.unshift(resolve);
    break;
  }
}

export function getEngineCapabilities(engineId) {
  const capabilities = ENGINE_CAPABILITY_MATRIX[engineId];
  if (!capabilities) {
    throw new Error(`Unsupported engine: ${engineId}`);
  }
  return cloneCapabilities(capabilities);
}

export function buildSessionOwnerState(engineId, state = "queued", overrides = {}) {
  const capabilities = getEngineCapabilities(engineId);
  return {
    engine: engineId,
    state,
    cancelStrategy: capabilities.interruptKind,
    resumeKind: capabilities.resumeKind,
    streamingLevel: capabilities.streamingLevel,
    sessionRefKind: capabilities.resumeKind,
    ...overrides
  };
}

export function createEngineRunController({ engine, request, cancel, capabilities = getEngineCapabilities(engine) }) {
  const streamState = {
    queue: [],
    waiters: [],
    closed: false
  };
  let resolveResult;
  let rejectResult;
  const resultPromise = new Promise((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });

  function emit(event) {
    if (streamState.closed) {
      return;
    }
    streamState.queue.push(normalizeEvent(event));
    flushWaiters(streamState);
  }

  function closeStream() {
    if (streamState.closed) {
      return;
    }
    streamState.closed = true;
    flushWaiters(streamState);
  }

  const handle = {
    id: generateRunId(engine),
    engine,
    request,
    capabilities: cloneCapabilities(capabilities),
    async cancel() {
      if (typeof cancel !== "function") {
        return {
          attempted: false,
          interrupted: false,
          detail: "No engine-level interruption available."
        };
      }
      return await cancel();
    },
    events() {
      return createEventIterator(streamState);
    },
    result() {
      return resultPromise;
    }
  };

  return {
    handle,
    emit,
    resolve(result) {
      resolveResult(result);
      closeStream();
    },
    reject(error) {
      rejectResult(error);
      closeStream();
    }
  };
}

export function progressEventToEngineEvent(value) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const message =
    typeof source.message === "string" && source.message.trim()
      ? source.message.trim()
      : typeof value === "string"
        ? value.trim()
        : "";

  return normalizeEvent({
    type: "progress",
    phase: typeof source.phase === "string" ? source.phase : null,
    message,
    sessionRef:
      typeof source.sessionRef === "string" && source.sessionRef.trim()
        ? source.sessionRef.trim()
        : typeof source.threadId === "string" && source.threadId.trim()
          ? source.threadId.trim()
          : null,
    threadId: typeof source.threadId === "string" && source.threadId.trim() ? source.threadId.trim() : null,
    turnId: typeof source.turnId === "string" && source.turnId.trim() ? source.turnId.trim() : null,
    stderrMessage: source.stderrMessage ?? null,
    logTitle: source.logTitle ?? null,
    logBody: source.logBody ?? null,
    payload: {
      source: "progress"
    }
  });
}

export function engineEventToProgress(event, engine) {
  const normalized = normalizeEvent(event);
  const ownerStatePayload =
    normalized.type === "session_ready"
      ? buildSessionOwnerState(engine, "running", {
          sessionRef: normalized.sessionRef ?? normalized.threadId ?? null,
          threadId: normalized.threadId ?? null,
          turnId: normalized.turnId ?? null
        })
      : normalized.type === "completed"
        ? buildSessionOwnerState(engine, normalized.payload?.ok === false ? "failed" : "completed", {
            sessionRef: normalized.sessionRef ?? normalized.threadId ?? null,
            threadId: normalized.threadId ?? null,
            turnId: normalized.turnId ?? null
          })
        : null;

  return {
    message: normalized.message,
    phase: normalized.phase,
    sessionRef: normalized.sessionRef ?? normalized.threadId ?? null,
    threadId: normalized.threadId,
    turnId: normalized.turnId,
    stderrMessage: normalized.stderrMessage,
    logTitle: normalized.logTitle,
    logBody: normalized.logBody,
    ownerState: ownerStatePayload
  };
}

export function buildCompletedEvent(result, engine) {
  return normalizeEvent({
    type: "completed",
    phase: result.ok ? "done" : "failed",
    message: result.ok ? `${engine} run completed.` : `${engine} run failed.`,
    sessionRef: result.sessionRef ?? result.threadId ?? null,
    threadId: result.threadId ?? null,
    turnId: result.turnId ?? null,
    payload: {
      ok: Boolean(result.ok)
    }
  });
}
