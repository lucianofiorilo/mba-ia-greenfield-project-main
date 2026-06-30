# phase-03-videos — Progress

**Status:** in_progress
**SIs:** 7/12 completed

> **Resume next session at SI-03.8 (Worker Bootstrap).** The producer side is
> complete: the API initiates uploads, completes/aborts them, and enqueues
> `video-processing` jobs — but no consumer exists yet, so jobs accumulate in
> Redis unprocessed. Next is the standalone worker entrypoint (03.8), then the
> FFmpeg processor (03.9), then the read endpoints (03.10 metadata, 03.11
> stream/Range, 03.12 download). DoD is green through SI-03.7: `tsc` clean,
> lint 0, 177 unit/integration, 64 e2e. Docker stack (db/redis/minio/api) must
> be up before implementing/testing; run e2e with `npm run test:e2e` (now
> `--runInBand` + `testTimeout: 30000`).
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
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.9 — Video Processing Processor (metadata + thumbnail + status lifecycle)
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.10 — Video Metadata Endpoint
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.11 — Streaming Endpoint (Range / 206 Partial Content)
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.12 — Download Endpoint
- **Status:** pending
- **Tests:** —
- **Observations:** none
