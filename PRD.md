# Speech-to-Text API Service — PRD

## Overview

A self-hosted API service that accepts audio files (upload or URL, including Telegram bot file URLs), queues transcription jobs, processes them via whisper.cpp, and returns plain text results. Supports MP3, OGG/Opus, WAV, M4A, and WEBM — all converted to 16kHz mono WAV via ffmpeg before transcription. Docker Compose deployment with separate API and worker containers, scalable to N workers. Built with Bun, Hono, Drizzle, PostgreSQL, ffmpeg, and whisper.cpp.

---

## Architecture

```
┌──────────────────────────────────────────────────────────┐
│  Docker Compose                                          │
│                                                          │
│  ┌──────────────────┐    ┌──────────────────┐            │
│  │  API Container    │    │  Worker Container │ × N       │
│  │  (Bun + Hono)     │    │  (Bun + whisper)  │           │
│  │                   │    │  + ffmpeg          │           │
│  │  - HTTP server    │    │  - Polling loop   │           │
│  │  - Job creation   │    │  - Download audio │           │
│  │  - Status queries │    │  - Invoke whisper │           │
│  │  - Retry endpoint │    │  - Store results  │           │
│  │  - Cleanup cron   │    │                   │           │
│  └────────┬──────────┘    └────────┬──────────┘           │
│           │                        │                      │
│           └────────┐  ┌────────────┘                      │
│                    ▼  ▼                                   │
│           ┌──────────────────┐   ┌──────────────────┐     │
│           │   PostgreSQL     │   │  Shared Volume    │     │
│           │   (job queue +   │   │  /data/audio      │     │
│           │    results)      │   │                   │     │
│           └──────────────────┘   └──────────────────┘     │
│                                                          │
└──────────────────────────────────────────────────────────┘
```

- **API container**: Hono HTTP server. Handles job creation, status queries, retry, and cleanup. Single instance.
- **Worker container(s)**: Polls DB for pending jobs, downloads audio (if URL), converts to WAV via ffmpeg, invokes whisper.cpp, stores results. Scalable to N replicas.
- **PostgreSQL**: Job queue, state, and results. `FOR UPDATE SKIP LOCKED` ensures no two workers pick the same job.
- **Shared volume**: Audio files accessible by both API (for uploads) and workers (for processing).
- **Same codebase, two entrypoints**: `bun run api` and `bun run worker`.
- **No Python. No GPU.**

### Tech Stack

| Component     | Choice                          |
|---------------|---------------------------------|
| Runtime       | Bun                             |
| Framework     | Hono                            |
| ORM           | Drizzle                         |
| Database      | PostgreSQL 16                   |
| STT Engine    | whisper.cpp (small model)       |
| Audio Convert | ffmpeg (any format → 16kHz WAV) |
| Auth          | HTTP Basic Auth                 |
| Deployment    | Docker Compose                  |

---

## Data Model

### `jobs` table

| Column         | Type         | Notes                                              |
|----------------|--------------|----------------------------------------------------|
| `id`           | UUID (PK)    | Returned to client on creation                     |
| `status`       | enum         | `pending`, `processing`, `completed`, `failed`     |
| `source_type`  | enum         | `upload`, `url`                                    |
| `source_url`   | text (null)  | Original URL if source_type is `url` (incl. Telegram file URLs) |
| `original_name`| text (null)  | Original filename or URL basename, for debugging   |
| `file_path`    | text         | Local path to the stored original audio file       |
| `wav_path`     | text (null)  | Local path to the converted 16kHz mono WAV. Set by worker after conversion |
| `language`     | text (null)  | Optional BCP-47 language hint (e.g. `en`, `es`, `ja`). Null = auto-detect |
| `result_text`  | text (null)  | Transcription output. Populated on completion      |
| `error`        | text (null)  | Error message if failed. For debugging             |
| `attempts`     | integer      | Number of processing attempts. Default 0           |
| `max_attempts` | integer      | Default from `MAX_ATTEMPTS` env                    |
| `created_at`   | timestamp    | Job creation time                                  |
| `updated_at`   | timestamp    | Last status change                                 |

Index on `(status, created_at)` for the worker polling query (FIFO).

---

## API Endpoints

All endpoints require Basic Auth.

### `POST /jobs`

Create a new transcription job.

**Option A — File upload:**
```
POST /jobs
Content-Type: multipart/form-data

file: <audio binary>
language: "en"  (optional)
```

