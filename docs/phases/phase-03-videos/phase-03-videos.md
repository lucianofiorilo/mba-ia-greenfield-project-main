---
kind: phase
name: phase-03-videos
sources_mtime:
  docs/phases/phase-03-videos/context.md: "2026-06-28T20:04:32-03:00"
  docs/phases/phase-03-videos/library-refs.md: "2026-06-28T20:02:36-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-06-28T20:00:16-03:00"
---

# Phase 03 — Upload e Processamento de Vídeos

## Objective

Deliver large-file (up to 10GB) video upload without blocking the API — via direct-to-storage multipart presigned uploads — plus automatic background processing (duration/metadata extraction and thumbnail generation) by a separate FFmpeg worker consuming a queue, a unique public URL per video, range-based streaming and download, and a `draft → processing → ready/failed` status lifecycle reflected in the database.

---

## Step Implementations

### SI-03.1 — Dependencies, Configuration Namespaces, and Env Validation

**Description:** Install Phase 03 production dependencies and create the `storage`, `queue`, and `upload` config namespaces following the Phase 01 `registerAs` pattern, extending the Joi env schema.

**Technical actions:**

1. Install in `nestjs-project`: `@nestjs/bullmq@^11.0.4`, `bullmq@^5`, `@aws-sdk/client-s3@^3`, `@aws-sdk/s3-request-presigner@^3`, `fluent-ffmpeg@^2.1.3`, `nanoid@^3.3.7`; dev: `@types/fluent-ffmpeg@^2.1.27` (per `library-refs.md`; nanoid pinned to v3 — CommonJS).
2. Create `src/config/storage.config.ts` — `registerAs('storage', ...)` reading `S3_ENDPOINT`, `S3_REGION` (default `'us-east-1'`), `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `S3_BUCKET` (default `'streamtube-videos'`), `S3_FORCE_PATH_STYLE` (default `true`) (per `phase-03-videos/TD-03`).
3. Create `src/config/queue.config.ts` — `registerAs('queue', ...)` reading `REDIS_HOST` (default `'redis'`), `REDIS_PORT` (default `6379`) (per `phase-03-videos/TD-01`).
4. Create `src/config/upload.config.ts` — `registerAs('upload', ...)` reading `UPLOAD_PART_SIZE_BYTES` (default `67108864` = 64MB), `UPLOAD_MAX_SIZE_BYTES` (default `10737418240` = 10GB), `UPLOAD_URL_EXPIRES_SECONDS` (default `900`) (per `phase-03-videos/TD-02`).
5. Update `src/config/env.validation.ts` (add all new keys; `S3_ACCESS_KEY`/`S3_SECRET_KEY`/`S3_ENDPOINT` required, rest with defaults) and `.env.example`; register the three new config factories in `ConfigModule.forRoot({ load: [...] })`.

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| env validation | Integration | `src/config/env.validation.integration-spec.ts` — app boots with required S3 vars; missing `S3_ACCESS_KEY` fails Joi at bootstrap |

**Dependencies:** None

**Acceptance criteria:**

- The application boots without error when all new environment variables are provided — the existing `GET /` E2E test still returns 200.
- Starting the application without `S3_ACCESS_KEY` (or `S3_SECRET_KEY`/`S3_ENDPOINT`) causes a Joi validation error at bootstrap — the app does not start.
- `storage`, `queue`, and `upload` config are injectable via `ConfigType<typeof xxxConfig>` with the documented defaults.

---

### SI-03.2 — Docker Compose Infrastructure (MinIO + Redis) and Worker Image

**Description:** Add MinIO (object storage) and Redis (queue broker) services to Compose, and a worker service built from a dedicated FFmpeg-enabled image, all on the same Compose network (service-name hosts only).

**Technical actions:**

1. Add `minio` service to `nestjs-project/compose.yaml` — image `minio/minio`, command `server /data --console-address ":9001"`, ports `9000:9000` + `9001:9001`, env `MINIO_ROOT_USER`/`MINIO_ROOT_PASSWORD`, named volume `minio-data:/data`, healthcheck on `/minio/health/ready`.
2. Add `redis` service — image `redis:7`, port `6379:6379`, healthcheck `redis-cli ping`.
3. Create `nestjs-project/Dockerfile.worker` — same Node base as `Dockerfile.dev` plus `apt-get install -y ffmpeg`; default command runs the worker entrypoint (`npm run start:worker`, added in SI-03.8).
4. Add `video-worker` service to `compose.yaml` — built from `Dockerfile.worker`, `depends_on` db/redis/minio (healthy), shares the same env as `nestjs-api`, host values use Compose service names (`db`, `redis`, `minio`) per CLAUDE.md.
5. Update `nestjs-api` `depends_on` to include `redis` and `minio` (service_healthy); add `S3_ENDPOINT=http://minio:9000`, `REDIS_HOST=redis` and the other new vars to `.env.example`/compose env.

