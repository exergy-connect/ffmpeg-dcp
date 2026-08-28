function formatLogTimestamp(date = new Date()) {
  const iso = date.toISOString();
  const match = iso.match(/^(.+)\.(\d{3})Z$/);
  if (!match) return `${iso.replace('Z', '')}0000Z `;
  return `${match[1]}.${match[2]}0000Z `;
}

export function formatGithubLogLines(text) {
  if (!text) return '';
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  if (!lines.length) return '';
  return lines.map((line) => `${formatLogTimestamp()}${line}`).join('\n').concat('\n');
}

export function countGithubLogLines(text) {
  if (!text) return 0;
  return formatGithubLogLines(text).split('\n').filter((line) => line.length > 0).length;
}

// Stub so accidental imports of executeAcquiredJobSteps fail clearly.
export async function executeAcquiredJobSteps() {
  throw new Error('Use browser/executor.js executeAcquiredJobSteps in dcpGhRunner');
}
