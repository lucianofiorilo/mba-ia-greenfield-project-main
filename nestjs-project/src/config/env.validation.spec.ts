import { envValidationSchema } from './env.validation';

// Minimal set of always-required vars (DB + JWT from prior phases) plus the
// Phase 03 storage credentials. Used as the baseline for each test.
const baseEnv = {
  DB_USERNAME: 'streamtube',
  DB_PASSWORD: 'streamtube',
  DB_NAME: 'streamtube',
  JWT_SECRET: 'secret',
  JWT_REFRESH_SECRET: 'refresh-secret',
  S3_ENDPOINT: 'http://minio:9000',
  S3_ACCESS_KEY: 'streamtube',
  S3_SECRET_KEY: 'streamtube',
};

describe('envValidationSchema (Phase 03 storage/queue/upload)', () => {
  it('passes with all required vars and applies the documented defaults', () => {
    const { error, value } = envValidationSchema.validate(baseEnv, {
      allowUnknown: true,
      abortEarly: false,
    });

    expect(error).toBeUndefined();
    expect(value.S3_REGION).toBe('us-east-1');
    expect(value.S3_BUCKET).toBe('streamtube-videos');
    expect(value.S3_FORCE_PATH_STYLE).toBe('true');
    expect(value.REDIS_HOST).toBe('redis');
    expect(value.REDIS_PORT).toBe(6379);
    expect(value.UPLOAD_PART_SIZE_BYTES).toBe(67108864);
    expect(value.UPLOAD_MAX_SIZE_BYTES).toBe(10737418240);
    expect(value.UPLOAD_URL_EXPIRES_SECONDS).toBe(900);
  });

  it('fails when S3_ACCESS_KEY is missing', () => {
    const { S3_ACCESS_KEY: _omitted, ...env } = baseEnv;
    const { error } = envValidationSchema.validate(env, { abortEarly: false });

    expect(error).toBeDefined();
    expect(error?.message).toContain('S3_ACCESS_KEY');
  });

  it('fails when S3_ENDPOINT is missing', () => {
    const { S3_ENDPOINT: _omitted, ...env } = baseEnv;
    const { error } = envValidationSchema.validate(env, { abortEarly: false });

    expect(error).toBeDefined();
    expect(error?.message).toContain('S3_ENDPOINT');
  });

  it('rejects a non-URI S3_ENDPOINT', () => {
    const { error } = envValidationSchema.validate(
      { ...baseEnv, S3_ENDPOINT: 'not-a-url' },
      { abortEarly: false },
    );

    expect(error).toBeDefined();
    expect(error?.message).toContain('S3_ENDPOINT');
  });
});