**Tests:** _(empty — infrastructure; exercised by the storage/queue integration tests in SI-03.3 and SI-03.9, which connect to the real MinIO/Redis services)_

**Dependencies:** SI-03.1

**Acceptance criteria:**

- `docker compose up -d` starts `db`, `mailpit`, `minio`, `redis`, `nestjs-api`, and `video-worker`, and `docker compose ps` shows all as running/healthy.
- MinIO is reachable inside the network at `http://minio:9000` and its console at `localhost:9001`; Redis answers `PING` with `PONG`.
- The `video-worker` image has `ffmpeg` and `ffprobe` available on `$PATH` (`docker compose exec video-worker ffmpeg -version` succeeds).
- No service configuration uses `localhost`/`127.0.0.1` as a cross-service host — only Compose service names.

---

### SI-03.3 — Object Storage Service (S3/MinIO adapter)

**Description:** Create a `StorageModule`/`StorageService` wrapping the AWS SDK v3 S3 client configured for MinIO, exposing multipart, presign, ranged-get, put, and delete operations plus idempotent bucket creation on startup.

**Technical actions:**

1. Create `src/storage/storage.service.ts` — builds an `S3Client` from `storageConfig` (`endpoint`, `region`, `forcePathStyle`, credentials) (per `phase-03-videos/TD-03`). On `onModuleInit`, ensure the bucket exists (create if absent).
2. Implement multipart methods (per `phase-03-videos/TD-02`): `createMultipartUpload(key, contentType): Promise<{ uploadId }>`, `presignUploadParts(key, uploadId, partNumbers): Promise<{ partNumber, url }[]>` (via `getSignedUrl` + `UploadPartCommand`, `expiresIn` from `uploadConfig`), `completeMultipartUpload(key, uploadId, parts)`, `abortMultipartUpload(key, uploadId)`.
3. Implement `getObjectRange(key, range?): Promise<{ body: Readable, contentLength, contentType, contentRange? }>` (GetObject with optional `Range`) and `headObject(key)` (per `phase-03-videos/TD-07`).
4. Implement `putObject(key, body, contentType)` (thumbnail upload), `getObjectToFile(key, destPath)` (stream download to a temp file), and `deleteObjects(prefix)` (cleanup).
5. Create `src/storage/storage.module.ts` — provides + exports `StorageService`; add a `buildVideoKeys(videoId, filename)` helper (`videos/{id}/original/{filename}`, `videos/{id}/thumbnail.jpg`) per the key scheme in `phase-03-videos/TD-03`.

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `StorageService` | Integration (real MinIO) | `src/storage/storage.service.integration-spec.ts` — round-trip put/headObject; multipart init→presign→(upload via presigned URL)→complete; getObjectRange returns the requested byte slice; abortMultipartUpload removes the pending upload |
| `StorageModule` | Unit (compilation) | `src/storage/storage.module.spec.ts` |

**Dependencies:** SI-03.1, SI-03.2

**Acceptance criteria:**

- On startup the configured bucket exists in MinIO (created if it was absent), and a second startup does not error (idempotent).
- A small object uploaded through the multipart init→presign-part→complete flow is afterwards retrievable, and a `getObjectRange` with `bytes=0-{n}` returns exactly that byte slice with a correct `Content-Range`.
- `abortMultipartUpload` discards an initiated-but-not-completed upload — its parts are not retained.
- Object keys are derived from the video UUID via `buildVideoKeys`, never from raw user input.

---

### SI-03.4 — Video Entity, Status Enum, and Migration

**Description:** Create the `Video` entity linked to `Channel`, with the status enum and the unique `public_id`, and generate the migration that creates the `videos` table.

**Technical actions:**

1. Create `src/videos/entities/video.entity.ts` — `@Entity('videos')` with the columns in `## Technical Specifications → Data Model` (uuid PK, `public_id` unique, `channel_id` FK, `title`, `status` enum default `'draft'`, storage/thumbnail keys, `upload_id`, `duration_seconds`, `metadata` jsonb, `size_bytes`, `original_filename`, `mime_type`, `error_reason`, timestamps). Define `@ManyToOne(() => Channel)` with `@JoinColumn({ name: 'channel_id' })`.
2. Add the inverse `@OneToMany(() => Video, (v) => v.channel)` relation to `src/channels/entities/channel.entity.ts`.
3. Define the PostgreSQL enum `videos_status_enum` with values `draft`, `processing`, `ready`, `failed` (per `phase-03-videos/TD-08`), following the existing `verification_tokens_type_enum` precedent.
4. Generate the migration via `npm run migration:generate -- src/database/migrations/CreateVideos` and review the SQL (enum type, unique index on `public_id`, FK to `channels`, indexes on `channel_id` and `status`).

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `Video` | Integration (real DB) | `src/videos/entities/video.entity.integration-spec.ts` — unique `public_id` constraint, `status` defaults to `'draft'`, FK to channel enforced, `metadata` jsonb round-trips, timestamps auto-populate |
| migration | Integration | `src/database/migrations.integration-spec.ts` (extend) — `runMigrations` creates `videos`; `undoLastMigration` drops it and the enum type |