**Option B — URL (including Telegram bot file URLs):**
```
POST /jobs
Content-Type: application/json

{
  "url": "https://api.telegram.org/file/bot<token>/voice/file_123.ogg",
  "language": "en"
}
```

The `language` field is optional. Accepts BCP-47 language codes (e.g. `en`, `es`, `de`, `ja`, `zh`). When omitted, whisper.cpp auto-detects the language.

**Accepted audio formats:** MP3, OGG/Opus, WAV, M4A, WEBM. All formats are converted to 16kHz mono WAV by the worker before transcription.

**Response (201):**
```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "status": "pending"
}
```

**Behavior:**
- For uploads: validate file extension is a supported audio format, validate file size against `MAX_FILE_SIZE_MB`, save original file to shared volume, create DB record, return immediately.
- For URLs (including Telegram `https://api.telegram.org/file/bot.../...` URLs): validate URL format, create DB record with `source_type: url`, return immediately. The worker handles downloading. Telegram file URLs are treated as regular HTTP downloads — the bot token in the URL provides authentication.
- File size validation applies after download for URL jobs. If the downloaded file exceeds the limit, the job fails with an error.

**Errors:**
- `413` — File exceeds `MAX_FILE_SIZE_MB`
- `400` — No file or URL provided, unsupported audio format, invalid language code
- `401` — Auth failure

### `GET /jobs/:id`

Get job status and result.

**Response (200):**
```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "status": "completed",
  "source_type": "upload",
  "result_text": "Hello, this is the transcribed text...",
  "error": null,
  "attempts": 1,
  "created_at": "2025-02-11T10:00:00Z",
  "updated_at": "2025-02-11T10:02:30Z"
}
```

- `result_text` is `null` unless status is `completed`.
- `error` is `null` unless status is `failed`.
- When status is `failed` and `attempts < max_attempts`, the job is eligible for retry.

**Errors:**
- `404` — Job not found
- `401` — Auth failure

### `POST /jobs/:id/retry`

Retry a failed job.

**Response (200):**
```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "status": "pending"
}
```

**Behavior:**
- Only works on jobs with status `failed` where `attempts < max_attempts`.
- Resets status to `pending`.

**Errors:**
- `404` — Job not found
- `409` — Job is not in a retryable state (not failed, or max attempts reached)
- `401` — Auth failure

### `GET /health`

No auth required. Returns `200 OK` with basic service info. Used for Docker healthcheck.

---

## Worker

### Separate Container

Workers run as independent containers with the same codebase as the API, using a different entrypoint (`bun run worker`). Scale via Docker Compose `replicas` or `--scale worker=N`.

Each worker instance runs a single-threaded polling loop processing one job at a time. whisper.cpp is CPU-intensive, so one job per container is optimal. Scale horizontally by adding more worker containers.

### Polling Loop

- Polls the DB every `WORKER_POLL_INTERVAL_MS` (default: 3000ms).
- Query: `SELECT * FROM jobs WHERE status = 'pending' ORDER BY created_at ASC LIMIT 1 FOR UPDATE SKIP LOCKED`
- `FOR UPDATE SKIP LOCKED` is the coordination mechanism: multiple workers can poll simultaneously and each gets a different job. No duplicate processing. No external queue needed.
- If no pending jobs, sleep and poll again.

### Processing Pipeline

For each job:

1. **Claim job**: Set status → `processing`, increment `attempts`.
2. **Download** (if `source_type = url`): Download file to shared volume. Works with any HTTP URL including Telegram bot file URLs (`https://api.telegram.org/file/bot<token>/<path>`). Enforce `MAX_FILE_SIZE_MB` — fail if exceeded. Timeout: `DOWNLOAD_TIMEOUT_SEC` (default: 120).
3. **Convert**: Transcode to 16kHz mono WAV via ffmpeg:
   ```
   ffmpeg -i <input_file> -ar 16000 -ac 1 -c:a pcm_s16le <job-uuid>.wav
   ```
   - Handles MP3, OGG/Opus (Telegram voice messages), WAV, M4A, WEBM.
   - Output saved as `{job-uuid}.wav` in shared volume. `wav_path` updated in DB.
   - If ffmpeg fails (corrupt file, unsupported codec), job fails with ffmpeg stderr in `error`.
