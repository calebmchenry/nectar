import { Command } from 'commander';
import { SWARM_PROVIDERS, SwarmAnalysisService } from '../../runtime/swarm-analysis-service.js';
import { workspacePathsFromCwd } from '../../seedbed/paths.js';
import { SeedStore } from '../../seedbed/store.js';
import { createTheme } from '../ui/theme.js';

const SUPPORTED_PROVIDERS = new Set<string>(SWARM_PROVIDERS);

interface SwarmOptions {
  provider?: string[];
  force?: boolean;
  attachments?: boolean;
}

export function registerSwarmCommand(program: Command): void {
  program
    .command('swarm')
    .argument('<seed-id>', 'Seed ID to analyze')
    .description('Run swarm analysis for a seed without requiring the HTTP server.')
    .option('-p, --provider <provider...>', `Providers (any of: ${SWARM_PROVIDERS.join(', ')})`)
    .option('--force', 'Re-run provider analyses even when already complete')
    .option('--no-attachments', 'Skip attachments when building provider prompts')
    .action(async (seedIdRaw: string, options: SwarmOptions) => {
      const theme = createTheme(process.stdout, process.env);
      const seedId = Number.parseInt(seedIdRaw, 10);
      if (!Number.isInteger(seedId) || seedId <= 0) {
        process.stderr.write(`Error: Invalid seed ID "${seedIdRaw}".\n`);
        process.exitCode = 1;
        return;
      }

      const ws = workspacePathsFromCwd();
      const store = new SeedStore(ws);
      const seed = await store.get(seedId);
      if (!seed) {
        process.stderr.write(`Error: Seed ${seedId} not found.\n`);
        process.exitCode = 1;
        return;
      }

      const providers = normalizeProviders(options.provider);
      if (providers === null) {
        process.exitCode = 1;
        return;
      }

      process.stdout.write(`${theme.icons.bee} Running swarm analysis for seed ${seedId} with ${providers.join(', ')}\n`);

      const service = new SwarmAnalysisService({ workspace_root: ws.root });
      const results = await service.analyzeSeed({
        seed_id: seedId,
        providers,
        include_attachments: options.attachments !== false,
        force: options.force === true,
      });

      for (const result of results) {
        process.stdout.write(`  - ${result.provider}: ${result.status}${result.message ? ` (${result.message})` : ''}\n`);
      }

      if (results.some((result) => result.status === 'failed')) {
        process.exitCode = 1;
      }
    });
}

function normalizeProviders(input?: string[]): Array<'claude' | 'codex' | 'gemini'> | null {
  if (!input || input.length === 0) {
    return [...SWARM_PROVIDERS];
  }

  const values: string[] = [];
  for (const raw of input) {
    for (const token of raw.split(',')) {
      const value = token.trim().toLowerCase();
      if (value.length > 0) {
        values.push(value);
      }
    }
  }

  const deduped: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) {
      continue;
    }
    seen.add(value);
    deduped.push(value);
  }

  const invalid = deduped.filter((provider) => !SUPPORTED_PROVIDERS.has(provider));
  if (invalid.length > 0) {
    process.stderr.write(
      `Error: Unsupported provider(s): ${invalid.join(', ')}. Valid providers: ${SWARM_PROVIDERS.join(', ')}\n`
    );
    return null;
  }

  return deduped as Array<'claude' | 'codex' | 'gemini'>;
}