**Dependencies:** SI-03.1

**Acceptance criteria:**

- `npm run migration:run` creates the `videos` table with all columns, the `videos_status_enum` type, a unique index on `public_id`, and an FK to `channels`.
- Inserting a video with a duplicate `public_id` fails with a unique constraint violation.
- A newly inserted video without an explicit status has `status = 'draft'`.
- Inserting a video referencing a non-existent `channel_id` fails with a FK violation.
- `dataSource.undoLastMigration()` removes the `videos` table and the `videos_status_enum` type.

---

### SI-03.5 — Videos Module, Domain Exceptions, and Queue Registration

**Description:** Create the `VideosModule` wiring the entity, storage, channels, and the BullMQ `video-processing` queue (producer side), and define the Phase 03 domain exceptions extending the inherited `DomainException`.

**Technical actions:**

1. Create `src/videos/videos.module.ts` — `TypeOrmModule.forFeature([Video])`, import `StorageModule` and `ChannelsModule`, register the queue via `BullModule.registerQueue({ name: 'video-processing' })` (per `phase-03-videos/TD-01`); declare `VideosService` + `VideosController`; register `BullModule.forRootAsync` (Redis connection from `queueConfig`) in `AppModule` and import `VideosModule` there.
2. Create `src/videos/videos.constants.ts` — export `VIDEO_PROCESSING_QUEUE = 'video-processing'` and `VIDEO_PROCESS_JOB = 'process'` (the producer/consumer contract).
3. Add `findByUserId(userId): Promise<Channel | null>` to `ChannelsService` (resolves the caller's channel from the JWT `sub`) — keeps channel ownership inside `ChannelsModule` (single responsibility).
4. Create `src/videos/exceptions/video.exceptions.ts` — `VideoNotFoundException` (404 `VIDEO_NOT_FOUND`), `VideoAccessDeniedException` (403 `VIDEO_ACCESS_DENIED`), `InvalidVideoStateException` (409 `INVALID_VIDEO_STATE`), `VideoNotReadyException` (409 `VIDEO_NOT_READY`), `InvalidUploadException` (400 `INVALID_UPLOAD`), `FileTooLargeException` (413 `FILE_TOO_LARGE`), `UnsupportedMediaTypeException` (415 `UNSUPPORTED_MEDIA_TYPE`) — all extending `DomainException` (per inherited `phase-02-auth/TD-07`).
5. Create `src/videos/videos.module.spec.ts` skeleton wiring (compilation test authored in Tests).

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosModule` | Unit (compilation) | `src/videos/videos.module.spec.ts` — resolves with TypeORM forFeature, BullModule.registerQueue, StorageModule, ChannelsModule |
| `ChannelsService.findByUserId` | Integration | `src/channels/channels.service.integration-spec.ts` (extend) — returns the channel for a user_id, null when absent |

**Dependencies:** SI-03.3, SI-03.4

**Acceptance criteria:**

- `VideosModule` compiles with all DI wiring resolved, including the `video-processing` queue registration.
- `ChannelsService.findByUserId` returns the channel owned by a given user id and `null` when none exists.
- Each new domain exception maps through the existing global `DomainExceptionFilter` to `{ statusCode, error, message }` with the documented code.
- The queue name and job name are sourced from `videos.constants.ts` (single shared contract between API and worker).

---

### SI-03.6 — Upload Initiation (draft pre-register + multipart presigned URLs)

**Description:** Implement `POST /videos` — resolve the caller's channel, pre-register the video as a `draft` with a unique `public_id`, initiate the multipart upload, and return one presigned URL per part so the client uploads the file directly to storage.

**Technical actions:**

1. Create `src/videos/dto/initiate-upload.dto.ts` — `title` (string, required, max length), `filename` (string, required), `mimeType` (string, required, must start with `video/`), `sizeBytes` (int, required, ≤ `uploadConfig.maxSizeBytes`).
2. In `src/videos/videos.service.ts`, implement `initiateUpload(userId, dto)` — resolve channel via `ChannelsService.findByUserId` (throw if none); validate `mimeType` (`UnsupportedMediaTypeException`) and `sizeBytes` (`FileTooLargeException`); generate `public_id` via `nanoid(11)` with regenerate-on-`23505` retry (per `phase-03-videos/TD-06`); compute part count from `uploadConfig.partSizeBytes`; build keys via `StorageService.buildVideoKeys`; `createMultipartUpload`; persist the `draft` row (channel_id, title, keys, upload_id, size/mime/filename); `presignUploadParts`; return the contract in `## API Contracts`.
3. Create `src/videos/videos.controller.ts` — `@Controller('videos')`, `@ApiTags('videos')`; `@Post()` (JWT-protected, default guard) calling `initiateUpload` with `@CurrentUser()`, documented with `@ApiBearerAuth('access-token')` + `@ApiOperation`/`@ApiResponse`.

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService.initiateUpload` | Unit | `src/videos/videos.service.spec.ts` — rejects non-video mime / oversized; computes part count; regenerates public_id on collision (mock repo + storage) |
| `VideosService.initiateUpload` | Integration | `src/videos/videos.service.integration-spec.ts` — persists a `draft` row with a unique public_id and a real `upload_id` from MinIO |
| `POST /videos` | E2E | `test/videos.e2e-spec.ts` — 201 with `{ publicId, uploadId, parts[] }` for an authed user; 401 without token; 400 invalid body; 413 oversized; 415 non-video mime |

**Dependencies:** SI-03.5

**Acceptance criteria:**

- `POST /videos` with a valid body and a Bearer token returns 201 with `{ publicId, uploadId, key, partSize, parts: [{ partNumber, url }] }`, and a `draft` video row is persisted on the caller's channel.
- `POST /videos` without a token returns 401.
- `POST /videos` with `mimeType` not starting with `video/` returns 415 `UNSUPPORTED_MEDIA_TYPE`; with `sizeBytes` above the 10GB limit returns 413 `FILE_TOO_LARGE`; with a missing/invalid field returns 400.
- The returned `publicId` is a unique ~11-char nanoid; two concurrent initiations never produce the same `public_id`.
- The file content never passes through the API process — only presigned URLs are generated and returned.

---

### SI-03.7 — Upload Completion (enqueue) and Abort

**Description:** Implement `POST /videos/:publicId/complete` (finalize the multipart upload, flip to `processing`, enqueue the processing job) and `POST /videos/:publicId/abort` (abort the multipart upload, delete the draft) — both owner-only.

**Technical actions:**

1. Create `src/videos/dto/complete-upload.dto.ts` — `parts: { partNumber: int; etag: string }[]` (required, non-empty, validated nested).
2. In `VideosService`, implement `completeUpload(userId, publicId, dto)` — load the video by `public_id` (`VideoNotFoundException`); assert ownership against the caller's channel (`VideoAccessDeniedException`); assert `status === 'draft'` (`InvalidVideoStateException`); `StorageService.completeMultipartUpload`; set `status = 'processing'`; enqueue `VIDEO_PROCESS_JOB` on the `video-processing` queue with `{ videoId }`, `attempts: 3`, exponential backoff, `removeOnFail: false` (per `phase-03-videos/TD-01`, `TD-08`). On invalid parts surface `InvalidUploadException`.
3. In `VideosService`, implement `abortUpload(userId, publicId)` — load + ownership + `status === 'draft'` checks; `StorageService.abortMultipartUpload`; delete the draft row.
4. Add `@Post(':publicId/complete')` (200) and `@Post(':publicId/abort')` (204) to `VideosController`, JWT-protected, using `@CurrentUser()`.

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService.completeUpload`/`abortUpload` | Unit | `src/videos/videos.service.spec.ts` (extend) — ownership + state guards; enqueues job on complete; aborts + deletes on abort |
| completion flow | Integration | `src/videos/videos.service.integration-spec.ts` (extend) — real MinIO complete + real queue receives a job with `{ videoId }`; status transitions to `processing` |
| `POST /videos/:publicId/complete` + `/abort` | E2E | `test/videos.e2e-spec.ts` (extend) — complete returns 200 `{ status: 'processing' }`; non-owner 403; non-draft 409; abort returns 204 and removes the draft |

**Dependencies:** SI-03.6

**Acceptance criteria:**

- `POST /videos/:publicId/complete` by the owner with valid parts returns 200 with `{ publicId, status: 'processing' }`, the object is finalized in storage, and a `video-processing` job carrying `{ videoId }` is enqueued.
- `POST /videos/:publicId/complete` by a non-owner returns 403 `VIDEO_ACCESS_DENIED`; on a video not in `draft` returns 409 `INVALID_VIDEO_STATE`.
- `POST /videos/:publicId/abort` by the owner returns 204, aborts the multipart upload in storage, and deletes the draft row.
- Completing or aborting an unknown `publicId` returns 404 `VIDEO_NOT_FOUND`.

---

### SI-03.8 — Worker Bootstrap (standalone entrypoint)

**Description:** Add a separate worker entrypoint that boots a NestJS standalone application context (no HTTP listener) wiring only the modules the processor needs, started by the `video-worker` Compose service.

**Technical actions:**

1. Create `src/worker.ts` — `NestFactory.createApplicationContext(WorkerModule)` (per `phase-03-videos/TD-05`); enables graceful shutdown hooks; no `app.listen()`.
2. Create `src/worker/worker.module.ts` — imports `ConfigModule` (global), `TypeOrmModule.forRootAsync` (same factory as `AppModule`), `BullModule.forRootAsync` (Redis), `TypeOrmModule.forFeature([Video])`, `StorageModule`, and declares the processor (SI-03.9).
3. Add `start:worker` (`ts-node src/worker.ts` / `node dist/worker`) script to `package.json`; ensure `Dockerfile.worker`'s command runs it.
4. Ensure the API process does NOT register the processor (producer-only) — the `@Processor` lives in `WorkerModule`, imported only by `worker.ts`.

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `WorkerModule` | Unit (compilation) | `src/worker/worker.module.spec.ts` — resolves with TypeORM, BullModule, StorageModule, and the processor provider |

**Dependencies:** SI-03.5

**Acceptance criteria:**

- `npm run start:worker` boots a standalone Nest context that connects to the DB, Redis, and MinIO and stays alive consuming the `video-processing` queue, without opening an HTTP port.
- The `video-worker` Compose service runs the worker entrypoint and reports healthy alongside the stack.
- The API process registers the queue as a producer only — it does not instantiate the `@Processor`.

---

### SI-03.9 — Video Processing Processor (metadata + thumbnail + status lifecycle)

**Description:** Implement the BullMQ processor that, per job, downloads the source from storage, extracts duration/metadata via ffprobe, generates a thumbnail frame via FFmpeg, uploads the thumbnail, persists results, and transitions the video to `ready` — or to `failed` after retries are exhausted.

**Technical actions:**

1. Create `src/worker/video-processing.processor.ts` — `@Processor(VIDEO_PROCESSING_QUEUE)` extending `WorkerHost`; `process(job)` loads the video by id, streams the original from storage to a temp file via `StorageService.getObjectToFile` (10GB-safe, disk-bounded) (per `phase-03-videos/TD-04`).
2. Extract metadata with `fluent-ffmpeg`'s `ffprobe` (duration, width, height, codec, container, bitrate); generate a thumbnail with `.screenshots({ timestamps: ['50%'], folder: <existing tmp dir> })` — create the output dir first (per `library-refs.md` gotcha).
3. Upload the thumbnail to the `thumbnail_key` via `StorageService.putObject`; persist `duration_seconds`, `metadata` (jsonb), `thumbnail_key`, and set `status = 'ready'`; delete the temp files in a `finally`.
4. On a thrown error, let BullMQ retry (attempts/backoff from the producer). Implement the failed-state transition: when the job's final attempt fails, set `status = 'failed'` and record `error_reason` (via the processor's failure path / `onFailed`), leaving the job in the dead-letter (failed) set (per `phase-03-videos/TD-08`).

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideoProcessingProcessor` | Integration (real FFmpeg + MinIO + Redis + DB) | `src/worker/video-processing.processor.integration-spec.ts` — given a small sample video object, the processor extracts a non-zero duration, writes a thumbnail object, persists metadata, and flips status to `ready` |
| failure path | Integration | same spec — a corrupt/non-video object drives the video to `status = 'failed'` with `error_reason` set after retries are exhausted |

**Dependencies:** SI-03.7, SI-03.8

**Acceptance criteria:**

- After a completed upload is processed, the video row has a non-zero `duration_seconds`, populated `metadata`, a `thumbnail_key`, and `status = 'ready'`.
- A thumbnail object exists in storage at the video's `thumbnail_key` after processing.
- Processing a corrupt/non-video file drives the video to `status = 'failed'` with a recorded `error_reason`, and the failed job is retained for inspection.
- The source file is streamed to disk (not buffered in memory), and temp files are removed after each job regardless of outcome.

---

### SI-03.10 — Video Metadata Endpoint

**Description:** Implement `GET /videos/:publicId` returning the public-facing video metadata and status, so a client can poll processing progress and read playback info.

**Technical actions:**

1. In `VideosService`, implement `getByPublicId(publicId): Promise<VideoView>` — load by `public_id` (`VideoNotFoundException`); map to a view object (`publicId`, `title`, `status`, `durationSeconds`, `metadata`, `channelId`, `createdAt`, and a `thumbnailUrl`/`streamUrl` derived from `publicId`).
2. Create `src/videos/dto/video-view.dto.ts` documenting the response shape for Swagger (`@ApiProperty`).
3. Add `@Public() @Get(':publicId')` to `VideosController` (200), documented with `@ApiOperation`/`@ApiResponse`.

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService.getByPublicId` | Unit | `src/videos/videos.service.spec.ts` (extend) — maps entity to view; throws on unknown public_id |
| `GET /videos/:publicId` | E2E | `test/videos.e2e-spec.ts` (extend) — 200 with metadata for an existing video (anonymous), 404 for unknown publicId |

