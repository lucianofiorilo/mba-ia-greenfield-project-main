---
scope_type: phase
related_phases: [3]
status: decided
date: 2026-06-28
scope_description: "Backend foundation for video upload and processing: object storage (MinIO/S3), background processing queue, 10GB direct-to-storage upload, FFmpeg metadata/thumbnail extraction, worker deployment, unique public URL, range-based streaming and download, and the video status lifecycle."
---

# Technical Decisions — Phase 03: Upload e Processamento de Vídeos

_Subprojects in scope:_

- `nestjs-project/` — backend that delivers the videos module (entity, endpoints), the object-storage integration, the processing queue producer, the video worker (FFmpeg), the streaming/download endpoints, and the new Docker Compose infrastructure (storage, queue broker, worker). All decisions in this document are Backend or Repo-wide.
- `next-frontend/` — Frontend deferred: the video UI (upload widget, player) is out of scope for Phase 03 per the challenge brief. No open decision in this document.

---

## TD-01: Background Processing Queue Technology

**Scope:** Backend

**Capability:** Serviço de processamento em segundo plano (filas)

**Context:** The project plan leaves the queue technology explicitly as "TBD" — it is the primary stack decision of this phase. Video processing (metadata extraction + thumbnail generation via FFmpeg) is CPU-heavy and slow; it must run asynchronously in a worker, decoupled from the upload request. The queue is the contract between the API (producer) and the worker (consumer): it must support retries with backoff, failure handling (dead-letter), concurrency control, and job state observability. The current stack has PostgreSQL 17 but no Redis or AMQP broker.

**Options:**

### Option A: BullMQ + Redis (`@nestjs/bullmq`)
- BullMQ is a Redis-backed job queue with a first-class NestJS integration (`@nestjs/bullmq`). The API injects a `Queue` to enqueue jobs; the worker uses a `@Processor` class. Redis runs as a new Compose service.
- **Pros:** De-facto standard for Node background jobs; official NestJS module. Native retries with exponential backoff, configurable concurrency, job progress events, delayed/repeatable jobs, and automatic dead-letter (failed jobs retained). Strong TypeScript support. Excellent observability (Bull Board UI). Maps cleanly to a separate worker process sharing the same codebase.
- **Cons:** Adds Redis as new infrastructure (one more container + a dependency the team must operate). Redis is in-memory — job durability depends on Redis persistence config (AOF/RDB).

