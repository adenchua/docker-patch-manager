import type { OpenAPIV3 } from 'openapi-types';

export const openApiSpec: OpenAPIV3.Document = {
  openapi: '3.0.3',
  info: {
    title: 'Docker Patch Manager',
    version: '1.0.0',
    description:
      'Manages Docker images: downloads them from public registries, scans for vulnerabilities with Trivy, patches OS-level vulnerabilities with Copa, and saves patched images as tar files for offline deployment.',
  },
  servers: [{ url: 'http://localhost:5432', description: 'Local' }],
  tags: [
    { name: 'Images', description: 'Manage the image manifest' },
    { name: 'Scan', description: 'Trigger and monitor patch cycles' },
    { name: 'Health', description: 'Service health' },
  ],
  paths: {
    '/health': {
      get: {
        tags: ['Health'],
        summary: 'Health check',
        responses: {
          '200': {
            description: 'Service is running',
            content: { 'text/plain': { schema: { type: 'string', example: 'OK' } } },
          },
        },
      },
    },
    '/images': {
      get: {
        tags: ['Images'],
        summary: 'List all managed images',
        responses: {
          '200': {
            description: 'Array of all images in the manifest',
            content: {
              'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/ManifestImage' } } },
            },
          },
        },
      },
      post: {
        tags: ['Images'],
        summary: 'Add an image to the manifest',
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/AddImageRequest' } } },
        },
        responses: {
          '201': {
            description: 'Image added successfully',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ManifestImage' } } },
          },
          '400': {
            description: 'Missing required fields',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } },
          },
          '409': {
            description: 'Image already exists',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } },
          },
        },
      },
    },
    '/images/{name}': {
      delete: {
        tags: ['Images'],
        summary: 'Remove an image from the manifest',
        description:
          'Removes the image entry from the manifest and deletes its tar file from the data volume if present.',
        parameters: [
          {
            name: 'name',
            in: 'path',
            required: true,
            description: 'Image name (e.g. "nginx" or "library/nginx")',
            schema: { type: 'string' },
          },
        ],
        responses: {
          '204': { description: 'Image removed successfully' },
          '404': {
            description: 'Image not found',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } },
          },
        },
      },
    },
    '/scan': {
      post: {
        tags: ['Scan'],
        summary: 'Trigger an immediate patch cycle',
        description:
          'Starts a full scan-and-patch cycle across all images in the manifest. No-op if a cycle is already running.',
        responses: {
          '202': {
            description: 'Patch cycle started',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/MessageResponse' } } },
          },
          '409': {
            description: 'A patch cycle is already running',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/MessageResponse' } } },
          },
        },
      },
    },
    '/scan/status': {
      get: {
        tags: ['Scan'],
        summary: 'Get current job status',
        responses: {
          '200': {
            description: 'Current state of the patch job',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/JobStatus' } } },
          },
        },
      },
    },
  },
  components: {
    schemas: {
      ImageStatus: {
        type: 'string',
        enum: ['pending', 'downloading', 'scanning', 'patching', 'ready', 'ready-unpatched', 'failed'],
        description:
          '`pending` – added, not yet processed. `ready` – fully patched. `ready-unpatched` – scanned but only language-level vulns remain (Copa cannot patch). `failed` – pipeline error.',
      },
      VulnerabilityCounts: {
        type: 'object',
        properties: {
          critical: { type: 'integer', example: 0 },
          high: { type: 'integer', example: 2 },
          medium: { type: 'integer', example: 5 },
          low: { type: 'integer', example: 12 },
        },
        required: ['critical', 'high', 'medium', 'low'],
      },
      ManifestImage: {
        type: 'object',
        properties: {
          name: { type: 'string', example: 'nginx' },
          tag: { type: 'string', example: '1.27' },
          registry: { type: 'string', example: 'docker.io' },
          architecture: { type: 'string', example: 'linux/amd64' },
          status: { $ref: '#/components/schemas/ImageStatus' },
          tarPath: { type: 'string', nullable: true, example: 'images/nginx_1.27.tgz' },
          lastScanned: { type: 'string', format: 'date-time', nullable: true },
          lastPatched: { type: 'string', format: 'date-time', nullable: true },
          vulnerabilities: { allOf: [{ $ref: '#/components/schemas/VulnerabilityCounts' }], nullable: true },
        },
        required: [
          'name',
          'tag',
          'registry',
          'architecture',
          'status',
          'tarPath',
          'lastScanned',
          'lastPatched',
          'vulnerabilities',
        ],
      },
      AddImageRequest: {
        type: 'object',
        required: ['name', 'tag', 'registry', 'architecture'],
        properties: {
          name: { type: 'string', example: 'nginx' },
          tag: { type: 'string', example: '1.27' },
          registry: { type: 'string', example: 'docker.io' },
          architecture: { type: 'string', example: 'linux/amd64' },
        },
      },
      LastRunSummary: {
        type: 'object',
        properties: {
          startedAt: { type: 'string', format: 'date-time' },
          completedAt: { type: 'string', format: 'date-time' },
          total: { type: 'integer', example: 12 },
          patched: { type: 'integer', example: 10 },
          unpatchable: { type: 'integer', example: 1 },
          failed: { type: 'integer', example: 1 },
        },
        required: ['startedAt', 'completedAt', 'total', 'patched', 'unpatchable', 'failed'],
      },
      JobStatus: {
        type: 'object',
        properties: {
          state: { type: 'string', enum: ['idle', 'running'] },
          progress: {
            type: 'string',
            nullable: true,
            example: '3/12',
            description: 'Completed/total images in the current run',
          },
          lastRun: { allOf: [{ $ref: '#/components/schemas/LastRunSummary' }], nullable: true },
        },
        required: ['state', 'progress', 'lastRun'],
      },
      ErrorResponse: {
        type: 'object',
        properties: { error: { type: 'string' } },
        required: ['error'],
      },
      MessageResponse: {
        type: 'object',
        properties: { message: { type: 'string' } },
        required: ['message'],
      },
    },
  },
};
