import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import type { Readable } from 'node:stream';
import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateBucketCommand,
  CreateMultipartUploadCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import storageConfig from '../config/storage.config';
import uploadConfig from '../config/upload.config';

export interface PresignedPart {
  partNumber: number;
  url: string;
}

export interface CompletedPart {
  partNumber: number;
  etag: string;
}

export interface ObjectRange {
  body: Readable;
  contentLength: number;
  contentType: string;
  contentRange?: string;
}

/** Thumbnail key for a video, derived from its UUID (never from user input). */
export function buildThumbnailKey(videoId: string): string {
  return `videos/${videoId}/thumbnail.jpg`;
}

/** Storage keys for a video, derived from its UUID (never from user input). */
export function buildVideoKeys(
  videoId: string,
  filename: string,
): { originalKey: string; thumbnailKey: string } {
  return {
    originalKey: `videos/${videoId}/original/${filename}`,
    thumbnailKey: buildThumbnailKey(videoId),
  };
}

@Injectable()
export class StorageService implements OnModuleInit {
  private readonly logger = new Logger(StorageService.name);
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(
    @Inject(storageConfig.KEY)
    private readonly config: ConfigType<typeof storageConfig>,
    @Inject(uploadConfig.KEY)
    private readonly upload: ConfigType<typeof uploadConfig>,
  ) {
    const { endpoint, region, accessKey, secretKey, bucket, forcePathStyle } =
      this.config;
    if (!endpoint || !accessKey || !secretKey) {
      throw new Error('Storage config is incomplete (endpoint/credentials)');
    }
    this.bucket = bucket;
    this.client = new S3Client({
      endpoint,
      region,
      forcePathStyle,
      credentials: { accessKeyId: accessKey, secretAccessKey: secretKey },
    });
  }

  /** Ensure the target bucket exists (idempotent) on startup. */
  async onModuleInit(): Promise<void> {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
    } catch {
      try {
        await this.client.send(
          new CreateBucketCommand({ Bucket: this.bucket }),
        );
        this.logger.log(`Created storage bucket "${this.bucket}"`);
      } catch (err) {
        // A concurrent creator (e.g., another instance) may have won the race.
        this.logger.warn(
          `Could not ensure bucket "${this.bucket}": ${(err as Error).message}`,
        );
      }
    }
  }

  async createMultipartUpload(
    key: string,
    contentType: string,
  ): Promise<string> {
    const res = await this.client.send(
      new CreateMultipartUploadCommand({
        Bucket: this.bucket,
        Key: key,
        ContentType: contentType,
      }),
    );
    if (!res.UploadId) {
      throw new Error('Storage did not return an UploadId');
    }
    return res.UploadId;
  }

  async presignUploadParts(
    key: string,
    uploadId: string,
    partNumbers: number[],
  ): Promise<PresignedPart[]> {
    return Promise.all(
      partNumbers.map(async (partNumber) => {
        const command = new UploadPartCommand({
          Bucket: this.bucket,
          Key: key,
          UploadId: uploadId,
          PartNumber: partNumber,
        });
        const url = await getSignedUrl(this.client, command, {
          expiresIn: this.upload.urlExpiresSeconds,
        });
        return { partNumber, url };
      }),
    );
  }

  async completeMultipartUpload(
    key: string,
    uploadId: string,
    parts: CompletedPart[],
  ): Promise<void> {
    await this.client.send(
      new CompleteMultipartUploadCommand({
        Bucket: this.bucket,
        Key: key,
        UploadId: uploadId,
        MultipartUpload: {
          Parts: parts
            .slice()
            .sort((a, b) => a.partNumber - b.partNumber)
            .map((p) => ({ PartNumber: p.partNumber, ETag: p.etag })),
        },
      }),
    );
  }

  async abortMultipartUpload(key: string, uploadId: string): Promise<void> {
    await this.client.send(
      new AbortMultipartUploadCommand({
        Bucket: this.bucket,
        Key: key,
        UploadId: uploadId,
      }),
    );
  }

  async headObject(
    key: string,
  ): Promise<{ contentLength: number; contentType: string }> {
    const res = await this.client.send(
      new HeadObjectCommand({ Bucket: this.bucket, Key: key }),
    );
    return {
      contentLength: res.ContentLength ?? 0,
      contentType: res.ContentType ?? 'application/octet-stream',
    };
  }

  /** Fetch an object, optionally a byte range (`bytes=start-end`). */
  async getObjectRange(key: string, range?: string): Promise<ObjectRange> {
    const res = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: key, Range: range }),
    );
    return {
      body: res.Body as Readable,
      contentLength: res.ContentLength ?? 0,
      contentType: res.ContentType ?? 'application/octet-stream',
      contentRange: res.ContentRange,
    };
  }

  async putObject(
    key: string,
    body: Buffer,
    contentType: string,
  ): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
      }),
    );
  }

  /** Stream an object to a local file (bounded by disk, not memory). */
  async getObjectToFile(key: string, destPath: string): Promise<void> {
    const res = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
    );
    await pipeline(res.Body as Readable, createWriteStream(destPath));
  }

  /** Delete every object under a key prefix (cleanup). */
  async deleteObjects(prefix: string): Promise<void> {
    const listed = await this.client.send(
      new ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefix }),
    );
    const keys = (listed.Contents ?? [])
      .map((o) => o.Key)
      .filter((k): k is string => typeof k === 'string');
    if (keys.length === 0) {
      return;
    }
    await this.client.send(
      new DeleteObjectsCommand({
        Bucket: this.bucket,
        Delete: { Objects: keys.map((Key) => ({ Key })) },
      }),
    );
  }
}
