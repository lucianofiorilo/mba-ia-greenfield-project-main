---
libs:
  "@nestjs/bullmq":
    version: "^11.0.4"
    context7_id: "unavailable-in-session"
    fetched_at: "2026-06-28T20:05:00-03:00"
  bullmq:
    version: "^5"
    context7_id: "unavailable-in-session"
    fetched_at: "2026-06-28T20:05:00-03:00"
  "@aws-sdk/client-s3":
    version: "^3"
    context7_id: "unavailable-in-session"
    fetched_at: "2026-06-28T20:05:00-03:00"
  "@aws-sdk/s3-request-presigner":
    version: "^3"
    context7_id: "unavailable-in-session"
    fetched_at: "2026-06-28T20:05:00-03:00"
  fluent-ffmpeg:
    version: "^2.1.3"
    context7_id: "unavailable-in-session"
    fetched_at: "2026-06-28T20:05:00-03:00"
  "@types/fluent-ffmpeg":
    version: "^2.1.27"
    context7_id: "unavailable-in-session"
    fetched_at: "2026-06-28T20:05:00-03:00"
  nanoid:
    version: "^3.3.7"
    context7_id: "unavailable-in-session"
    fetched_at: "2026-06-28T20:05:00-03:00"
sources_mtime:
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-06-28T20:02:00-03:00"
---

# phase-03-videos — Library References

Distilled usage notes for the new libraries pinned in this phase. Versions confirmed against the npm registry (June 2026).

> **Note on sourcing:** the `context7` MCP server declared in `.mcp.json` was **not connected in the session** that produced this file, so versions/usage were confirmed via the npm registry + official docs (web) instead. The `context7_id` fields are marked `unavailable-in-session`. Re-run `/plan-resolve phase-03-videos` with context7 connected to refresh these with canonical Context7 IDs. All versions below are real, current, and compatible with the installed stack (NestJS 11, TypeScript 5.7, CommonJS/ts-jest).

## @nestjs/bullmq + bullmq

**Versions:** `@nestjs/bullmq@^11.0.4` (supports `@nestjs/common`/`core` `^10 || ^11` → compatible with NestJS 11), `bullmq@^5` (the module supports BullMQ 3/4/5; pin 5, the current major). Backed by Redis 7 (Docker image, NOT an npm dep). BullMQ uses `ioredis` transitively — no need to add it directly.

### Wiring (maps to TD-01, TD-05)

Register the connection once and declare the queue:

```typescript
// app.module.ts (or a dedicated QueueModule)
BullModule.forRootAsync({
  inject: [queueConfig.KEY],
  useFactory: (cfg: ConfigType<typeof queueConfig>) => ({
    connection: { host: cfg.redisHost, port: cfg.redisPort },
  }),
}),
BullModule.registerQueue({ name: 'video-processing' }),
```

- **Producer (API):** inject the queue and add jobs.
  ```typescript
  constructor(@InjectQueue('video-processing') private readonly queue: Queue) {}
  await this.queue.add('process', { videoId }, {
    attempts: 3,
    backoff: { type: 'exponential', delay: 5000 },
    removeOnComplete: true,
    removeOnFail: false, // keep failed jobs (dead-letter) for inspection
  });
  ```
- **Consumer (worker):** a `@Processor` class with a `WorkerHost`.
  ```typescript
  @Processor('video-processing')
  export class VideoProcessingProcessor extends WorkerHost {
    async process(job: Job<{ videoId: string }>): Promise<void> { /* ffprobe + thumbnail */ }
  }
  ```
- **Concurrency / retry / dead-letter:** all native — `attempts` + `backoff` on `add()` (or worker options); failed jobs after exhausting `attempts` stay in the failed set when `removeOnFail: false` → maps to video `status = failed` (TD-08).
- **Host binding:** `connection.host` MUST be the Compose service name `redis` (per CLAUDE.md Docker networking), never `localhost`.

### Key contracts for Phase 03

- The **same `'video-processing'` queue name** is the contract between the API producer and the worker consumer — define it as a shared constant.
- Job payload is minimal (`{ videoId }`); the worker re-reads the video row + storage object. Keeps the queue small and the DB the source of truth.
- Integration tests use a **real Redis** from Compose (do not mock BullMQ — testing-guide §1 "configured libs").

## @aws-sdk/client-s3 + @aws-sdk/s3-request-presigner

**Versions:** both `@^3` (current `3.10xx.x`, released in lock-step). S3-compatible client that talks to MinIO (dev) and AWS S3 (prod) by swapping `endpoint`.

### Client config for MinIO (maps to TD-03)

```typescript
new S3Client({
  region: cfg.region,                 // e.g. 'us-east-1' (MinIO ignores but required)
  endpoint: cfg.endpoint,             // http://minio:9000 (Compose service name!)
  forcePathStyle: true,               // REQUIRED for MinIO (path-style, not vhost-style)
  credentials: { accessKeyId: cfg.accessKey, secretAccessKey: cfg.secretKey },
});
```

