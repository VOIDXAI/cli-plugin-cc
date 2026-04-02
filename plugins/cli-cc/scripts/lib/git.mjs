import fs from "node:fs";
import path from "node:path";

import { runCommand, runCommandChecked } from "./process.mjs";

const MAX_UNTRACKED_BYTES = 24 * 1024;

function git(cwd, args, options = {}) {
  return runCommand("git", args, { cwd, ...options });
}

function gitChecked(cwd, args, options = {}) {
  return runCommandChecked("git", args, { cwd, ...options });
}

function isProbablyText(buffer) {
  const slice = buffer.subarray(0, 512);
  for (const byte of slice) {
    if (byte === 0) {
      return false;
    }
  }
  return true;
}

function formatSection(title, body) {
  return [`## ${title}`, "", body.trim() ? body.trim() : "(none)", ""].join("\n");
}

function formatUntrackedFile(cwd, relativePath) {
  const absolutePath = path.join(cwd, relativePath);
  const stat = fs.statSync(absolutePath);
  if (stat.size > MAX_UNTRACKED_BYTES) {
    return `### ${relativePath}\n(skipped: ${stat.size} bytes exceeds ${MAX_UNTRACKED_BYTES} byte limit)`;
  }

  const buffer = fs.readFileSync(absolutePath);
  if (!isProbablyText(buffer)) {
    return `### ${relativePath}\n(skipped: binary file)`;
  }

  return [`### ${relativePath}`, "```", buffer.toString("utf8").trimEnd(), "```"].join("\n");
}

function collectWorkingTreeContext(cwd, state) {
  const status = gitChecked(cwd, ["status", "--short"]).stdout.trim();
  const stagedDiff = gitChecked(cwd, ["diff", "--cached", "--binary", "--no-ext-diff", "--submodule=diff"]).stdout;
  const unstagedDiff = gitChecked(cwd, ["diff", "--binary", "--no-ext-diff", "--submodule=diff"]).stdout;
  const untrackedBody = state.untracked.map((file) => formatUntrackedFile(cwd, file)).join("\n\n");

  return {
    mode: "working-tree",
    summary: `Reviewing ${state.staged.length} staged, ${state.unstaged.length} unstaged, and ${state.untracked.length} untracked file(s).`,
    content: [
      formatSection("Git Status", status),
      formatSection("Staged Diff", stagedDiff),
      formatSection("Unstaged Diff", unstagedDiff),
      formatSection("Untracked Files", untrackedBody)
    ].join("\n")
  };
}

function collectBranchContext(cwd, baseRef) {
  const mergeBase = gitChecked(cwd, ["merge-base", "HEAD", baseRef]).stdout.trim();
  const commitRange = `${mergeBase}..HEAD`;
  const currentBranch = getCurrentBranch(cwd);
  const logOutput = gitChecked(cwd, ["log", "--oneline", "--decorate", commitRange]).stdout.trim();
  const diffStat = gitChecked(cwd, ["diff", "--stat", commitRange]).stdout.trim();
  const diff = gitChecked(cwd, ["diff", "--binary", "--no-ext-diff", "--submodule=diff", commitRange]).stdout;

  return {
    mode: "branch",
    summary: `Reviewing branch ${currentBranch} against ${baseRef} from merge-base ${mergeBase}.`,
    content: [
      formatSection("Commit Log", logOutput),
      formatSection("Diff Stat", diffStat),
      formatSection("Branch Diff", diff)
    ].join("\n")
  };
}

function parseDiffShortStat(text) {
  const normalized = String(text ?? "").trim();
  if (!normalized) {
    return {
      files: 0,
      additions: 0,
      deletions: 0
    };
  }

  const files = Number.parseInt(normalized.match(/(\d+)\s+files?\s+changed/)?.[1] ?? "0", 10) || 0;
  const additions = Number.parseInt(normalized.match(/(\d+)\s+insertions?\(\+\)/)?.[1] ?? "0", 10) || 0;
  const deletions = Number.parseInt(normalized.match(/(\d+)\s+deletions?\(-\)/)?.[1] ?? "0", 10) || 0;

  return {
    files,
    additions,
    deletions
  };
}

function combineDiffStats(...stats) {
  return stats.reduce(
    (combined, entry) => ({
      files: combined.files + (entry?.files ?? 0),
      additions: combined.additions + (entry?.additions ?? 0),
      deletions: combined.deletions + (entry?.deletions ?? 0)
    }),
    {
      files: 0,
      additions: 0,
      deletions: 0
    }
  );
}

export function ensureGitRepository(cwd) {
  const result = git(cwd, ["rev-parse", "--show-toplevel"]);
  const errorCode = result.error && "code" in result.error ? result.error.code : null;
  if (errorCode === "ENOENT") {
    throw new Error("git is not installed. Install Git and retry.");
  }
  if (result.status !== 0) {
    throw new Error("This command must run inside a Git repository.");
  }
  return result.stdout.trim();
}

