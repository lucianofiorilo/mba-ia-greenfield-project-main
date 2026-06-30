import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { InjectQueue } from '@nestjs/bullmq';
import { QueryFailedError, type Repository } from 'typeorm';
import type { Queue } from 'bullmq';
import type { ConfigType } from '@nestjs/config';
import { nanoid } from 'nanoid';
import { Video, VideoStatus } from './entities/video.entity';
import {
  StorageService,
  buildVideoKeys,
  type PresignedPart,
} from '../storage/storage.service';
import { ChannelsService } from '../channels/channels.service';
import { ChannelNotFoundException } from '../channels/exceptions/channel.exceptions';
import {
  FileTooLargeException,
  UnsupportedMediaTypeException,
} from './exceptions/video.exceptions';
import {
  MAX_PUBLIC_ID_RETRIES,
  PG_UNIQUE_VIOLATION,
  PUBLIC_ID_LENGTH,
  VIDEO_MIME_PREFIX,
  VIDEO_PROCESSING_QUEUE,
} from './videos.constants';
import type { InitiateUploadDto } from './dto/initiate-upload.dto';
import uploadConfig from '../config/upload.config';
import appConfig from '../config/app.config';

export interface InitiateUploadResult {
  publicId: string;
  uploadId: string;
  key: string;
  partSize: number;
  parts: PresignedPart[];
}

function isUniqueViolation(err: unknown): boolean {
  return (
    err instanceof QueryFailedError &&
    (err.driverError as { code?: string }).code === PG_UNIQUE_VIOLATION
  );
}

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

  /**
   * Pre-register a video as a `draft`, open a multipart upload, and hand back
   * one presigned PUT URL per part. The file is uploaded by the client
   * directly to storage — it never flows through the API process.
   */
  async initiateUpload(
    userId: string,
    dto: InitiateUploadDto,
  ): Promise<InitiateUploadResult> {
    const channel = await this.channelsService.findByUserId(userId);
    if (!channel) {
      throw new ChannelNotFoundException();
    }
    if (!dto.mimeType.startsWith(VIDEO_MIME_PREFIX)) {
      throw new UnsupportedMediaTypeException();
    }
    if (dto.sizeBytes > this.upload.maxSizeBytes) {
      throw new FileTooLargeException();
    }

    // The storage key is derived from an app-generated UUID, never from user
    // input, so it is stable across the public_id collision retry below.
    const videoId = randomUUID();
    const { originalKey } = buildVideoKeys(videoId, dto.filename);
    const uploadId = await this.storageService.createMultipartUpload(
      originalKey,
      dto.mimeType,
    );

    const partSize = this.upload.partSizeBytes;
    const partCount = Math.ceil(dto.sizeBytes / partSize);
    const partNumbers = Array.from({ length: partCount }, (_, i) => i + 1);

    const publicId = await this.persistDraft(
      videoId,
      channel.id,
      originalKey,
      uploadId,
      dto,
    );
    const parts = await this.storageService.presignUploadParts(
      originalKey,
      uploadId,
      partNumbers,
    );

    return { publicId, uploadId, key: originalKey, partSize, parts };
  }

  /**
   * Insert the draft row, regenerating `public_id` on the (astronomically
   * rare) unique-violation collision — same pattern channels use for nickname.
   */
  private async persistDraft(
    videoId: string,
    channelId: string,
    storageKey: string,
    uploadId: string,
    dto: InitiateUploadDto,
  ): Promise<string> {
    for (let attempt = 0; attempt <= MAX_PUBLIC_ID_RETRIES; attempt++) {
      const publicId = nanoid(PUBLIC_ID_LENGTH);
      try {
        await this.videoRepository.insert({
          id: videoId,
          public_id: publicId,
          channel_id: channelId,
          title: dto.title,
          status: VideoStatus.DRAFT,
          storage_key: storageKey,
          upload_id: uploadId,
          size_bytes: String(dto.sizeBytes),
          original_filename: dto.filename,
          mime_type: dto.mimeType,
        });
        return publicId;
      } catch (err) {
        if (isUniqueViolation(err) && attempt < MAX_PUBLIC_ID_RETRIES) {
          continue;
        }
        throw err;
      }
    }
    // Unreachable: the loop either returns a publicId or rethrows.
    throw new Error('Could not generate a unique public_id');
  }
}