### Option B: pg-boss (queue on PostgreSQL)
- pg-boss implements a job queue on top of the existing PostgreSQL database using `SKIP LOCKED` polling. No new broker needed — it creates its own schema/tables in the DB already in the stack.
- **Pros:** Zero new infrastructure — reuses PostgreSQL, the one durable datastore already present. Jobs are transactionally durable (survive restarts) and can even be enqueued in the same DB transaction that pre-registers the video draft (exactly-once-ish semantics). Simple operational footprint. Supports retries, backoff, archiving.
- **Cons:** No official NestJS module — integration is a thin custom wrapper (a provider that owns the pg-boss instance). Polling adds load to the primary DB (competes with application queries for connections). Smaller ecosystem; fewer ready-made dashboards. Throughput ceiling lower than Redis (irrelevant at this project's scale).

### Option C: RabbitMQ (`@nestjs/microservices` / amqplib)
- RabbitMQ is a dedicated AMQP message broker. NestJS can consume it via the microservices transport or a custom `amqplib` consumer. Runs as a new Compose service.
- **Pros:** Mature, battle-tested broker with rich routing (exchanges, dead-letter exchanges), durable queues, and strong delivery guarantees. Language-agnostic — a future non-Node worker could consume the same queue.
- **Cons:** Heaviest operational footprint (broker + management plane). The NestJS microservices abstraction is oriented to RPC/event patterns, not job-queue ergonomics — retries/backoff/concurrency must be wired manually. Overkill for a single job type (one producer, one consumer) at this scale.

**Recommendation:** **Option A (BullMQ + Redis)** — It is the standard Node.js background-job solution with an official NestJS module, and it provides out-of-the-box exactly the reliability primitives video processing needs (retry with backoff, concurrency limits, dead-letter retention, progress events) without hand-rolling them. The cost is a single Redis container in Compose — a one-time, well-understood addition. pg-boss is the strong runner-up if avoiding new infrastructure is a hard constraint, but the manual NestJS integration and DB-connection contention trade away the ergonomics that matter for a heavy, failure-prone workload. RabbitMQ's routing power is unnecessary for one job type and adds the most operational weight.

**Decision:** A (BullMQ + Redis via `@nestjs/bullmq`)

**Libraries:** `@nestjs/bullmq@^11.0.4`, `bullmq@^5`, Redis 7 (Docker image)

---

## TD-02: 10GB Upload Strategy

**Scope:** Backend

**Capability:** Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance

**Context:** The defining engineering constraint of the phase: a 10GB file must reach storage **without passing through the API process** (buffering or streaming 10GB through Node would exhaust memory/connections and block the event loop). The object storage is fixed (MinIO/S3); the open decision is the upload protocol and the API↔client handshake. Note a hard S3/MinIO limit: a single presigned `PUT` is capped at **5GB**, so a 10GB target cannot use single-part presigned PUT.

**Options:**

### Option A: Single presigned PUT URL
- The API generates one presigned `PUT` URL; the client uploads the whole file directly to storage in one request.
- **Pros:** Simplest possible flow — one URL, one upload, one completion call. No multipart bookkeeping.
- **Cons:** **Disqualifying:** S3/MinIO cap presigned PUT objects at 5GB — cannot satisfy the 10GB requirement. No resumability; a dropped connection at 9GB restarts from zero.

### Option B: Multipart upload with per-part presigned URLs
- The API initiates a multipart upload (`CreateMultipartUpload`), returns an `uploadId` + a presigned URL per part (`UploadPart`). The client splits the file into chunks (e.g., 5–64MB) and uploads each part directly to storage; on finish, the client calls the API to complete (`CompleteMultipartUpload`). The completion call is what flips the video to "processing" and enqueues the job (TD-01/TD-08).
- **Pros:** Handles up to 5TB — well within the 10GB target. Parts upload in parallel (faster) and are independently retryable (resumability). The file never touches the API — Node only signs small URLs and orchestrates init/complete. Industry-standard pattern for large uploads.
- **Cons:** More moving parts: the client must chunk, track parts (`ETag` per part), and the API exposes init/sign/complete endpoints. Requires an abort/cleanup path for incomplete uploads.

### Option C: tus resumable upload protocol
- Adopt the tus open protocol (e.g., `tus-node-server` or a tus-compatible storage) for resumable uploads.
- **Pros:** Best-in-class resumability and a standardized protocol with mature clients.
- **Cons:** Either routes bytes through a tus server (reintroducing the "file through the app" problem unless backed by S3 multipart under the hood) or adds a separate tus service — extra infrastructure and a protocol the rest of the stack doesn't use. Heavier than needed when S3 multipart already gives resumable, direct-to-storage uploads.

**Recommendation:** **Option B (Multipart upload with per-part presigned URLs)** — It is the only option that meets the 10GB requirement (Option A is hard-capped at 5GB) while keeping the file entirely off the API process, and it natively gives parallel + resumable part uploads. tus solves the same problem with more infrastructure and a protocol foreign to the stack. The handshake (init → sign parts → complete) becomes the backbone of the upload API contract.

**Decision:** B (Multipart upload with per-part presigned URLs)

**Libraries:** `@aws-sdk/client-s3@^3`, `@aws-sdk/s3-request-presigner@^3` (shared with TD-03)

---

## TD-03: Object Storage Client & Bucket/Key Organization

**Scope:** Backend

**Capability:** Serviço de armazenamento de arquivos (vídeos e thumbnails)

**Context:** The storage backend is fixed (MinIO locally = S3 API; swappable for AWS S3 in prod). Two sub-decisions remain: (1) which client library the backend uses to talk to it, and (2) how buckets and object keys are organized — a cross-component concern because the same key scheme is referenced by the upload (TD-02), the worker (TD-04), and the streaming/download endpoints (TD-07).

**Options:**

### Option A: AWS SDK v3 (`@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner`)
- Official AWS SDK, S3-compatible (works against MinIO by setting `endpoint` + `forcePathStyle: true`). Provides multipart commands and presigned-URL signing.
- **Pros:** Canonical S3 client; identical code path for MinIO (dev) and AWS S3 (prod) — the production swap is a config change, not a rewrite. Modular packages (tree-shakeable). First-class multipart + presigner support (directly enables TD-02). Strong TypeScript types.
- **Cons:** Slightly more verbose command/middleware API. Two packages to add.

### Option B: MinIO JS client (`minio`)
- The official MinIO SDK, also S3-compatible.
- **Pros:** Ergonomic helpers (`presignedPutObject`, `presignedGetObject`). Built for MinIO.
- **Cons:** Couples the code to MinIO's client even though prod targets AWS S3; the "MinIO now, S3 later" story is cleaner with the AWS SDK. Multipart presigned-per-part flow is less idiomatic than with the AWS SDK.

**Recommendation:** **Option A (AWS SDK v3)** — The project's stated trajectory is "MinIO locally, S3 in production." Using the AWS SDK against a configurable `endpoint` makes that swap a pure configuration change and keeps the multipart + presigner ergonomics that TD-02 depends on. **Key organization:** one private bucket (e.g., `streamtube-videos`) with deterministic, collision-free keys derived from the video id: `videos/{videoId}/original/{originalFilename}` for the source and `videos/{videoId}/thumbnail.jpg` for the generated thumbnail. Keys are derived from the video's UUID (never user input), so they never collide and map 1:1 to the DB row.

**Decision:** A (AWS SDK v3 — `@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner`; single private bucket, UUID-derived keys)

**Libraries:** `@aws-sdk/client-s3@^3`, `@aws-sdk/s3-request-presigner@^3`, MinIO (Docker image)

---

## TD-04: Video Processing Tooling (metadata + thumbnail)

**Scope:** Backend

**Capability:** Transversal — covers: "Processamento automático do vídeo após upload (extração de duração e metadados)", "Geração automática de thumbnail a partir de um frame do vídeo"

**Context:** After upload, the worker must extract duration/metadata and capture a single frame as a thumbnail. FFmpeg/ffprobe is the standard tool; the decision is how the Node worker drives it and how the binary is provisioned in the worker container.

**Options:**

### Option A: `fluent-ffmpeg` wrapper + FFmpeg installed in the image
- Use the `fluent-ffmpeg` library to build/execute ffmpeg/ffprobe commands; install the `ffmpeg` package in the worker's Docker image (apt).
- **Pros:** Readable, promise-friendly API for `ffprobe()` (duration/metadata) and `.screenshots()` (thumbnail). Uses the OS-provided, full-featured FFmpeg build (all codecs). Widely documented pattern.
- **Cons:** `fluent-ffmpeg` is in light maintenance; relies on the binary being on `$PATH` (must be guaranteed by the image). The thumbnail output folder must exist or FFmpeg fails silently.

### Option B: Direct `child_process` calls to ffmpeg/ffprobe
- Spawn ffmpeg/ffprobe directly and parse stdout/JSON.
- **Pros:** No wrapper dependency; full control over arguments.
- **Cons:** Must hand-build argument arrays and parse ffprobe JSON manually; more error-prone and verbose for the same result.

### Option C: `ffmpeg-static` / `ffprobe-static` (bundled binaries) + `fluent-ffmpeg`
- Pull prebuilt FFmpeg binaries via npm instead of installing via the OS.
- **Pros:** Binary version pinned in `package.json`; no apt step.
- **Cons:** Larger node_modules; prebuilt binaries may lag and can have codec/license limitations vs. the distro build; less predictable than an explicit apt install in a controlled image.

**Recommendation:** **Option A (`fluent-ffmpeg` + FFmpeg installed in the worker image)** — The wrapper's `ffprobe()` and `.screenshots()` map directly onto the two required operations with the least code, and installing FFmpeg in the worker image gives a complete, predictable codec set. The maintenance status of the wrapper is acceptable for the narrow use here (probe + single screenshot); a direct `child_process` fallback (Option B) remains trivial if a specific command needs it.

**Decision:** A (`fluent-ffmpeg` + FFmpeg installed in the worker image)

**Libraries:** `fluent-ffmpeg@^2.1.3`, `@types/fluent-ffmpeg@^2.1.27` (dev), FFmpeg (apt-installed in worker image)

---

## TD-05: Worker Deployment Model

**Scope:** Repo-wide

**Capability:** Transversal — covers: "Serviço de processamento em segundo plano (filas)", "Processamento automático do vídeo após upload (extração de duração e metadados)"

**Context:** The architecture (C4 diagram + CLAUDE.md) prescribes a separate "Video Worker (FFmpeg)" container. The decision is how the worker is built and run relative to the API: a distinct codebase/repo, or the same NestJS codebase started in a worker mode. This is Repo-wide because it shapes Compose structure and the build/image strategy.

**Options:**

### Option A: Same codebase, separate worker entrypoint + separate Compose service
- The worker is the same NestJS project started via a dedicated bootstrap (e.g., a standalone Nest application context or a worker `main`) that registers only the queue processor + storage. It runs as its own Compose service (its image adds FFmpeg), scaling independently of the API.
- **Pros:** Shares entities, config, storage service, and DTOs — no code duplication and no contract drift between API and worker. One repo, one dependency tree. The processor consumes the same BullMQ queue the API produces to. Scales independently (can run N worker replicas). Matches the "separate container" architecture.
- **Cons:** The worker image must include FFmpeg (larger than the API image) — handled with a separate Dockerfile/target. Care needed so the worker bootstrap doesn't start the HTTP server.

### Option B: Fully separate worker project
- A standalone project (separate package, possibly separate repo) dedicated to processing.
- **Pros:** Smallest possible worker footprint; total isolation.
- **Cons:** Duplicates entities/config/storage logic or forces a shared package — significant overhead for one job type. Contract drift risk. Out of proportion for this phase.

### Option C: In-process worker (no separate container)
- Run the BullMQ processor inside the API process.
- **Pros:** Simplest — one service.
- **Cons:** Violates the prescribed architecture (no separate worker container). Heavy FFmpeg jobs compete with API request handling for CPU/event loop. Cannot scale processing independently. Rejected.

**Recommendation:** **Option A (same codebase, separate worker entrypoint + Compose service)** — It satisfies the architecture's separate-worker requirement while reusing the entities, config, and storage code, eliminating duplication and contract drift. A second Dockerfile (or build target) adds FFmpeg to the worker image; a worker bootstrap starts the queue processor without the HTTP listener. This is the standard NestJS standalone-worker pattern.

**Decision:** A (Same codebase, separate worker entrypoint + dedicated Compose service with FFmpeg)

**Libraries:** — (reuses `@nestjs/core` standalone application context)

---

## TD-06: Unique Public Video URL Strategy

**Scope:** Backend

**Capability:** URL única por vídeo, sem conflito com outros vídeos

**Context:** Each video needs a short, unique, public-facing identifier used in its URL (e.g., `/videos/{publicId}` / a future watch URL), distinct from the internal UUID primary key. It must be collision-free, URL-safe, and not enumerable/sequential (so videos aren't trivially guessable/scrapable). This identifier is a cross-component contract (entity column + API routes + future frontend links).

**Options:**

### Option A: Reuse the UUID primary key
- Expose the existing `id` (UUID v4) directly in URLs.
- **Pros:** No extra column or library; already unique.
- **Cons:** 36 chars — long and ugly in URLs. Couples the public URL to the internal primary key (leaks internal identifier; harder to change later).

### Option B: `nanoid` short id in a dedicated column
- Generate a short (e.g., 11-character) URL-safe id with `nanoid`, stored in a unique `public_id` column, separate from the PK.
- **Pros:** Short, URL-friendly, non-sequential (not guessable). Collision probability negligible at this scale (and enforced by a unique constraint with regenerate-on-conflict). Decouples public URL from internal PK. Tiny, well-maintained dependency.
- **Cons:** One extra column + unique index; one extra dependency; must handle the (astronomically rare) unique-violation retry.

### Option C: Sequential short code / hashids over an integer
- Encode an incrementing counter into a short code.
- **Pros:** Compact.
- **Cons:** Enumerable (reveals counts, enables scraping) unless obfuscated; obfuscation adds complexity. Requires an integer sequence alongside the UUID PK. More machinery than `nanoid` for no benefit here.

**Recommendation:** **Option B (`nanoid` in a dedicated `public_id` column)** — It delivers a short, non-guessable, URL-safe identifier decoupled from the internal UUID, with a negligible collision risk backstopped by a unique constraint. This mirrors how YouTube-style platforms expose opaque short ids and keeps the internal PK private. The existing channels module already demonstrates the "unique column with conflict-retry" pattern (nickname), so the approach is consistent with the codebase.

**Decision:** B (`nanoid` short id in a dedicated unique `public_id` column)

**Libraries:** `nanoid@^3.3.7` — **pinned to v3 (CommonJS)**; v4+ is ESM-only and breaks `require()` under the project's CommonJS/ts-jest setup (`ERR_REQUIRE_ESM`).

---

## TD-07: Streaming & Download Delivery Strategy

**Scope:** Backend

**Capability:** Transversal — covers: "Reprodução via streaming (sem necessidade de download completo)", "Download do vídeo pelo usuário"

**Context:** Playback must start without downloading the whole file — i.e., HTTP **Range** requests answered with **206 Partial Content** — and a download path must also exist. Anonymous users can watch (Phase 02 made the JWT guard global with `@Public()` opt-out). The open decision is who serves the bytes: the API proxies ranges from storage, or the API issues a presigned GET and the client streams directly from storage.

**Options:**

### Option A: API-proxied streaming with Range/206
- A `GET /videos/{publicId}/stream` endpoint reads the client's `Range` header, fetches the matching byte range from storage (S3/MinIO `GetObject` with `Range`), and pipes it back with `206 Partial Content`, `Content-Range`, `Accept-Ranges: bytes`. Download is the same mechanism with `Content-Disposition: attachment` (or full-body 200).
- **Pros:** Single origin — the storage endpoint and credentials stay private; no CORS or bucket-exposure concerns. Clean access control: anonymous playback, future visibility rules (public/unlisted), and view counting all live in one place. Fully exercisable by e2e tests inside Compose (no external bucket exposure). MinIO/S3 honor the upstream `Range`, so only the requested bytes are fetched — no full download server-side.
- **Cons:** Bytes transit the API process (Node streams them) — more API bandwidth/CPU than a redirect. Must stream (pipe) rather than buffer to stay memory-safe for large files.

### Option B: Presigned GET URL redirect
- The endpoint returns (or 302-redirects to) a short-lived presigned GET URL; the client streams directly from MinIO/S3, which natively serves Range/206.
- **Pros:** Offloads all bandwidth from the API to storage — most scalable. Storage handles Range natively.
- **Cons:** Exposes a (temporary) storage URL to the client; CORS must be configured on the bucket. Harder to enforce per-request authorization, anonymous-vs-auth rules, and view counting (the client bypasses the API for the actual bytes). With MinIO, the presigned host must be the externally reachable one, complicating the dev/Compose setup.

**Recommendation:** **Option A (API-proxied streaming with Range/206)** — For this phase it keeps storage private, centralizes access control (anonymous watch today, visibility/counting later), and is directly testable end-to-end inside Compose, while still fetching only the requested byte range from storage (true streaming, not full download). The bandwidth cost is acceptable at the project's scale; Option B (presigned redirect) is the natural production optimization and can be introduced later without changing the public route shape. Download uses the same range-capable handler with `Content-Disposition: attachment`.

**Decision:** A (API-proxied streaming with Range/206; download via the same range-capable handler with `Content-Disposition: attachment`)

**Libraries:** `@aws-sdk/client-s3@^3` (GetObject with Range; reuses the TD-03 client)

---

## TD-08: Video Status Lifecycle & Processing-Failure Handling

**Scope:** Backend

**Capability:** Transversal — covers: "Pré-cadastro automático do vídeo como rascunho ao iniciar o upload", "Processamento automático do vídeo após upload (extração de duração e metadados)"

**Context:** A video moves through states from the moment the upload starts until it is playable or has failed. The phase requires a draft pre-registration at upload start and automatic processing afterward; the lifecycle (and what happens when FFmpeg fails) must be explicit because it is the contract shared by the upload endpoints, the worker, and the status the client reads. Depends on TD-01 (queue retries/DLQ) and TD-02 (upload completion trigger).

**Options:**

### Option A: Four-state machine — `draft → processing → ready` (+ `failed`)
- `draft`: row created when the upload is initiated (multipart init), before bytes are confirmed. `processing`: set when the client completes the multipart upload, which enqueues the job. `ready`: worker finished — duration/metadata/thumbnail persisted. `failed`: worker exhausted retries (BullMQ backoff per TD-01) or the file is invalid; an error reason is recorded. Failed jobs land in BullMQ's failed set (dead-letter) for inspection/manual retry.
- **Pros:** Minimal but complete — each state maps to a concrete event in the flow and to a phase requirement. `failed` makes processing errors observable to the user/API rather than leaving videos stuck in `processing`. Retries are handled by the queue (TD-01) before a terminal `failed`. Easy to model as a Postgres enum.
- **Cons:** Need to guard illegal transitions (e.g., re-completing an already-processed upload).

### Option B: Boolean flags (`is_uploaded`, `is_processed`)
- Track progress with independent booleans instead of an enum.
- **Pros:** No enum migration.
- **Cons:** Representable illegal combinations (`processed && !uploaded`); no clean "failed" representation; harder to query "give me ready videos." Worse contract for the frontend. Rejected.

### Option C: Richer state machine (adds `uploading`, `queued`, etc.)
- More granular states between draft and ready.
- **Pros:** Finer observability.
- **Cons:** Extra states beyond what Phase 03 capabilities require (extrapolation); more transition logic to maintain. The watch/management UI that would consume finer states is a later phase.

**Recommendation:** **Option A (`draft → processing → ready` + `failed`)** — It is the smallest lifecycle that satisfies the explicit requirements (draft at upload start, automatic processing, and a real failure state) and exposes a clean `status` contract. Transient errors are absorbed by BullMQ retries/backoff (TD-01); only after retries are exhausted does the video become `failed` with a recorded reason, and the job is retained in the dead-letter set for inspection. Modeled as a PostgreSQL enum column on the videos table, consistent with the existing `verification_tokens_type_enum` precedent.

**Decision:** A (`draft → processing → ready` + `failed`, modeled as a PostgreSQL enum column)

---

## Decisions Summary

| ID | Scope | Decision | Recommendation | Choice |
|----|-------|----------|----------------|--------|
| TD-01 | Backend | Background Processing Queue Technology | BullMQ + Redis (`@nestjs/bullmq`) | A (BullMQ + Redis) |
| TD-02 | Backend | 10GB Upload Strategy | Multipart upload with per-part presigned URLs | B (Multipart presigned) |
| TD-03 | Backend | Object Storage Client & Bucket/Key Organization | AWS SDK v3 + UUID-derived keys, single private bucket | A (AWS SDK v3) |
| TD-04 | Backend | Video Processing Tooling | `fluent-ffmpeg` + FFmpeg installed in worker image | A (`fluent-ffmpeg` + FFmpeg in image) |
| TD-05 | Repo-wide | Worker Deployment Model | Same codebase, separate worker entrypoint + Compose service | A (Shared codebase, separate worker service) |
| TD-06 | Backend | Unique Public Video URL Strategy | `nanoid` short id in a dedicated `public_id` column | B (`nanoid` `public_id` column) |
| TD-07 | Backend | Streaming & Download Delivery Strategy | API-proxied streaming with Range/206 | A (API-proxied Range/206) |
| TD-08 | Backend | Video Status Lifecycle & Failure Handling | `draft → processing → ready` + `failed` (Postgres enum) | A (`draft→processing→ready`+`failed`) |
