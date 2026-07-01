import { randomUUID } from 'node:crypto';
import { DataSource, Repository } from 'typeorm';
import { RefreshToken } from '../../auth/entities/refresh-token.entity';
import { VerificationToken } from '../../auth/entities/verification-token.entity';
import { User } from '../../users/entities/user.entity';
import { Channel } from '../../channels/entities/channel.entity';
import {
  cleanAllTables,
  createTestDataSource,
} from '../../test/create-test-data-source';
import { Video, VideoStatus } from './video.entity';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

describe('Video entity (integration)', () => {
  let dataSource: DataSource;
  let videoRepository: Repository<Video>;
  let channelRepository: Repository<Channel>;
  let userRepository: Repository<User>;

  beforeAll(async () => {
    dataSource = createTestDataSource(ALL_ENTITIES);
    await dataSource.initialize();
    videoRepository = dataSource.getRepository(Video);
    channelRepository = dataSource.getRepository(Channel);
    userRepository = dataSource.getRepository(User);
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  beforeEach(async () => {
    // Delete in FK-dependency order (incl. token tables other suites may leave),
    // otherwise a lingering verification_tokens row blocks DELETE FROM users.
    await cleanAllTables(dataSource);
  });

  async function createChannel(): Promise<Channel> {
    const user = await userRepository.save(
      userRepository.create({
        email: `${randomUUID()}@example.com`,
        password: 'hashed',
      }),
    );
    return channelRepository.save(
      channelRepository.create({
        name: 'Test',
        nickname: `chan_${randomUUID().slice(0, 8)}`,
        user_id: user.id,
      }),
    );
  }

  function buildVideo(
    channelId: string,
    overrides: Partial<Video> = {},
  ): Video {
    return videoRepository.create({
      public_id: randomUUID().slice(0, 11),
      channel_id: channelId,
      title: 'My Video',
      storage_key: `videos/${randomUUID()}/original/v.mp4`,
      ...overrides,
    });
  }

  it('defaults status to draft and auto-populates timestamps', async () => {
    const channel = await createChannel();
    const saved = await videoRepository.save(buildVideo(channel.id));

    expect(saved.id).toBeDefined();
    expect(saved.status).toBe(VideoStatus.DRAFT);
    expect(saved.created_at).toBeInstanceOf(Date);
    expect(saved.updated_at).toBeInstanceOf(Date);
  });

  it('enforces the unique public_id constraint', async () => {
    const channel = await createChannel();
    const publicId = 'dup12345678';
    await videoRepository.save(buildVideo(channel.id, { public_id: publicId }));

    await expect(
      videoRepository.save(buildVideo(channel.id, { public_id: publicId })),
    ).rejects.toThrow();
  });

  it('enforces the foreign key to channels', async () => {
    await expect(
      videoRepository.save(buildVideo(randomUUID())),
    ).rejects.toThrow();
  });

  it('round-trips jsonb metadata', async () => {
    const channel = await createChannel();
    const saved = await videoRepository.save(
      buildVideo(channel.id, {
        metadata: { width: 1920, height: 1080, codec: 'h264' },
        duration_seconds: 12.5,
        status: VideoStatus.READY,
      }),
    );

    const found = await videoRepository.findOneByOrFail({ id: saved.id });
    expect(found.metadata).toEqual({
      width: 1920,
      height: 1080,
      codec: 'h264',
    });
    expect(found.duration_seconds).toBe(12.5);
    expect(found.status).toBe(VideoStatus.READY);
  });
});
