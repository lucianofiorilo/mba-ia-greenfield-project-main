import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { getQueueToken } from '@nestjs/bullmq';
import { QueryFailedError } from 'typeorm';
import { VideosService } from './videos.service';
import { Video } from './entities/video.entity';
import { StorageService } from '../storage/storage.service';
import { ChannelsService } from '../channels/channels.service';
import { ChannelNotFoundException } from '../channels/exceptions/channel.exceptions';
import {
  FileTooLargeException,
  UnsupportedMediaTypeException,
} from './exceptions/video.exceptions';
import { VIDEO_PROCESSING_QUEUE } from './videos.constants';
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
  let repository: { insert: jest.Mock };
  let storageService: {
    createMultipartUpload: jest.Mock;
    presignUploadParts: jest.Mock;
  };
  let channelsService: { findByUserId: jest.Mock };

  beforeEach(async () => {
    repository = { insert: jest.fn().mockResolvedValue(undefined) };
    storageService = {
      createMultipartUpload: jest.fn().mockResolvedValue('upload-123'),
      presignUploadParts: jest.fn().mockResolvedValue([]),
    };
    channelsService = {
      findByUserId: jest.fn().mockResolvedValue({ id: 'channel-1' }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        VideosService,
        { provide: getRepositoryToken(Video), useValue: repository },
        { provide: StorageService, useValue: storageService },
        { provide: ChannelsService, useValue: channelsService },
        { provide: getQueueToken(VIDEO_PROCESSING_QUEUE), useValue: {} },
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
});
