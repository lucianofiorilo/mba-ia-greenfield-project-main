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
});
