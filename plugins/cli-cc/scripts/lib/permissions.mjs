import { codexTaskSandbox } from "./engines/shared.mjs";

export const VALID_TASK_PERMISSIONS = ["read-only", "edit", "dev", "full", "unsafe"];

const VALID_TASK_PERMISSION_SET = new Set(VALID_TASK_PERMISSIONS);

function unsupportedPermission(value) {
  return new Error(
    `Unsupported permission "${value}". Use one of: ${VALID_TASK_PERMISSIONS.join(", ")}.`
  );
}

function assertSupportedEngine(engine) {
  if (engine === "codex" || engine === "gemini" || engine === "droid") {
    return;
  }
  throw new Error(`Unsupported engine: ${engine}`);
}

export function normalizeTaskPermission(value) {
  if (value == null) {
    return null;
  }
  const normalized = String(value).trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  if (!VALID_TASK_PERMISSION_SET.has(normalized)) {
    throw unsupportedPermission(value);
  }
  return normalized;
}

function legacyTaskPermissionProfile(engine) {
  assertSupportedEngine(engine);
  if (engine === "codex") {
    const sandbox = codexTaskSandbox();
    return {
      permission: null,
      nativeLabel: `sandbox=${sandbox}`,
      sandbox,
      approvalMode: null,
      autoMode: null,
      skipPermissionsUnsafe: false
    };
  }
  if (engine === "gemini") {
    return {
      permission: null,
      nativeLabel: "approval-mode=auto_edit",
      sandbox: null,
      approvalMode: "auto_edit",
      autoMode: null,
      skipPermissionsUnsafe: false
    };
  }
  return {
    permission: null,
    nativeLabel: "auto=low",
    sandbox: null,
    approvalMode: null,
    autoMode: "low",
    skipPermissionsUnsafe: false
  };
}

function codexTaskPermissionProfile(permission) {
  if (permission === "read-only") {
    return {
      permission,
      nativeLabel: "sandbox=read-only",
      sandbox: "read-only",
      approvalMode: null,
      autoMode: null,
      skipPermissionsUnsafe: false
    };
  }
  if (permission === "edit" || permission === "dev") {
    return {
      permission,
      nativeLabel: "sandbox=workspace-write",
      sandbox: "workspace-write",
      approvalMode: null,
      autoMode: null,
      skipPermissionsUnsafe: false
    };
  }
  return {
    permission,
    nativeLabel: "sandbox=danger-full-access",
    sandbox: "danger-full-access",
    approvalMode: null,
    autoMode: null,
    skipPermissionsUnsafe: false
  };
}

function geminiTaskPermissionProfile(permission) {
  if (permission === "read-only") {
    return {
      permission,
      nativeLabel: "approval-mode=plan",
      sandbox: null,
      approvalMode: "plan",
      autoMode: null,
      skipPermissionsUnsafe: false
    };
  }
  if (permission === "edit" || permission === "dev") {
    return {
      permission,
      nativeLabel: "approval-mode=auto_edit",
      sandbox: null,
      approvalMode: "auto_edit",
      autoMode: null,
      skipPermissionsUnsafe: false
    };
  }
  return {
    permission,
    nativeLabel: "approval-mode=yolo",
    sandbox: null,
    approvalMode: "yolo",
    autoMode: null,
    skipPermissionsUnsafe: false
  };
}

function droidTaskPermissionProfile(permission) {
  if (permission === "read-only") {
    return {
      permission,
      nativeLabel: "read-only",
      sandbox: null,
      approvalMode: null,
      autoMode: null,
      skipPermissionsUnsafe: false
    };
  }
  if (permission === "edit") {
    return {
      permission,
      nativeLabel: "auto=low",
      sandbox: null,
      approvalMode: null,
      autoMode: "low",
      skipPermissionsUnsafe: false
    };
  }
  if (permission === "dev") {
    return {
      permission,
      nativeLabel: "auto=medium",
      sandbox: null,
      approvalMode: null,
      autoMode: "medium",
      skipPermissionsUnsafe: false
    };
  }
  if (permission === "full") {
    return {
      permission,
      nativeLabel: "auto=high",
      sandbox: null,
      approvalMode: null,
      autoMode: "high",
      skipPermissionsUnsafe: false
    };
  }
  return {
    permission,
    nativeLabel: "skip-permissions-unsafe",
    sandbox: null,
    approvalMode: null,
    autoMode: null,
    skipPermissionsUnsafe: true
  };
}

export function buildTaskPermissionProfile(engine, permission = null) {
  const normalizedPermission = normalizeTaskPermission(permission);
  if (normalizedPermission == null) {
    return legacyTaskPermissionProfile(engine);
  }
  assertSupportedEngine(engine);
  if (engine === "codex") {
    return codexTaskPermissionProfile(normalizedPermission);
  }
  if (engine === "gemini") {
    return geminiTaskPermissionProfile(normalizedPermission);
  }
  return droidTaskPermissionProfile(normalizedPermission);
}

