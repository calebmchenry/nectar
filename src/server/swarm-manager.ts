import { SWARM_PROVIDERS, SwarmAnalysisService } from '../runtime/swarm-analysis-service.js';
import type { SwarmProvider, AnalysisOutcomeStatus } from './workspace-event-bus.js';

export interface SwarmManagerOptions {
  workspace_root?: string;
  analysis_service: SwarmAnalysisService;
}

export interface StartAnalysisRequest {
  providers?: string[];
  force?: boolean;
  include_attachments?: boolean;
}

export interface StartAnalysisResult {
  seed_id: number;
  job_status: 'started';
  accepted_providers: SwarmProvider[];
  already_running: boolean;
}

interface ActiveAnalysisJob {
  seed_id: number;
  providers: SwarmProvider[];
  force: boolean;
  include_attachments: boolean;
  started_at: string;
  promise: Promise<Array<{ provider: SwarmProvider; status: AnalysisOutcomeStatus; message?: string }>>;
}

export class SwarmManager {
  private readonly analysisService: SwarmAnalysisService;
  private readonly activeJobs = new Map<number, ActiveAnalysisJob>();

  constructor(options: SwarmManagerOptions) {
    this.analysisService = options.analysis_service;
  }

  start(seedId: number, request: StartAnalysisRequest): StartAnalysisResult {
    const providers = normalizeProviders(request.providers);
    const force = request.force === true;
    const includeAttachments = request.include_attachments !== false;

    const active = this.activeJobs.get(seedId);
    if (active) {
      return {
        seed_id: seedId,
        job_status: 'started',
        accepted_providers: [...active.providers],
        already_running: true,
      };
    }

    const promise = this.analysisService.analyzeSeed({
      seed_id: seedId,
      providers,
      include_attachments: includeAttachments,
      force,
    });

    const job: ActiveAnalysisJob = {
      seed_id: seedId,
      providers,
      force,
      include_attachments: includeAttachments,
      started_at: new Date().toISOString(),
      promise,
    };

    this.activeJobs.set(seedId, job);
    promise.finally(() => {
      const current = this.activeJobs.get(seedId);
      if (current?.promise === promise) {
        this.activeJobs.delete(seedId);
      }
    });

    return {
      seed_id: seedId,
      job_status: 'started',
      accepted_providers: providers,
      already_running: false,
    };
  }

  isRunning(seedId: number): boolean {
    return this.activeJobs.has(seedId);
  }

  getJob(seedId: number): {
    seed_id: number;
    providers: SwarmProvider[];
    force: boolean;
    include_attachments: boolean;
    started_at: string;
  } | null {
    const job = this.activeJobs.get(seedId);
    if (!job) {
      return null;
    }
    return {
      seed_id: job.seed_id,
      providers: [...job.providers],
      force: job.force,
      include_attachments: job.include_attachments,
      started_at: job.started_at,
    };
  }

  async recoverStaleRunningAnalyses(): Promise<number> {
    return this.analysisService.recoverStaleRunningStatuses();
  }

  async recoverStaleRunningStatuses(): Promise<number> {
    return this.recoverStaleRunningAnalyses();
  }

  async shutdown(): Promise<void> {
    const active = Array.from(this.activeJobs.values());
    await Promise.allSettled(active.map((job) => job.promise));
  }
}

function normalizeProviders(requested?: string[]): SwarmProvider[] {
  if (!requested || requested.length === 0) {
    return [...SWARM_PROVIDERS];
  }

  const normalized = dedupe(
    requested
      .map((provider) => provider.trim().toLowerCase())
      .filter((provider) => provider.length > 0)
  );
  const invalid = normalized.filter((provider) => !SWARM_PROVIDERS.includes(provider as SwarmProvider));
  if (invalid.length > 0) {
    throw new Error(`Unsupported providers requested: ${invalid.join(', ')}`);
  }
  return normalized as SwarmProvider[];
}

function dedupe(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (seen.has(value)) {
      continue;
    }
    seen.add(value);
    out.push(value);
  }
  return out;
}
