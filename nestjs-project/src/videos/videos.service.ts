import { Inject, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { InjectQueue } from '@nestjs/bullmq';
import type { Repository } from 'typeorm';
import type { Queue } from 'bullmq';
import type { ConfigType } from '@nestjs/config';
import { Video } from './entities/video.entity';
import { StorageService } from '../storage/storage.service';
import { ChannelsService } from '../channels/channels.service';
import { VIDEO_PROCESSING_QUEUE } from './videos.constants';
import uploadConfig from '../config/upload.config';
import appConfig from '../config/app.config';

@Injectable()
export class VideosService {
  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly storageService: StorageService,
    private readonly channelsService: ChannelsService,
    @InjectQueue(VIDEO_PROCESSING_QUEUE)
    private readonly queue: Queue,
    @Inject(uploadConfig.KEY)
    private readonly upload: ConfigType<typeof uploadConfig>,
    @Inject(appConfig.KEY)
    private readonly app: ConfigType<typeof appConfig>,
  ) {}
}
