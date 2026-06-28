---
kind: phase
name: phase-03-videos
sources_mtime:
  docs/project-plan.md: "2026-06-28T19:22:56-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-06-28T20:00:16-03:00"
  docs/phases/phase-02-auth/context.md: "2026-06-28T19:22:56-03:00"
  .claude/skills/testing-guide-nestjs-project/SKILL.md: "2026-06-28T19:22:56-03:00"
  docs/phases/phase-03-videos/library-refs.md: "2026-06-28T20:02:36-03:00"
---

# phase-03-videos — Context

## Scope

**Phase name:** Fase 03 — Upload e Processamento de Vídeos

**Capabilities** (literal, `docs/project-plan.md`):

- Serviço de armazenamento de arquivos (vídeos e thumbnails)
- Serviço de processamento em segundo plano (filas)
- Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance
- Pré-cadastro automático do vídeo como rascunho ao iniciar o upload
- Processamento automático do vídeo após upload (extração de duração e metadados)
- Geração automática de thumbnail a partir de um frame do vídeo
- URL única por vídeo, sem conflito com outros vídeos
- Reprodução via streaming (sem necessidade de download completo)
- Download do vídeo pelo usuário

**Out of scope:** Edição de informações do vídeo, categorias, visibilidade público/unlisted, fluxo de publicação, painel de gerenciamento e página pública do canal (Fase 04); player de UI, contagem de visualizações e sugestões (Fase 05); interações sociais (Fase 06). O frontend de vídeo (widget de upload, player) está fora do escopo desta fase.

**Deliverables:** upload de até 10GB funcional, processamento automático do vídeo, streaming funcionando, URLs únicas geradas.

**Affected subprojects:** `nestjs-project/` (+ infraestrutura Docker Compose: object storage, fila/broker e worker)

**Deferred subprojects:** `next-frontend/` — a interface de vídeo (upload, player) fica diferida; não faz parte desta fase.

**Sequencing notes:** Depends on Fase 01 — Configuração Base e Fase 02 — Auth (vídeos pertencem ao canal criado na Fase 02; reusa guard JWT global, `@Public()`, filtro de exceções de domínio, ValidationPipe, padrão de migrations e config).

**Neighbors (for boundary detection only):**

- **Phase 02:** Cadastro, Login e Gerenciamento de Conta (prior) — provê usuários, canais (1:1 com user) e a infraestrutura de auth.
- **Phase 04:** Gerenciamento de Vídeos e Canal (next) — edição de vídeo, categorias, visibilidade, publicação, painel — consumirá a entidade `videos` criada aqui.

## Decisions Index

| Ref | Source | Scope | Topic | Status | Decision | Libraries |
|-----|--------|-------|-------|--------|----------|-----------|
| phase-03-videos/TD-01 | technical-decisions-phase-03-videos.md | Backend | Background Processing Queue Technology | decided | A (BullMQ + Redis) | @nestjs/bullmq@^11.0.4, bullmq@^5 |
| phase-03-videos/TD-02 | technical-decisions-phase-03-videos.md | Backend | 10GB Upload Strategy | decided | B (Multipart presigned URLs) | @aws-sdk/client-s3@^3, @aws-sdk/s3-request-presigner@^3 |
| phase-03-videos/TD-03 | technical-decisions-phase-03-videos.md | Backend | Object Storage Client & Bucket/Key Organization | decided | A (AWS SDK v3) | @aws-sdk/client-s3@^3, @aws-sdk/s3-request-presigner@^3 |
| phase-03-videos/TD-04 | technical-decisions-phase-03-videos.md | Backend | Video Processing Tooling (metadata + thumbnail) | decided | A (fluent-ffmpeg + FFmpeg in image) | fluent-ffmpeg@^2.1.3, @types/fluent-ffmpeg@^2.1.27 |
| phase-03-videos/TD-05 | technical-decisions-phase-03-videos.md | Repo-wide | Worker Deployment Model | decided | A (shared codebase, separate worker service) | — |
| phase-03-videos/TD-06 | technical-decisions-phase-03-videos.md | Backend | Unique Public Video URL Strategy | decided | B (nanoid public_id column) | nanoid@^3.3.7 |
| phase-03-videos/TD-07 | technical-decisions-phase-03-videos.md | Backend | Streaming & Download Delivery Strategy | decided | A (API-proxied Range/206) | @aws-sdk/client-s3@^3 |
| phase-03-videos/TD-08 | technical-decisions-phase-03-videos.md | Backend | Video Status Lifecycle & Failure Handling | decided | A (draft→processing→ready + failed) | — |

