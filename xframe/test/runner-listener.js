#!/usr/bin/env node
/**
 * @file runner-listener.js
 *
 * One-shot GitHub Actions listener prototype:
 *   JIT registration -> OAuth auth -> broker session -> long-poll ->
 *   decrypt job reference -> print metadata -> exit
 *
 * Does not acquire or execute jobs.
 *
 * Usage:
 *   node --env-file=xframe/test/.env xframe/test/runner-listener.js
 */

import { pathToFileURL } from "node:url";

import { registerJitRunner } from "./register-runner.js";
import {
  createBrokerSession,
  decodeJitConfig,
  deleteBrokerSession,
  fetchRunnerOAuthToken,
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
  try {
    jobReference = await pollForJobReference(
      session,
      fetch,
      abortController.signal
    );
  } finally {
    await deleteBrokerSession(session).catch(() => {});
  }

  console.log("\nJob reference received:");
  printJobMetadata({ registration, identity, session, jobReference });
  console.log(
    "\nPrototype complete. Job was not acquired; dispatch another run if needed."
  );
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
