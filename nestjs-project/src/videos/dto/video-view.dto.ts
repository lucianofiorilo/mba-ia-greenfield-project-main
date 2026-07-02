import { ApiProperty } from '@nestjs/swagger';
import { VideoStatus, type VideoMetadata } from '../entities/video.entity';

/**
 * Public-facing view of a video — the response of `GET /videos/:publicId`.
 * Never exposes internal storage keys or the multipart `upload_id`; playback
 * and thumbnail access are indirected through `publicId`-derived API URLs.
 */
export class VideoViewDto {
  @ApiProperty({ description: 'Public, URL-safe identifier of the video.' })
  publicId: string;

  @ApiProperty({ description: 'Video title chosen at upload time.' })
  title: string;

  @ApiProperty({
    enum: VideoStatus,
    description: 'Processing lifecycle state; poll until `ready`.',
  })
  status: VideoStatus;

  @ApiProperty({
    type: Number,
    nullable: true,
    description: 'Duration in seconds; `null` until processing completes.',
  })
  durationSeconds: number | null;

  @ApiProperty({
    type: 'object',
    additionalProperties: true,
    nullable: true,
    description: 'Extracted technical metadata (width, height, codec, …).',
  })
  metadata: VideoMetadata | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'URL of the generated thumbnail; `null` until processed.',
  })
  thumbnailUrl: string | null;

  @ApiProperty({ description: 'URL to stream the video (Range-enabled).' })
  streamUrl: string;

  @ApiProperty({ description: 'Identifier of the owning channel.' })
  channelId: string;

  @ApiProperty({
    format: 'date-time',
    description: 'ISO-8601 timestamp of when the video was created.',
  })
  createdAt: string;
}
