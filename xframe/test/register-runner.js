#!/usr/bin/env node
/**
 * @file register-runner.js
 *
 * Node.js 18+
 *
 * Environment:
 *   GITHUB_TOKEN  - token with repository Administration: write
 *   GITHUB_OWNER  - repository owner
 *   GITHUB_REPO   - repository name
 *
 * Creates a just-in-time runner configuration via the GitHub REST API.
 * The returned encoded_jit_config is consumed by github-runner-client.js.
 */

import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

const DEFAULT_LABELS = ["dcp", "wasm", "video"];
const DEFAULT_RUNNER_GROUP_ID = 1;
const DEFAULT_WORK_FOLDER = "_work";

/**
 * @param {object} [options]
 * @param {string} [options.owner]
 * @param {string} [options.repo]
 * @param {string} [options.token]
 * @param {string} [options.name]
 * @param {number} [options.runnerGroupId]
 * @param {string[]} [options.labels]
 * @param {string} [options.workFolder]
 * @param {typeof fetch} [options.fetchImpl]
 * @returns {Promise<{
 *   runner: { id: number, name: string, labels: Array<{ name: string }> },
 *   encoded_jit_config: string
 * }>}
 */
export async function registerJitRunner(options = {}) {
  const owner = options.owner ?? process.env.GITHUB_OWNER;
  const repo = options.repo ?? process.env.GITHUB_REPO;
  const token = options.token ?? process.env.GITHUB_TOKEN;
  const fetchImpl = options.fetchImpl ?? fetch;

  if (!owner || !repo || !token) {
    throw new Error("Set GITHUB_OWNER, GITHUB_REPO and GITHUB_TOKEN");
  }

  const runnerName = options.name ?? `dcp-${randomUUID()}`;
  const response = await fetchImpl(
    `https://api.github.com/repos/${owner}/${repo}/actions/runners/generate-jitconfig`,
    {
      method: "POST",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2026-03-10",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: runnerName,
        runner_group_id: options.runnerGroupId ?? DEFAULT_RUNNER_GROUP_ID,
        labels: options.labels ?? DEFAULT_LABELS,
        work_folder: options.workFolder ?? DEFAULT_WORK_FOLDER,
      }),
    }
  );

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`GitHub returned ${response.status}: ${body}`);
  }

  return response.json();
}

function printRegistrationSummary(result, { includeJitConfig = false } = {}) {
  console.log("Runner:", result.runner.name);
  console.log("Runner ID:", result.runner.id);
  console.log("Labels:", result.runner.labels.map((label) => label.name));
  if (includeJitConfig) {
    console.log("JIT configuration:", result.encoded_jit_config);
  }
}

async function main() {
  const includeJitConfig = process.argv.includes("--show-jit-config");
  const result = await registerJitRunner();
  printRegistrationSummary(result, { includeJitConfig });
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
