import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseDocument } from 'yaml';
import { getModelInfo } from '../llm/catalog.js';
import type {
  ResolvedWorkspaceConfig,
  SwarmProviderName,
  WorkspaceConfigDiagnostic,
  WorkspaceConfigLoadResult,
} from './types.js';

const CONFIG_RELATIVE_PATH = path.join('.nectar', 'config.yaml');
const KNOWN_LLM_PROVIDERS = new Set(['anthropic', 'openai', 'openai_compatible', 'gemini', 'simulation']);
const SWARM_PROVIDER_NAMES: readonly SwarmProviderName[] = ['claude', 'codex', 'gemini'];
const SECRET_FIELD_PATTERN = /(api[_-]?key|token|secret|password|credential)/i;

export const DEFAULT_WORKSPACE_CONFIG: ResolvedWorkspaceConfig = {
  draft: {
    provider: 'simulation',
    model: 'simulation',
  },
  swarm: {
    providers: {
      claude: {
        enabled: true,
        llm_provider: 'anthropic',
        model: 'default',
      },
      codex: {
        enabled: true,
        llm_provider: 'openai',
        model: 'default',
      },
      gemini: {
        enabled: true,
        llm_provider: 'gemini',
        model: 'default',
      },
    },
  },
  runtime: {
    fallback_llm_provider: 'simulation',
    fallback_model: 'default',
  },
};

export class WorkspaceConfigLoader {
  private readonly workspaceRoot: string;

  constructor(workspaceRoot: string) {
    this.workspaceRoot = workspaceRoot;
  }

  configPath(): string {
    return path.join(this.workspaceRoot, CONFIG_RELATIVE_PATH);
  }

  async load(): Promise<WorkspaceConfigLoadResult> {
    const targetPath = this.configPath();
    let sourceText: string;
    try {
      sourceText = await readFile(targetPath, 'utf8');
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code === 'ENOENT') {
        return {
          path: targetPath,
          exists: false,
          source: 'defaults',
          resolved: cloneDefaults(),
          diagnostics: [],
        };
      }
      throw error;
    }

    const diagnostics: WorkspaceConfigDiagnostic[] = [];
    const resolved = cloneDefaults();

    const document = parseDocument(sourceText);
    if (document.errors.length > 0) {
      const firstError = document.errors[0];
      diagnostics.push({
        code: 'INVALID_YAML',
        severity: 'error',
        message: firstError?.message ?? 'Invalid YAML in .nectar/config.yaml.',
      });
      return {
        path: targetPath,
        exists: true,
        source: 'file',
        resolved,
        diagnostics,
      };
    }

    const parsed = document.toJS({ maxAliasCount: 50 }) as unknown;
    if (!isRecord(parsed)) {
      diagnostics.push({
        code: 'INVALID_TYPE',
        severity: 'error',
        message: 'Workspace config must be a YAML mapping at the top level.',
        path: 'config',
      });
      return {
        path: targetPath,
        exists: true,
        source: 'file',
        resolved,
        diagnostics,
      };
    }

    collectSecrets(parsed, '', diagnostics);
    collectUnknownFields(parsed, ['draft', 'swarm', 'runtime'], '', diagnostics);

    this.applyDraftSection(parsed['draft'], resolved, diagnostics);
    this.applySwarmSection(parsed['swarm'], resolved, diagnostics);
    this.applyRuntimeSection(parsed['runtime'], resolved, diagnostics);

