import type { JobsOptions } from 'bullmq';

// Shared producer/consumer contract between the API and the video worker.
export const VIDEO_PROCESSING_QUEUE = 'video-processing';
export const VIDEO_PROCESS_JOB = 'process';

// Retry policy for processing jobs (per TD-01/TD-08): retry 3× with exponential
// backoff; keep failed jobs (dead-letter) so a video can be flipped to `failed`.
export const VIDEO_JOB_OPTIONS: JobsOptions = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 5000 },
  removeOnComplete: true,
  removeOnFail: false,
};

// Upload initiation tuning.
export const PUBLIC_ID_LENGTH = 11;
export const MAX_PUBLIC_ID_RETRIES = 5;
export const VIDEO_MIME_PREFIX = 'video/';

// PostgreSQL unique-violation SQLSTATE — only `public_id` is unique on videos.
export const PG_UNIQUE_VIOLATION = '23505';
