import { registerAs } from '@nestjs/config';

// Defaults: 64MB part size, 10GB max upload, 15-minute presigned URL TTL.
export default registerAs('upload', () => ({
  partSizeBytes: parseInt(process.env.UPLOAD_PART_SIZE_BYTES || '67108864', 10),
  maxSizeBytes: parseInt(
    process.env.UPLOAD_MAX_SIZE_BYTES || '10737418240',
    10,
  ),
  urlExpiresSeconds: parseInt(
    process.env.UPLOAD_URL_EXPIRES_SECONDS || '900',
    10,
  ),
}));
