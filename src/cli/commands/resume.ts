import { Command } from 'commander';
import { RunStore } from '../../checkpoint/run-store.js';
import type { ManifestData } from '../../checkpoint/run-store.js';
import { PipelineEngine } from '../../engine/engine.js';
import { Interviewer } from '../../interviewer/types.js';
import { AutoApproveInterviewer } from '../../interviewer/auto-approve.js';
import { ConsoleInterviewer } from '../../interviewer/console.js';
import { UnifiedClient } from '../../llm/client.js';
import { EventRenderer } from '../ui/renderer.js';
import { createTheme } from '../ui/theme.js';
import { formatDiagnostic, hasErrors, loadAndValidate } from './shared.js';

export function registerResumeCommand(program: Command): void {
  program
    .command('resume')
    .argument('[run-id]', 'Run ID to resume')
    .option('--force', 'Resume even if DOT graph hash changed', false)
    .option('--auto-approve', 'Auto-approve human gates (select default or first choice)', false)
    .description('Resume a hibernating run from its cocoon.')
    .action(async (runId: string | undefined, options: { force: boolean; autoApprove: boolean }) => {
      if (!runId) {
        const summaries = await RunStore.listRuns(process.cwd());
        if (summaries.length === 0) {
          process.stdout.write('No cocoons found.\n');
          return;
        }

        for (const cocoon of summaries) {
          process.stdout.write(
            `${cocoon.run_id} ${cocoon.status} ${cocoon.dot_file} completed=${cocoon.completed_count} current=${cocoon.current_node ?? '-'}\n`
          );
        }
        return;
      }

      // Follow restart chain to find latest run
      let resolvedRunId = runId;
      for (let depth = 0; depth < 100; depth++) {
        const store = new RunStore(resolvedRunId, process.cwd());
        const manifest = await store.readManifest();
        if (manifest?.restarted_to) {
          resolvedRunId = manifest.restarted_to;
        } else {
          break;
        }
      }

      // Read canonical first, then legacy fallback
      const cocoon = await RunStore.readCocoon(resolvedRunId, process.cwd());
      if (!cocoon) {
        process.stderr.write(`Run '${resolvedRunId}' not found.\n`);
        process.exitCode = 1;
        return;
      }

      const load = await loadAndValidate(cocoon.dot_file);
      if (!load.graph || hasErrors(load.diagnostics)) {
        for (const diagnostic of load.diagnostics) {
          process.stderr.write(`${formatDiagnostic(diagnostic)}\n`);
        }
        process.exitCode = 1;
        return;
      }

      const nextHash = load.graph_hash ?? '';
      if (!options.force && nextHash !== cocoon.graph_hash) {
        process.stderr.write(
          `Graph hash mismatch for run '${runId}'. Original ${cocoon.graph_hash}, current ${nextHash}. Re-run with --force to override.\n`
        );
        process.exitCode = 1;
        return;
      }

      // If --force and pending_transition points to invalid target, fail fast
      if (options.force && cocoon.pending_transition) {
        const targetId = cocoon.pending_transition.target_node_id;
        if (!load.graph.nodeMap.has(targetId)) {
          process.stderr.write(
            `Cannot resume: pending transition target '${targetId}' no longer exists in the edited graph.\n`
          );
          process.exitCode = 1;
          return;
        }
      }

      const interviewer: Interviewer = options.autoApprove
        ? new AutoApproveInterviewer()
        : new ConsoleInterviewer();

      const theme = createTheme(process.stdout, process.env);
      const renderer = new EventRenderer({ theme });
      const llmClient = UnifiedClient.from_env();
      const engine = new PipelineEngine({
        graph: load.graph,
        graph_hash: nextHash,
        workspace_root: process.cwd(),
        initial_cocoon: cocoon,
        interviewer,
        llm_client: llmClient
      });

      engine.onEvent((event) => renderer.render(event));
      let runResult = await engine.run();

      // Follow restart chains automatically
      while (runResult.restart) {
        const restart = runResult.restart;
        const successorStore = new RunStore(restart.successor_run_id, process.cwd());
        const successorManifest: ManifestData = {
          run_id: restart.successor_run_id,
          dot_file: load.graph.dotPath,
          graph_hash: nextHash,
          graph_label: load.graph.graphAttributes.label,
          goal: load.graph.graphAttributes.goal,
          started_at: new Date().toISOString(),
          workspace_root: process.cwd(),
          restart_of: runResult.run_id,
          restart_depth: restart.restart_depth,
        };
        await successorStore.initialize(successorManifest);

        const successorEngine = new PipelineEngine({
          graph: load.graph,
          graph_hash: nextHash,
          workspace_root: process.cwd(),
          interviewer,
          llm_client: llmClient,
          run_id: restart.successor_run_id,
          initial_context: restart.filtered_context,
          start_node_override: restart.target_node,
        });
        successorEngine.onEvent((event) => renderer.render(event));
        runResult = await successorEngine.run();
      }

      if (runResult.status === 'failed') {
        process.exitCode = 1;
      }
    });
}
