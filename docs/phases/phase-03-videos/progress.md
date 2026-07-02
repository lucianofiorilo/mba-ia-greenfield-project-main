# phase-03-videos — Progress

**Status:** in_progress
**SIs:** 10/12 completed

> **Resume next session at SI-03.11 (Streaming Endpoint — Range/206).** The full
> upload→process pipeline works end to end and the public metadata read
> (`GET /videos/:publicId`, 03.10) is live. Remaining are the two byte-serving
> read endpoints: 03.11 (`GET /videos/:publicId/stream` Range/206) and 03.12
> (`GET /videos/:publicId/download`). DoD green through SI-03.10: `tsc` clean,
> lint 0, 185 unit/integration, 66 e2e.
>
> **Worker is now profile-gated** (`profiles: ["worker"]`) — it does NOT
> autostart with the stack (per the convention that only infra autostarts;
> app processes are started on demand, like the nestjs-api server). To exercise
> the live pipeline: `docker compose --profile worker up -d video-worker`. The
> processor is covered by direct-call integration tests, so the test suite needs
> no live consumer. Docker infra (db/redis/minio/api) must be up before
> implementing/testing; run e2e with `npm run test:e2e`.
>
> Note: the integration suite has a pre-existing intermittent flake (`mail`,
> occasionally `auth`/`video.entity` before the 03.9 cleanup fix) tied to the
> single shared DB + mailpit — each passes clean in isolation and on re-run. Not
> a regression; a real fix would isolate per-suite DB state (future task).
>
> Branch `feature/phase-03-videos`; commits not yet pushed to `origin`.

### SI-03.1 — Dependencies, Configuration Namespaces, and Env Validation
- **Status:** completed
- **Tests:** 4/4 passing (env.validation.spec.ts)
- **Observations:**
  - Test authored as a unit `*.spec.ts` (pure Joi schema validation, no I/O) rather than the plan's `*.integration-spec.ts` label — per the testing guide, suffix follows behavior. The "app boots with the new vars" AC is covered by the existing `app.e2e-spec.ts` against the populated `.env`.
  - Created `.env` from `.env.example` (was absent) with `DB_HOST=db` and quoted `MAIL_FROM`; S3 creds = MinIO root (`streamtube`/`streamtube`).

### SI-03.2 — Docker Compose Infrastructure (MinIO + Redis) and Worker Image
- **Status:** completed
- **Tests:** no tests (infra) — verified live: minio + redis healthy, ffmpeg 5.1 + ffprobe in worker, service-name connectivity (minio:9000, redis:6379)
- **Observations:**
  - `Dockerfile.worker` CMD is `tail -f /dev/null` (mirrors `Dockerfile.dev`); the worker process is started via the Compose service command in SI-03.8 (`npm run start:worker`, which does not exist yet).
  - MinIO healthcheck uses `curl -f /minio/health/live` (curl is present in the minio image). Added `minio-data` named volume.

### SI-03.3 — Object Storage Service (S3/MinIO adapter)
- **Status:** completed
- **Tests:** 4/4 passing (storage.service.integration-spec.ts: 3 against real MinIO; storage.module.spec.ts: 1 compilation)
- **Observations:**
  - `StorageService` also injects `uploadConfig` (presigned URL TTL) beyond the plan's mention of `storageConfig` — needed for `presignUploadParts`. `buildVideoKeys` exported from `storage.service.ts`.
  - Integration test uploads parts via global `fetch` to the presigned URL (host `minio:9000`), proving the direct-to-storage path end-to-end.

### SI-03.4 — Video Entity, Status Enum, and Migration
- **Status:** completed
- **Tests:** 6/6 passing (video.entity.integration-spec.ts: 4; migrations.integration-spec.ts: 2 extended)
- **Observations:**
  - `size_bytes` is `bigint` → TypeORM maps it to `string | null` in JS (precision-safe). Added `@Index()` on `channel_id` and `status` per the Data Model.
  - Extended `migrations.integration-spec.ts` for the 3rd migration (CreateVideos) and made its `beforeAll` drop the managed enum types (`DROP TYPE IF EXISTS ... CASCADE`) — `DROP TABLE CASCADE` does not remove standalone enum types, so this prevents "type already exists" when a prior synchronize suite created them.