**Dependencies:** SI-03.5

**Acceptance criteria:**

- `GET /videos/:publicId` returns 200 with `{ publicId, title, status, durationSeconds, metadata, thumbnailUrl, streamUrl }` for an existing video, accessible anonymously.
- `GET /videos/:publicId` for an unknown id returns 404 `VIDEO_NOT_FOUND`.
- A client can observe the status field transition from `processing` to `ready` by polling this endpoint after completing an upload.

---

### SI-03.11 — Streaming Endpoint (Range / 206 Partial Content)

**Description:** Implement `GET /videos/:publicId/stream` serving the video bytes with HTTP Range support (206 Partial Content), fetching only the requested byte range from storage so playback starts without a full download.

**Technical actions:**

1. In `VideosService`, implement `openStream(publicId, range?)` — load by `public_id`; require `status === 'ready'` (`VideoNotReadyException`); parse the `Range` header into start/end (default full); call `StorageService.getObjectRange(storage_key, range)` and return the stream + headers (per `phase-03-videos/TD-07`).
2. Add `@Public() @Get(':publicId/stream')` to `VideosController` — read the `Range` request header, and when a range is present set status `206` with `Content-Range`, `Accept-Ranges: bytes`, `Content-Length`, `Content-Type`, then pipe the storage stream to the Express `Response`; for no-range requests respond `200` with `Accept-Ranges: bytes`.
3. Ensure the stream is piped (never buffered) and upstream/downstream errors are handled (destroy the response on stream error).

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `GET /videos/:publicId/stream` | E2E | `test/videos.e2e-spec.ts` (extend) — with `Range: bytes=0-{n}` returns 206 + `Content-Range` + the requested slice length (anonymous); without Range returns 200 + `Accept-Ranges: bytes`; a non-`ready` video returns 409 `VIDEO_NOT_READY`; unknown publicId 404 |