4. **Transcribe**: Invoke whisper.cpp via `Bun.spawn()`:
   ```
   whisper-cli -m /models/ggml-small.bin -f <wav_file> --output-txt --no-timestamps [-l <language>]
   ```
   - Reads the converted WAV, not the original file.
   - The `-l` flag is included only if `language` is set on the job. Otherwise whisper auto-detects.
   - Timeout: `TRANSCRIBE_TIMEOUT_SEC` (default: 300 — the 5 minute cap).
   - Capture stdout/stderr.
5. **On success**: Set `status = completed`, store `result_text`, update `updated_at`.
6. **On failure**: Set `status = failed`, store error message in `error`, update `updated_at`. Job can be retried manually via the retry endpoint if `attempts < max_attempts`.

### Timeout Handling

- If whisper.cpp exceeds `TRANSCRIBE_TIMEOUT_SEC`, the child process is killed and the job is marked `failed` with error `"Transcription timed out after {n} seconds"`.

---

## Cleanup

### Scheduled Cleanup Task

- Runs inside the **API container** on interval: `CLEANUP_INTERVAL_HOURS` (default: 1).
- Deletes all jobs (DB record + original audio file + converted WAV on shared volume) where `created_at < now() - CLEANUP_RETENTION_DAYS`.
- Also deletes orphaned audio files in the storage directory that have no corresponding DB record.
- Only one API instance runs, so no coordination needed for cleanup.

---

## Configuration (Environment Variables)

| Variable                  | Default      | Description                                   |
|---------------------------|--------------|-----------------------------------------------|
| `PORT`                    | `3000`       | API listen port                               |
| `DATABASE_URL`            | (required)   | PostgreSQL connection string                  |
| `BASIC_AUTH_USER`         | (required)   | Basic auth username                           |
| `BASIC_AUTH_PASS`         | (required)   | Basic auth password                           |
| `MAX_FILE_SIZE_MB`        | `20`         | Max upload/download size in MB                |
| `STORAGE_DIR`             | `/data/audio`| Shared volume for audio files                 |
| `WHISPER_MODEL_PATH`      | `/models/ggml-small.bin` | Path to whisper.cpp model file   |
| `WHISPER_BINARY_PATH`     | `whisper-cli`| Path to whisper.cpp binary                    |
| `WORKER_POLL_INTERVAL_MS` | `3000`       | Worker polling interval in ms                 |
| `TRANSCRIBE_TIMEOUT_SEC`  | `300`        | Max transcription time (5 min)                |
| `DOWNLOAD_TIMEOUT_SEC`    | `120`        | Max download time for URL jobs                |
| `MAX_ATTEMPTS`            | `3`          | Max processing attempts per job               |
| `CLEANUP_RETENTION_DAYS`  | `7`          | Days to keep completed/failed jobs            |
| `CLEANUP_INTERVAL_HOURS`  | `1`          | How often cleanup runs (API container only)   |

---

## Docker Compose Structure

```yaml
services:
  api:
    build:
      context: .
      dockerfile: Dockerfile
    command: ["bun", "run", "src/api.ts"]
    ports:
      - "${PORT:-3000}:3000"
    environment:
      - DATABASE_URL=postgresql://stt:stt@db:5432/stt
      - BASIC_AUTH_USER
      - BASIC_AUTH_PASS
      # ... all other env vars
    volumes:
      - audio_data:/data/audio
      - model_data:/models
    depends_on:
      db:
        condition: service_healthy
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:3000/health"]
      interval: 30s
      timeout: 5s
      retries: 3

  worker:
    build:
      context: .
      dockerfile: Dockerfile
    command: ["bun", "run", "src/worker.ts"]
    environment:
      - DATABASE_URL=postgresql://stt:stt@db:5432/stt
      # ... worker env vars (no PORT, no AUTH needed)
    volumes:
      - audio_data:/data/audio
      - model_data:/models
    depends_on:
      db:
        condition: service_healthy
    deploy:
      replicas: 2  # Scale as needed
    restart: unless-stopped

  db:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: stt
      POSTGRES_PASSWORD: stt
      POSTGRES_DB: stt
    volumes:
      - pg_data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-ARGS", "pg_isready", "-U", "stt"]
      interval: 10s
      timeout: 5s
      retries: 5

volumes:
  pg_data:
  audio_data:
  model_data:
```

Scale workers at any time:
```bash
docker compose up --scale worker=5 -d
```

### Shared Dockerfile

```dockerfile
FROM oven/bun:1 AS base

# Install ffmpeg, build deps, compile whisper.cpp from source
# Download ggml-small.bin model (~500MB)
# Copy app source, install deps

# No CMD — overridden by docker-compose command per service
```