    return {
      path: targetPath,
      exists: true,
      source: 'file',
      resolved,
      diagnostics,
    };
  }

  private applyDraftSection(
    value: unknown,
    resolved: ResolvedWorkspaceConfig,
    diagnostics: WorkspaceConfigDiagnostic[],
  ): void {
    if (value === undefined) {
      return;
    }
    if (!isRecord(value)) {
      diagnostics.push({
        code: 'INVALID_TYPE',
        severity: 'warning',
        message: 'draft must be a mapping when provided.',
        path: 'draft',
      });
      return;
    }

    collectUnknownFields(value, ['provider', 'model'], 'draft', diagnostics);

    const provider = coerceProvider(value['provider'], 'draft.provider', diagnostics, resolved.draft.provider);
    resolved.draft.provider = provider;

    const model = coerceString(value['model'], 'draft.model', diagnostics);
    if (model !== undefined) {
      resolved.draft.model = normalizeModel(provider, model, 'draft.model', diagnostics, resolved.draft.model);
      return;
    }

    resolved.draft.model = provider === 'simulation' ? 'simulation' : 'default';
  }

  private applySwarmSection(
    value: unknown,
    resolved: ResolvedWorkspaceConfig,
    diagnostics: WorkspaceConfigDiagnostic[],
  ): void {
    if (value === undefined) {
      return;
    }
    if (!isRecord(value)) {
      diagnostics.push({
        code: 'INVALID_TYPE',
        severity: 'warning',
        message: 'swarm must be a mapping when provided.',
        path: 'swarm',
      });
      return;
    }

    collectUnknownFields(value, ['providers'], 'swarm', diagnostics);
    const providers = value['providers'];
    if (providers === undefined) {
      return;
    }
    if (!isRecord(providers)) {
      diagnostics.push({
        code: 'INVALID_TYPE',
        severity: 'warning',
        message: 'swarm.providers must be a mapping when provided.',
        path: 'swarm.providers',
      });
      return;
    }

    for (const key of Object.keys(providers)) {
      if (!SWARM_PROVIDER_NAMES.includes(key as SwarmProviderName)) {
        diagnostics.push({
          code: 'UNKNOWN_SWARM_PROVIDER',
          severity: 'warning',
          message: `Unknown swarm provider '${key}' in config.`,
          path: `swarm.providers.${key}`,
        });
      }
    }

    for (const providerName of SWARM_PROVIDER_NAMES) {
      const providerValue = providers[providerName];
      if (providerValue === undefined) {
        continue;
      }
      if (!isRecord(providerValue)) {
        diagnostics.push({
          code: 'INVALID_TYPE',
          severity: 'warning',
          message: `swarm.providers.${providerName} must be a mapping.`,
          path: `swarm.providers.${providerName}`,
        });
        continue;
      }

      collectUnknownFields(providerValue, ['enabled', 'llm_provider', 'model'], `swarm.providers.${providerName}`, diagnostics);

      const existing = resolved.swarm.providers[providerName];
      const enabled = coerceBoolean(providerValue['enabled'], `swarm.providers.${providerName}.enabled`, diagnostics);
      if (enabled !== undefined) {
        existing.enabled = enabled;
      }

      const llmProvider = coerceProvider(
        providerValue['llm_provider'],
        `swarm.providers.${providerName}.llm_provider`,
        diagnostics,
        existing.llm_provider,
      );
      existing.llm_provider = llmProvider;

      const model = coerceString(providerValue['model'], `swarm.providers.${providerName}.model`, diagnostics);
      if (model !== undefined) {
        existing.model = normalizeModel(
          llmProvider,
          model,
          `swarm.providers.${providerName}.model`,
          diagnostics,
          existing.model,
        );
      }
    }
  }

  private applyRuntimeSection(
    value: unknown,
    resolved: ResolvedWorkspaceConfig,
    diagnostics: WorkspaceConfigDiagnostic[],
  ): void {
    if (value === undefined) {
      return;
    }
    if (!isRecord(value)) {
      diagnostics.push({
        code: 'INVALID_TYPE',
        severity: 'warning',
        message: 'runtime must be a mapping when provided.',
        path: 'runtime',
      });
      return;
    }

    collectUnknownFields(value, ['fallback_llm_provider', 'fallback_model'], 'runtime', diagnostics);

    const provider = coerceProvider(
      value['fallback_llm_provider'],
      'runtime.fallback_llm_provider',
      diagnostics,
      resolved.runtime.fallback_llm_provider,
    );
    resolved.runtime.fallback_llm_provider = provider;

    const model = coerceString(value['fallback_model'], 'runtime.fallback_model', diagnostics);
    if (model !== undefined) {
      resolved.runtime.fallback_model = normalizeModel(
        provider,
        model,
        'runtime.fallback_model',
        diagnostics,
        resolved.runtime.fallback_model,
      );
    }
  }
}