**Dependencies:** SI-03.9, SI-03.10

**Acceptance criteria:**

- `GET /videos/:publicId/stream` with `Range: bytes=0-1023` on a `ready` video returns 206 with `Content-Range: bytes 0-1023/<total>`, `Accept-Ranges: bytes`, and exactly the requested bytes — accessible anonymously.
- The same endpoint without a `Range` header returns 200 with `Accept-Ranges: bytes` and the full body streamed (not buffered in the API).
- Streaming a video whose `status` is not `ready` returns 409 `VIDEO_NOT_READY`; an unknown `publicId` returns 404.
- Only the requested byte range is fetched from storage (the API does not download the whole object to serve a partial request).

---

### SI-03.12 — Download Endpoint

**Description:** Implement `GET /videos/:publicId/download` serving the full video as an attachment, reusing the range-capable storage read.

**Technical actions:**

1. In `VideosService`, reuse `openStream`/`getObjectRange` to expose `openDownload(publicId)` returning the full object stream + `Content-Length`/`Content-Type` (require `status === 'ready'`).
2. Add `@Public() @Get(':publicId/download')` to `VideosController` — set `Content-Disposition: attachment; filename="<original_filename>"`, `Content-Type`, `Content-Length`, and pipe the stream to the response.

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `GET /videos/:publicId/download` | E2E | `test/videos.e2e-spec.ts` (extend) — returns 200 with `Content-Disposition: attachment` and the full body for a `ready` video (anonymous); 409 when not ready; 404 unknown |