export function getRepoRoot(cwd) {
  return gitChecked(cwd, ["rev-parse", "--show-toplevel"]).stdout.trim();
}

export function detectDefaultBranch(cwd) {
  const symbolic = git(cwd, ["symbolic-ref", "refs/remotes/origin/HEAD"]);
  if (symbolic.status === 0) {
    const remoteHead = symbolic.stdout.trim();
    if (remoteHead.startsWith("refs/remotes/origin/")) {
      return remoteHead.replace("refs/remotes/origin/", "");
    }
  }

  for (const candidate of ["main", "master", "trunk"]) {
    const local = git(cwd, ["show-ref", "--verify", "--quiet", `refs/heads/${candidate}`]);
    if (local.status === 0) {
      return candidate;
    }
    const remote = git(cwd, ["show-ref", "--verify", "--quiet", `refs/remotes/origin/${candidate}`]);
    if (remote.status === 0) {
      return `origin/${candidate}`;
    }
  }

  throw new Error("Unable to detect the repository default branch. Pass --base <ref> or use --scope working-tree.");
}

export function getCurrentBranch(cwd) {
  return gitChecked(cwd, ["branch", "--show-current"]).stdout.trim() || "HEAD";
}

export function getWorkingTreeState(cwd) {
  const staged = gitChecked(cwd, ["diff", "--cached", "--name-only"]).stdout.trim().split("\n").filter(Boolean);
  const unstaged = gitChecked(cwd, ["diff", "--name-only"]).stdout.trim().split("\n").filter(Boolean);
  const untracked = gitChecked(cwd, ["ls-files", "--others", "--exclude-standard"]).stdout.trim().split("\n").filter(Boolean);

  return {
    staged,
    unstaged,
    untracked,
    isDirty: staged.length > 0 || unstaged.length > 0 || untracked.length > 0
  };
}

export function resolveReviewTarget(cwd, options = {}) {
  ensureGitRepository(cwd);

  const requestedScope = options.scope ?? "auto";
  const baseRef = options.base ?? null;
  const state = getWorkingTreeState(cwd);
  const supportedScopes = new Set(["auto", "working-tree", "branch"]);

  if (baseRef) {
    return {
      mode: "branch",
      label: `branch diff against ${baseRef}`,
      baseRef,
      explicit: true
    };
  }

  if (requestedScope === "working-tree") {
    return {
      mode: "working-tree",
      label: "working tree diff",
      explicit: true
    };
  }

  if (!supportedScopes.has(requestedScope)) {
    throw new Error(`Unsupported review scope "${requestedScope}". Use one of: auto, working-tree, branch, or pass --base <ref>.`);
  }

  if (requestedScope === "branch") {
    const detectedBase = detectDefaultBranch(cwd);
    return {
      mode: "branch",
      label: `branch diff against ${detectedBase}`,
      baseRef: detectedBase,
      explicit: true
    };
  }

  if (state.isDirty) {
    return {
      mode: "working-tree",
      label: "working tree diff",
      explicit: false
    };
  }

  const detectedBase = detectDefaultBranch(cwd);
  return {
    mode: "branch",
    label: `branch diff against ${detectedBase}`,
    baseRef: detectedBase,
    explicit: false
  };
}

export function collectReviewContext(cwd, target) {
  const repoRoot = getRepoRoot(cwd);
  const state = getWorkingTreeState(repoRoot);
  const currentBranch = getCurrentBranch(repoRoot);
  const details =
    target.mode === "working-tree"
      ? collectWorkingTreeContext(repoRoot, state)
      : collectBranchContext(repoRoot, target.baseRef);

  return {
    cwd: repoRoot,
    repoRoot,
    branch: currentBranch,
    target,
    ...details
  };
}

export function summarizeReviewTarget(cwd, options = {}) {
  const repoRoot = getRepoRoot(cwd);
  const target = resolveReviewTarget(repoRoot, options);

  if (target.mode === "working-tree") {
    const state = getWorkingTreeState(repoRoot);
    const changedFiles = new Set([...state.staged, ...state.unstaged, ...state.untracked]).size;
    const staged = parseDiffShortStat(gitChecked(repoRoot, ["diff", "--cached", "--shortstat"]).stdout);
    const unstaged = parseDiffShortStat(gitChecked(repoRoot, ["diff", "--shortstat"]).stdout);
    const combined = combineDiffStats(staged, unstaged);
    return {
      target,
      repoRoot,
      changedFiles,
      additions: combined.additions,
      deletions: combined.deletions,
      totalLines: combined.additions + combined.deletions
    };
  }

  const mergeBase = gitChecked(repoRoot, ["merge-base", "HEAD", target.baseRef]).stdout.trim();
  const commitRange = `${mergeBase}..HEAD`;
  const diff = parseDiffShortStat(gitChecked(repoRoot, ["diff", "--shortstat", commitRange]).stdout);
  return {
    target,
    repoRoot,
    changedFiles: diff.files,
    additions: diff.additions,
    deletions: diff.deletions,
    totalLines: diff.additions + diff.deletions
  };
}
