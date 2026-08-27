import { isUuid, mapConclusion } from "../util.js";

/**
 * @typedef {import("./job.js").AcquiredJobStep} AcquiredJobStep
 * @typedef {import("./run-service.js").JobStepResult} JobStepResult
 * @typedef {import("./executor.js").StepExecutionResult} StepExecutionResult
 */

/**
 * @param {AcquiredJobStep[]} steps
 * @param {"succeeded" | "failed"} conclusion
 * @param {StepExecutionResult} [execution]
 * @returns {JobStepResult[]}
 */
export function buildJobStepResults(steps, conclusion, execution = {}) {
  const timestamp = new Date().toISOString();
  const failedOrder = execution.failedStep?.order;
  const logsByOrder = new Map(
    (execution.stepLogs ?? []).map((entry) => [entry.step.order, entry])
  );

  return steps
    .filter((step) => isUuid(step.id))
    .map((step) => {
      let stepConclusion = "Succeeded";
      if (conclusion === "failed" && step.kind === "run") {
        if (failedOrder === step.order) {
          stepConclusion = "Failed";
        } else if (failedOrder && step.order > failedOrder) {
          stepConclusion = "Skipped";
        }
      }
      const logEntry = logsByOrder.get(step.order);
      const result = {
        external_id: step.id,
        number: step.order,
        name: step.displayName,
        type: step.type || step.kind,
        status: "completed",
        conclusion: mapConclusion(stepConclusion),
        started_at: timestamp,
        completed_at: timestamp,
        annotations: [],
      };
      if (logEntry?.lineCount) {
        result.completed_log_lines = logEntry.lineCount;
      }
      return result;
    });
}
