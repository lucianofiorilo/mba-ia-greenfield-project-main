# phase-03-videos — Progress

**Status:** in_progress
**SIs:** 5/12 completed

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
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.7 — Upload Completion (enqueue) and Abort
- **Status:** pending
- **Tests:** —
- **Observations:** none

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