_Source files:_

- `docs/decisions/technical-decisions-phase-03-videos.md` (scope_type: phase)

_Libraries pinned by `plan-resolve` in `library-refs.md` (versions confirmed against npm; context7 was not connected this session — see note in `library-refs.md`)._

## Capability Coverage

| Capability (from project-plan.md) | Covered by |
|-----------------------------------|------------|
| Serviço de armazenamento de arquivos (vídeos e thumbnails) | phase-03-videos/TD-03 |
| Serviço de processamento em segundo plano (filas) | phase-03-videos/TD-01, phase-03-videos/TD-05 |
| Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance | phase-03-videos/TD-02, phase-03-videos/TD-03 |
| Pré-cadastro automático do vídeo como rascunho ao iniciar o upload | phase-03-videos/TD-08, phase-03-videos/TD-02 |
| Processamento automático do vídeo após upload (extração de duração e metadados) | phase-03-videos/TD-04, phase-03-videos/TD-05, phase-03-videos/TD-08 |
| Geração automática de thumbnail a partir de um frame do vídeo | phase-03-videos/TD-04 |
| URL única por vídeo, sem conflito com outros vídeos | phase-03-videos/TD-06 |
| Reprodução via streaming (sem necessidade de download completo) | phase-03-videos/TD-07 |
| Download do vídeo pelo usuário | phase-03-videos/TD-07 |

## Decisions Detail

### phase-03-videos/TD-01

**Recommendation:** BullMQ + Redis — standard Node background-job solution with an official NestJS module (`@nestjs/bullmq`); provides out-of-the-box the reliability primitives video processing needs (retry with backoff, concurrency limits, dead-letter retention, progress events) at the cost of a single Redis container.

**Libraries:** `@nestjs/bullmq`, `bullmq`, Redis (image) _(pin in library-refs.md)_

### phase-03-videos/TD-02

**Recommendation:** Multipart upload with per-part presigned URLs — the only option that meets the 10GB target (single presigned PUT is capped at 5GB) while keeping the file off the API process; gives parallel + resumable part uploads. Handshake: API `init` (CreateMultipartUpload) → sign parts → client uploads parts directly to storage → API `complete` (CompleteMultipartUpload), which flips status to `processing` and enqueues the job.

**Libraries:** `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner` (shared with TD-03)

### phase-03-videos/TD-03

**Recommendation:** AWS SDK v3 against a configurable `endpoint` (+ `forcePathStyle: true`) — makes the "MinIO local → S3 prod" swap a config change, with first-class multipart + presigner support. Key organization: one private bucket (e.g., `streamtube-videos`); deterministic UUID-derived keys `videos/{videoId}/original/{filename}` and `videos/{videoId}/thumbnail.jpg` (never user input → no collisions).

**Libraries:** `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner`, MinIO (image)

### phase-03-videos/TD-04

**Recommendation:** `fluent-ffmpeg` + FFmpeg installed in the worker image — `ffprobe()` extracts duration/metadata and `.screenshots()` captures the thumbnail frame with minimal code; the OS-provided FFmpeg gives a complete codec set. Direct `child_process` is a trivial fallback for any specific command.

**Libraries:** `fluent-ffmpeg`, `@types/fluent-ffmpeg`, FFmpeg (apt in worker image)

### phase-03-videos/TD-05

