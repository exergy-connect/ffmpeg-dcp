#!/usr/bin/env node
/**
 * @file runner-listener.js
 *
 * One-shot GitHub Actions listener prototype:
 *   JIT registration -> OAuth auth -> broker session -> long-poll ->
 *   decrypt job reference -> acquire job -> execute process-video steps -> exit
 *
 * Executes shell steps from the acquired `process-video` job manifest. Other
 * jobs are completed as skipped.
 *
 * Usage:
 *   node --env-file=xframe/test/.env xframe/test/runner-listener.js
 */

import { pathToFileURL } from "node:url";

import { registerJitRunner } from "./register-runner.js";
import {
  acquireJob,
  acknowledgeJobRequest,
  buildJobStepResults,
  completeJob,
  createBrokerSession,
  decodeJitConfig,
  deleteBrokerSession,
  executeAcquiredJobSteps,
  uploadAcquiredJobLogs,
  fetchRunnerOAuthToken,
  isUuid,
  mergeStepIdsFromTimeline,
  parseAcquiredJobEnvironment,
  parseAcquiredJobMetadata,
  parseAcquiredJobSteps,
  parseRunnerIdentity,
  pollForJobReference,
  renewJob,
  sanitizeRunServiceUrl,
  shouldExecuteAcquiredJob,
} from "./github-runner-client.js";

function printJobMetadata({
  registration,
  identity,
  session,
  jobReference,
}) {
  console.log("Runner:", registration.runner.name);
  console.log("Runner ID:", registration.runner.id);
  console.log("Labels:", registration.runner.labels.map((label) => label.name));
  console.log("Broker URL:", identity.brokerUrl);
  console.log("Session ID:", session.sessionId);
  console.log("Message ID:", jobReference.messageId);
  console.log("Message type:", jobReference.messageType);
  console.log("Runner request ID:", jobReference.runnerRequestId);
  console.log(
    "Run service URL:",
    sanitizeRunServiceUrl(jobReference.runServiceUrl)
  );
  console.log("Billing owner ID:", jobReference.billingOwnerId);
}

function printAcquiredJobMetadata(jobMetadata) {
  console.log("Plan ID:", jobMetadata.planId);
  console.log("Job ID:", jobMetadata.jobId);
  console.log("Job name:", jobMetadata.jobName || "(unknown)");
  console.log("Workflow:", jobMetadata.workflowFile || "(unknown)");
  console.log("Git ref:", jobMetadata.workflowRef || "(unknown)");
  console.log("Repository:", jobMetadata.repository || "(unknown)");
  if (jobMetadata.secretVariableNames.length > 0) {
    console.log(
      "Secret variables:",
      jobMetadata.secretVariableNames.join(", ")
    );
  }
}

function printAcquiredJobSteps(steps) {
  console.log("\nAcquired job steps:");
  if (steps.length === 0) {
    console.log("(no steps found in acquire payload)");
    return;
  }

  for (const step of steps) {
    console.log(`\n--- Step ${step.order}: ${step.displayName} (${step.kind}) ---`);
    if (step.uses) {
      console.log(`uses: ${step.uses}`);
    }
    if (step.script) {
      console.log(step.script);
    }
  }
}