Both `api` and `worker` services use the same image. The `command` directive selects the entrypoint. ffmpeg, whisper.cpp binary, and model are baked into the image.

---

## File Storage Layout

```
/data/audio/          (shared Docker volume, mounted by API + all workers)
  ├── {job-uuid-1}.ogg      # original upload or download
  ├── {job-uuid-1}.wav      # converted by worker (16kHz mono)
  ├── {job-uuid-2}.mp3
  ├── {job-uuid-2}.wav
  └── ...
```

Original files keep their format extension. Converted WAVs use the same job UUID with `.wav` extension. Both are cleaned up together.

---

## Error Handling

| Scenario                        | Behavior                                                  |
|---------------------------------|-----------------------------------------------------------|
| Upload exceeds size limit       | `413` response, no job created                            |
| Unsupported audio format        | `400` response, no job created                            |
| Invalid URL format              | `400` response, no job created                            |
| URL download fails              | Job marked `failed`, error stored                         |
| Downloaded file exceeds limit   | Job marked `failed`, file deleted, error stored           |
| ffmpeg conversion fails         | Job marked `failed`, ffmpeg stderr in `error`             |
| whisper.cpp crashes             | Job marked `failed`, stderr captured in `error`           |
| whisper.cpp times out           | Process killed, job marked `failed`, timeout error stored |
| whisper.cpp returns empty text  | Job marked `completed`, `result_text` = `""`              |
| DB connection lost during work  | Worker crashes, job stays `processing` — see below        |

### Stale Job Recovery

On startup, **each worker** checks for jobs stuck in `processing` status that have been in that state for longer than `TRANSCRIBE_TIMEOUT_SEC + DOWNLOAD_TIMEOUT_SEC + 60s` (a generous buffer). These are reset to `pending` so they can be retried. This handles cases where a worker container crashed mid-processing.

The staleness check uses `updated_at` timestamp comparison rather than claiming specific job IDs, so multiple workers starting simultaneously won't conflict.

---

## Project Structure

```
src/
  ├── api.ts              # API entrypoint (Hono server + cleanup cron)
  ├── worker.ts           # Worker entrypoint (polling loop)
  ├── db/
  │   ├── schema.ts       # Drizzle schema
  │   ├── index.ts        # DB connection
  │   └── migrate.ts      # Migration runner
  ├── routes/
  │   ├── jobs.ts         # Job endpoints
  │   └── health.ts       # Health endpoint
  ├── services/
  │   ├── transcribe.ts   # whisper.cpp invocation
  │   ├── convert.ts      # ffmpeg audio conversion (any format → 16kHz WAV)
  │   ├── download.ts     # URL download logic (generic HTTP, works with Telegram)
  │   └── cleanup.ts      # Cleanup logic
  ├── middleware/
  │   └── auth.ts         # Basic auth middleware
  └── config.ts           # Env var parsing + validation
tests/
  ├── unit/
  │   ├── config.test.ts
  │   ├── services/
  │   │   ├── transcribe.test.ts
  │   │   ├── convert.test.ts
  │   │   ├── download.test.ts
  │   │   └── cleanup.test.ts
  │   ├── middleware/
  │   │   └── auth.test.ts
  │   └── routes/
  │       ├── jobs.test.ts
  │       └── health.test.ts
  ├── integration/
  │   ├── worker.test.ts
  │   └── api.test.ts
  └── helpers/
      ├── fixtures.ts       # Test audio files, mock job records
      ├── db.ts             # Test DB setup/teardown helpers
      └── mocks.ts          # Shared mocks (Bun.spawn, ffmpeg, whisper, fs)
drizzle/
  └── migrations/         # SQL migrations
Dockerfile
docker-compose.yml
docker-compose.test.yml    # Compose override for test environment (test DB)
biome.json                 # Linter + formatter config
package.json
```

---

## Testing

### Framework

Bun's built-in test runner (`bun test`). No additional test framework needed. It supports `describe`, `it`/`test`, `expect`, `beforeAll`, `beforeEach`, `afterAll`, `afterEach`, `mock`, and `spyOn` natively.

### Strategy

All external side effects (Bun.spawn, file system, network, DB) are injected as dependencies or mocked. Services accept their dependencies explicitly so unit tests never touch real processes, files, or databases.

### Unit Tests

