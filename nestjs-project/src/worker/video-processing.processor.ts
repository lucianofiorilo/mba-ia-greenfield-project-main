import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Logger } from '@nestjs/common';
import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import type { Job } from 'bullmq';
import ffmpeg from 'fluent-ffmpeg';
import type { FfprobeData } from 'fluent-ffmpeg';
import {
  Video,
  VideoStatus,
  type VideoMetadata,
} from '../videos/entities/video.entity';
import { StorageService, buildThumbnailKey } from '../storage/storage.service';
import { VIDEO_PROCESSING_QUEUE } from '../videos/videos.constants';

export interface VideoProcessingJobData {
  videoId: string;
}

// Capture the thumbnail from a frame halfway through the clip.
const THUMBNAIL_TIMESTAMP = '50%';
const THUMBNAIL_FILENAME = 'thumbnail.jpg';
const THUMBNAIL_SIZE = '1280x?';
// error_reason is stored in a text column; keep the recorded cause bounded.
const MAX_ERROR_REASON_LENGTH = 1000;

// BullMQ consumer (TD-04/TD-05): per job, streams the source from storage to a
// temp file (10GB-safe: bounded by disk, not RAM), extracts metadata + a
// thumbnail via FFmpeg, persists them, and flips the video to `ready`. Thrown
// errors bubble up so BullMQ retries with backoff; only when the final attempt
// fails does `onFailed` move the video to `failed` (TD-08).
@Processor(VIDEO_PROCESSING_QUEUE)
export class VideoProcessingProcessor extends WorkerHost {
  private readonly logger = new Logger(VideoProcessingProcessor.name);

  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly storageService: StorageService,
  ) {
    super();
  }

  async process(job: Job<VideoProcessingJobData>): Promise<void> {
    const { videoId } = job.data;
    const video = await this.videoRepository.findOne({
      where: { id: videoId },
    });
    if (!video) {
      // The draft was deleted (e.g. aborted) after the job was enqueued — there
      // is nothing to process. Return cleanly so BullMQ does not retry.
      this.logger.warn(`Video ${videoId} not found; skipping job ${job.id}`);
      return;
    }

    const workDir = await mkdtemp(join(tmpdir(), `video-${videoId}-`));
    const sourcePath = join(workDir, 'source');
    try {
      await this.storageService.getObjectToFile(video.storage_key, sourcePath);

      const probe = await this.probe(sourcePath);
      const videoStream = probe.streams.find(
        (stream) => stream.codec_type === 'video',
      );
      const metadata: VideoMetadata = {
        width: videoStream?.width,
        height: videoStream?.height,
        codec: videoStream?.codec_name,
        container: probe.format.format_name,
        bitrate: this.toNumber(probe.format.bit_rate),
      };
      const durationSeconds = this.toNumber(probe.format.duration) ?? 0;

      // The output folder MUST exist before .screenshots(), or FFmpeg exits
      // silently with no `error` event (library-refs gotcha). mkdtemp created it.
      await this.captureThumbnail(sourcePath, workDir);
      const thumbnailKey = buildThumbnailKey(videoId);
      const thumbnail = await readFile(join(workDir, THUMBNAIL_FILENAME));
      await this.storageService.putObject(
        thumbnailKey,
        thumbnail,
        'image/jpeg',
      );

      await this.videoRepository.update(
        { id: videoId },
        {
          duration_seconds: durationSeconds,
          metadata,
          thumbnail_key: thumbnailKey,
          status: VideoStatus.READY,
          error_reason: null,
        },
      );
      this.logger.log(
        `Video ${videoId} processed → ready (${durationSeconds}s)`,
      );
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  }

  // Fires after every failed attempt; only the terminal failure (retries
  // exhausted) transitions the video to `failed` with a recorded reason. The
  // job is retained in the failed set (removeOnFail: false) for inspection.
  @OnWorkerEvent('failed')
  async onFailed(job: Job<VideoProcessingJobData>, err: Error): Promise<void> {
    const attempts = job.opts.attempts ?? 1;
    if (job.attemptsMade < attempts) {
      return;
    }
    const { videoId } = job.data;
    this.logger.error(
      `Video ${videoId} failed after ${job.attemptsMade} attempts: ${err.message}`,
    );
    await this.videoRepository.update(
      { id: videoId },
      {
        status: VideoStatus.FAILED,
        error_reason: err.message?.slice(0, MAX_ERROR_REASON_LENGTH) ?? null,
      },
    );
  }

  private probe(path: string): Promise<FfprobeData> {
    return new Promise<FfprobeData>((resolve, reject) =>
      // ffprobe types the callback error as `any`; normalize to a real Error.
      ffmpeg.ffprobe(path, (err: unknown, data) =>
        err ? reject(this.toError(err, 'ffprobe failed')) : resolve(data),
      ),
    );
  }

  private captureThumbnail(sourcePath: string, outDir: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      ffmpeg(sourcePath)
        .screenshots({
          timestamps: [THUMBNAIL_TIMESTAMP],
          filename: THUMBNAIL_FILENAME,
          folder: outDir,
          size: THUMBNAIL_SIZE,
        })
        .on('end', () => resolve())
        .on('error', (err) => reject(err));
    });
  }

  // Normalize an unknown rejection reason into a real Error without risking
  // '[object Object]' stringification of non-string, non-Error values.
  private toError(err: unknown, fallback: string): Error {
    if (err instanceof Error) {
      return err;
    }
    return new Error(typeof err === 'string' ? err : fallback);
  }

  private toNumber(value: string | number | undefined): number | undefined {
    if (value === undefined) {
      return undefined;
    }
    const parsed = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
}
