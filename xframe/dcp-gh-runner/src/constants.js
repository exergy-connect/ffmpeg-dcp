import { Buffer } from './shims/buffer.js';

export const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);

export const DEFAULT_RUNNER_VERSION = '2.336.0';
export const LONG_POLL_TIMEOUT_MS = 55_000;
export const DEFAULT_POLL_BACKOFF_MS = 1_000;
export const MAX_POLL_BACKOFF_MS = 15_000;

export const DEFAULT_LABELS = ['dcp', 'wasm', 'video'];
export const DEFAULT_RUNNER_GROUP_ID = 1;
export const DEFAULT_WORK_FOLDER = '_work';

export const LI_FEED_FORMAT = {
  width: 1080,
  height: 1350,
  bitrateKbps: 6000,
  audioBitrateKbps: 160,
  maxFps: 30,
  gopSeconds: 2,
  frameMode: 1,
  signature: '1080x1350-6000-160-30',
};
