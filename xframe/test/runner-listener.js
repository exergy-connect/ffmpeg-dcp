#!/usr/bin/env node
/**
 * @file runner-listener.js
 *
 * One-shot GitHub Actions listener prototype:
 *   JIT registration -> OAuth auth -> broker session -> long-poll ->
 *   decrypt job reference -> acquire job -> print metadata -> exit
 *
 * Does not execute workflow steps. After acquiring, the job is completed as
 * skipped so the workflow does not remain locked.
 *
 * Usage:
 *   node --env-file=xframe/test/.env xframe/test/runner-listener.js
 */

import { pathToFileURL } from "node:url";

import { registerJitRunner } from "./register-runner.js";
import {
  acquireJob,
  completeJob,
  createBrokerSession,
  decodeJitConfig,
  deleteBrokerSession,
  fetchRunnerOAuthToken,
  parseAcquiredJobMetadata,
  parseAcquiredJobSteps,
  parseRunnerIdentity,
  pollForJobReference,
  sanitizeRunServiceUrl,
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
    console.log("Acquiring job...");
    acquiredJob = await acquireJob(session, jobReference);
    jobMetadata = parseAcquiredJobMetadata(
      acquiredJob.payload,
      jobReference,
      acquiredJob.planId
    );
    jobSteps = parseAcquiredJobSteps(acquiredJob.payload);
  } finally {
    await deleteBrokerSession(session).catch(() => {});
  }

  console.log("\nJob reference received:");
  printJobMetadata({ registration, identity, session, jobReference });
  console.log("\nAcquired job metadata:");
  printAcquiredJobMetadata(jobMetadata);
  printAcquiredJobSteps(jobSteps);

  if (acquiredJob.jobAuthToken && jobMetadata.planId) {
    console.log("\nCompleting acquired job as skipped...");
    await completeJob(jobReference.runServiceUrl, {
      planId: jobMetadata.planId,
      jobId: jobMetadata.jobId,
      result: "skipped",
      authToken: acquiredJob.jobAuthToken,
    });
    console.log("Job completed as skipped.");
  } else {
    console.log(
      "\nJob acquired but no job-scoped token was returned; workflow may remain in progress."
    );
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
