# Docker Patch Manager

A self-hosted service that downloads Docker images from public registries, scans them for vulnerabilities with [Trivy](https://github.com/aquasecurity/trivy), patches OS-level packages with [Copa](https://github.com/project-copacetic/copacetic), and saves the patched images as `.tgz` tar files — ready to be loaded in an air-gapped offline environment.

## How It Works

```
Add image via API
      │
      ▼
docker pull (from Docker Hub or other registry)
      │
      ▼
Trivy scan → vulnerability report
      │
      ▼
Copa patch → updated image layers (OS packages only)
      │
      ▼
docker save | gzip → /output/<arch>/<name>_<tag>.tgz
      │
      ▼
Transfer tar to offline environment → docker load
```

Images that only contain language-level vulnerabilities (npm, pip, etc.) that Copa cannot patch are saved as-is and marked `ready-unpatched` with the vulnerability counts preserved for the operator's awareness.

## Requirements

- Docker (host Docker daemon, socket mounted into the container)
- Internet access to Docker Hub (or your target registry)

## Quick Start

```bash
docker compose up --build
```

The API is available at `http://localhost:5432`. Interactive API docs at `http://localhost:5432/docs`.

Patched image tars are written to `./output/` on the host, organized by architecture. The database is stored in `./database/`.

## Configuration

| Variable            | Default     | Description                                               |
| ------------------- | ----------- | --------------------------------------------------------- |
| `PORT`              | `5432`      | HTTP server port                                          |
| `PATCH_SCHEDULE`    | `0 2 * * *` | Cron expression for automatic patch cycles (daily at 2am) |
| `PATCH_CONCURRENCY` | `3`         | Max images processed simultaneously                       |
| `COPA_TIMEOUT`      | `30m`       | Timeout for each Copa patch operation                     |
| `CORS_ORIGIN`       | `http://localhost:5432` | Allowed CORS origin for API requests             |

Copy `.env.example` to `.env` and adjust values before running outside Docker Compose.

## API Reference

| Method   | Path                  | Description                                                          |
| -------- | --------------------- | -------------------------------------------------------------------- |
| `GET`    | `/images`             | List all images in the manifest                                      |
| `POST`   | `/images`             | Add an image to the manifest                                         |
| `DELETE` | `/images/:id`         | Remove an image and delete its tar                                   |
| `POST`   | `/images/:id/scan`    | Trigger an ad-hoc scan-and-patch cycle for a single image            |
| `POST`   | `/images/cleanup`     | Delete superseded minor/patch versions, keeping the latest per group |
| `POST`   | `/scan`               | Trigger an immediate scan-and-patch cycle                            |
| `GET`    | `/scan/status`        | Current job state, progress, and last run summary                    |
| `GET`    | `/health`             | Health check                                                         |
| `GET`    | `/docs`               | Swagger UI (full OpenAPI 3.0 spec)                                   |

### Add an image

```bash
curl -X POST http://localhost:5432/images \
  -H 'Content-Type: application/json' \
  -d '{"name":"nginx","tag":"1.27","registry":"docker.io","architecture":"linux/amd64"}'
```

### Scan a single image

```bash
curl -X POST http://localhost:5432/images/1/scan
```

### Trigger a patch cycle

```bash
curl -X POST http://localhost:5432/scan
```

### Check progress

```bash
curl http://localhost:5432/scan/status
```

### Clean up old image versions

Preview what would be deleted (dry run):

```bash
curl -X POST 'http://localhost:5432/images/cleanup?dryRun=true'
```

Delete superseded versions (keeps the highest semver per name/registry/architecture/major/suffix group):

```bash
curl -X POST http://localhost:5432/images/cleanup
```

Returns `{ dryRun, count, images }` — the list of images that were (or would be) removed.

## Data Layout

```
./database/
└── patch-manager.db        # SQLite database (image list, status, vuln counts)

./output/
├── linux-amd64/
│   ├── nginx_1.27.tgz
│   └── redis_7.2.tgz
└── linux-arm64/
    └── nginx_1.27.tgz
```

Both directories are bind-mounted into the container and persist across restarts. Transfer the relevant architecture folder to your offline environment and load images with:

```bash
docker load -i nginx_1.27.tgz
```

## Tools Used

| Tool                                                                    | Role                                                        |
| ----------------------------------------------------------------------- | ----------------------------------------------------------- |
| [Trivy](https://github.com/aquasecurity/trivy)                          | Vulnerability scanning (runs as ephemeral Docker container) |
| [Copa](https://github.com/project-copacetic/copacetic)                  | OS-level package patching (binary bundled in image)         |
| [node-cron](https://github.com/node-cron/node-cron)                     | Scheduled patch cycles                                      |
| [p-limit](https://github.com/sindresorhus/p-limit)                      | Concurrency control for parallel image processing           |
| [swagger-ui-express](https://github.com/scottie1984/swagger-ui-express) | Interactive API documentation                               |