function cloneDefaults(): ResolvedWorkspaceConfig {
  return {
    draft: { ...DEFAULT_WORKSPACE_CONFIG.draft },
    swarm: {
      providers: {
        claude: { ...DEFAULT_WORKSPACE_CONFIG.swarm.providers.claude },
        codex: { ...DEFAULT_WORKSPACE_CONFIG.swarm.providers.codex },
        gemini: { ...DEFAULT_WORKSPACE_CONFIG.swarm.providers.gemini },
      },
    },
    runtime: { ...DEFAULT_WORKSPACE_CONFIG.runtime },
  };
}

function normalizeModel(
  provider: string,
  model: string,
  fieldPath: string,
  diagnostics: WorkspaceConfigDiagnostic[],
  fallback: string,
): string {
  if (model.trim().length === 0) {
    diagnostics.push({
      code: 'INVALID_TYPE',
      severity: 'warning',
      message: `${fieldPath} must be a non-empty string when provided.`,
      path: fieldPath,
    });
    return fallback;
  }

  const normalized = model.trim();
  if (normalized === 'default') {
    return normalized;
  }
  if (provider === 'simulation') {
    return normalized;
  }

  const info = getModelInfo(normalized, provider);
  if (!info) {
    diagnostics.push({
      code: 'UNKNOWN_MODEL',
      severity: 'warning',
      message: `Unknown model '${normalized}' for provider '${provider}'.`,
      path: fieldPath,
    });
  }

  return normalized;
}

function coerceProvider(
  value: unknown,
  fieldPath: string,
  diagnostics: WorkspaceConfigDiagnostic[],
  fallback: string,
): string {
  const normalized = coerceString(value, fieldPath, diagnostics);
  if (normalized === undefined) {
    return fallback;
  }

  if (!KNOWN_LLM_PROVIDERS.has(normalized)) {
    diagnostics.push({
      code: 'UNKNOWN_PROVIDER',
      severity: 'warning',
      message: `Unknown provider '${normalized}'.`,
      path: fieldPath,
    });
    return fallback;
  }
  return normalized;
}

function coerceString(
  value: unknown,
  fieldPath: string,
  diagnostics: WorkspaceConfigDiagnostic[],
): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value === 'string') {
    return value.trim();
  }
  diagnostics.push({
    code: 'INVALID_TYPE',
    severity: 'warning',
    message: `${fieldPath} must be a string.`,
    path: fieldPath,
  });
  return undefined;
}

function coerceBoolean(
  value: unknown,
  fieldPath: string,
  diagnostics: WorkspaceConfigDiagnostic[],
): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value === 'boolean') {
    return value;
  }
  diagnostics.push({
    code: 'INVALID_TYPE',
    severity: 'warning',
    message: `${fieldPath} must be a boolean.`,
    path: fieldPath,
  });
  return undefined;
}

function collectUnknownFields(
  record: Record<string, unknown>,
  allowed: string[],
  prefix: string,
  diagnostics: WorkspaceConfigDiagnostic[],
): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(record)) {
    if (allowedSet.has(key)) {
      continue;
    }
    const location = prefix ? `${prefix}.${key}` : key;
    diagnostics.push({
      code: 'UNKNOWN_FIELD',
      severity: 'warning',
      message: `Unknown config field '${location}'.`,
      path: location,
    });
  }
}

function collectSecrets(
  value: unknown,
  currentPath: string,
  diagnostics: WorkspaceConfigDiagnostic[],
): void {
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      collectSecrets(value[index], `${currentPath}[${index}]`, diagnostics);
    }
    return;
  }

  if (!isRecord(value)) {
    return;
  }

  for (const [key, nestedValue] of Object.entries(value)) {
    const nextPath = currentPath ? `${currentPath}.${key}` : key;
    if (SECRET_FIELD_PATTERN.test(key)) {
      diagnostics.push({
        code: 'SECRET_FIELD',
        severity: 'warning',
        message: `Secret-like field '${nextPath}' was ignored. Put credentials in environment variables, not config.yaml.`,
        path: nextPath,
      });
      continue;
    }
    collectSecrets(nestedValue, nextPath, diagnostics);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