**Dependencies:** SI-03.11

**Acceptance criteria:**

- `GET /videos/:publicId/download` on a `ready` video returns 200 with `Content-Disposition: attachment; filename="..."` and the full file body, accessible anonymously.
- Downloading a non-`ready` video returns 409 `VIDEO_NOT_READY`; an unknown `publicId` returns 404.
- The response body is streamed from storage (not buffered in the API process).

---

## Technical Specifications

### Data Model

#### Video

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| id | uuid | PK, generated | Internal identifier; never exposed in URLs |
| public_id | varchar(16) | unique, not null | nanoid(11), URL identifier (per `phase-03-videos/TD-06`) |
| channel_id | uuid | FK → channels.id, not null | Owning channel (per `phase-03-videos/TD-08`) |
| title | varchar(255) | not null | Provided at upload initiation |
| status | enum `videos_status_enum` | not null, default `'draft'` | `draft` → `processing` → `ready` / `failed` (per `phase-03-videos/TD-08`) |
| storage_key | varchar | not null | `videos/{id}/original/{filename}` (per `phase-03-videos/TD-03`) |
| thumbnail_key | varchar | nullable | `videos/{id}/thumbnail.jpg`; set when processed |
| upload_id | varchar | nullable | S3/MinIO multipart `UploadId`; cleared after completion |
| duration_seconds | double precision | nullable | Extracted by ffprobe (per `phase-03-videos/TD-04`) |
| metadata | jsonb | nullable | `{ width, height, codec, container, bitrate }` |
| size_bytes | bigint | nullable | Declared file size |
| original_filename | varchar | nullable | For download `Content-Disposition` |
| mime_type | varchar | nullable | Must be `video/*` |
| error_reason | text | nullable | Set when `status = 'failed'` |
| created_at | timestamp | not null, auto | `@CreateDateColumn` |
| updated_at | timestamp | not null, auto | `@UpdateDateColumn` |

