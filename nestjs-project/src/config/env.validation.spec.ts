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

type BaseEnvKey = keyof typeof baseEnv;

function envWithout(key: BaseEnvKey): Partial<typeof baseEnv> {
  const env: Partial<typeof baseEnv> = { ...baseEnv };
  delete env[key];
  return env;
}

describe('envValidationSchema (Phase 03 storage/queue/upload)', () => {
  it('passes with all required vars and applies the documented defaults', () => {
    const result = envValidationSchema.validate(baseEnv, {
      allowUnknown: true,
      abortEarly: false,
    });
    const config = result.value as Record<string, unknown>;

    expect(result.error).toBeUndefined();
    expect(config.S3_REGION).toBe('us-east-1');
    expect(config.S3_BUCKET).toBe('streamtube-videos');
    expect(config.S3_FORCE_PATH_STYLE).toBe('true');
    expect(config.REDIS_HOST).toBe('redis');
    expect(config.REDIS_PORT).toBe(6379);
    expect(config.UPLOAD_PART_SIZE_BYTES).toBe(67108864);
    expect(config.UPLOAD_MAX_SIZE_BYTES).toBe(10737418240);
    expect(config.UPLOAD_URL_EXPIRES_SECONDS).toBe(900);
  });

  it('fails when S3_ACCESS_KEY is missing', () => {
    const result = envValidationSchema.validate(envWithout('S3_ACCESS_KEY'), {
      abortEarly: false,
    });

    expect(result.error).toBeDefined();
    expect(result.error?.message).toContain('S3_ACCESS_KEY');
  });

  it('fails when S3_ENDPOINT is missing', () => {
    const result = envValidationSchema.validate(envWithout('S3_ENDPOINT'), {
      abortEarly: false,
    });

    expect(result.error).toBeDefined();
    expect(result.error?.message).toContain('S3_ENDPOINT');
  });

  it('rejects a non-URI S3_ENDPOINT', () => {
    const result = envValidationSchema.validate(
      { ...baseEnv, S3_ENDPOINT: 'not-a-url' },
      { abortEarly: false },
    );

    expect(result.error).toBeDefined();
    expect(result.error?.message).toContain('S3_ENDPOINT');
  });
});
