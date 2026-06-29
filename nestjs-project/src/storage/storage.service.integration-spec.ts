import { randomUUID } from 'node:crypto';
import { Test, type TestingModule } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { StorageService, buildVideoKeys } from './storage.service';
import storageConfig from '../config/storage.config';
import uploadConfig from '../config/upload.config';

describe('StorageService (integration, real MinIO)', () => {
  let moduleRef: TestingModule;
  let service: StorageService;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [storageConfig, uploadConfig],
        }),
      ],
      providers: [StorageService],
    }).compile();
    await moduleRef.init(); // triggers onModuleInit -> ensureBucket
    service = moduleRef.get(StorageService);
  });

  afterAll(async () => {
    await moduleRef.close();
  });

  it('round-trips putObject + headObject', async () => {
    const key = `test/${randomUUID()}.txt`;
    const body = Buffer.from('hello storage');

    await service.putObject(key, body, 'text/plain');
    const head = await service.headObject(key);

    expect(head.contentLength).toBe(body.length);
    await service.deleteObjects(key);
  });

  it('completes a multipart upload via presigned part URLs and reads a byte range', async () => {
    const id = randomUUID();
    const { originalKey } = buildVideoKeys(id, 'sample.bin');

    const uploadId = await service.createMultipartUpload(
      originalKey,
      'application/octet-stream',
    );
    const [part] = await service.presignUploadParts(originalKey, uploadId, [1]);
    expect(part.url).toContain('minio:9000');

    const body = Buffer.from('0123456789');
    const put = await fetch(part.url, { method: 'PUT', body });
    expect(put.ok).toBe(true);
    const etag = put.headers.get('etag');
    expect(etag).toBeTruthy();

    await service.completeMultipartUpload(originalKey, uploadId, [
      { partNumber: 1, etag: etag as string },
    ]);

    const ranged = await service.getObjectRange(originalKey, 'bytes=0-3');
    const chunks: Buffer[] = [];
    for await (const c of ranged.body) {
      chunks.push(c as Buffer);
    }
    expect(Buffer.concat(chunks).toString()).toBe('0123');
    expect(ranged.contentRange).toContain('bytes 0-3/10');

    await service.deleteObjects(`videos/${id}/`);
  });

  it('aborts an initiated multipart upload (object is never retrievable)', async () => {
    const id = randomUUID();
    const { originalKey } = buildVideoKeys(id, 'aborted.bin');

    const uploadId = await service.createMultipartUpload(
      originalKey,
      'application/octet-stream',
    );
    await service.abortMultipartUpload(originalKey, uploadId);

    await expect(service.headObject(originalKey)).rejects.toBeDefined();
  });
});
