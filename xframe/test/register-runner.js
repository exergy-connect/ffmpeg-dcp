// register-runner.js
//
// Node.js 18+
//
// Environment:
//   GITHUB_TOKEN  - token with repository Administration: write
//   GITHUB_OWNER  - repository owner
//   GITHUB_REPO   - repository name
//
// This asks GitHub to create a just-in-time runner configuration.
// The returned encoded_jit_config is then consumed by the runner.

const owner = process.env.GITHUB_OWNER;
const repo = process.env.GITHUB_REPO;
const token = process.env.GITHUB_TOKEN;

if (!owner || !repo || !token) {
  throw new Error(
    "Set GITHUB_OWNER, GITHUB_REPO and GITHUB_TOKEN"
  );
}

const runnerName =
  `dcp-${crypto.randomUUID()}`;

const response = await fetch(
  `https://api.github.com/repos/${owner}/${repo}/actions/runners/generate-jitconfig`,
  {
    method: "POST",
    headers: {
      "Accept": "application/vnd.github+json",
      "Authorization": `Bearer ${token}`,
      "X-GitHub-Api-Version": "2026-03-10",
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      name: runnerName,

      // Repository runner-group ID.
      // Usually 1 for the default group.
      runner_group_id: 1,

      labels: [
        "dcp",
        "wasm",
        "video"
      ],

      work_folder: "_work"
    })
  }
);

if (!response.ok) {
  const body = await response.text();
  throw new Error(
    `GitHub returned ${response.status}: ${body}`
  );
}

const result = await response.json();

console.log("Runner:", result.runner.name);
console.log("Runner ID:", result.runner.id);
console.log("Labels:", result.runner.labels.map(x => x.name));

console.log(
  "JIT configuration:",
  result.encoded_jit_config
);