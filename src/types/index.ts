export type ImageStatus = 'pending' | 'downloading' | 'scanning' | 'patching' | 'ready' | 'ready-unpatched' | 'failed';

export interface VulnerabilityCounts {
  critical: number;
  high: number;
  medium: number;
  low: number;
}

export interface ManifestImage {
  name: string;
  tag: string;
  registry: string;
  architecture: string;
  status: ImageStatus;
  tarPath: string | null;
  lastScanned: string | null;
  lastPatched: string | null;
  vulnerabilities: VulnerabilityCounts | null;
}

export interface ManifestFile {
  images: ManifestImage[];
}

export interface JobStatus {
  state: 'idle' | 'running';
  progress: string | null;
  lastRun: LastRunSummary | null;
}

export interface LastRunSummary {
  startedAt: string;
  completedAt: string;
  total: number;
  patched: number;
  unpatchable: number;
  failed: number;
}