### SI-03.5 — Videos Module, Domain Exceptions, and Queue Registration
- **Status:** completed
- **Tests:** videos.module.spec.ts (1, compilation) + channels.service.integration-spec.ts findByUserId (2) — passing; full unit+integration suite 159/159 green
- **Observations:**
  - `VideosService`/`VideosController` created as shells here (constructor + DI only); behavior methods/routes are added in SI-03.6+. `BullModule.forRootAsync` (Redis) registered in `AppModule`.
  - **Ripple 1 (inverse relation):** adding `Channel.videos` `@OneToMany` requires `Video` in every test DataSource that registers `Channel` — added `Video` to 10 inherited Phase 02 test entity lists (otherwise `initialize()` throws "metadata for Channel#videos not found").
  - **Ripple 2 (required env):** making `S3_*` required in the Joi schema broke the inherited `env.validation.integration-spec.ts` (its `requiredEnv` lacked S3) — added the S3 vars to its baseline.
  - **Lint debt (user decision):** the inherited Phase 02 code already failed `npm run lint` (150 errors from `recommendedTypeChecked` on `any` in test files). Per user choice, added an eslint override exempting test files (`*.spec.ts`/`*.integration-spec.ts`/`*.e2e-spec.ts`/`src/test/**`) from the type-aware safety rules; production `src` stays fully checked. Also fixed the one production offender properly: `channels.service.ts` now reads `err.driverError.code/detail` (correct TypeORM shape) instead of `err as any` — unit-test mock updated to wrap the driver error accordingly. Lint now exits 0.

### SI-03.6 — Upload Initiation (draft pre-register + multipart presigned URLs)
- **Status:** completed (commit `d995bd5`)
- **Tests:** unit `videos.service.spec.ts` (6) + integration `videos.service.integration-spec.ts` (2, real MinIO) + e2e `videos.e2e-spec.ts` (5: 201/401/400/415/413) — all passing
- **Observations:**
  - `initiateUpload`: resolves channel via `ChannelsService.findByUserId`, validates `video/*` mime + size ceiling, generates an **app-side UUID** (`randomUUID()`) so the storage key is fixed before persistence, opens the multipart upload, persists the draft, and presigns one PUT URL per part.
  - The draft is written with `repository.insert` (not `save`): `save` with a populated PK would attempt an UPDATE, and `insert` cleanly surfaces the `23505` unique violation that drives the nanoid `public_id` regenerate-and-retry loop. The storage key derives from the UUID, not `public_id`, so a regeneration never invalidates the already-opened upload.
  - **New cross-module artifact:** `ChannelNotFoundException` was created in the **channels** domain (`src/channels/exceptions/`), not in videos — a missing-channel error belongs to the channel domain (SRP). Maps to 404 `CHANNEL_NOT_FOUND`.
  - **Test-infra fix (separate commit `1259941`):** running the full DoD suite exposed two pre-existing drifts. (1) `cleanAllTables` didn't know about the new `videos` table, so any suite deleting `channels` could trip the `videos→channels` FK — it now wipes `videos` first. (2) `test:e2e` ran in parallel without `--runInBand` (contradicting CLAUDE.md and risking shared-DB FK violations) and `jest-e2e.json` had no `testTimeout`, so cold `AppModule` boots (Redis+MinIO+TypeORM) intermittently exceeded the 5s `beforeAll` default and failed auth/app/swagger. Added `--runInBand` to the script and `testTimeout: 30000` to the config.

