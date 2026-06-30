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
  InvalidUploadException,
  InvalidVideoStateException,
  UnsupportedMediaTypeException,
  VideoAccessDeniedException,
  VideoNotFoundException,
} from './exceptions/video.exceptions';
import {
  MAX_PUBLIC_ID_RETRIES,
  PG_UNIQUE_VIOLATION,
  PUBLIC_ID_LENGTH,
  VIDEO_JOB_OPTIONS,
  VIDEO_MIME_PREFIX,
  VIDEO_PROCESS_JOB,
  VIDEO_PROCESSING_QUEUE,
} from './videos.constants';
import type { InitiateUploadDto } from './dto/initiate-upload.dto';
import type { CompleteUploadDto } from './dto/complete-upload.dto';
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

// S3/MinIO client-side errors that mean the supplied parts are unusable —
// mapped to a 400 InvalidUploadException; anything else (network, 5xx) bubbles.
const INVALID_UPLOAD_ERROR_NAMES = new Set([
  'InvalidPart',
  'InvalidPartOrder',
  'EntityTooSmall',
  'NoSuchUpload',
  'MalformedXML',
]);

function isInvalidPartsError(err: unknown): boolean {
  const e = err as {
    name?: string;
    $metadata?: { httpStatusCode?: number };
  };
  if (typeof e?.name === 'string' && INVALID_UPLOAD_ERROR_NAMES.has(e.name)) {
    return true;
  }
  const status = e?.$metadata?.httpStatusCode;
  return typeof status === 'number' && status >= 400 && status < 500;
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

  /**
   * Finalize the multipart upload, flip the draft to `processing`, and enqueue
   * the processing job. Owner-only; the video must still be a `draft`.
   */
  async completeUpload(
    userId: string,
    publicId: string,
    dto: CompleteUploadDto,
  ): Promise<{ publicId: string; status: VideoStatus }> {
    const video = await this.loadOwnedDraft(userId, publicId);

    try {
      await this.storageService.completeMultipartUpload(
        video.storage_key,
        video.upload_id as string,
        dto.parts,
      );
    } catch (err) {
      if (isInvalidPartsError(err)) {
        throw new InvalidUploadException();
      }
      throw err;
    }

    video.status = VideoStatus.PROCESSING;
    await this.videoRepository.save(video);
    await this.queue.add(
      VIDEO_PROCESS_JOB,
      { videoId: video.id },
      VIDEO_JOB_OPTIONS,
    );

    return { publicId: video.public_id, status: video.status };
  }

  /**
   * Abort the multipart upload and delete the draft row. Owner-only; the video
   * must still be a `draft`.
   */
  async abortUpload(userId: string, publicId: string): Promise<void> {
    const video = await this.loadOwnedDraft(userId, publicId);

    if (video.upload_id) {
      await this.storageService.abortMultipartUpload(
        video.storage_key,
        video.upload_id,
      );
    }
    await this.videoRepository.delete({ id: video.id });
  }

  /**
   * Load a video by `public_id` and assert the caller owns it and it is still
   * a draft — the shared precondition for both completion and abort.
   */
  private async loadOwnedDraft(
    userId: string,
    publicId: string,
  ): Promise<Video> {
    const video = await this.videoRepository.findOne({
      where: { public_id: publicId },
    });
    if (!video) {
      throw new VideoNotFoundException();
    }
    const channel = await this.channelsService.findByUserId(userId);
    if (!channel || channel.id !== video.channel_id) {
      throw new VideoAccessDeniedException();
    }
    if (video.status !== VideoStatus.DRAFT) {
      throw new InvalidVideoStateException();
    }
    return video;
  }
}
