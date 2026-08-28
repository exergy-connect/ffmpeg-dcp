import { runOneShotListener } from './runner.js';
import { transcodeVideoFromUrl } from './transcode.js';
import { publishDirectToLinkedIn } from './linkedin/direct.js';
import { publishViaGithubCommit } from './linkedin/github-commit.js';

function normalizeOptions(raw = {}) {
  const github = raw.github || {
    token: raw.githubToken,
    owner: raw.githubOwner,
    repo: raw.githubRepo,
    branch: raw.branch,
  };
  const linkedin = raw.linkedin || {
    accessToken: raw.linkedinAccessToken,
    authorUrn: raw.linkedinAuthorUrn,
    postText: raw.linkedinPostText,
    apiVersion: raw.linkedinApiVersion,
  };
  const githubPublish = raw.githubPublish || {
    branch: github.branch || raw.branch || 'main',
    uploadPrefix: raw.uploadPrefix || 'docs/uploads',
    postMetadataPrefix: raw.postMetadataPrefix || 'xframe/posts/linkedin',
  };
  return {
    github,
    linkedin,
    githubPublish,
    createFfmpegModule: raw.createFfmpegModule,
    progress: raw.progress ?? (() => {}),
    log: raw.log ?? console.log,
    format: raw.transcode?.format || raw.format,
  };
}

async function publishLinkedIn(mp4Bytes, opts) {
  const hasLinkedIn = opts.linkedin?.accessToken && opts.linkedin?.authorUrn;
  if (hasLinkedIn) {
    opts.log('Publishing to LinkedIn via REST API...');
    return publishDirectToLinkedIn(mp4Bytes, {
      ...opts.linkedin,
      githubToken: opts.github.token,
      githubOwner: opts.github.owner,
      githubRepo: opts.github.repo,
    });
  }
  opts.log('Publishing via GitHub commit + post-to-linkedin workflow...');
  return publishViaGithubCommit(mp4Bytes, {
    ...opts.githubPublish,
    ...opts.linkedin,
    token: opts.github.token,
    owner: opts.github.owner,
    repo: opts.github.repo,
    branch: opts.github.branch || opts.githubPublish.branch,
  });
}

/**
 * Full dcpGhRunner pipeline for DCP workFunction.
 * @param {object} rawOptions
 */
export async function runPipeline(rawOptions = {}) {
  const opts = normalizeOptions(rawOptions);

  if (!opts.github?.token || !opts.github?.owner || !opts.github?.repo) {
    throw new Error('runPipeline requires github.token, github.owner, github.repo');
  }

  return runOneShotListener({
    fetchImpl: fetch,
    github: {
      token: opts.github.token,
      owner: opts.github.owner,
      repo: opts.github.repo,
      githubToken: opts.github.token,
      githubOwner: opts.github.owner,
      githubRepo: opts.github.repo,
    },
    logger: { log: opts.log, warn: opts.log, error: opts.log },
    onPipeline: async (videoUrl) => {
      opts.log(`dcpGhRunner: VIDEO_URL=${videoUrl}`);
      const mp4Bytes = await transcodeVideoFromUrl(videoUrl, {
        createFfmpegModule: opts.createFfmpegModule,
        format: opts.format,
        progress: opts.progress,
        log: opts.log,
      });
      const publishResult = await publishLinkedIn(mp4Bytes, opts);
      opts.progress(1);
      return { videoUrl, mp4Bytes: mp4Bytes.length, publish: publishResult };
    },
  });
}

export { transcodeVideoFromUrl, publishDirectToLinkedIn, publishViaGithubCommit, runOneShotListener };
