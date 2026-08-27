import { spawn } from "node:child_process";

/**
 * @typedef {import("./job.js").AcquiredJobStep} AcquiredJobStep
 */

/**
 * @typedef {object} StepLogCapture
 * @property {AcquiredJobStep} step
 * @property {string} output
 * @property {number} lineCount
 */

/**
 * @typedef {object} StepExecutionResult
 * @property {boolean} success
 * @property {AcquiredJobStep} [failedStep]
 * @property {number} [exitCode]
 * @property {StepLogCapture[]} [stepLogs]
 */

/**
 * @param {Date} [date]
 */
function formatLogTimestamp(date = new Date()) {
  const iso = date.toISOString();
  const match = iso.match(/^(.+)\.(\d{3})Z$/);
  if (!match) {
    return `${iso.replace("Z", "")}0000Z `;
  }
  return `${match[1]}.${match[2]}0000Z `;
}

/**
 * @param {string} text
 */
export function formatGithubLogLines(text) {
  if (!text) {
    return "";
  }
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  while (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  if (lines.length === 0) {
    return "";
  }
  return lines
    .map((line) => `${formatLogTimestamp()}${line}`)
    .join("\n")
    .concat("\n");
}

/**
 * @param {string} text
 */
export function countGithubLogLines(text) {
  if (!text) {
    return 0;
  }
  return formatGithubLogLines(text)
    .split("\n")
    .filter((line) => line.length > 0).length;
}

/**
 * @param {string} script
 * @param {NodeJS.ProcessEnv} env
 * @param {string} [cwd]
 */
function runShellScript(script, env, cwd) {
  return new Promise((resolve) => {
    const child = spawn("bash", ["-e", "-c", script], {
      env,
      cwd: cwd ?? process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => {
      const text = String(chunk);
      stdout += text;
      process.stdout.write(text);
    });
    child.stderr?.on("data", (chunk) => {
      const text = String(chunk);
      stderr += text;
      process.stderr.write(text);
    });
    child.on("close", (code) => {
      const output = `${stdout}${stderr}`;
      resolve({
        exitCode: code ?? 1,
        output,
        lineCount: countGithubLogLines(output),
      });
    });
    child.on("error", () => {
      resolve({ exitCode: 1, output: `${stdout}${stderr}`, lineCount: 0 });
    });
  });
}

/**
 * @param {AcquiredJobStep[]} steps
 * @param {NodeJS.ProcessEnv} env
 * @param {object} [options]
 * @param {string} [options.cwd]
 * @param {(step: AcquiredJobStep) => void} [options.onStepStart]
 * @param {(step: AcquiredJobStep) => void} [options.onStepSkip]
 * @returns {Promise<StepExecutionResult>}
 */
export async function executeAcquiredJobSteps(steps, env, options = {}) {
  /** @type {StepLogCapture[]} */
  const stepLogs = [];

  for (const step of steps) {
    if (step.kind === "uses") {
      options.onStepSkip?.(step);
      continue;
    }
    if (step.kind !== "run" || !step.script) {
      continue;
    }

    options.onStepStart?.(step);
    const result = await runShellScript(step.script, env, options.cwd);
    stepLogs.push({
      step,
      output: result.output,
      lineCount: result.lineCount,
    });
    if (result.exitCode !== 0) {
      return {
        success: false,
        failedStep: step,
        exitCode: result.exitCode,
        stepLogs,
      };
    }
  }

  return { success: true, stepLogs };
}
