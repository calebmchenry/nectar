import type { WorkspaceConfigLoader } from '../../config/workspace.js';
import { Router } from '../router.js';
import type { UnifiedClient } from '../../llm/client.js';

export interface WorkspaceRoutesOptions {
  config_loader: WorkspaceConfigLoader;
  client: UnifiedClient;
}

const KNOWN_PROVIDERS = ['anthropic', 'openai', 'openai_compatible', 'gemini', 'simulation'] as const;

export function registerWorkspaceRoutes(router: Router, options: WorkspaceRoutesOptions): void {
  router.register('GET', '/workspace/config', async (ctx) => {
    const loaded = await options.config_loader.load();
    const available = new Set(options.client.available_providers());

    const providerAvailability = Object.fromEntries(
      KNOWN_PROVIDERS.map((provider) => [provider, available.has(provider)]),
    ) as Record<(typeof KNOWN_PROVIDERS)[number], boolean>;

    ctx.sendJson(200, {
      path: loaded.path,
      exists: loaded.exists,
      source: loaded.source,
      config: loaded.resolved,
      provider_availability: {
        llm: providerAvailability,
        draft_provider_available: available.has(loaded.resolved.draft.provider),
        swarm: {
          claude: available.has(loaded.resolved.swarm.providers.claude.llm_provider),
          codex: available.has(loaded.resolved.swarm.providers.codex.llm_provider),
          gemini: available.has(loaded.resolved.swarm.providers.gemini.llm_provider),
        },
      },
      diagnostics: loaded.diagnostics,
    });
  });
}