### Multipart upload handshake (maps to TD-02)

1. **Init:** `CreateMultipartUploadCommand` → returns `UploadId`.
2. **Sign each part:** build an `UploadPartCommand` per part and sign it with `getSignedUrl(client, command, { expiresIn })` from `@aws-sdk/s3-request-presigner`. The client uploads each part directly to MinIO via the presigned URL and collects the `ETag` of each.
3. **Complete:** `CompleteMultipartUploadCommand` with the ordered `{ PartNumber, ETag }[]`.
4. **Abort/cleanup:** `AbortMultipartUploadCommand` for cancelled/abandoned uploads.

- Single presigned `PUT` caps at **5GB** → multipart is mandatory for the 10GB target.
- Part size: 5MB–5GB per part (use ~5–64MB chunks). Max object size 5TB.
- `getSignedUrl` `expiresIn` short (e.g. 5–15 min); treat presigned URLs as secrets (never log them).

### Range streaming + download (maps to TD-07)

```typescript
const res = await client.send(new GetObjectCommand({
  Bucket, Key, Range: `bytes=${start}-${end}`,
}));
// res.Body is a Node Readable stream → pipe to the HTTP response with status 206
// res.ContentLength / res.ContentRange describe the slice
```

- `GetObjectCommand` honors the `Range` header → MinIO returns only the requested bytes (true streaming). Pipe `res.Body` (a stream) to the Express response — never buffer the whole object.
- Download = same command without `Range` (or full range) + `Content-Disposition: attachment`.

### Key contracts for Phase 03

- `endpoint` + `forcePathStyle: true` is the MinIO↔S3 portability seam — production swaps `endpoint` to AWS and drops `forcePathStyle`.
- Bucket name + region come from config (`registerAs` `storage.config.ts`); host is the Compose service name `minio`.
- Integration tests use **real MinIO** from Compose.

## fluent-ffmpeg (+ @types/fluent-ffmpeg)

**Versions:** `fluent-ffmpeg@^2.1.3` runtime, `@types/fluent-ffmpeg@^2.1.27` dev (the lib ships no own types). Requires the `ffmpeg`/`ffprobe` **binaries** on `$PATH` — installed via apt in the worker image (TD-04/TD-05), NOT bundled by npm.

### Metadata extraction (maps to TD-04)

```typescript
import ffmpeg from 'fluent-ffmpeg';

const meta = await new Promise<FfprobeData>((resolve, reject) =>
  ffmpeg.ffprobe(localPath, (err, data) => (err ? reject(err) : resolve(data))),
);
const durationSeconds = meta.format.duration;          // number (seconds)
const { width, height } = meta.streams.find(s => s.codec_type === 'video') ?? {};
```

### Thumbnail from a frame (maps to TD-04)

```typescript
await new Promise<void>((resolve, reject) =>
  ffmpeg(localPath)
    .screenshots({ timestamps: ['50%'], filename: 'thumbnail.jpg', folder: outDir, size: '1280x?' })
    .on('end', () => resolve())
    .on('error', reject),
);
```

### Key contracts / gotchas for Phase 03

- **`folder` MUST exist before calling `.screenshots()`** — FFmpeg exits silently (no `error` event) if the output dir is missing. Create the temp dir first.
- The worker streams the source object from MinIO to a **temp file on disk** (10GB-safe: bounded by disk, not RAM), runs ffprobe + screenshot, uploads the thumbnail back to MinIO, persists duration/metadata, sets `status = ready`, then deletes the temp file.
- `@types/fluent-ffmpeg` is a `devDependency`; `FfprobeData` typing comes from it.
- Integration test uses a tiny real sample video + real FFmpeg (worker image) — asserts duration extracted, thumbnail object created, status flips to `ready`.

## nanoid

**Version:** `nanoid@^3.3.7` — **pinned to the v3 line on purpose.** nanoid **v4+ is ESM-only** and throws `ERR_REQUIRE_ESM` under the project's CommonJS setup (`ts-node-commonjs`, `ts-jest`, `module: nodenext` emitting CJS in tests). v3 ships CommonJS and `require()`s cleanly.

### Usage (maps to TD-06)

```typescript
import { nanoid } from 'nanoid';
const publicId = nanoid(11);   // e.g. 'V1StGXR8_Z5' — URL-safe, ~11 chars
```

### Key contracts for Phase 03

- Stored in `videos.public_id` with a **unique constraint**; on the (astronomically rare) `23505` unique violation, regenerate and retry — same pattern the channels module uses for `nickname`.
- Default alphabet is URL-safe (`A-Za-z0-9_-`); 11 chars at the platform's scale has negligible collision probability.
- **Do not upgrade to v4/v5** without migrating the whole test/runtime chain to ESM — out of scope for this phase.
