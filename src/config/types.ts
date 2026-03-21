export type SwarmProviderName = 'claude' | 'codex' | 'gemini';

export interface DraftConfig {
  provider: string;
  model: string;
}

export interface SwarmProviderConfig {
  enabled: boolean;
  llm_provider: string;
  model: string;
}

export type SwarmProvidersConfig = Record<SwarmProviderName, SwarmProviderConfig>;

export interface SwarmConfig {
  providers: SwarmProvidersConfig;
}

export interface RuntimeConfig {
  fallback_llm_provider: string;
  fallback_model: string;
}

export interface ResolvedWorkspaceConfig {
  draft: DraftConfig;
  swarm: SwarmConfig;
  runtime: RuntimeConfig;
}

export type WorkspaceConfigSource = 'defaults' | 'file';

export type WorkspaceConfigDiagnosticSeverity = 'warning' | 'error';

export interface WorkspaceConfigDiagnostic {
  code:
    | 'INVALID_YAML'
    | 'INVALID_TYPE'
    | 'UNKNOWN_FIELD'
    | 'UNKNOWN_PROVIDER'
    | 'UNKNOWN_MODEL'
    | 'UNKNOWN_SWARM_PROVIDER'
    | 'SECRET_FIELD';
  severity: WorkspaceConfigDiagnosticSeverity;
  message: string;
  path?: string;
}

export interface WorkspaceConfigLoadResult {
  path: string;
  exists: boolean;
  source: WorkspaceConfigSource;
  resolved: ResolvedWorkspaceConfig;
  diagnostics: WorkspaceConfigDiagnostic[];
}
