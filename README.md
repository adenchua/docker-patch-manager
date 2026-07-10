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
OS package types found?  ──No──▶ skip Copa → ready-unpatched (patchReason: app-layer-only)
      │ Yes
      ▼
OS-level CVEs present?   ──No──▶ skip Copa → ready-unpatched (patchReason: no-os-vulns)
      │ Yes
      ▼
Copa patch → updated image layers (OS packages only)
      │
      ├── updates applied ──▶ ready
      └── no updates found ──▶ ready-unpatched (patchReason: copa-no-updates)
      │
      ▼
docker save | gzip → /output/<arch>/<name>_<tag>.tgz
      │
      ▼
Transfer tar to offline environment → docker load
```

Copa only runs when Trivy's report contains OS-level package types (`dpkg`, `rpm`, or `apk`) **and** at least one CVE in those packages. This avoids unnecessary BuildKit round-trips and gives operators a clear `patchReason` field explaining exactly why an image was not patched.

## Distroless Images

Copa can still patch many distroless images — it spins up an external build-tooling container rather than relying on a package manager inside the target image. The key factor is whether the image retains OS package metadata:

| Image type                                                           | Trivy sees                                       | Copa behaviour                    | `patchReason`               |
| -------------------------------------------------------------------- | ------------------------------------------------ | --------------------------------- | --------------------------- |
| Regular Debian / Alpine / RHEL                                       | `dpkg` / `apk` / `rpm` results with CVEs         | Patches OS packages               | `null` (fully patched)      |
| Distroless **Debian-based** (e.g. `gcr.io/distroless/base-debian12`) | `dpkg` results, may have CVEs                    | Copa patches via external tooling | `null` or `copa-no-updates` |
| Distroless **RPM-based**                                             | `rpm` results, may have CVEs                     | Copa patches via external tooling | `null` or `copa-no-updates` |
| True distroless / scratch (no OS package DB)                         | Only app-layer results (`gomodule`, `npm`, etc.) | Copa skipped entirely             | `app-layer-only`            |
| Any image with clean OS packages                                     | OS package types present, zero OS CVEs           | Copa skipped as optimisation      | `no-os-vulns`               |

Images with `ready-unpatched` status are saved to the output directory unchanged — vulnerability counts are preserved for the operator's awareness.

## Requirements

- Docker (host Docker daemon, socket mounted into the container)
- Internet access to Docker Hub (or your target registry)

## Quick Start

```bash
export DOCKER_GID=$(stat -c '%g' /var/run/docker.sock)  # non-root container user needs the socket's group
docker compose up --build
```

### Docker Desktop (macOS / Windows)

The `docker-compose.yml` includes a dedicated `buildkitd` sidecar that Copa uses for patching (`COPA_BUILDKIT_ADDR=tcp://buildkitd:1234`). This is needed on macOS Docker Desktop, where the built-in BuildKit stalls when Copa tries to apply OS-level patches inside container layers. Windows Docker Desktop may work without it (WSL2 uses a real Linux kernel with no Rosetta translation), but the sidecar is kept as a safe default.

On a native Linux host the sidecar is unnecessary — remove the `buildkitd` service and the `COPA_BUILDKIT_ADDR` environment variable and Copa will use the Docker daemon's built-in BuildKit directly.

**Windows hosts** are supported only via `docker compose` on Docker Desktop with the WSL2 backend. Running natively with `npm run dev` on Windows is unsupported — the service assumes a Unix Docker socket (`/var/run/docker.sock`) and Linux `docker`/`copa` CLI behaviour.

**Windows container images** cannot be patched: Copa only patches Linux OS packages (`dpkg`/`rpm`/`apk`), which is why the API's architecture allowlist accepts `linux/*` platforms only. Linux images can of course be managed _from_ a Windows host via Docker Desktop.

The API is available at `http://localhost:5432`. Interactive API docs at `http://localhost:5432/docs`.

Patched image tars are written to `./output/` on the host, organized by architecture. The database is stored in `./database/`.

## Security & Deployment