**`config.test.ts`** — Env var parsing and validation:
- Parses all env vars with valid values
- Applies correct defaults for optional vars (PORT=3000, MAX_FILE_SIZE_MB=20, etc.)
- Throws on missing required vars (DATABASE_URL, BASIC_AUTH_USER, BASIC_AUTH_PASS)
- Throws on invalid values (negative numbers, non-numeric strings for numeric vars)
- Coerces string env vars to correct types (number, boolean)

**`auth.test.ts`** — Basic auth middleware:
- Allows request with valid credentials
- Rejects request with no Authorization header → 401
- Rejects request with wrong credentials → 401
- Rejects request with malformed Authorization header (not Basic scheme) → 401
- Handles empty username or password gracefully
- Handles non-base64 encoded credentials

**`routes/jobs.test.ts`** — Job endpoint handlers (DB mocked via dependency injection):
- `POST /jobs` with file upload: creates job, returns 201 with id + status
- `POST /jobs` with URL body: creates job, returns 201
- `POST /jobs` with Telegram URL: accepted, creates job with source_type=url
- `POST /jobs` with optional language field: stored on job record
- `POST /jobs` with invalid language code: returns 400
- `POST /jobs` with no file and no URL: returns 400
- `POST /jobs` with file exceeding MAX_FILE_SIZE_MB: returns 413
- `POST /jobs` with unsupported file extension: returns 400
- `POST /jobs` validates each supported format (mp3, ogg, wav, m4a, webm) is accepted
- `GET /jobs/:id` returns full job record with correct fields
- `GET /jobs/:id` with pending job: result_text is null
- `GET /jobs/:id` with completed job: result_text populated
- `GET /jobs/:id` with failed job: error populated
- `GET /jobs/:id` with nonexistent id: returns 404
- `POST /jobs/:id/retry` on failed job with attempts < max: resets to pending, returns 200
- `POST /jobs/:id/retry` on failed job with attempts >= max: returns 409
- `POST /jobs/:id/retry` on non-failed job (pending/processing/completed): returns 409
- `POST /jobs/:id/retry` on nonexistent id: returns 404

**`routes/health.test.ts`** — Health endpoint:
- Returns 200 with service info
- Does not require auth

**`services/convert.test.ts`** — ffmpeg conversion (Bun.spawn mocked):
- Calls ffmpeg with correct args: `-i <input> -ar 16000 -ac 1 -c:a pcm_s16le <output.wav>`
- Returns wav path on success
- Throws with ffmpeg stderr on non-zero exit code
- Handles each input format (mp3, ogg, wav, m4a, webm)
- Respects timeout — kills process if conversion hangs

**`services/transcribe.test.ts`** — whisper.cpp invocation (Bun.spawn mocked):
- Calls whisper-cli with correct args
- Includes `-l <language>` flag when language is provided
- Omits `-l` flag when language is null
- Returns stdout text on success
- Throws with stderr on non-zero exit code
- Kills process and throws on timeout (TRANSCRIBE_TIMEOUT_SEC)
- Uses wav_path, not the original file_path

**`services/download.test.ts`** — URL download (fetch mocked):
- Downloads file to correct path ({uuid}.{ext})
- Extracts extension from URL path
- Extracts extension from Content-Type header as fallback
- Defaults to `.ogg` for Telegram-style URLs with no clear extension
- Fails with error when HTTP response is not 2xx
- Fails when downloaded file exceeds MAX_FILE_SIZE_MB
- Deletes partial file on failure
- Fails on timeout (DOWNLOAD_TIMEOUT_SEC)
- Handles redirects

**`services/cleanup.test.ts`** — Cleanup logic (DB + fs mocked):
- Queries for jobs older than CLEANUP_RETENTION_DAYS
- Deletes DB records for expired jobs
- Deletes original audio file for each expired job
- Deletes converted WAV file for each expired job
- Handles missing files gracefully (file already deleted)
- Deletes orphaned files with no DB record

### Integration Tests

Run against a real PostgreSQL instance (via `docker-compose.test.yml`).

**`integration/api.test.ts`**:
- Full request lifecycle: create job → poll status → verify pending
- Auth enforcement across all protected endpoints
- File upload with real multipart form parsing
- URL job creation and DB record verification
- Retry flow: create → manually set to failed → retry → verify pending

**`integration/worker.test.ts`**:
- Worker picks up pending job and sets to processing (with mocked whisper/ffmpeg)
- Worker FIFO ordering: earlier jobs processed first
- Multiple workers don't pick up the same job (FOR UPDATE SKIP LOCKED)
- Stale job recovery on startup
- Failed job increments attempts
- Worker skips jobs at max_attempts

