import { sanitizeRunServiceUrl } from './browser/http.js';
import { DEFAULT_RUNNER_VERSION } from './constants.js';
import { decodeJitConfig, parseRunnerIdentity } from './browser/jit-config.js';
import { fetchRunnerOAuthToken } from './browser/auth.js';
import {
  acknowledgeJobRequest,
  createBrokerSession,
  deleteBrokerSession,
  pollForJobReference,
} from './browser/broker.js';
import { executeAcquiredJobSteps } from './browser/executor.js';
import {
  acquireJob,
  renewJob,
  completeJob,
  parseAcquiredJobMetadata,
  parseAcquiredJobSteps,
  parseAcquiredJobEnvironment,
  mergeStepIdsFromTimeline,
  uploadAcquiredJobLogs,
  buildJobStepResults,
  isUuid,
} from './github-protocol.js';
import { registerJitRunner } from './browser/registration.js';
import { shouldExecuteProcessVideoJob } from './policy.js';

function createLogger(logger = {}) {
  return {
    log: logger.log ?? ((message) => console.log(message)),
    warn: logger.warn ?? ((message) => console.warn(message)),
    error: logger.error ?? ((message) => console.error(message)),
  };
}

export async function runOneShotListener(options = {}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const register = options.register ?? registerJitRunner;
  const shouldExecute = options.shouldExecute ?? shouldExecuteProcessVideoJob;
  const logger = createLogger(options.logger);
  const runnerVersion = options.runnerVersion ?? DEFAULT_RUNNER_VERSION;

  logger.log('Registering JIT runner...');
  const registration = await register({ fetchImpl, ...options.github });

  logger.log('Authenticating runner...');
  const files = decodeJitConfig(registration.encoded_jit_config);
  const identity = await parseRunnerIdentity(files);
  const accessToken = await fetchRunnerOAuthToken(identity, fetchImpl);

  logger.log('Opening broker session...');
  const session = await createBrokerSession(
    identity,
    accessToken,
    runnerVersion,
    fetchImpl,
  );

  logger.log('Connected to Actions broker. Long-polling for a job...');
  let jobReference;
  let acquiredJob;
  let jobMetadata;
  let jobSteps;
  try {
    jobReference = await pollForJobReference(session, fetchImpl, options.signal);
    logger.log('Acknowledging job request...');
    await acknowledgeJobRequest(session, jobReference, fetchImpl);
    logger.log('Acquiring job...');
    acquiredJob = await acquireJob(session, jobReference, fetchImpl);
    jobMetadata = parseAcquiredJobMetadata(
      acquiredJob.payload,
      jobReference,
      acquiredJob.planId,
    );
    jobSteps = mergeStepIdsFromTimeline(
      parseAcquiredJobSteps(acquiredJob.payload),
      acquiredJob.payload,
    );
  } finally {
    await deleteBrokerSession(session, fetchImpl).catch(() => {});
  }

  logger.log(`Runner: ${registration.runner.name} (${registration.runner.id})`);
  logger.log(`Run service URL: ${sanitizeRunServiceUrl(jobReference.runServiceUrl)}`);

  let jobResult = 'skipped';
  let execution = { success: true };
  if (shouldExecute(acquiredJob.payload, jobMetadata)) {
    const env = parseAcquiredJobEnvironment(acquiredJob.payload, {
      runnerName: registration.runner.name,
    });
    if (acquiredJob.jobAuthToken && jobMetadata.planId && jobMetadata.jobId) {
      await renewJob(
        jobReference.runServiceUrl,
        {
          planId: jobMetadata.planId,
          jobId: jobMetadata.jobId,
          authToken: acquiredJob.jobAuthToken,
        },
        fetchImpl,
      ).catch((error) => logger.warn(`Job renew warning: ${error.message}`));
    }

    logger.log('Executing dcpGhRunner pipeline...');
    execution = await executeAcquiredJobSteps(jobSteps, env, {
      onPipeline: options.onPipeline,
      onStepStart(step) {
        logger.log(`>>> Running step ${step.order}: ${step.displayName}`);
      },
      onStepSkip(step) {
        logger.log(`>>> Skipping action step ${step.order}: ${step.displayName}`);
      },
    });

    jobResult = execution.success ? 'succeeded' : 'failed';
  } else {
    logger.log('Job is not eligible for execution; skipping.');
  }

  if (acquiredJob.jobAuthToken && jobMetadata.planId && jobMetadata.jobId) {
    const conclusion = jobResult === 'failed' ? 'failed' : 'succeeded';
    const jobServiceUrl = acquiredJob.jobServiceUrl || jobReference.runServiceUrl;
    const stepResults = buildJobStepResults(jobSteps, conclusion, execution);
    if (execution.stepLogs?.length) {
      await uploadAcquiredJobLogs({
        acquired: acquiredJob.payload,
        planId: jobMetadata.planId,
        jobId: jobMetadata.jobId,
        authToken: acquiredJob.jobAuthToken,
        stepLogs: execution.stepLogs,
        fetchImpl,
      }).catch((error) => logger.warn(`Log upload warning: ${error.message}`));
    }
    await completeJob(
      jobServiceUrl,
      {
        planId: jobMetadata.planId,
        jobId: jobMetadata.jobId,
        conclusion,
        authToken: acquiredJob.jobAuthToken,
        stepResults,
        billingOwnerId: jobReference.billingOwnerId,
      },
      fetchImpl,
    );
    logger.log(`Job completed as ${conclusion}.`);
  }

  return {
    exitCode: jobResult === 'failed' ? 1 : 0,
    jobResult,
    registration,
    jobMetadata,
    pipelineResult: execution.pipelineResult,
  };
}
