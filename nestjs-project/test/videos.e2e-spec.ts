import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import { AppModule } from '../src/app.module';
import { AuthService } from '../src/auth/auth.service';
import { DomainExceptionFilter } from '../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../src/common/filters/validation-exception.filter';
import { cleanAllTables } from '../src/test/create-test-data-source';

const VALID_BODY = {
  title: 'My first upload',
  filename: 'clip.mp4',
  mimeType: 'video/mp4',
  sizeBytes: 5_000_000,
};

describe('Videos (e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let throttlerStorage: ThrottlerStorageService;

  beforeAll(async () => {
    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.useGlobalFilters(
      new DomainExceptionFilter(),
      new ValidationExceptionFilter(),
    );
    await app.init();

    dataSource = moduleFixture.get(DataSource);
    throttlerStorage =
      moduleFixture.get<ThrottlerStorageService>(ThrottlerStorage);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    throttlerStorage.storage.clear();
  });

  async function registerConfirmAndLogin(
    email: string,
    password = 'password123',
  ): Promise<string> {
    const authService = app.get(AuthService);
    const mailServiceInstance = (authService as any).mailService;
    let token = '';
    jest
      .spyOn(mailServiceInstance, 'sendConfirmationEmail')
      .mockImplementationOnce(async (_e: string, _n: string, t: string) => {
        token = t;
      });
    await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email, password });
    await request(app.getHttpServer())
      .get('/auth/confirm-email')
      .query({ token });
    const res = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password });
    return res.body.access_token;
  }

  describe('POST /videos', () => {
    it('returns 201 with the upload contract for an authenticated user', async () => {
      const accessToken = await registerConfirmAndLogin('uploader@example.com');

      const res = await request(app.getHttpServer())
        .post('/videos')
        .set('Authorization', `Bearer ${accessToken}`)
        .send(VALID_BODY)
        .expect(201);

      expect(res.body.publicId).toEqual(expect.any(String));
      expect(res.body.uploadId).toEqual(expect.any(String));
      expect(res.body.key).toEqual(expect.any(String));
      expect(res.body.partSize).toEqual(expect.any(Number));
      expect(Array.isArray(res.body.parts)).toBe(true);
      expect(res.body.parts.length).toBeGreaterThan(0);
      expect(res.body.parts[0]).toEqual({
        partNumber: 1,
        url: expect.any(String),
      });
    });

    it('returns 401 without an access token', async () => {
      await request(app.getHttpServer())
        .post('/videos')
        .send(VALID_BODY)
        .expect(401);
    });

    it('returns 400 with VALIDATION_ERROR on an invalid body', async () => {
      const accessToken = await registerConfirmAndLogin('badbody@example.com');

      const res = await request(app.getHttpServer())
        .post('/videos')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ title: 'no rest of fields' })
        .expect(400);

      expect(res.body.error).toBe('VALIDATION_ERROR');
    });

    it('returns 415 UNSUPPORTED_MEDIA_TYPE for a non-video mime type', async () => {
      const accessToken = await registerConfirmAndLogin('image@example.com');

      const res = await request(app.getHttpServer())
        .post('/videos')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ ...VALID_BODY, mimeType: 'image/png' })
        .expect(415);

      expect(res.body.error).toBe('UNSUPPORTED_MEDIA_TYPE');
    });

    it('returns 413 FILE_TOO_LARGE for a file above the size ceiling', async () => {
      const accessToken = await registerConfirmAndLogin('toobig@example.com');

      const res = await request(app.getHttpServer())
        .post('/videos')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ ...VALID_BODY, sizeBytes: 10_737_418_241 })
        .expect(413);

      expect(res.body.error).toBe('FILE_TOO_LARGE');
    });
  });

  // Initiate an upload over HTTP, then PUT the single part directly to MinIO
  // (presigned URL) and return its ETag — mirrors the real client flow.
  async function initiateAndUpload(
    accessToken: string,
    body = 'hello world',
  ): Promise<{
    publicId: string;
    parts: { partNumber: number; etag: string }[];
  }> {
    const init = await request(app.getHttpServer())
      .post('/videos')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ ...VALID_BODY, sizeBytes: body.length })
      .expect(201);
    const put = await fetch(init.body.parts[0].url, { method: 'PUT', body });
    expect(put.ok).toBe(true);
    const etag = put.headers.get('etag');
    expect(etag).toBeTruthy();
    return {
      publicId: init.body.publicId,
      parts: [{ partNumber: 1, etag: etag as string }],
    };
  }

  describe('POST /videos/:publicId/complete', () => {
    it('returns 200 { status: processing } for the owner with valid parts', async () => {
      const token = await registerConfirmAndLogin('complete-ok@example.com');
      const { publicId, parts } = await initiateAndUpload(token);

      const res = await request(app.getHttpServer())
        .post(`/videos/${publicId}/complete`)
        .set('Authorization', `Bearer ${token}`)
        .send({ parts })
        .expect(200);

      expect(res.body).toEqual({ publicId, status: 'processing' });
    });

    it('returns 403 VIDEO_ACCESS_DENIED for a non-owner', async () => {
      const owner = await registerConfirmAndLogin('complete-owner@example.com');
      const { publicId, parts } = await initiateAndUpload(owner);
      const intruder = await registerConfirmAndLogin('complete-x@example.com');

      const res = await request(app.getHttpServer())
        .post(`/videos/${publicId}/complete`)
        .set('Authorization', `Bearer ${intruder}`)
        .send({ parts })
        .expect(403);

      expect(res.body.error).toBe('VIDEO_ACCESS_DENIED');
    });

    it('returns 409 INVALID_VIDEO_STATE when the video is no longer a draft', async () => {
      const token = await registerConfirmAndLogin('complete-twice@example.com');
      const { publicId, parts } = await initiateAndUpload(token);

      await request(app.getHttpServer())
        .post(`/videos/${publicId}/complete`)
        .set('Authorization', `Bearer ${token}`)
        .send({ parts })
        .expect(200);

      const res = await request(app.getHttpServer())
        .post(`/videos/${publicId}/complete`)
        .set('Authorization', `Bearer ${token}`)
        .send({ parts })
        .expect(409);

      expect(res.body.error).toBe('INVALID_VIDEO_STATE');
    });

    it('returns 404 VIDEO_NOT_FOUND for an unknown publicId', async () => {
      const token = await registerConfirmAndLogin('complete-404@example.com');

      const res = await request(app.getHttpServer())
        .post('/videos/doesnotexist/complete')
        .set('Authorization', `Bearer ${token}`)
        .send({ parts: [{ partNumber: 1, etag: 'x' }] })
        .expect(404);

      expect(res.body.error).toBe('VIDEO_NOT_FOUND');
    });

    it('returns 401 without an access token', async () => {
      await request(app.getHttpServer())
        .post('/videos/whatever/complete')
        .send({ parts: [{ partNumber: 1, etag: 'x' }] })
        .expect(401);
    });
  });

  describe('POST /videos/:publicId/abort', () => {
    it('returns 204 and removes the draft for the owner', async () => {
      const token = await registerConfirmAndLogin('abort-ok@example.com');
      const init = await request(app.getHttpServer())
        .post('/videos')
        .set('Authorization', `Bearer ${token}`)
        .send(VALID_BODY)
        .expect(201);

      await request(app.getHttpServer())
        .post(`/videos/${init.body.publicId}/abort`)
        .set('Authorization', `Bearer ${token}`)
        .expect(204);

      // Draft is gone — a follow-up operation can no longer find it.
      const res = await request(app.getHttpServer())
        .post(`/videos/${init.body.publicId}/complete`)
        .set('Authorization', `Bearer ${token}`)
        .send({ parts: [{ partNumber: 1, etag: 'x' }] })
        .expect(404);

      expect(res.body.error).toBe('VIDEO_NOT_FOUND');
    });

    it('returns 403 VIDEO_ACCESS_DENIED for a non-owner', async () => {
      const owner = await registerConfirmAndLogin('abort-owner@example.com');
      const init = await request(app.getHttpServer())
        .post('/videos')
        .set('Authorization', `Bearer ${owner}`)
        .send(VALID_BODY)
        .expect(201);
      const intruder = await registerConfirmAndLogin('abort-x@example.com');

      const res = await request(app.getHttpServer())
        .post(`/videos/${init.body.publicId}/abort`)
        .set('Authorization', `Bearer ${intruder}`)
        .expect(403);

      expect(res.body.error).toBe('VIDEO_ACCESS_DENIED');
    });
  });

  describe('GET /videos/:publicId', () => {
    it('returns 200 with the public metadata for an existing video (anonymous)', async () => {
      const token = await registerConfirmAndLogin('meta-ok@example.com');
      const init = await request(app.getHttpServer())
        .post('/videos')
        .set('Authorization', `Bearer ${token}`)
        .send(VALID_BODY)
        .expect(201);
      const { publicId } = init.body;

      // No Authorization header — the endpoint is public.
      const res = await request(app.getHttpServer())
        .get(`/videos/${publicId}`)
        .expect(200);

      expect(res.body).toEqual({
        publicId,
        title: VALID_BODY.title,
        status: 'draft',
        durationSeconds: null,
        metadata: null,
        thumbnailUrl: null,
        streamUrl: expect.stringContaining(`/videos/${publicId}/stream`),
        channelId: expect.any(String),
        createdAt: expect.any(String),
      });
    });

    it('returns 404 VIDEO_NOT_FOUND for an unknown publicId', async () => {
      const res = await request(app.getHttpServer())
        .get('/videos/doesnotexist')
        .expect(404);

      expect(res.body.error).toBe('VIDEO_NOT_FOUND');
    });
  });
});
