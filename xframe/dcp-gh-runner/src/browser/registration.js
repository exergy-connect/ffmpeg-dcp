import {
  DEFAULT_LABELS,
  DEFAULT_RUNNER_GROUP_ID,
  DEFAULT_WORK_FOLDER,
} from '../constants.js';

export async function registerJitRunner(options = {}) {
  const owner = options.owner ?? options.githubOwner;
  const repo = options.repo ?? options.githubRepo;
  const token = options.token ?? options.githubToken;
  const fetchImpl = options.fetchImpl ?? fetch;

  if (!owner || !repo || !token) {
    throw new Error('GitHub owner, repo, and token are required for JIT registration');
  }

  const runnerName = options.name ?? `dcp-${crypto.randomUUID()}`;
  const response = await fetchImpl(
    `https://api.github.com/repos/${owner}/${repo}/actions/runners/generate-jitconfig`,
    {
      method: 'POST',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2026-03-10',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: runnerName,
        runner_group_id: options.runnerGroupId ?? DEFAULT_RUNNER_GROUP_ID,
        labels: options.labels ?? DEFAULT_LABELS,
        work_folder: options.workFolder ?? DEFAULT_WORK_FOLDER,
      }),
    },
  );

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`GitHub returned ${response.status}: ${body}`);
  }

  return response.json();
}
