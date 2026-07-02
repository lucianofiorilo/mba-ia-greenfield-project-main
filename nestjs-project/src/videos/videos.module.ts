import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BullModule } from '@nestjs/bullmq';
import { Video } from './entities/video.entity';
import { VideosService } from './videos.service';
import { VideosController } from './videos.controller';
import { StorageModule } from '../storage/storage.module';
import { ChannelsModule } from '../channels/channels.module';
import { VIDEO_PROCESSING_QUEUE } from './videos.constants';

@Module({
  imports: [
    TypeOrmModule.forFeature([Video]),
    BullModule.registerQueue({ name: VIDEO_PROCESSING_QUEUE }),
    StorageModule,
    ChannelsModule,
  ],
  controllers: [VideosController],
  providers: [VideosService],
  exports: [VideosService],
})
export class VideosModule {}
