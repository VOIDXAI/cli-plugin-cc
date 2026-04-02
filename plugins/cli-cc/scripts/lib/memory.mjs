import { sortJobsNewestFirst } from "./job-control.mjs";
import { listJobs } from "./state.mjs";
import { resolveWorkspaceRoot } from "./workspace.mjs";

function isFinished(job) {
  return job.status === "completed" || job.status === "failed" || job.status === "cancelled";
}

function isSuccessful(job) {
  return job.status === "completed";
}

function summarizeEngineRecommendation(jobs, jobClass) {
  const relevant = jobs.filter((job) => job.jobClass === jobClass && isFinished(job) && job.engine && job.engine !== "multi");
  const stats = new Map();

  for (const job of relevant) {
    const existing = stats.get(job.engine) ?? {
      engine: job.engine,
      total: 0,
      success: 0
    };
    existing.total += 1;
    if (isSuccessful(job)) {
      existing.success += 1;
    }
    stats.set(job.engine, existing);
  }

  const ranked = [...stats.values()].sort((left, right) => {
    const rightRate = right.total > 0 ? right.success / right.total : 0;
    const leftRate = left.total > 0 ? left.success / left.total : 0;
    if (rightRate !== leftRate) {
      return rightRate - leftRate;
    }
    return right.success - left.success;
  });

  if (ranked.length === 0) {
    return null;
  }

  const best = ranked[0];
  return {
    ...best,
    successRate: best.total > 0 ? Math.round((best.success / best.total) * 100) : 0
  };
}

function summarizeAutoRoutingHistory(jobs) {
  const relevant = jobs.filter((job) => job.requestedEngine === "auto" && job.engine && job.engine !== "multi");
  const counts = new Map();
  for (const job of relevant) {
    counts.set(job.engine, (counts.get(job.engine) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([engine, count]) => ({ engine, count }))
    .sort((left, right) => right.count - left.count);
}

export function buildWorkspaceMemorySnapshot(cwd) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const jobs = sortJobsNewestFirst(listJobs(workspaceRoot));
  const finishedJobs = jobs.filter(isFinished);
  return {
    workspaceRoot,
    totalJobs: jobs.length,
    finishedJobs: finishedJobs.length,
    completedJobs: jobs.filter((job) => job.status === "completed").length,
    failedJobs: jobs.filter((job) => job.status === "failed").length,
    cancelledJobs: jobs.filter((job) => job.status === "cancelled").length,
    recommendations: {
      task: summarizeEngineRecommendation(jobs, "task"),
      review: summarizeEngineRecommendation(jobs, "review"),
      adversarialReview: summarizeEngineRecommendation(jobs, "adversarial-review")
    },
    autoRoutingHistory: summarizeAutoRoutingHistory(jobs),
    recentSuccesses: jobs.filter((job) => job.status === "completed").slice(0, 5),
    recentFailures: jobs.filter((job) => job.status === "failed").slice(0, 5)
  };
}
