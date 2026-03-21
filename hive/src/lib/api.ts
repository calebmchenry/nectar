export interface ApiErrorPayload {
  error?: string;
  code?: string;
  details?: unknown;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly details?: unknown;

  constructor(status: number, message: string, code?: string, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export interface GardenSummary {
  name: string;
  size: number;
  modified_at: string;
  node_count: number;
}

export interface GardenFile {
  name: string;
  path: string;
  dot_source: string;
  metadata: Record<string, unknown>;
}

export interface Diagnostic {
  severity: 'error' | 'warning';
  code: string;
  message: string;
  file?: string;
  location?: { line: number; col: number };
}

export interface GardenPreviewResult {
  parse_ok: boolean;
  valid: boolean;
  diagnostics: Diagnostic[];
  metadata: {
    node_count: number;
    edge_count: number;
  };
  svg?: string;
}

export interface PipelineCreateResponse {
  run_id: string;
  status: 'running';
}

export interface PipelineStatusResponse {
  run_id: string;
  status: 'running' | 'completed' | 'failed' | 'interrupted';
  dot_file: string;
  started_at: string;
  updated_at: string;
  duration_ms: number;
  current_node?: string;
  completed_nodes: string[];
  completed_count: number;
  interruption_reason?: string;
}

export interface QuestionChoice {
  label: string;
  accelerator?: string;
  edge_target?: string;
}

export interface PendingQuestion {
  question_id: string;
  run_id: string;
  node_id: string;
  stage: string;
  text: string;
  choices: QuestionChoice[];
  status: 'pending' | 'answered' | 'timed_out';
  default_choice?: string;
  timeout_ms?: number;
  answer?: { selected_label: string; source: string };
}

export interface QuestionsResponse {
  run_id: string;
  questions: PendingQuestion[];
}

export interface EventEnvelope {
  seq: number;
  timestamp: string;
  event: {
    type: string;
    [key: string]: unknown;
  };
}

export type SeedStatus = 'seedling' | 'sprouting' | 'blooming' | 'honey' | 'wilted';
export type SeedPriority = 'low' | 'normal' | 'high' | 'queens_order';
export type AnalysisStatus = 'pending' | 'running' | 'complete' | 'failed' | 'skipped';
export type AnalysisDocumentStatus = AnalysisStatus | 'parse_error';
export type SwarmProvider = 'claude' | 'codex' | 'gemini';

export interface SeedSummary {
  id: number;
  slug: string;
  title: string;
  status: SeedStatus;
  priority: SeedPriority;
  tags: string[];
  created_at: string;
  updated_at: string;
  linked_gardens: string[];
  linked_runs: string[];
  analysis_status: Record<string, AnalysisStatus>;
  location: 'seedbed' | 'honey';
}

export interface SeedMeta {
  id: number;
  slug: string;
  title: string;
  status: SeedStatus;
  priority: SeedPriority;
  tags: string[];
  created_at: string;
  updated_at: string;
  linked_gardens: string[];
  linked_runs: string[];
  analysis_status: Record<string, AnalysisStatus>;
}

export interface SeedLinkedGardenSummary {
  garden: string;
  status: 'ok' | 'unknown';
}

export type LinkedRunStatus = 'running' | 'completed' | 'failed' | 'interrupted' | 'unknown';

export interface SeedLinkedRunSummary {
  run_id: string;
  status: LinkedRunStatus;
  dot_file?: string;
  started_at?: string;
  updated_at?: string;
  seed_garden?: string;
  launch_origin?: 'seedbed' | 'seed_cli' | 'pipeline_api' | 'garden_hive';
}

export interface SeedStatusSuggestion {
  suggested_status: 'honey';
  reason: string;
  based_on_run_id: string;
}

export interface SeedActivityEvent {
  type: string;
  timestamp: string;
  seed_id: number;
  actor: 'user' | 'system' | 'agent';
  [key: string]: unknown;
}

export interface SeedAttachment {
  filename: string;
  size: number;
  content_type: string;
  url: string;
  is_image: boolean;
}

export interface SeedAnalysis {
  provider: string;
  generated_at: string;
  status: AnalysisDocumentStatus;
  recommended_priority?: SeedPriority;
  estimated_complexity?: 'low' | 'medium' | 'high';
  feasibility?: 'low' | 'medium' | 'high';
  error?: string;
  summary: string;
  implementation_approach: string;
  risks: string;
  open_questions: string;
  body_md: string;
}

export interface SeedDetail {
  meta: SeedMeta;
  seed_md: string;
  attachments: SeedAttachment[];
  analyses: SeedAnalysis[];
  linked_garden_summaries: SeedLinkedGardenSummary[];
  linked_run_summaries: SeedLinkedRunSummary[];
  status_suggestion: SeedStatusSuggestion | null;
  activity: SeedActivityEvent[];
}

export interface SeedSynthesis {
  consensus: Partial<Record<'recommended_priority' | 'estimated_complexity' | 'feasibility', string>>;
  majorities: Array<{
    field: 'recommended_priority' | 'estimated_complexity' | 'feasibility';
    value: string;
    outliers: Record<string, string>;
  }>;
  divergences: Array<{
    field: 'recommended_priority' | 'estimated_complexity' | 'feasibility';
    values: Record<string, string>;
  }>;
  available_providers: string[];
}

export interface AnalyzeSeedResponse {
  seed_id: number;
  job_status: 'started';
  accepted_providers: SwarmProvider[];
  already_running: boolean;
}

export interface SeedRunResponse {
  run_id: string;
  status: 'running';
  seed_id: number;
  garden_path: string;
  resumed: boolean;
}

async function throwApiError(response: Response): Promise<never> {
  let payload: ApiErrorPayload | undefined;
  try {
    payload = (await response.json()) as ApiErrorPayload;
  } catch {
    payload = undefined;
  }

  throw new ApiError(
    response.status,
    payload?.error ?? `Request failed (${response.status})`,
    payload?.code,
    payload?.details
  );
}

async function requestJson<T>(input: string, init?: RequestInit): Promise<T> {
  const response = await fetch(input, init);
  if (!response.ok) {
    await throwApiError(response);
  }
  return (await response.json()) as T;
}

export const api = {
  async listGardens(): Promise<GardenSummary[]> {
    const payload = await requestJson<{ gardens: GardenSummary[] }>('/gardens');
    return payload.gardens;
  },

  getGarden(name: string): Promise<GardenFile> {
    return requestJson<GardenFile>(`/gardens/${encodeURIComponent(name)}`);
  },

  saveGarden(name: string, dot_source: string): Promise<{ diagnostics: Diagnostic[] }> {
    return requestJson<{ diagnostics: Diagnostic[] }>(`/gardens/${encodeURIComponent(name)}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ dot_source }),
    });
  },

  previewGarden(dot_source: string, dot_path?: string, signal?: AbortSignal): Promise<GardenPreviewResult> {
    return requestJson<GardenPreviewResult>('/gardens/preview', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ dot_source, dot_path }),
      signal,
    });
  },

  startPipeline(input: { dot_path?: string; dot_source?: string }): Promise<PipelineCreateResponse> {
    return requestJson<PipelineCreateResponse>('/pipelines', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    });
  },

  getPipelineStatus(runId: string): Promise<PipelineStatusResponse> {
    return requestJson<PipelineStatusResponse>(`/pipelines/${encodeURIComponent(runId)}`);
  },

  getPipelineContext(runId: string): Promise<{ context: Record<string, string> }> {
    return requestJson<{ context: Record<string, string> }>(`/pipelines/${encodeURIComponent(runId)}/context`);
  },

  async getPipelineGraph(runId: string): Promise<string> {
    const response = await fetch(`/pipelines/${encodeURIComponent(runId)}/graph`);
    if (!response.ok) {
      throw new ApiError(response.status, `Failed to fetch graph SVG (${response.status})`);
    }
    return response.text();
  },

  cancelPipeline(runId: string): Promise<PipelineStatusResponse> {
    return requestJson<PipelineStatusResponse>(`/pipelines/${encodeURIComponent(runId)}/cancel`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
  },

  resumePipeline(runId: string): Promise<PipelineCreateResponse> {
    return requestJson<PipelineCreateResponse>(`/pipelines/${encodeURIComponent(runId)}/resume`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
  },

  getQuestions(runId: string): Promise<QuestionsResponse> {
    return requestJson<QuestionsResponse>(`/pipelines/${encodeURIComponent(runId)}/questions`);
  },

  answerQuestion(runId: string, questionId: string, selected_label: string): Promise<unknown> {
    return requestJson(`/pipelines/${encodeURIComponent(runId)}/questions/${encodeURIComponent(questionId)}/answer`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ selected_label }),
    });
  },

  async listSeeds(): Promise<SeedSummary[]> {
    const payload = await requestJson<{ seeds: SeedSummary[] }>('/seeds');
    return payload.seeds;
  },

  getSeed(seedId: number): Promise<SeedDetail> {
    return requestJson<SeedDetail>(`/seeds/${seedId}`);
  },

  createSeed(input: {
    title?: string;
    body: string;
    priority?: SeedPriority;
    tags?: string[];
  }): Promise<{ seed: SeedMeta }> {
    return requestJson<{ seed: SeedMeta }>('/seeds', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    });
  },

  patchSeed(
    seedId: number,
    input: {
      title?: string;
      body?: string;
      status?: SeedStatus;
      priority?: SeedPriority;
      tags?: string[];
      linked_gardens_add?: string[];
      linked_gardens_remove?: string[];
    }
  ): Promise<{ seed: SeedMeta }> {
    return requestJson<{ seed: SeedMeta }>(`/seeds/${seedId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    });
  },

  async uploadSeedAttachment(seedId: number, file: File): Promise<SeedAttachment> {
    const formData = new FormData();
    formData.set('file', file, file.name);

    const response = await fetch(`/seeds/${seedId}/attachments`, {
      method: 'POST',
      body: formData,
    });
    if (!response.ok) {
      await throwApiError(response);
    }

    const payload = (await response.json()) as Omit<SeedAttachment, 'is_image'>;
    return {
      ...payload,
      is_image: payload.content_type.startsWith('image/'),
    };
  },

  analyzeSeed(
    seedId: number,
    input: {
      providers?: SwarmProvider[];
      force?: boolean;
      include_attachments?: boolean;
    } = {}
  ): Promise<AnalyzeSeedResponse> {
    return requestJson<AnalyzeSeedResponse>(`/seeds/${seedId}/analyze`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    });
  },

  getSeedSynthesis(seedId: number): Promise<SeedSynthesis> {
    return requestJson<SeedSynthesis>(`/seeds/${seedId}/synthesis`);
  },

  startSeedRun(
    seedId: number,
    input: {
      garden_path?: string;
      run_id?: string;
      auto_approve?: boolean;
      force?: boolean;
      launch_origin?: 'seedbed' | 'seed_cli' | 'pipeline_api' | 'garden_hive';
    } = {}
  ): Promise<SeedRunResponse> {
    return requestJson<SeedRunResponse>(`/seeds/${seedId}/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    });
  },

  getSeedActivity(input: { limit?: number; cursor?: string } = {}): Promise<{ events: SeedActivityEvent[]; next_cursor: string | null }> {
    const params = new URLSearchParams();
    if (input.limit !== undefined) {
      params.set('limit', String(input.limit));
    }
    if (input.cursor) {
      params.set('cursor', input.cursor);
    }
    const query = params.toString();
    return requestJson<{ events: SeedActivityEvent[]; next_cursor: string | null }>(
      query.length > 0 ? `/seeds/activity?${query}` : '/seeds/activity'
    );
  },
};
