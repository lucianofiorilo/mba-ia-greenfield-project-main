// Shared producer/consumer contract between the API and the video worker.
export const VIDEO_PROCESSING_QUEUE = 'video-processing';
export const VIDEO_PROCESS_JOB = 'process';

// Upload initiation tuning.
export const PUBLIC_ID_LENGTH = 11;
export const MAX_PUBLIC_ID_RETRIES = 5;
export const VIDEO_MIME_PREFIX = 'video/';

// PostgreSQL unique-violation SQLSTATE — only `public_id` is unique on videos.
export const PG_UNIQUE_VIOLATION = '23505';