### Test Commands

```bash
bun test                          # Run all tests
bun test --filter unit            # Unit tests only
bun test --filter integration     # Integration tests only (requires test DB)
bun test --coverage               # With coverage report
```

### Test Database

`docker-compose.test.yml` extends the base compose with a separate PostgreSQL instance on a different port. Migrations run before tests. Each test suite truncates tables in `beforeEach`.

---

## Linting & Formatting

### Tool: Biome

Biome (biomejs.dev) — single tool for linting + formatting. Fast, built in Rust, native TypeScript support, zero config needed. Preferred over ESLint + Prettier for Bun projects (no plugin hell, single dependency).

### Config (`biome.json`)

```json
{
  "$schema": "https://biomejs.dev/schemas/1.9.0/schema.json",
  "organizeImports": {
    "enabled": true
  },
  "formatter": {
    "enabled": true,
    "indentStyle": "tab",
    "indentWidth": 2,
    "lineWidth": 100
  },
  "linter": {
    "enabled": true,
    "rules": {
      "recommended": true,
      "complexity": {
        "noExcessiveCognitiveComplexity": "error",
        "noForEach": "warn",
        "useLiteralKeys": "error"
      },
      "correctness": {
        "noUnusedVariables": "error",
        "noUnusedImports": "error",
        "useExhaustiveDependencies": "error",
        "noUndeclaredVariables": "error"
      },
      "performance": {
        "noAccumulatingSpread": "error",
        "noDelete": "warn"
      },
      "security": {
        "noDangerouslySetInnerHtml": "error"
      },
      "style": {
        "noNonNullAssertion": "error",
        "useConst": "error",
        "useTemplate": "error",
        "noVar": "error",
        "useNodejsImportProtocol": "error"
      },
      "suspicious": {
        "noExplicitAny": "error",
        "noConsoleLog": "warn",
        "noDebugger": "error",
        "noDoubleEquals": "error",
        "noImplicitAnyLet": "error"
      }
    }
  },
  "typescript": {
    "formatter": {
      "quoteStyle": "single"
    }
  }
}
```

### Strict TypeScript (`tsconfig.json` additions)

```json
{
  "compilerOptions": {
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitReturns": true,
    "noFallthroughCasesInSwitch": true,
    "forceConsistentCasingInFileNames": true,
    "exactOptionalPropertyTypes": true
  }
}
```

### Key Rules (Strict)

- **No `any`**: `noExplicitAny: error` + `noImplicitAnyLet: error`. Everything is typed.
- **No unused code**: Unused variables and imports are errors, not warnings.
- **No non-null assertions** (`!`): Forces proper null handling.
- **No `var`**: Only `const` and `let`.
- **No `==`**: Only `===`.
- **No `console.log`**: Use a structured logger. `console.log` is a warning (allowed in dev, caught in CI).
- **Cognitive complexity limit**: Functions that are too complex must be refactored.

### Commands

```bash
bun run lint                      # Check for lint errors
bun run lint:fix                  # Auto-fix what's possible
bun run format                    # Format all files
bun run format:check              # Check formatting (CI)
bun run check                     # lint + format check (CI gate)
```

### package.json Scripts

```json
{
  "scripts": {
    "api": "bun run src/api.ts",
    "worker": "bun run src/worker.ts",
    "test": "bun test",
    "test:unit": "bun test --filter unit",
    "test:integration": "bun test --filter integration",
    "test:coverage": "bun test --coverage",
    "lint": "biome check .",
    "lint:fix": "biome check --write .",
    "format": "biome format --write .",
    "format:check": "biome format .",
    "check": "biome check . && bun run tsc --noEmit",
    "typecheck": "tsc --noEmit",
    "db:generate": "drizzle-kit generate",
    "db:migrate": "bun run src/db/migrate.ts"
  }
}
```

### CI Gate

All of the following must pass before merge/deploy:
1. `bun run check` (Biome lint + format + TypeScript type check)
2. `bun test` (all unit + integration tests pass)
3. `bun test --coverage` (optional: enforce coverage threshold)

---

## Out of Scope (for now)

- Multiple users / API key management
- Webhooks / callbacks
- Job listing / pagination
- Priority queues
- GPU support
- Streaming transcription
- Timestamped output / segments

---

## Open Questions

None — all decisions resolved. Ready for implementation.