- **No built-in authentication.** The compose file therefore binds the API to `127.0.0.1` only — it is unreachable from other machines by default. If you need remote access, do **not** widen the port binding; place the service behind a reverse proxy (nginx, Traefik, Caddy) that terminates TLS and enforces authentication.
- **The container is root-equivalent on the host.** It mounts the host Docker socket (`/var/run/docker.sock`), which grants full control of the Docker daemon. The ephemeral Trivy scan containers also receive the socket. Never expose this service to the public internet.
- **The app runs as the non-root `node` user.** Socket access is granted via `group_add` in `docker-compose.yml` — set `DOCKER_GID` to the GID of your host's Docker socket (`stat -c '%g' /var/run/docker.sock`). The bind-mounted `./database/` and `./output/` directories must be writable by uid 1000.
- The `patch-manager` container itself runs unprivileged — only the `buildkitd` sidecar needs `privileged: true`. The sidecar's BuildKit daemon has no TLS or auth, so it must stay on the internal compose network; never publish its port.
- Set `ALLOWED_REGISTRIES` to restrict which registries `POST /images` accepts. Left unset, any hostname is allowed, meaning API callers can make the server contact arbitrary (including internal) hosts and pull images from them.
- The Copa binary download is verified against a pinned SHA-256 (`COPA_SHA256`, from the release's `copacetic_checksums.txt`) at image build time.
- The Trivy scanner image and BuildKit sidecar are version-pinned (`TRIVY_IMAGE`, `BUILDKIT_VERSION`) for supply-chain reproducibility. Pinning freezes the scanner _binary_ only — the CVE database is still downloaded fresh at scan time (and cached in the `trivy-db-cache` volume). Bump the pins periodically. For stricter guarantees, pin `node`, `moby/buildkit`, and `aquasec/trivy` by digest (`image@sha256:…`) instead of by tag.
- The Swagger UI at `/docs` can be disabled with `ENABLE_DOCS=false`.

## Configuration

| Variable             | Default                 | Description                                                                                                                                                                                             |
| -------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PORT`               | `5432`                  | HTTP server port                                                                                                                                                                                        |
| `PATCH_SCHEDULE`     | `0 2 * * *`             | Cron expression for automatic patch cycles (daily at 2am)                                                                                                                                               |
| `PATCH_CONCURRENCY`  | `3`                     | Max images processed simultaneously                                                                                                                                                                     |
| `COPA_TIMEOUT`       | `10m`                   | Timeout for each Copa patch operation                                                                                                                                                                   |
| `COPA_BUILDKIT_ADDR` | _(unset)_               | BuildKit address for Copa (`<scheme>://<address>`; schemes: `tcp`, `unix`, `docker-container`, `kube-pod`, `podman-container`, `nerdctl-container`, `ssh`, `buildx`). Unset → Copa's default resolution |
| `TRIVY_IMAGE`        | `aquasec/trivy:0.71.0`  | Pinned Trivy scanner image (binary only — the CVE DB still updates at scan time)                                                                                                                        |
| `TRIVY_CACHE_VOLUME` | `trivy-db-cache`        | Docker named volume caching the Trivy vulnerability DB between scans                                                                                                                                    |
| `BUILDKIT_VERSION`   | `v0.30.0`               | BuildKit sidecar image tag (docker-compose only)                                                                                                                                                        |
| `CORS_ORIGIN`        | `http://localhost:5432` | Allowed CORS origin for API requests                                                                                                                                                                    |
| `COPA_SHA256`        | _(0.14.1 amd64 hash)_   | Expected SHA-256 of the Copa release tarball, verified at image build; update together with `COPA_VERSION`                                                                                              |
| `DOCKER_GID`         | `999`                   | GID of the host Docker socket group, granted to the non-root container user (`stat -c '%g' /var/run/docker.sock`)                                                                                       |
| `ALLOWED_REGISTRIES` | _(unset)_               | Comma-separated registries `POST /images` accepts (e.g. `docker.io,ghcr.io`); unset = any registry, with a startup warning                                                                              |
| `ENABLE_DOCS`        | `true`                  | Set to `false` to disable the Swagger UI at `/docs`                                                                                                                                                     |

Copy `.env.example` to `.env` and adjust values before running outside Docker Compose.

## API Reference

| Method   | Path               | Description                                                          |
| -------- | ------------------ | -------------------------------------------------------------------- |
| `GET`    | `/images`          | List all images in the manifest                                      |
| `POST`   | `/images`          | Add an image to the manifest                                         |
| `DELETE` | `/images/:id`      | Remove an image and delete its tar                                   |
| `POST`   | `/images/:id/scan` | Trigger an ad-hoc scan-and-patch cycle for a single image            |
| `POST`   | `/images/cleanup`  | Delete superseded minor/patch versions, keeping the latest per group |
| `POST`   | `/scan`            | Trigger an immediate scan-and-patch cycle                            |
| `GET`    | `/scan/status`     | Current job state, progress, and last run summary                    |
| `GET`    | `/health`          | Health check                                                         |
| `GET`    | `/docs`            | Swagger UI (full OpenAPI 3.0 spec)                                   |

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