export function resolveConfiguredTaskPermission(engine, explicitPermission, defaultPermission = null) {
  const requestedPermission = normalizeTaskPermission(explicitPermission);
  const storedPermission = normalizeTaskPermission(defaultPermission);
  const resolvedPermission = requestedPermission ?? storedPermission;
  const source = requestedPermission != null ? "explicit" : storedPermission != null ? "default" : "legacy";
  return {
    requestedPermission,
    resolvedPermission,
    source,
    ...buildTaskPermissionProfile(engine, resolvedPermission)
  };
}

export function formatConfiguredTaskPermission(permission) {
  return normalizeTaskPermission(permission) ?? "legacy";
}

export function formatTaskPermissionSummary(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return "legacy";
  }
  const semanticPermission = normalizeTaskPermission(value.permission);
  const nativeLabel =
    typeof value.nativeLabel === "string" && value.nativeLabel.trim() ? value.nativeLabel.trim() : "unknown";
  if (semanticPermission == null) {
    return `legacy (effective: ${nativeLabel})`;
  }
  return `${semanticPermission} (effective: ${nativeLabel})`;
}

function normalizeText(value) {
  return String(value ?? "").trim();
}

function looksLikePermissionFailure(engine, text) {
  const normalized = normalizeText(text);
  if (!normalized) {
    return false;
  }

  const genericPatterns = [
    /insufficient permission/i,
    /insufficient permissions/i,
    /permission denied/i,
    /permission to proceed/i,
    /approval required/i,
    /requires approval/i,
    /write access .* denied/i,
    /sandbox blocked/i,
    /not permitted/i
  ];
  const enginePatterns =
    engine === "droid"
      ? [/--skip-permissions-unsafe/i, /re-run with --auto/i]
      : engine === "gemini"
        ? [/approval-mode/i, /\byolo\b/i, /\bauto_edit\b/i]
        : [/sandbox/i, /danger-full-access/i, /workspace-write/i, /read-only/i];

  return [...genericPatterns, ...enginePatterns].some((pattern) => pattern.test(normalized));
}

function buildPermissionRetrySuggestions(engine, profile) {
  const permission = profile?.permission ?? null;
  const nativeLabel = profile?.nativeLabel ?? "unknown";

  if (engine === "droid") {
    if (nativeLabel === "auto=low") {
      return [
        "Retry with `--permission dev` to use `--auto medium`.",
        "If the action is still blocked, retry with `--permission full` or `--permission unsafe`."
      ];
    }
    if (nativeLabel === "auto=medium") {
      return [
        "Retry with `--permission full` to use `--auto high`.",
        "If Droid still marks the action unsafe, retry with `--permission unsafe`."
      ];
    }
    if (nativeLabel === "auto=high") {
      return ["Retry with `--permission unsafe` to use `--skip-permissions-unsafe`."];
    }
    if (nativeLabel === "skip-permissions-unsafe") {
      return ["Droid is already using its highest bypass mode. Review the raw CLI output for any non-permission restriction."];
    }
    return [
      "Retry with `--permission edit` or `--permission dev` to allow edits.",
      "For destructive changes, retry with `--permission unsafe`."
    ];
  }

  if (engine === "gemini") {
    if (nativeLabel === "approval-mode=plan") {
      return ["Retry with `--permission edit` or `--permission dev` to use `--approval-mode auto_edit`."];
    }
    if (nativeLabel === "approval-mode=auto_edit") {
      return ["Retry with `--permission full` to use `--approval-mode yolo`."];
    }
    return [
      "Gemini is already using its highest automation tier in this plugin.",
      "If the CLI mentions an untrusted directory, trust the workspace and retry."
    ];
  }

  if (nativeLabel === "sandbox=read-only") {
    return ["Retry with `--permission edit` or `--permission dev` to enable workspace writes."];
  }
  if (nativeLabel === "sandbox=workspace-write") {
    return ["Retry with `--permission full` to use `sandbox=danger-full-access`."];
  }
  if (permission === "unsafe" || nativeLabel === "sandbox=danger-full-access") {
    return ["Codex is already using the highest sandbox tier available in this plugin. Review the raw error for any non-sandbox restriction."];
  }
  return ["Retry with `--permission full` if the task needs broader filesystem access."];
}

export function appendTaskPermissionFailureGuidance(engine, permission, output) {
  const normalizedOutput = normalizeText(output);
  if (!looksLikePermissionFailure(engine, normalizedOutput)) {
    return normalizedOutput;
  }

  const profile = buildTaskPermissionProfile(engine, permission);
  const lines = [normalizedOutput, "", "Permission issue detected.", "Reason: The engine reported that the current permission tier could not perform the requested action.", "Suggestions:"];

  for (const suggestion of buildPermissionRetrySuggestions(engine, profile)) {
    lines.push(`- ${suggestion}`);
  }

  return lines.join("\n").trim();
}
