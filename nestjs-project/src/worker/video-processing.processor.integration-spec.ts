import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule, getRepositoryToken } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import type { Job } from 'bullmq';
import ffmpeg from 'fluent-ffmpeg';
import {
  VideoProcessingProcessor,
  type VideoProcessingJobData,
} from './video-processing.processor';
import { Video, VideoStatus } from '../videos/entities/video.entity';
import { Channel } from '../channels/entities/channel.entity';
import { User } from '../users/entities/user.entity';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import {
  StorageService,
  buildThumbnailKey,
  buildVideoKeys,
} from '../storage/storage.service';
import { StorageModule } from '../storage/storage.module';
import storageConfig from '../config/storage.config';
import uploadConfig from '../config/upload.config';
import appConfig from '../config/app.config';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';

const ENTITIES = [User, Channel, Video, RefreshToken, VerificationToken];

// A tiny, real, well-formed MP4 produced by FFmpeg's synthetic `testsrc`.
async function generateSampleVideo(): Promise<Buffer> {
  const dir = await mkdtemp(join(tmpdir(), 'sample-src-'));
  const path = join(dir, 'sample.mp4');
  try {
    await new Promise<void>((resolve, reject) => {
      ffmpeg()
        .input('testsrc=duration=1:size=320x240:rate=15')
        .inputFormat('lavfi')
        .outputOptions('-pix_fmt', 'yuv420p')
        .save(path)
        .on('end', () => resolve())
        .on('error', (err) => reject(err));
    });
    return await readFile(path);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function jobFor(videoId: string): Job<VideoProcessingJobData> {
  return { id: 'job-1', data: { videoId } } as Job<VideoProcessingJobData>;
}

describe('VideoProcessingProcessor (integration)', () => {
  let moduleRef: TestingModule;
  let processor: VideoProcessingProcessor;
  let storageService: StorageService;
  let dataSource: DataSource;
  let videoRepository: Repository<Video>;
  let channelId: string;
  let sampleVideo: Buffer;

  beforeAll(async () => {
    sampleVideo = await generateSampleVideo();

    const ds = createTestDataSource(ENTITIES);
    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [storageConfig, uploadConfig, appConfig],
        }),
        TypeOrmModule.forRoot(ds.options),
        TypeOrmModule.forFeature([Video]),
        StorageModule,
      ],
      // The processor is exercised directly (no BullMQ worker started), so
      // enqueued jobs never race the live compose worker on the shared Redis.
      providers: [VideoProcessingProcessor],
    }).compile();
    await moduleRef.init();

    processor = moduleRef.get(VideoProcessingProcessor);
    storageService = moduleRef.get(StorageService);
    dataSource = moduleRef.get(DataSource);
    videoRepository = moduleRef.get(getRepositoryToken(Video));
  }, 60000);

  afterAll(async () => {
    await moduleRef.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    const user = await dataSource.getRepository(User).save(
      dataSource.getRepository(User).create({
        email: `uploader-${randomUUID()}@example.com`,
        password: 'hashed',
      }),
    );
    const channel = await dataSource.getRepository(Channel).save(
      dataSource.getRepository(Channel).create({
        name: 'Test Channel',
        nickname: `chan-${randomUUID().slice(0, 8)}`,
        user_id: user.id,
      }),
    );
    channelId = channel.id;
  });

  // Persist a processing draft whose stored object is `body`, and return its id.
  async function seedProcessingVideo(
    body: Buffer,
    filename = 'sample.mp4',
  ): Promise<string> {
    const video = await videoRepository.save(
      videoRepository.create({
        public_id: randomUUID().slice(0, 11),
        channel_id: channelId,
        title: 'Processing clip',
        status: VideoStatus.PROCESSING,
        storage_key: 'placeholder',
      }),
    );
    const { originalKey } = buildVideoKeys(video.id, filename);
    await videoRepository.update(
      { id: video.id },
      { storage_key: originalKey },
    );
    await storageService.putObject(originalKey, body, 'video/mp4');
    return video.id;
  }

  it('extracts metadata, writes a thumbnail, and flips status to ready', async () => {
    const videoId = await seedProcessingVideo(sampleVideo);

    await processor.process(jobFor(videoId));

    const video = await videoRepository.findOneByOrFail({ id: videoId });
    expect(video.status).toBe(VideoStatus.READY);
    expect(video.duration_seconds).toBeGreaterThan(0);
    expect(video.metadata?.width).toBe(320);
    expect(video.metadata?.height).toBe(240);
    expect(video.metadata?.codec).toBeTruthy();
    expect(video.error_reason).toBeNull();

    const thumbnailKey = buildThumbnailKey(videoId);
    expect(video.thumbnail_key).toBe(thumbnailKey);
    const head = await storageService.headObject(thumbnailKey);
    expect(head.contentLength).toBeGreaterThan(0);
  }, 60000);

  it('throws when the stored object is not a valid video', async () => {
    const videoId = await seedProcessingVideo(
      Buffer.from('this is definitely not a video'),
    );

    await expect(processor.process(jobFor(videoId))).rejects.toThrow();

    // A non-terminal failure leaves the row untouched for BullMQ to retry.
    const video = await videoRepository.findOneByOrFail({ id: videoId });
    expect(video.status).toBe(VideoStatus.PROCESSING);
  }, 60000);

  it('transitions to failed with a reason once retries are exhausted', async () => {
    const videoId = await seedProcessingVideo(
      Buffer.from('this is definitely not a video'),
    );
    const err = new Error('ffprobe failed: invalid data found');

    const terminalJob = {
      data: { videoId },
      attemptsMade: 3,
      opts: { attempts: 3 },
    } as Job<VideoProcessingJobData>;
    await processor.onFailed(terminalJob, err);

    const video = await videoRepository.findOneByOrFail({ id: videoId });
    expect(video.status).toBe(VideoStatus.FAILED);
    expect(video.error_reason).toContain('ffprobe failed');
  });

  it('does not fail the video while attempts remain', async () => {
    const videoId = await seedProcessingVideo(sampleVideo);

    const retryingJob = {
      data: { videoId },
      attemptsMade: 1,
      opts: { attempts: 3 },
    } as Job<VideoProcessingJobData>;
    await processor.onFailed(retryingJob, new Error('transient'));

    const video = await videoRepository.findOneByOrFail({ id: videoId });
    expect(video.status).toBe(VideoStatus.PROCESSING);
    expect(video.error_reason).toBeNull();
  });
});
