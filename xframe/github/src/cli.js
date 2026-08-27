
import { pathToFileURL } from "node:url";

import { registerJitRunner } from "./github/registration.js";
import { runOneShotListener } from "./runner.js";

const HELP = `GitHub Actions JIT self-hosted runner listener

Usage:
  github-runner [listen]
  github-runner register [--show-jit-config]

Commands:
  listen              Register, poll for one job, execute, and exit (default)
  register            Register a JIT runner only

Environment:
  GITHUB_TOKEN        Token with repository Administration: write
  GITHUB_OWNER        Repository owner
  GITHUB_REPO         Repository name
  GITHUB_RUNNER_VERSION  Optional runner version (default 2.336.0)

Examples:
  node --env-file=.env dist/github-runner.min.js
  node --env-file=.env dist/github-runner.min.js register --show-jit-config
`;

/**
 * @param {string[]} argv
 */
export function parseCliArgs(argv) {
  const args = argv.filter((arg) => arg !== "--");
  let command = "listen";
  let showJitConfig = false;

  for (const arg of args) {
    if (arg === "--help" || arg === "-h") {
      return { command: "help", showJitConfig: false };
    }
    if (arg === "--show-jit-config") {
      showJitConfig = true;
      continue;
    }
    if (!arg.startsWith("-")) {
      command = arg;
    }
  }

  return { command, showJitConfig };
}

function printRegistrationSummary(result, { includeJitConfig = false } = {}) {
  console.log("Runner:", result.runner.name);
  console.log("Runner ID:", result.runner.id);
  console.log("Labels:", result.runner.labels.map((label) => label.name));
  if (includeJitConfig) {
    console.log("JIT configuration:", result.encoded_jit_config);
  }
}

async function runRegister(showJitConfig) {
  const result = await registerJitRunner();
  printRegistrationSummary(result, { includeJitConfig: showJitConfig });
}

async function runListen() {
  const abortController = new AbortController();
  const onSignal = () => {
    console.error("\nStopping listener...");
    abortController.abort();
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  const result = await runOneShotListener({ signal: abortController.signal });
  if (result.exitCode) {
    process.exitCode = result.exitCode;
  }
}

/**
 * @param {string[]} [argv]
 */
export async function main(argv = process.argv.slice(2)) {
  const { command, showJitConfig } = parseCliArgs(argv);

  if (command === "help") {
    console.log(HELP.trim());
    return;
  }

  if (command === "register") {
    await runRegister(showJitConfig);
    return;
  }

  if (command === "listen") {
    await runListen();
    return;
  }

  throw new Error(`Unknown command: ${command}\n\n${HELP.trim()}`);
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
