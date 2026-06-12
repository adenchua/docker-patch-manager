export type ImageStatus = 'pending' | 'downloading' | 'scanning' | 'patching' | 'ready' | 'ready-unpatched' | 'failed';

export type PatchReason =
  | 'app-layer-only' // No dpkg/rpm/apk result types in Trivy report — Copa cannot help (distroless/scratch)
  | 'no-os-vulns' // OS packages present but zero OS-level CVEs — Copa skipped as optimisation
  | 'copa-no-updates'; // Copa ran, confirmed no OS updates available upstream

export interface VulnerabilityCounts {
  critical: number;
  high: number;
  medium: number;
  low: number;
}

export interface Image {
  id?: number;
  name: string;
  tag: string;
  registry: string;
  architecture: string;
  status: ImageStatus;
  lastScanned: string | null;
  lastPatched: string | null;
  vulnerabilities: VulnerabilityCounts | null;
  patchReason: PatchReason | null;
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
