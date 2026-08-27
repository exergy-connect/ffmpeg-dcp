import { sanitizeRunServiceUrl } from "./http.js";
import { DEFAULT_RUNNER_VERSION } from "./constants.js";
import { decodeJitConfig, parseRunnerIdentity } from "./github/jit-config.js";
import { fetchRunnerOAuthToken } from "./github/auth.js";
import {
  acknowledgeJobRequest,
  createBrokerSession,
  deleteBrokerSession,
  pollForJobReference,
} from "./github/broker.js";
import { executeAcquiredJobSteps } from "./github/executor.js";
import {
  isUuid,
  mergeStepIdsFromTimeline,
  parseAcquiredJobEnvironment,
  parseAcquiredJobMetadata,
  parseAcquiredJobSteps,
} from "./github/job.js";
import { uploadAcquiredJobLogs } from "./github/logs.js";
import { registerJitRunner } from "./github/registration.js";
import { shouldExecuteProcessVideoJob } from "./policy.js";
import { buildJobStepResults } from "./github/results.js";
import {
  acquireJob,
  completeJob,
  renewJob,
} from "./github/run-service.js";

/**
 * @typedef {object} RunnerLogger
 * @property {(message: string) => void} [log]
 * @property {(message: string) => void} [warn]
 * @property {(message: string) => void} [error]
 */

/**
 * @param {RunnerLogger} [logger]
 */
function createLogger(logger = {}) {
  return {
    log: logger.log ?? ((message) => console.log(message)),
    warn: logger.warn ?? ((message) => console.warn(message)),
    error: logger.error ?? ((message) => console.error(message)),
  };
}

function printJobMetadata({
  registration,
  identity,
  session,
  jobReference,
  logger,
}) {
  logger.log(`Runner: ${registration.runner.name}`);
  logger.log(`Runner ID: ${registration.runner.id}`);
  logger.log(
    `Labels: ${registration.runner.labels.map((label) => label.name).join(", ")}`
  );
  logger.log(`Broker URL: ${identity.brokerUrl}`);
  logger.log(`Session ID: ${session.sessionId}`);
  logger.log(`Message ID: ${jobReference.messageId}`);
  logger.log(`Message type: ${jobReference.messageType}`);
  logger.log(`Runner request ID: ${jobReference.runnerRequestId}`);
  logger.log(
    `Run service URL: ${sanitizeRunServiceUrl(jobReference.runServiceUrl)}`
  );
  logger.log(`Billing owner ID: ${jobReference.billingOwnerId}`);
}

function printAcquiredJobMetadata(jobMetadata, logger) {
  logger.log(`Plan ID: ${jobMetadata.planId}`);
  logger.log(`Job ID: ${jobMetadata.jobId}`);
  logger.log(`Job name: ${jobMetadata.jobName || "(unknown)"}`);
  logger.log(`Workflow: ${jobMetadata.workflowFile || "(unknown)"}`);
  logger.log(`Git ref: ${jobMetadata.workflowRef || "(unknown)"}`);
  logger.log(`Repository: ${jobMetadata.repository || "(unknown)"}`);
  if (jobMetadata.secretVariableNames.length > 0) {
    logger.log(
      `Secret variables: ${jobMetadata.secretVariableNames.join(", ")}`
    );
  }
}

function printAcquiredJobSteps(steps, logger) {
  logger.log("\nAcquired job steps:");
  if (steps.length === 0) {
    logger.log("(no steps found in acquire payload)");
    return;
  }

  for (const step of steps) {
    logger.log(`\n--- Step ${step.order}: ${step.displayName} (${step.kind}) ---`);
    if (step.uses) {
      logger.log(`uses: ${step.uses}`);
    }
    if (step.script) {
      logger.log(step.script);
    }
  }
}

/**
 * @param {object} [options]
 * @param {typeof registerJitRunner} [options.register]
 * @param {typeof fetch} [options.fetchImpl]
 * @param {AbortSignal} [options.signal]
 * @param {(acquired: Record<string, unknown>, metadata: import("./github/job.js").AcquiredJobMetadata) => boolean} [options.shouldExecute]
 * @param {RunnerLogger} [options.logger]
 * @param {string} [options.runnerVersion]
 */
