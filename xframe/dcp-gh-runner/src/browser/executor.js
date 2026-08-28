function formatLogTimestamp(date = new Date()) {
  const iso = date.toISOString();
  const match = iso.match(/^(.+)\.(\d{3})Z$/);
  if (!match) return `${iso.replace('Z', '')}0000Z `;
  return `${match[1]}.${match[2]}0000Z `;
}

function formatGithubLogLines(text) {
  if (!text) return '';
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  if (!lines.length) return '';
  return lines.map((line) => `${formatLogTimestamp()}${line}`).join('\n').concat('\n');
}

function countGithubLogLines(text) {
  if (!text) return 0;
  return formatGithubLogLines(text).split('\n').filter((line) => line.length > 0).length;
}

/**
 * Browser executor: runs transcode/LinkedIn pipeline instead of bash.
 */
export async function executeAcquiredJobSteps(steps, env, options = {}) {
  const stepLogs = [];
  let pipelineResult = null;

  if (typeof options.onPipeline === 'function') {
    const videoUrl = String(env.VIDEO_URL || '').trim();
    if (!videoUrl) throw new Error('process-video job missing VIDEO_URL in environment');
    pipelineResult = await options.onPipeline(videoUrl, env);
  }

  for (const step of steps) {
    if (step.uses || step.kind === 'action') {
      options.onStepSkip?.(step);
      const output = formatGithubLogLines(`Skipped action step: ${step.uses || step.displayName}\n`);
      stepLogs.push({ step, output, lineCount: countGithubLogLines(output) });
      continue;
    }

    if (step.kind === 'run') {
      options.onStepStart?.(step);
      const videoUrl = String(env.VIDEO_URL || '').trim();
      let text = '';
      if (step.script?.includes('VIDEO_URL') && videoUrl) {
        text = `Self-hosted runner received video URL: ${videoUrl}\n`;
      } else if (pipelineResult) {
        text = `dcpGhRunner pipeline complete: ${JSON.stringify(pipelineResult)}\n`;
      } else {
        text = 'Step completed by dcpGhRunner browser executor\n';
      }
      const output = formatGithubLogLines(text);
      stepLogs.push({ step, output, lineCount: countGithubLogLines(output) });
    }
  }

  return { success: true, stepLogs, pipelineResult };
}
