import { randomUUID } from 'node:crypto';
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigModule, ConfigType } from '@nestjs/config';
import { TypeOrmModule, getRepositoryToken } from '@nestjs/typeorm';
import { BullModule, getQueueToken } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { DataSource, Repository } from 'typeorm';
import { VideosService } from './videos.service';
import { Video, VideoStatus } from './entities/video.entity';
import { StorageModule } from '../storage/storage.module';
import { ChannelsModule } from '../channels/channels.module';
import { Channel } from '../channels/entities/channel.entity';
import { User } from '../users/entities/user.entity';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { VIDEO_PROCESSING_QUEUE } from './videos.constants';
import storageConfig from '../config/storage.config';
import uploadConfig from '../config/upload.config';
import appConfig from '../config/app.config';
import queueConfig from '../config/queue.config';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';

const ENTITIES = [User, Channel, Video, RefreshToken, VerificationToken];

describe('VideosService (integration)', () => {
  let moduleRef: TestingModule;
  let service: VideosService;
  let dataSource: DataSource;
  let videoRepository: Repository<Video>;
  let queue: Queue;
  let userId: string;
  let channelId: string;

  beforeAll(async () => {
    const ds = createTestDataSource(ENTITIES);
    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [storageConfig, uploadConfig, appConfig, queueConfig],
        }),
        TypeOrmModule.forRoot(ds.options),
        TypeOrmModule.forFeature([Video]),
        // Real Redis-backed queue — BullMQ is a configured lib, not mocked.
        BullModule.forRootAsync({
          inject: [queueConfig.KEY],
          useFactory: (cfg: ConfigType<typeof queueConfig>) => ({
            connection: { host: cfg.redisHost, port: cfg.redisPort },
          }),
        }),
        BullModule.registerQueue({ name: VIDEO_PROCESSING_QUEUE }),
        StorageModule,
        ChannelsModule,
      ],
      providers: [VideosService],
    }).compile();
    await moduleRef.init();

    service = moduleRef.get(VideosService);
    dataSource = moduleRef.get(DataSource);
    videoRepository = moduleRef.get(getRepositoryToken(Video));
    queue = moduleRef.get(getQueueToken(VIDEO_PROCESSING_QUEUE));
  });

  afterAll(async () => {
    await moduleRef.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    await queue.obliterate({ force: true });

    const user = await dataSource.getRepository(User).save(
      dataSource.getRepository(User).create({
        email: `uploader-${randomUUID()}@example.com`,
        password: 'hashed',
      }),
    );
    userId = user.id;
    const channel = await dataSource.getRepository(Channel).save(
      dataSource.getRepository(Channel).create({
        name: 'Test Channel',
        nickname: `chan-${randomUUID().slice(0, 8)}`,
        user_id: userId,
      }),
    );
    channelId = channel.id;
  });

  it('persists a draft row with a real upload_id from MinIO', async () => {
    const result = await service.initiateUpload(userId, {
      title: 'Integration clip',
      filename: 'clip.mp4',
      mimeType: 'video/mp4',
      sizeBytes: 5_000_000,
    });

    expect(result.uploadId).toEqual(expect.any(String));
    expect(result.uploadId.length).toBeGreaterThan(0);
    expect(result.publicId).toHaveLength(11);
    expect(result.parts.length).toBeGreaterThan(0);

    const persisted = await videoRepository.findOne({
      where: { public_id: result.publicId },
    });
    expect(persisted).not.toBeNull();
    expect(persisted?.channel_id).toBe(channelId);
    expect(persisted?.status).toBe(VideoStatus.DRAFT);
    expect(persisted?.upload_id).toBe(result.uploadId);
    expect(persisted?.storage_key).toBe(result.key);
    expect(persisted?.mime_type).toBe('video/mp4');
  });

  it('generates a distinct public_id per initiation', async () => {
    const dto = {
      title: 'Clip',
      filename: 'clip.mp4',
      mimeType: 'video/mp4',
      sizeBytes: 1_000_000,
    };
    const first = await service.initiateUpload(userId, dto);
    const second = await service.initiateUpload(userId, dto);

    expect(first.publicId).not.toBe(second.publicId);
  });

  // Initiate, upload the single part to MinIO, and return the part ETag.
  async function initiateAndUploadOnePart(
    body = 'hello world',
  ): Promise<{ publicId: string; etag: string }> {
    const init = await service.initiateUpload(userId, {
      title: 'Completable clip',
      filename: 'clip.mp4',
      mimeType: 'video/mp4',
      sizeBytes: body.length,
    });
    const put = await fetch(init.parts[0].url, { method: 'PUT', body });
    expect(put.ok).toBe(true);
    const etag = put.headers.get('etag');
    expect(etag).toBeTruthy();
    return { publicId: init.publicId, etag: etag as string };
  }

  it('completes the upload, transitions to processing, and enqueues a job', async () => {
    const { publicId, etag } = await initiateAndUploadOnePart();

    const result = await service.completeUpload(userId, publicId, {
      parts: [{ partNumber: 1, etag }],
    });

    expect(result).toEqual({ publicId, status: VideoStatus.PROCESSING });

    const persisted = await videoRepository.findOne({
      where: { public_id: publicId },
    });
    expect(persisted?.status).toBe(VideoStatus.PROCESSING);

    const jobs = await queue.getJobs([
      'waiting',
      'delayed',
      'active',
      'prioritized',
    ]);
    const job = jobs.find((j) => j.data?.videoId === persisted?.id);
    expect(job).toBeDefined();
    expect(job?.data).toEqual({ videoId: persisted?.id });
  });

  it('aborts the upload and deletes the draft row', async () => {
    const init = await service.initiateUpload(userId, {
      title: 'Abortable clip',
      filename: 'clip.mp4',
      mimeType: 'video/mp4',
      sizeBytes: 1_000,
    });

    await service.abortUpload(userId, init.publicId);

    const persisted = await videoRepository.findOne({
      where: { public_id: init.publicId },
    });
    expect(persisted).toBeNull();
  });
});