export async function runOneShotListener(options = {}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const register = options.register ?? registerJitRunner;
  const shouldExecute =
    options.shouldExecute ?? shouldExecuteProcessVideoJob;
  const logger = createLogger(options.logger);
  const runnerVersion =
    options.runnerVersion ??
    process.env.GITHUB_RUNNER_VERSION ??
    DEFAULT_RUNNER_VERSION;

  logger.log("Registering JIT runner...");
  const registration = await register({ fetchImpl });

  logger.log("Authenticating runner...");
  const files = decodeJitConfig(registration.encoded_jit_config);
  const identity = parseRunnerIdentity(files);
  const accessToken = await fetchRunnerOAuthToken(identity, fetchImpl);

  logger.log("Opening broker session...");
  const session = await createBrokerSession(
    identity,
    accessToken,
    runnerVersion,
    fetchImpl
  );

  logger.log("Connected to Actions broker. Long-polling for a job...");
  let jobReference;
  let acquiredJob;
  let jobMetadata;
  let jobSteps;
  try {
    jobReference = await pollForJobReference(
      session,
      fetchImpl,
      options.signal
    );
    logger.log("Acknowledging job request...");
    await acknowledgeJobRequest(session, jobReference, fetchImpl);
    logger.log("Acquiring job...");
    acquiredJob = await acquireJob(session, jobReference, fetchImpl);
    jobMetadata = parseAcquiredJobMetadata(
      acquiredJob.payload,
      jobReference,
      acquiredJob.planId
    );
    jobSteps = mergeStepIdsFromTimeline(
      parseAcquiredJobSteps(acquiredJob.payload),
      acquiredJob.payload
    );
  } finally {
    await deleteBrokerSession(session, fetchImpl).catch(() => {});
  }

  logger.log("\nJob reference received:");
  printJobMetadata({ registration, identity, session, jobReference, logger });
  logger.log("\nAcquired job metadata:");
  printAcquiredJobMetadata(jobMetadata, logger);
  printAcquiredJobSteps(jobSteps, logger);

  let jobResult = "skipped";
  let execution = { success: true };
  if (shouldExecute(acquiredJob.payload, jobMetadata)) {
    const env = parseAcquiredJobEnvironment(acquiredJob.payload, {
      runnerName: registration.runner.name,
    });
    if (acquiredJob.jobAuthToken && jobMetadata.planId && jobMetadata.jobId) {
      await renewJob(
        jobReference.runServiceUrl,
        {
          planId: jobMetadata.planId,
          jobId: jobMetadata.jobId,
          authToken: acquiredJob.jobAuthToken,
        },
        fetchImpl
      ).catch((error) => {
        logger.warn(`Job renew warning: ${error.message}`);
      });
    }
    logger.log("\nExecuting job steps...");
    execution = await executeAcquiredJobSteps(jobSteps, env, {
      onStepStart(step) {
        logger.log(`\n>>> Running step ${step.order}: ${step.displayName}`);
      },
      onStepSkip(step) {
        logger.log(
          `\n>>> Skipping action step ${step.order}: ${step.displayName} (${step.uses})`
        );
      },
    });

    if (execution.success) {
      jobResult = "succeeded";
      logger.log("\nAll job steps completed successfully.");
    } else {
      jobResult = "failed";
      logger.error(
        `\nStep failed: ${execution.failedStep?.displayName ?? "unknown"} (exit ${execution.exitCode ?? 1})`
      );
    }
  } else {
    logger.log("\nJob is not eligible for execution; skipping.");
  }

  if (acquiredJob.jobAuthToken && jobMetadata.planId && jobMetadata.jobId) {
    const conclusion = jobResult === "failed" ? "failed" : "succeeded";
    const jobServiceUrl =
      acquiredJob.jobServiceUrl || jobReference.runServiceUrl;
    const stepResults = buildJobStepResults(jobSteps, conclusion, execution);
    const stepsWithoutIds = jobSteps.filter((step) => !isUuid(step.id)).length;
    if (stepsWithoutIds > 0) {
      logger.warn(
        `Warning: ${stepsWithoutIds} acquired steps are missing UUID ids; stepResults may be incomplete`
      );
    }

    if (execution.stepLogs?.length) {
      logger.log("\nUploading step logs to GitHub...");
      await uploadAcquiredJobLogs({
        acquired: acquiredJob.payload,
        planId: jobMetadata.planId,
        jobId: jobMetadata.jobId,
        authToken: acquiredJob.jobAuthToken,
        stepLogs: execution.stepLogs,
        fetchImpl,
      }).catch((error) => {
        logger.warn(`Log upload warning: ${error.message}`);
      });
    }

    logger.log(`\nCompleting acquired job as ${conclusion}...`);
    await completeJob(
      jobServiceUrl,
      {
        planId: jobMetadata.planId,
        jobId: jobMetadata.jobId,
        conclusion,
        authToken: acquiredJob.jobAuthToken,
        stepResults,
        billingOwnerId: jobReference.billingOwnerId,
      },
      fetchImpl
    );
    logger.log(`Job completed as ${conclusion}.`);
  } else {
    logger.log(
      "\nJob acquired but no job-scoped token was returned; workflow may remain in progress."
    );
    if (jobResult === "failed") {
      return { exitCode: 1, jobResult };
    }
  }

  return {
    exitCode: jobResult === "failed" ? 1 : 0,
    jobResult,
    registration,
    jobMetadata,
  };
}
