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
docker save | gzip → /data/images/<name>_<tag>.tgz
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

The API is available at `http://localhost:3000`. Interactive API docs at `http://localhost:3000/docs`.

Patched image tars and the manifest are written to `./data/` on the host.

## Configuration

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | HTTP server port |
| `PATCH_SCHEDULE` | `0 2 * * *` | Cron expression for automatic patch cycles (daily at 2am) |
| `PATCH_CONCURRENCY` | `3` | Max images processed simultaneously |
| `DATA_DIR` | `/data` | Mount path for manifest and image tars |

Copy `.env.example` to `.env` and adjust values before running outside Docker Compose.

## API Reference

| Method | Path | Description |
|---|---|---|
| `GET` | `/images` | List all images in the manifest |
| `POST` | `/images` | Add an image to the manifest |
| `DELETE` | `/images/:name` | Remove an image and delete its tar |
| `POST` | `/scan` | Trigger an immediate scan-and-patch cycle |
| `GET` | `/scan/status` | Current job state, progress, and last run summary |
| `GET` | `/health` | Health check |
| `GET` | `/docs` | Swagger UI (full OpenAPI 3.0 spec) |

### Add an image

```bash
curl -X POST http://localhost:3000/images \
  -H 'Content-Type: application/json' \
  -d '{"name":"nginx","tag":"1.27","registry":"docker.io","architecture":"linux/amd64"}'
```

### Trigger a patch cycle

```bash
curl -X POST http://localhost:3000/scan
```

### Check progress

```bash
curl http://localhost:3000/scan/status
```

## Data Volume

```
./data/
├── manifest.json       # Image list with status, vuln counts, and tar paths
└── images/
    ├── nginx_1.27.tgz
    └── redis_7.2.tgz
```

Transfer the `images/` directory and `manifest.json` to your offline environment. Load images with:

```bash
docker load -i nginx_1.27.tgz
```

## Tools Used

| Tool | Role |
|---|---|
| [Trivy](https://github.com/aquasecurity/trivy) | Vulnerability scanning (runs as ephemeral Docker container) |
| [Copa](https://github.com/project-copacetic/copacetic) | OS-level package patching (binary bundled in image) |
| [node-cron](https://github.com/node-cron/node-cron) | Scheduled patch cycles |
| [p-limit](https://github.com/sindresorhus/p-limit) | Concurrency control for parallel image processing |
| [swagger-ui-express](https://github.com/scottie1984/swagger-ui-express) | Interactive API documentation |