**Relations:** Video → Channel (many-to-one via `channel_id`); Channel → Video (one-to-many).
**Indexes:** `(public_id)` — unique; `(channel_id)` — FK; `(status)`.

---

### API Contracts

#### POST /videos (SI-03.6)

**Request headers:** Authorization: Bearer `<access_token>`; Content-Type: application/json

**Request body:**
- title: string, required
- filename: string, required
- mimeType: string, required — must start with `video/`
- sizeBytes: integer, required — ≤ `UPLOAD_MAX_SIZE_BYTES` (10GB)

**Response 201:**
- publicId: string (nanoid)
- uploadId: string (multipart UploadId)
- key: string (storage key)
- partSize: integer (bytes)
- parts: array of `{ partNumber: integer, url: string (presigned PUT) }`

**Error responses:** 401 (no/invalid token); 400 VALIDATION_ERROR; 413 FILE_TOO_LARGE; 415 UNSUPPORTED_MEDIA_TYPE.

---

#### POST /videos/:publicId/complete (SI-03.7)

**Request headers:** Authorization: Bearer `<access_token>`; Content-Type: application/json

**Request body:**
- parts: array of `{ partNumber: integer, etag: string }`, required, non-empty

**Response 200:**
- publicId: string
- status: string (`'processing'`)

**Error responses:** 401; 403 VIDEO_ACCESS_DENIED; 404 VIDEO_NOT_FOUND; 409 INVALID_VIDEO_STATE; 400 INVALID_UPLOAD.

---

#### POST /videos/:publicId/abort (SI-03.7)

**Request headers:** Authorization: Bearer `<access_token>`

**Response 204:** No content.

**Error responses:** 401; 403 VIDEO_ACCESS_DENIED; 404 VIDEO_NOT_FOUND; 409 INVALID_VIDEO_STATE.

---

#### GET /videos/:publicId (SI-03.10)

**Response 200:**
- publicId: string
- title: string
- status: string (`draft` | `processing` | `ready` | `failed`)
- durationSeconds: number | null
- metadata: object | null
- thumbnailUrl: string | null
- streamUrl: string
- channelId: string
- createdAt: string (ISO)

**Error responses:** 404 VIDEO_NOT_FOUND.

---

#### GET /videos/:publicId/stream (SI-03.11)

**Request headers:** Range: bytes=start-end (optional)

**Response 206 (with Range):** headers `Content-Range: bytes start-end/total`, `Accept-Ranges: bytes`, `Content-Length`, `Content-Type`; body = requested byte slice.
**Response 200 (no Range):** headers `Accept-Ranges: bytes`, `Content-Type`, `Content-Length`; body = full stream.

**Error responses:** 404 VIDEO_NOT_FOUND; 409 VIDEO_NOT_READY.

---

#### GET /videos/:publicId/download (SI-03.12)

**Response 200:** headers `Content-Disposition: attachment; filename="<original_filename>"`, `Content-Type`, `Content-Length`; body = full stream.

**Error responses:** 404 VIDEO_NOT_FOUND; 409 VIDEO_NOT_READY.

#### Validation Rules — Upload

| Field | Rule | Error |
|-------|------|-------|
| title | non-empty string | 400 VALIDATION_ERROR |
| filename | non-empty string | 400 VALIDATION_ERROR |
| mimeType | must start with `video/` | 415 UNSUPPORTED_MEDIA_TYPE |
| sizeBytes | integer, 1 .. `UPLOAD_MAX_SIZE_BYTES` | 413 FILE_TOO_LARGE / 400 |
| parts[] | non-empty array of `{ partNumber, etag }` | 400 INVALID_UPLOAD |

---

### Authorization Matrix

| Endpoint | Public | Authenticated | Owner-only | Notes |
|----------|--------|---------------|-----------|-------|
| POST /videos | | ✓ | | Creates draft on the caller's channel |
| POST /videos/:publicId/complete | | ✓ | ✓ | Caller's channel must own the video |
| POST /videos/:publicId/abort | | ✓ | ✓ | Caller's channel must own the video |
| GET /videos/:publicId | ✓ | | | Anonymous watch (status + metadata) |
| GET /videos/:publicId/stream | ✓ | | | Anonymous playback; only `ready` videos |
| GET /videos/:publicId/download | ✓ | | | Anonymous download; only `ready` videos |

Ownership is enforced in the service by resolving the caller's channel (`ChannelsService.findByUserId` on the JWT `sub`) and comparing it to the video's `channel_id`. Public endpoints use the inherited `@Public()` opt-out (per `phase-02-auth/TD-02`).

---

### Error Catalog