**Recommendation:** Same codebase, separate worker entrypoint + dedicated Compose service — satisfies the architecture's separate-worker requirement while reusing entities/config/storage code (no duplication, no contract drift). A second Dockerfile/target adds FFmpeg; a worker bootstrap (NestJS standalone application context) starts the BullMQ processor without the HTTP listener.

**Libraries:** — (reuses `@nestjs/core` standalone application context)

### phase-03-videos/TD-06

**Recommendation:** `nanoid` in a dedicated unique `public_id` column — short, non-guessable, URL-safe identifier decoupled from the internal UUID PK, with negligible collision risk backstopped by a unique constraint + regenerate-on-conflict (same pattern the channels module uses for `nickname`).

**Libraries:** `nanoid`

### phase-03-videos/TD-07

**Recommendation:** API-proxied streaming with Range/206 — `GET /videos/{publicId}/stream` reads the client `Range`, fetches only that byte range from storage (`GetObject` with `Range`), and pipes it back with `206 Partial Content` / `Content-Range` / `Accept-Ranges: bytes`. Keeps storage private, centralizes access control (anonymous watch via `@Public()`), and is e2e-testable in Compose. Download reuses the same range-capable handler with `Content-Disposition: attachment`. Presigned-GET redirect is the later production optimization (same route shape).

**Libraries:** `@aws-sdk/client-s3` (GetObject with Range; reuses TD-03 client)

### phase-03-videos/TD-08

**Recommendation:** `draft → processing → ready` + `failed`, modeled as a PostgreSQL enum column — smallest lifecycle satisfying the requirements (draft at upload start, automatic processing, real failure state). Transient errors absorbed by BullMQ retries/backoff (TD-01); only after retries are exhausted does the video become `failed` with a recorded reason, the job retained in the dead-letter set. Enum precedent: existing `verification_tokens_type_enum`.

**Libraries:** — (TypeORM enum column)

## Inherited Decisions Detail

### phase-02-auth/TD-07

**Recommendation:** Custom Domain Exception Filter — machine-readable error codes (`{ statusCode, error, message }`) via a `@Catch(DomainException)` filter. All Phase 03 domain errors (video not found, upload not found, invalid state transition, forbidden, etc.) MUST extend `DomainException` and be mapped by this existing filter — do not throw NestJS HTTP exceptions from services.

**Libraries:** —

### phase-02-auth/TD-02

**Recommendation:** Custom guards with `@nestjs/jwt` only — JWT auth via a global `JwtAuthGuard` (APP_GUARD) with `@Public()` opt-out and `@CurrentUser()` to read the JWT payload (`{ sub: userId, email }`). Phase 03 endpoints inherit this: authoring/upload/management endpoints require JWT; public watch/stream endpoints use `@Public()`.

**Libraries:** `@nestjs/jwt`

### phase-01-configuracao-base/TD-03

**Recommendation:** Namespaced config with `registerAs(name, () => ({...}))` — one file per domain in `src/config/`, typed injection via `ConfigType<typeof xxxConfig>` + `@Inject(xxxConfig.KEY)`. New Phase 03 config (storage, queue/Redis, upload limits) follows this pattern (e.g., `storage.config.ts`, `queue.config.ts`).

**Libraries:** `@nestjs/config`

## Inherited Conventions