### SI-03.7 — Upload Completion (enqueue) and Abort
- **Status:** completed (commit `145f7d5`)
- **Tests:** unit `videos.service.spec.ts` (+8: complete/abort guards, enqueue, error mapping) + integration `videos.service.integration-spec.ts` (+2: real complete with MinIO part upload + real BullMQ job assertion; abort deletes draft) + e2e `videos.e2e-spec.ts` (+7: complete 200/403/409/404/401, abort 204/403) — all passing
- **Observations:**
  - `loadOwnedDraft(userId, publicId)` is the shared precondition for both operations: 404 `VIDEO_NOT_FOUND` → 403 `VIDEO_ACCESS_DENIED` (channel mismatch) → 409 `INVALID_VIDEO_STATE` (not a draft).
  - `completeUpload`: `completeMultipartUpload` → `status='processing'` → `queue.add(VIDEO_PROCESS_JOB, { videoId }, VIDEO_JOB_OPTIONS)`. `VIDEO_JOB_OPTIONS` (new constant) = `attempts: 3`, exponential backoff (5000ms), `removeOnComplete: true`, `removeOnFail: false` (dead-letter for inspection / `status='failed'` mapping in 03.9).
  - **Storage error mapping (never-swallow rule):** S3/MinIO client-side errors on completion (`InvalidPart`, `InvalidPartOrder`, `EntityTooSmall`, `NoSuchUpload`, `MalformedXML`, or any 4xx `$metadata.httpStatusCode`) map to 400 `InvalidUploadException`; 5xx/network errors propagate unchanged so a transient storage fault is never reported to the client as bad input.
  - `abortUpload`: `abortMultipartUpload` (guarded on `upload_id`) → `repository.delete({ id })`.
  - The integration test switched the stubbed queue for a **real BullMQ** (`BullModule.forRootAsync` + `registerQueue`, `queueConfig`) — BullMQ is a configured lib and is not mocked (testing-guide §1). It uploads a real part to MinIO via global `fetch` (Node 25) to obtain a genuine ETag before completing. `moduleRef.close()` in `afterAll` closes the Redis + DB connections; the queue is obliterated in `beforeEach`.

### SI-03.8 — Worker Bootstrap (standalone entrypoint)
- **Status:** completed
- **Tests:** unit `worker.module.spec.ts` (1, compilation) — resolves `DataSource`, the registered `video-processing` queue token, and `StorageService`; full unit+integration 178/178 + e2e 64/64 green
- **Observations:**
  - `src/worker.ts` boots `NestFactory.createApplicationContext(WorkerModule)` (no `app.listen()`); the open DB pool + Redis/BullMQ handles keep the process alive; `enableShutdownHooks()` closes them on SIGTERM/SIGINT. Verified live: worker logs `Video worker started`, connects to db/redis/minio, stays `Up` with no HTTP port.
  - `WorkerModule` mirrors `AppModule`'s infra (global `ConfigModule` + Joi validation, `TypeOrmModule.forRootAsync` same factory, `BullModule.forRootAsync`) but loads only the namespaces the processor needs (`database`, `queue`, `storage`, `upload`) — no auth/mail/swagger. Registers `BullModule.registerQueue({ VIDEO_PROCESSING_QUEUE })` + `StorageModule`. The `@Processor` is **not** here yet (SI-03.9), so the API stays a pure producer and the worker connects but does not yet consume.
  - **Metadata-graph gotcha:** `forFeature([Video])` alone crashes the worker at boot with `Entity metadata for Video#channel was not found` — `Video @ManyToOne(Channel)` and `Channel @OneToOne(User)` pull `Channel` and `User` into the metadata graph. Registered `forFeature([Video, Channel, User])` (relation metadata only; the worker uses just the `Video` repo). `User` does not reference the token entities, so the closure stops there.
  - **New scripts:** `start:worker` (`ts-node --compiler-options '{"module":"CommonJS"}' src/worker.ts`, mirrors the `seed` script) and `start:worker:prod` (`node dist/worker`). The `video-worker` Compose service now runs `command: npm run start:worker` (autostarts with the stack), replacing the `tail -f` placeholder from SI-03.2.

