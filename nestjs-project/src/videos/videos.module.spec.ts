import { Test } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BullModule } from '@nestjs/bullmq';
import appConfig from '../config/app.config';
import storageConfig from '../config/storage.config';
import uploadConfig from '../config/upload.config';
import queueConfig from '../config/queue.config';
import { User } from '../users/entities/user.entity';
import { Channel } from '../channels/entities/channel.entity';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { createTestDataSource } from '../test/create-test-data-source';
import { VideosModule } from './videos.module';
import { Video } from './entities/video.entity';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

describe('VideosModule', () => {
  it('compiles with TypeOrm forFeature, BullMQ queue, StorageModule and ChannelsModule', async () => {
    const module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [appConfig, storageConfig, uploadConfig, queueConfig],
        }),
        TypeOrmModule.forRoot(createTestDataSource(ALL_ENTITIES).options),
        BullModule.forRoot({
          connection: {
            host: process.env.REDIS_HOST ?? 'redis',
            port: Number(process.env.REDIS_PORT ?? 6379),
          },
        }),
        VideosModule,
      ],
    }).compile();

    expect(module).toBeDefined();
    await module.close();
  }, 30000);
});
