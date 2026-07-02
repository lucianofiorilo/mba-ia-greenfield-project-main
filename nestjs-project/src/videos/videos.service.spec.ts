import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { getQueueToken } from '@nestjs/bullmq';
import { QueryFailedError } from 'typeorm';
import { VideosService } from './videos.service';
import { Video, VideoStatus } from './entities/video.entity';
import { StorageService } from '../storage/storage.service';
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
  VIDEO_JOB_OPTIONS,
  VIDEO_PROCESS_JOB,
  VIDEO_PROCESSING_QUEUE,
} from './videos.constants';
import uploadConfig from '../config/upload.config';
import appConfig from '../config/app.config';
import type { InitiateUploadDto } from './dto/initiate-upload.dto';

const UPLOAD_CONFIG = {
  partSizeBytes: 100,
  maxSizeBytes: 1000,
  urlExpiresSeconds: 900,
};

function validDto(
  overrides: Partial<InitiateUploadDto> = {},
): InitiateUploadDto {
  return {
    title: 'My clip',
    filename: 'clip.mp4',
    mimeType: 'video/mp4',
    sizeBytes: 250,
    ...overrides,
  };
}

describe('VideosService (unit)', () => {
  let service: VideosService;
  let repository: {
    insert: jest.Mock;
    findOne: jest.Mock;
    save: jest.Mock;
    delete: jest.Mock;
  };
  let storageService: {
    createMultipartUpload: jest.Mock;
    presignUploadParts: jest.Mock;
    completeMultipartUpload: jest.Mock;
    abortMultipartUpload: jest.Mock;
  };
  let channelsService: { findByUserId: jest.Mock };
  let queue: { add: jest.Mock };

  beforeEach(async () => {
    repository = {
      insert: jest.fn().mockResolvedValue(undefined),
      findOne: jest.fn(),
      save: jest.fn((v) => Promise.resolve(v)),
      delete: jest.fn().mockResolvedValue(undefined),
    };
    storageService = {
      createMultipartUpload: jest.fn().mockResolvedValue('upload-123'),
      presignUploadParts: jest.fn().mockResolvedValue([]),
      completeMultipartUpload: jest.fn().mockResolvedValue(undefined),
      abortMultipartUpload: jest.fn().mockResolvedValue(undefined),
    };
    channelsService = {
      findByUserId: jest.fn().mockResolvedValue({ id: 'channel-1' }),
    };
    queue = { add: jest.fn().mockResolvedValue(undefined) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        VideosService,
        { provide: getRepositoryToken(Video), useValue: repository },
        { provide: StorageService, useValue: storageService },
        { provide: ChannelsService, useValue: channelsService },
        { provide: getQueueToken(VIDEO_PROCESSING_QUEUE), useValue: queue },
        { provide: uploadConfig.KEY, useValue: UPLOAD_CONFIG },
        { provide: appConfig.KEY, useValue: { url: 'http://localhost:3000' } },
      ],
    }).compile();

    service = module.get(VideosService);
  });

  it('throws ChannelNotFoundException when the user has no channel', async () => {
    channelsService.findByUserId.mockResolvedValue(null);

    await expect(service.initiateUpload('user-1', validDto())).rejects.toThrow(
      ChannelNotFoundException,
    );
    expect(storageService.createMultipartUpload).not.toHaveBeenCalled();
  });

  it('rejects a non-video mime type with UnsupportedMediaTypeException', async () => {
    await expect(
      service.initiateUpload('user-1', validDto({ mimeType: 'image/png' })),
    ).rejects.toThrow(UnsupportedMediaTypeException);
    expect(storageService.createMultipartUpload).not.toHaveBeenCalled();
  });

  it('rejects a file above the size ceiling with FileTooLargeException', async () => {
    await expect(
      service.initiateUpload('user-1', validDto({ sizeBytes: 1001 })),
    ).rejects.toThrow(FileTooLargeException);
    expect(storageService.createMultipartUpload).not.toHaveBeenCalled();
  });

  it('computes the part count from the configured part size', async () => {
    // 250 bytes / 100-byte parts => ceil(2.5) = 3 parts.
    await service.initiateUpload('user-1', validDto({ sizeBytes: 250 }));

    expect(storageService.presignUploadParts).toHaveBeenCalledWith(
      expect.any(String),
      'upload-123',
      [1, 2, 3],
    );
  });

  it('regenerates public_id and retries insert on a unique violation', async () => {
    const collision = new QueryFailedError('insert', [], {
      code: '23505',
    } as unknown as Error);
    repository.insert
      .mockRejectedValueOnce(collision)
      .mockResolvedValueOnce(undefined);

    const result = await service.initiateUpload('user-1', validDto());

    expect(repository.insert).toHaveBeenCalledTimes(2);
    const firstId = (
      repository.insert.mock.calls[0][0] as { public_id: string }
    ).public_id;
    const secondId = (
      repository.insert.mock.calls[1][0] as { public_id: string }
    ).public_id;
    expect(firstId).not.toBe(secondId);
    expect(result.publicId).toBe(secondId);
  });

  it('returns the storage contract on success', async () => {
    storageService.presignUploadParts.mockResolvedValue([
      { partNumber: 1, url: 'https://minio/part-1' },
    ]);

    const result = await service.initiateUpload(
      'user-1',
      validDto({ sizeBytes: 50 }),
    );

    expect(result).toEqual({
      publicId: expect.any(String),
      uploadId: 'upload-123',
      key: expect.stringContaining('videos/'),
      partSize: 100,
      parts: [{ partNumber: 1, url: 'https://minio/part-1' }],
    });
  });

  describe('completeUpload', () => {
    const draft = (): Partial<Video> => ({
      id: 'video-uuid',
      public_id: 'pub123',
      channel_id: 'channel-1',
      status: VideoStatus.DRAFT,
      storage_key: 'videos/video-uuid/original/clip.mp4',
      upload_id: 'upload-123',
    });
    const parts = [{ partNumber: 1, etag: 'etag-1' }];

    it('throws VideoNotFoundException when the video does not exist', async () => {
      repository.findOne.mockResolvedValue(null);

      await expect(
        service.completeUpload('user-1', 'missing', { parts }),
      ).rejects.toThrow(VideoNotFoundException);
    });

    it('throws VideoAccessDeniedException when the caller is not the owner', async () => {
      repository.findOne.mockResolvedValue(draft());
      channelsService.findByUserId.mockResolvedValue({ id: 'other-channel' });

      await expect(
        service.completeUpload('user-1', 'pub123', { parts }),
      ).rejects.toThrow(VideoAccessDeniedException);
      expect(storageService.completeMultipartUpload).not.toHaveBeenCalled();
    });

    it('throws InvalidVideoStateException when the video is not a draft', async () => {
      repository.findOne.mockResolvedValue({
        ...draft(),
        status: VideoStatus.PROCESSING,
      });

      await expect(
        service.completeUpload('user-1', 'pub123', { parts }),
      ).rejects.toThrow(InvalidVideoStateException);
    });

    it('completes storage, flips to processing, and enqueues the job', async () => {
      repository.findOne.mockResolvedValue(draft());

      const result = await service.completeUpload('user-1', 'pub123', {
        parts,
      });

      expect(storageService.completeMultipartUpload).toHaveBeenCalledWith(
        'videos/video-uuid/original/clip.mp4',
        'upload-123',
        parts,
      );
      expect(repository.save).toHaveBeenCalledWith(
        expect.objectContaining({ status: VideoStatus.PROCESSING }),
      );
      expect(queue.add).toHaveBeenCalledWith(
        VIDEO_PROCESS_JOB,
        { videoId: 'video-uuid' },
        VIDEO_JOB_OPTIONS,
      );
      expect(result).toEqual({
        publicId: 'pub123',
        status: VideoStatus.PROCESSING,
      });
    });

    it('maps an invalid-parts storage error to InvalidUploadException', async () => {
      repository.findOne.mockResolvedValue(draft());
      storageService.completeMultipartUpload.mockRejectedValue({
        name: 'InvalidPart',
        $metadata: { httpStatusCode: 400 },
      });

      await expect(
        service.completeUpload('user-1', 'pub123', { parts }),
      ).rejects.toThrow(InvalidUploadException);
      expect(queue.add).not.toHaveBeenCalled();
    });

    it('rethrows non-client storage errors without enqueueing', async () => {
      repository.findOne.mockResolvedValue(draft());
      const networkError = Object.assign(new Error('socket hang up'), {
        $metadata: { httpStatusCode: 500 },
      });
      storageService.completeMultipartUpload.mockRejectedValue(networkError);

      await expect(
        service.completeUpload('user-1', 'pub123', { parts }),
      ).rejects.toThrow('socket hang up');
      expect(queue.add).not.toHaveBeenCalled();
    });
  });

  describe('getByPublicId', () => {
    const ready = (): Partial<Video> => ({
      public_id: 'pub123',
      title: 'My clip',
      status: VideoStatus.READY,
      duration_seconds: 42.5,
      metadata: { width: 1920, height: 1080, codec: 'h264' },
      thumbnail_key: 'videos/video-uuid/thumbnail.jpg',
      channel_id: 'channel-1',
      created_at: new Date('2026-07-01T12:00:00.000Z'),
    });

    it('throws VideoNotFoundException for an unknown public_id', async () => {
      repository.findOne.mockResolvedValue(null);

      await expect(service.getByPublicId('nope')).rejects.toThrow(
        VideoNotFoundException,
      );
    });

    it('maps the entity to a public view with publicId-derived URLs', async () => {
      repository.findOne.mockResolvedValue(ready());

      const view = await service.getByPublicId('pub123');

      expect(view).toEqual({
        publicId: 'pub123',
        title: 'My clip',
        status: VideoStatus.READY,
        durationSeconds: 42.5,
        metadata: { width: 1920, height: 1080, codec: 'h264' },
        thumbnailUrl: 'http://localhost:3000/videos/pub123/thumbnail',
        streamUrl: 'http://localhost:3000/videos/pub123/stream',
        channelId: 'channel-1',
        createdAt: '2026-07-01T12:00:00.000Z',
      });
    });

    it('returns a null thumbnailUrl while the video has no thumbnail yet', async () => {
      repository.findOne.mockResolvedValue({
        ...ready(),
        status: VideoStatus.PROCESSING,
        duration_seconds: null,
        metadata: null,
        thumbnail_key: null,
      });

      const view = await service.getByPublicId('pub123');

      expect(view.thumbnailUrl).toBeNull();
      expect(view.durationSeconds).toBeNull();
      expect(view.streamUrl).toBe('http://localhost:3000/videos/pub123/stream');
    });
  });

  describe('abortUpload', () => {
    const draft = (): Partial<Video> => ({
      id: 'video-uuid',
      public_id: 'pub123',
      channel_id: 'channel-1',
      status: VideoStatus.DRAFT,
      storage_key: 'videos/video-uuid/original/clip.mp4',
      upload_id: 'upload-123',
    });

    it('throws VideoAccessDeniedException for a non-owner', async () => {
      repository.findOne.mockResolvedValue(draft());
      channelsService.findByUserId.mockResolvedValue({ id: 'other-channel' });

      await expect(service.abortUpload('user-1', 'pub123')).rejects.toThrow(
        VideoAccessDeniedException,
      );
      expect(storageService.abortMultipartUpload).not.toHaveBeenCalled();
    });

    it('aborts the multipart upload and deletes the draft row', async () => {
      repository.findOne.mockResolvedValue(draft());

      await service.abortUpload('user-1', 'pub123');

      expect(storageService.abortMultipartUpload).toHaveBeenCalledWith(
        'videos/video-uuid/original/clip.mp4',
        'upload-123',
      );
      expect(repository.delete).toHaveBeenCalledWith({ id: 'video-uuid' });
    });
  });
});