**Error response format:** `{ statusCode: number, error: string, message: string }` (inherited from `phase-02-auth/TD-07`; new codes extend `DomainException`).

| Code | HTTP | Message | Trigger |
|------|------|---------|---------|
| VIDEO_NOT_FOUND | 404 | Video not found | Any `:publicId` route with an unknown id |
| VIDEO_ACCESS_DENIED | 403 | You do not own this video | complete/abort by a non-owner |
| INVALID_VIDEO_STATE | 409 | Video is not in a valid state for this operation | complete/abort on a non-`draft` video |
| VIDEO_NOT_READY | 409 | Video is not ready for playback | stream/download on a non-`ready` video |
| INVALID_UPLOAD | 400 | Invalid multipart upload parts | complete with malformed/empty parts |
| FILE_TOO_LARGE | 413 | File exceeds the maximum allowed size | initiate with `sizeBytes` > 10GB |
| UNSUPPORTED_MEDIA_TYPE | 415 | Only video files are supported | initiate with a non-`video/*` mimeType |

---

### Events/Messages

#### video-processing / process

**Payload:**

```json
{ "videoId": "uuid" }
```

**Producer:** `VideosService.completeUpload` (per `phase-03-videos/TD-01`, `phase-03-videos/TD-02`)
**Consumer:** `VideoProcessingProcessor` in the `video-worker` service (per `phase-03-videos/TD-05`)
**Trigger:** fires when the owner successfully completes the multipart upload (`POST /videos/:publicId/complete`), right after the status flips to `processing`.
**Delivery semantics:** at-least-once — BullMQ persists the job in Redis with `attempts: 3` and exponential backoff; the consumer is idempotent (re-reads the video row and re-derives keys), and after exhausting retries the job is retained in the failed (dead-letter) set while the video row is set to `failed` with an `error_reason` (per `phase-03-videos/TD-08`).

---

## Dependency Map

```
SI-03.1 (no deps)
├── SI-03.2 — Compose infra (MinIO + Redis + worker image)
│   └── SI-03.3 — Storage service (needs MinIO)
└── SI-03.4 — Video entity + migration

SI-03.3 + SI-03.4
└── SI-03.5 — Videos module + exceptions + queue registration
    ├── SI-03.6 — Upload initiation
    │   └── SI-03.7 — Complete + abort (enqueue)
    │       └── SI-03.9 — Processing processor (needs SI-03.8)
    ├── SI-03.8 — Worker bootstrap
    │   └── SI-03.9
    └── SI-03.10 — Metadata endpoint
        └── SI-03.11 — Streaming (needs SI-03.9 for ready videos)
            └── SI-03.12 — Download
```

Linearized implementation order: SI-03.1 → SI-03.2 → SI-03.3, SI-03.4 (parallel) → SI-03.5 → SI-03.6 → SI-03.7 → SI-03.8 → SI-03.9 → SI-03.10 → SI-03.11 → SI-03.12

---

## Deliverables

- [ ] SI-03.1 — Dependencies, configuration namespaces, env validation
- [ ] SI-03.2 — Docker Compose infrastructure (MinIO + Redis) and worker image
- [ ] SI-03.3 — Object storage service (S3/MinIO adapter)
- [ ] SI-03.4 — Video entity, status enum, and migration
- [ ] SI-03.5 — Videos module, domain exceptions, queue registration
- [ ] SI-03.6 — Upload initiation (draft + multipart presigned URLs)
- [ ] SI-03.7 — Upload completion (enqueue) and abort
- [ ] SI-03.8 — Worker bootstrap (standalone entrypoint)
- [ ] SI-03.9 — Video processing processor (metadata + thumbnail + status)
- [ ] SI-03.10 — Video metadata endpoint
- [ ] SI-03.11 — Streaming endpoint (Range/206)
- [ ] SI-03.12 — Download endpoint

**Feature deliverables (from the project plan):**

- [ ] Upload of up to 10GB without blocking the API (multipart presigned, direct to storage), with the video pre-registered as `draft` at initiation
- [ ] Automatic processing after upload: duration/metadata extraction and thumbnail generation
- [ ] Unique public URL per video (nanoid `public_id`), no conflicts
- [ ] Streaming (Range/206, no full download required) and download available
- [ ] Video status lifecycle (`draft → processing → ready/failed`) reflected in the database
- [ ] Object storage, queue, and worker run via `docker compose` alongside the backend

**Full test suites:**

- [ ] Backend tests pass (`docker compose exec nestjs-api npm test -- --runInBand`)
- [ ] E2E tests pass (`docker compose exec nestjs-api npm run test:e2e`)
- [ ] Type/compilation check passes (`docker compose exec nestjs-api npx tsc --noEmit`)
- [ ] Lint passes (`docker compose exec nestjs-api npm run lint`)
- [ ] Project builds successfully (`docker compose exec nestjs-api npm run build`)
