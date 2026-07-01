import { Module } from '@nestjs/common';
import { ConfigModule, ConfigType } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BullModule } from '@nestjs/bullmq';
import { Video } from '../videos/entities/video.entity';
import { Channel } from '../channels/entities/channel.entity';
import { User } from '../users/entities/user.entity';
import { StorageModule } from '../storage/storage.module';
import databaseConfig from '../config/database.config';
import queueConfig from '../config/queue.config';
import storageConfig from '../config/storage.config';
import uploadConfig from '../config/upload.config';
import { envValidationSchema } from '../config/env.validation';
import { VIDEO_PROCESSING_QUEUE } from '../videos/videos.constants';

// Standalone composition root for the video worker (TD-05): same codebase as the
// API, but boots only the infrastructure the BullMQ processor needs — no HTTP
// stack, controllers, auth or mail. The @Processor lands here in SI-03.9, so the
// API process never instantiates it and stays a pure producer.
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [databaseConfig, queueConfig, storageConfig, uploadConfig],
      validationSchema: envValidationSchema,
      validationOptions: { allowUnknown: true, abortEarly: false },
    }),
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [databaseConfig.KEY],
      useFactory: (dbConfig: ConfigType<typeof databaseConfig>) => ({
        type: 'postgres',
        host: dbConfig.host,
        port: dbConfig.port,
        username: dbConfig.username,
        password: dbConfig.password,
        database: dbConfig.name,
        autoLoadEntities: true,
        synchronize: false,
      }),
    }),
    BullModule.forRootAsync({
      inject: [queueConfig.KEY],
      useFactory: (cfg: ConfigType<typeof queueConfig>) => ({
        connection: { host: cfg.redisHost, port: cfg.redisPort },
      }),
    }),
    // Video alone is insufficient: its @ManyToOne(Channel) — and Channel's
    // OneToOne(User) — pull Channel and User into the metadata graph. They are
    // registered for relation metadata only; the worker uses just the Video repo.
    TypeOrmModule.forFeature([Video, Channel, User]),
    BullModule.registerQueue({ name: VIDEO_PROCESSING_QUEUE }),
    StorageModule,
  ],
})
export class WorkerModule {}
