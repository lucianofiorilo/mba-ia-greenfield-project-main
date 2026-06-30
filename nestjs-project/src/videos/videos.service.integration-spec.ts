import { randomUUID } from 'node:crypto';
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule, getRepositoryToken } from '@nestjs/typeorm';
import { getQueueToken } from '@nestjs/bullmq';
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
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';

const ENTITIES = [User, Channel, Video, RefreshToken, VerificationToken];

describe('VideosService (integration)', () => {
  let service: VideosService;
  let dataSource: DataSource;
  let videoRepository: Repository<Video>;
  let userId: string;
  let channelId: string;

  beforeAll(async () => {
    const ds = createTestDataSource(ENTITIES);
    const module: TestingModule = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [storageConfig, uploadConfig, appConfig],
        }),
        TypeOrmModule.forRoot(ds.options),
        TypeOrmModule.forFeature([Video]),
        StorageModule,
        ChannelsModule,
      ],
      providers: [
        VideosService,
        // The queue is not exercised by initiateUpload — stub the token so DI
        // resolves without a live Redis connection.
        { provide: getQueueToken(VIDEO_PROCESSING_QUEUE), useValue: {} },
      ],
    }).compile();
    await module.init();

    service = module.get(VideosService);
    dataSource = module.get(DataSource);
    videoRepository = module.get(getRepositoryToken(Video));
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);

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
});
