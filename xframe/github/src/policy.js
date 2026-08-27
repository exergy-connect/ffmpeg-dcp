import { getGithubContext } from "./github/context.js";

/**
 * @param {Record<string, unknown>} acquired
 * @param {{ jobName?: string }} [jobMetadata]
 */
export function shouldExecuteProcessVideoJob(acquired, jobMetadata = {}) {
  const github = getGithubContext(acquired);
  const jobId = String(github.job ?? github.Job ?? "").toLowerCase();
  if (jobId === "process-video") {
    return true;
  }

  return String(jobMetadata.jobName ?? "")
    .toLowerCase()
    .includes("process video");
}

/** @deprecated Use shouldExecuteProcessVideoJob */
export function shouldExecuteAcquiredJob(acquired, jobMetadata = {}) {
  return shouldExecuteProcessVideoJob(acquired, jobMetadata);
}