async function main() {
  const abortController = new AbortController();
  const onSignal = () => {
    console.error("\nStopping listener...");
    abortController.abort();
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  console.log("Registering JIT runner...");
  const registration = await registerJitRunner();

  console.log("Authenticating runner...");
  const files = decodeJitConfig(registration.encoded_jit_config);
  const identity = parseRunnerIdentity(files);
  const accessToken = await fetchRunnerOAuthToken(identity);

  console.log("Opening broker session...");
  const session = await createBrokerSession(identity, accessToken);

  console.log("Connected to Actions broker. Long-polling for a job...");
  let jobReference;
  let acquiredJob;
  let jobMetadata;
  let jobSteps;
  try {
    jobReference = await pollForJobReference(
      session,
      fetch,
      abortController.signal
    );
    console.log("Acknowledging job request...");
    await acknowledgeJobRequest(session, jobReference);
    console.log("Acquiring job...");
    acquiredJob = await acquireJob(session, jobReference);
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
    await deleteBrokerSession(session).catch(() => {});
  }

  console.log("\nJob reference received:");
  printJobMetadata({ registration, identity, session, jobReference });
  console.log("\nAcquired job metadata:");
  printAcquiredJobMetadata(jobMetadata);
  printAcquiredJobSteps(jobSteps);

  let jobResult = "skipped";
  let execution = { success: true };
  if (shouldExecuteAcquiredJob(acquiredJob.payload, jobMetadata)) {
    const env = parseAcquiredJobEnvironment(acquiredJob.payload, {
      runnerName: registration.runner.name,
    });
    if (acquiredJob.jobAuthToken && jobMetadata.planId && jobMetadata.jobId) {
      await renewJob(jobReference.runServiceUrl, {
        planId: jobMetadata.planId,
        jobId: jobMetadata.jobId,
        authToken: acquiredJob.jobAuthToken,
      }).catch((error) => {
        console.warn(`Job renew warning: ${error.message}`);
      });
    }
    console.log("\nExecuting process-video steps...");
    execution = await executeAcquiredJobSteps(jobSteps, env, {
      onStepStart(step) {
        console.log(`\n>>> Running step ${step.order}: ${step.displayName}`);
      },
      onStepSkip(step) {
        console.log(
          `\n>>> Skipping action step ${step.order}: ${step.displayName} (${step.uses})`
        );
      },
    });

    if (execution.success) {
      jobResult = "succeeded";
      console.log("\nAll process-video steps completed successfully.");
    } else {
      jobResult = "failed";
      console.error(
        `\nStep failed: ${execution.failedStep?.displayName ?? "unknown"} (exit ${execution.exitCode ?? 1})`
      );
    }
  } else {
    console.log("\nJob is not process-video; skipping execution.");
  }

  if (acquiredJob.jobAuthToken && jobMetadata.planId && jobMetadata.jobId) {
    const conclusion = jobResult === "failed" ? "failed" : "succeeded";
    const jobServiceUrl =
      acquiredJob.jobServiceUrl || jobReference.runServiceUrl;
    const stepResults = buildJobStepResults(jobSteps, conclusion, execution);
    const stepsWithoutIds = jobSteps.filter((step) => !isUuid(step.id)).length;
    if (stepsWithoutIds > 0) {
      console.warn(
        `Warning: ${stepsWithoutIds} acquired steps are missing UUID ids; stepResults may be incomplete`
      );
      console.warn(
        "Step ids:",
        jobSteps.map((step) => ({
          order: step.order,
          id: step.id || "(missing)",
          name: step.displayName,
        }))
      );
    }
    console.log(`Plan ID: ${jobMetadata.planId}`);
    console.log(`Job ID: ${jobMetadata.jobId}`);
    console.log(`Step results: ${stepResults.length}`);

    if (execution.stepLogs?.length) {
      console.log("\nUploading step logs to GitHub...");
      await uploadAcquiredJobLogs({
        acquired: acquiredJob.payload,
        planId: jobMetadata.planId,
        jobId: jobMetadata.jobId,
        authToken: acquiredJob.jobAuthToken,
        stepLogs: execution.stepLogs,
      }).catch((error) => {
        console.warn(`Log upload warning: ${error.message}`);
      });
    }

    console.log(`\nCompleting acquired job as ${conclusion}...`);
    console.log(`CompleteJob URL: ${sanitizeRunServiceUrl(jobServiceUrl)}/completejob`);
    await completeJob(jobServiceUrl, {
      planId: jobMetadata.planId,
      jobId: jobMetadata.jobId,
      conclusion,
      authToken: acquiredJob.jobAuthToken,
      stepResults,
      billingOwnerId: jobReference.billingOwnerId,
    });
    console.log(`Job completed as ${conclusion}.`);
  } else {
    console.log(
      "\nJob acquired but no job-scoped token was returned; workflow may remain in progress."
    );
    if (jobResult === "failed") {
      process.exitCode = 1;
    }
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