### SI-03.9 — Video Processing Processor (metadata + thumbnail + status lifecycle)
- **Status:** completed
- **Tests:** integration `video-processing.processor.integration-spec.ts` (4: real FFmpeg + MinIO + DB — success flips to `ready` with duration/metadata/thumbnail; corrupt object throws; terminal `onFailed` → `failed` + `error_reason`; non-terminal `onFailed` leaves `processing`). Full unit+integration 182/182 + e2e 64/64.
- **Observations:**
  - `VideoProcessingProcessor` (`@Processor(VIDEO_PROCESSING_QUEUE)` extends `WorkerHost`) `process(job)`: loads the video, streams the source to a temp file via `StorageService.getObjectToFile` (10GB-safe), `ffprobe` for duration/metadata, `.screenshots()` for the thumbnail, `putObject`, then `status = ready`; temp dir removed in `finally`. Missing video row → warn + return (no retry) — proven live against orphaned test jobs.
  - **Failure lifecycle (TD-08):** thrown errors bubble so BullMQ retries with the producer's backoff; `@OnWorkerEvent('failed')` flips to `failed` + bounded `error_reason` **only** on the terminal attempt (`attemptsMade >= opts.attempts`), leaving the job in the dead-letter set.
  - Registered as a provider in `WorkerModule`; added `buildThumbnailKey(videoId)` to `storage.service.ts` (extracted from `buildVideoKeys`, reused by the processor).
  - **FFmpeg in the dev image:** the processor integration test runs in the `nestjs-api` container, which lacked FFmpeg — added `ffmpeg` to `Dockerfile.dev` (mirrors `Dockerfile.worker`) and rebuilt. The test generates a real MP4 via FFmpeg's `lavfi testsrc` (no committed binary fixture).
  - **Test isolation choice:** the integration test calls `process()`/`onFailed()` **directly** (no job enqueued, no BullMQ worker started in the test module) so it never races the live compose worker on the shared Redis.
  - **Worker profile-gated (revised from 03.8):** `video-worker` no longer autostarts — moved behind `profiles: ["worker"]`. Rationale corrected after investigation: an early hypothesis blamed worker↔test DB contention for a flake, but the flake reproduced with the worker stopped — it was a **partial-cleanup bug** in `video.entity.integration-spec` (`beforeEach` deleted `videos/channels/users` but not the token tables, so a lingering `verification_tokens` row from another suite broke `DELETE FROM users` once my new test files shifted Jest's suite order). Fixed by switching that suite to the canonical `cleanAllTables`. The profile gating stands on its own merit: only infra autostarts (convention), and the processor is covered by direct-call tests.

### SI-03.10 — Video Metadata Endpoint
- **Status:** completed
- **Tests:** unit `videos.service.spec.ts` (+3: unknown→`VideoNotFoundException`, entity→view mapping with `publicId`-derived URLs, null `thumbnailUrl` before processing) + e2e `videos.e2e-spec.ts` (+2: 200 anonymous metadata, 404 unknown). Full unit+integration 185/185 + e2e 66/66; `tsc` clean, lint 0.
- **Observations:**
  - `VideosService.getByPublicId(publicId)` loads by `public_id` (no ownership check — anonymous watch), throws `VideoNotFoundException` on miss, and maps to `VideoViewDto`. Internal fields (`storage_key`, `upload_id`, `thumbnail_key`) are never exposed — only `publicId`-derived API URLs.
  - **URL derivation:** `streamUrl` = `${app.url}/videos/${publicId}/stream` (always present; the route lands in 03.11). `thumbnailUrl` = `${app.url}/videos/${publicId}/thumbnail` **only when `thumbnail_key` is set**, else `null` — so a client polling this endpoint observes `thumbnailUrl` flip from `null` to a URL as processing completes, alongside `status` and `durationSeconds`. **Note:** no `/thumbnail` serving route exists yet — the phase defines only stream + download endpoints. The derived thumbnail URL is forward-looking (the field is part of the documented contract); if a thumbnail-serving route is never added, revisit whether to presign the thumbnail object instead. Flagged as a follow-up, not blocking the AC (which only asserts the field shape).
  - `createdAt` is emitted as an ISO-8601 string (`created_at.toISOString()`) to match the documented `string` contract rather than leaning on implicit `Date`→JSON serialization.
  - `VideoViewDto` is a **response** DTO (no `class-validator` decorators), so per the DTO rule every field carries an explicit `@ApiProperty` (the Swagger CLI plugin cannot introspect a non-validated shape). Controller route is `@Public() @Get(':publicId')`, documented 200 (`type: VideoViewDto`) + 404 (shared `ApiErrorEnvelope`).

### SI-03.11 — Streaming Endpoint (Range / 206 Partial Content)
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.12 — Download Endpoint
- **Status:** pending
- **Tests:** —
- **Observations:** none
