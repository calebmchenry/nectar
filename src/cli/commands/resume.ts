import { Command } from 'commander';
import { listCocoons, readCocoon } from '../../checkpoint/cocoon.js';
import { PipelineEngine } from '../../engine/engine.js';
import { EventRenderer } from '../ui/renderer.js';
import { createTheme } from '../ui/theme.js';
import { formatDiagnostic, hasErrors, loadAndValidate } from './shared.js';

export function registerResumeCommand(program: Command): void {
  program
    .command('resume')
    .argument('[run-id]', 'Run ID to resume')
    .option('--force', 'Resume even if DOT graph hash changed', false)
    .description('Resume a hibernating run from its cocoon.')
    .action(async (runId: string | undefined, options: { force: boolean }) => {
      if (!runId) {
        const cocoons = await listCocoons(process.cwd());
        if (cocoons.length === 0) {
          process.stdout.write('No cocoons found.\n');
          return;
        }

        for (const cocoon of cocoons) {
          process.stdout.write(
            `${cocoon.run_id} ${cocoon.status} ${cocoon.dot_file} completed=${cocoon.completed_count} current=${cocoon.current_node ?? '-'}\n`
          );
        }
        return;
      }

      const cocoon = await readCocoon(runId, process.cwd());
      if (!cocoon) {
        process.stderr.write(`Run '${runId}' not found.\n`);
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

      const theme = createTheme(process.stdout, process.env);
      const renderer = new EventRenderer({ theme });
      const engine = new PipelineEngine({
        graph: load.graph,
        graph_hash: nextHash,
        workspace_root: process.cwd(),
        initial_cocoon: cocoon
      });

      engine.onEvent((event) => renderer.render(event));
      const runResult = await engine.run();
      if (runResult.status === 'failed') {
        process.exitCode = 1;
      }
    });
}
