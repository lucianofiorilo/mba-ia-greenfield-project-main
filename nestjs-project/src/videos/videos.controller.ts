import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  Post,
  Res,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { ApiErrorEnvelope } from '../common/openapi/api-error-envelope.dto';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Public } from '../auth/decorators/public.decorator';
import type { JwtPayload } from '../auth/auth.types';
import {
  VideosService,
  type InitiateUploadResult,
  type VideoStreamResult,
} from './videos.service';
import { InitiateUploadDto } from './dto/initiate-upload.dto';
import { CompleteUploadDto } from './dto/complete-upload.dto';
import { VideoViewDto } from './dto/video-view.dto';
import type { VideoStatus } from './entities/video.entity';

@ApiTags('videos')
@Controller('videos')
export class VideosController {
  constructor(private readonly videosService: VideosService) {}

  @Post()
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Initiate a video upload',
    description:
      "Pre-registers the video as a draft on the caller's channel, opens a " +
      'multipart upload, and returns one presigned PUT URL per part. The file ' +
      'is uploaded directly to object storage — it never passes through the API.',
  })
  @ApiResponse({
    status: 201,
    description: 'Upload initiated; draft created and presigned URLs returned',
    schema: {
      properties: {
        publicId: { type: 'string' },
        uploadId: { type: 'string' },
        key: { type: 'string' },
        partSize: { type: 'integer' },
        parts: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              partNumber: { type: 'integer' },
              url: { type: 'string' },
            },
          },
        },
      },
    },
  })
  @ApiResponse({
    status: 400,
    description: 'Validation failed',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 413,
    description: 'File exceeds the maximum allowed size',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 415,
    description: 'Only video files are supported',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async initiateUpload(
    @CurrentUser() user: JwtPayload,
    @Body() dto: InitiateUploadDto,
  ): Promise<InitiateUploadResult> {
    return this.videosService.initiateUpload(user.sub, dto);
  }

  @Post(':publicId/complete')
  @HttpCode(200)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Complete a video upload',
    description:
      'Finalizes the multipart upload with the uploaded part ETags, flips the ' +
      'video to `processing`, and enqueues the processing job. Owner-only; the ' +
      'video must still be a draft.',
  })
  @ApiResponse({
    status: 200,
    description: 'Upload completed; video is now processing',
    schema: {
      properties: {
        publicId: { type: 'string' },
        status: { type: 'string', example: 'processing' },
      },
    },
  })
  @ApiResponse({
    status: 400,
    description: 'Invalid multipart upload parts',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 403,
    description: 'Caller does not own this video',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'Video is not in a draft state',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async completeUpload(
    @CurrentUser() user: JwtPayload,
    @Param('publicId') publicId: string,
    @Body() dto: CompleteUploadDto,
  ): Promise<{ publicId: string; status: VideoStatus }> {
    return this.videosService.completeUpload(user.sub, publicId, dto);
  }

  @Post(':publicId/abort')
  @HttpCode(204)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Abort a video upload',
    description:
      'Aborts the multipart upload and deletes the draft. Owner-only; the ' +
      'video must still be a draft.',
  })
  @ApiResponse({ status: 204, description: 'Upload aborted; draft removed' })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 403,
    description: 'Caller does not own this video',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'Video is not in a draft state',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async abortUpload(
    @CurrentUser() user: JwtPayload,
    @Param('publicId') publicId: string,
  ): Promise<void> {
    return this.videosService.abortUpload(user.sub, publicId);
  }

  @Public()
  @Get(':publicId')
  @ApiOperation({
    summary: 'Get video metadata',
    description:
      'Returns the public-facing metadata and processing status of a video. ' +
      'Accessible anonymously; a client can poll this to observe the status ' +
      'transition from `processing` to `ready` after completing an upload.',
  })
  @ApiResponse({
    status: 200,
    description: 'Video metadata and status',
    type: VideoViewDto,
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async getByPublicId(
    @Param('publicId') publicId: string,
  ): Promise<VideoViewDto> {
    return this.videosService.getByPublicId(publicId);
  }

  @Public()
  @Get(':publicId/stream')
  @ApiOperation({
    summary: 'Stream a video',
    description:
      'Serves the video bytes with HTTP Range support. A `Range` request ' +
      'yields `206 Partial Content` with `Content-Range`; a plain request ' +
      'yields `200` with the full body. Bytes are piped from storage, never ' +
      'buffered in the API. Accessible anonymously; only `ready` videos.',
  })
  @ApiResponse({
    status: 200,
    description: 'Full video body (no Range header)',
    content: { '*/*': { schema: { type: 'string', format: 'binary' } } },
  })
  @ApiResponse({
    status: 206,
    description: 'Partial video body for the requested byte range',
    content: { '*/*': { schema: { type: 'string', format: 'binary' } } },
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'Video is not ready for playback',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async stream(
    @Param('publicId') publicId: string,
    @Headers('range') range: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    const result = await this.videosService.openStream(publicId, range);
    this.pipeToResponse(res, result);
  }

  @Public()
  @Get(':publicId/download')
  @ApiOperation({
    summary: 'Download a video',
    description:
      'Serves the full video file as an attachment ' +
      '(`Content-Disposition: attachment; filename="..."`). Bytes are piped ' +
      'from storage, never buffered in the API. Accessible anonymously; only ' +
      '`ready` videos.',
  })
  @ApiResponse({
    status: 200,
    description: 'Full video file served as an attachment',
    content: { '*/*': { schema: { type: 'string', format: 'binary' } } },
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'Video is not ready for download',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async download(
    @Param('publicId') publicId: string,
    @Res() res: Response,
  ): Promise<void> {
    const result = await this.videosService.openDownload(publicId);
    this.pipeToResponse(res, result);
  }

  // Never buffer: pipe the storage stream straight to the client. On an
  // upstream error, destroy the response so the client sees a broken
  // connection rather than a hang; if the client disconnects first, tear
  // down the upstream stream to avoid leaking the storage connection.
  private pipeToResponse(
    res: Response,
    { stream, status, headers }: VideoStreamResult,
  ): void {
    res.status(status);
    res.set(headers);

    stream.on('error', (err) => res.destroy(err));
    res.on('close', () => {
      if (!stream.destroyed) {
        stream.destroy();
      }
    });
    stream.pipe(res);
  }
}