- Backend config uses `@nestjs/config` with namespaced `registerAs(name, () => ({...}))` factories — one file per domain in `src/config/`; injected via `ConfigType<typeof xxxConfig>` + `@Inject(xxxConfig.KEY)`. _(from phase 01)_
- Env variables are validated by a Joi schema in `src/config/env.validation.ts`, passed to `ConfigModule.forRoot({ validationSchema, validationOptions: { allowUnknown: true, abortEarly: false } })`. New env keys (storage, Redis, upload) must be added there. _(from phase 01)_
- `TypeOrmModule.forRootAsync` with `autoLoadEntities: true`, `synchronize: false`; entities registered per-module via `TypeOrmModule.forFeature([...])`. _(from phase 01)_
- Migrations live in `src/database/migrations/` named `<unixTimestampMs>-<DescriptiveAction>.ts` (class `Name<timestamp>`), raw SQL in `up()`/`down()`; run via `npm run migration:run` (CLI uses `src/database/data-source.ts`). _(from phase 01)_
- Entities: `@Entity('table_name')`, UUID PK via `@PrimaryGeneratedColumn('uuid')`, `@CreateDateColumn`/`@UpdateDateColumn`, FK as both a `@Column` and a relation decorator; snake_case columns. _(from phase 02)_
- Domain errors extend the abstract `DomainException` (`errorCode`, `httpStatus`, `message`) in `src/common/exceptions/`; mapped to `{ statusCode, error, message }` by the global `DomainExceptionFilter`. Services never throw NestJS HTTP exceptions. _(from phase 02)_
- Global `ValidationPipe` (`whitelist`, `forbidNonWhitelisted`, `transform`) + global `JwtAuthGuard` (APP_GUARD) with `@Public()` opt-out; `@CurrentUser()` reads the JWT payload `{ sub, email }`. _(from phase 02)_
- DTOs use `class-validator` decorators with JSDoc comments; the `@nestjs/swagger` CLI plugin auto-generates `@ApiProperty`. Controllers are thin, documented with `@ApiTags`/`@ApiOperation`/`@ApiResponse` and `@ApiBearerAuth('access-token')` on protected routes. _(from phase 02)_
- Domain modules export `TypeOrmModule` + their service; cross-module reuse via importing the owning module (e.g., import `ChannelsModule` to resolve a user's channel). _(from phase 02)_
- Unique-column conflicts handled with a regenerate-on-conflict retry against the PG unique-violation code `23505` (channels `nickname` precedent) — reused for `videos.public_id`. _(from phase 02)_

## Inherited Deferred Capabilities

_No inherited deferred capabilities._

## Non-UI / Deferred Capabilities

| Capability | Status | Rationale | TD refs |
|-----------|--------|-----------|---------|
| Frontend de vídeo (widget de upload, player) | deferred | A interface de vídeo está fora do escopo da Fase 03 (desafio é backend); `next-frontend/` não recebe telas de vídeo nesta fase. | — |

## Testing Requirements

### nestjs-project

Per the `testing-guide-nestjs-project` Skill (§3 Feature Implementation Checklist). Phase 03 introduces a new entity, services with DB + external-system boundaries (object storage, queue), a controller with public + protected endpoints, DTOs, a module, and a background worker/processor.

| Artifact type | Required layers |
|---------------|-----------------|
| Entity (`video.entity.ts`) | Integration — constraints (unique `public_id`), enum default (`status = draft`), timestamps, FK to channel |
| Service with branching + DB (videos service) | Unit (branch logic, mocked repo) + Integration (DB contract) |
| Service with external-system boundary (storage adapter, queue producer) | Integration — real MinIO + real Redis/BullMQ via Compose (do not mock what Compose can run) |
| Worker processor (FFmpeg job consumer) | Integration — real FFmpeg + real storage; processes a small sample video end-to-end (metadata + thumbnail persisted, status → ready) |
| Module (`videos.module.ts`, worker module) | Unit — compilation test (DI wiring: TypeORM forFeature, BullModule.registerQueue, storage provider) |
| Controller (videos controller) | E2E only — status codes, auth enforcement (`@Public()` vs JWT), Range/206 streaming response, multipart init/complete flow |
| DTOs (init upload, complete upload, etc.) | E2E — one validation-wiring test per endpoint proving `ValidationPipe` is active |
| Exception filter mappings (new domain exceptions) | Reuse existing `DomainExceptionFilter` (Unit + E2E already cover the filter); add E2E assertions for new error codes |

Notes: integration + e2e suites share one test database and run with `--runInBand`. Race conditions (concurrent uploads, `public_id` collision) are explicitly worth testing per the guide §2. Specific layer coverage by SI is recorded in `progress.md`.
