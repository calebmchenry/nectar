import { Command } from 'commander';
import { RunStore } from '../../checkpoint/run-store.js';

export function registerStatusCommand(program: Command): void {
  program
    .command('status')
    .argument('[run-id]', 'Run ID to inspect')
    .description('Inspect cocoon status.')
    .action(async (runId: string | undefined) => {
      if (!runId) {
        const summaries = await RunStore.listRuns(process.cwd());
        if (summaries.length === 0) {
          process.stdout.write('No cocoons found.\n');
          return;
        }

        for (const cocoon of summaries) {
          process.stdout.write(
            `${cocoon.run_id} ${cocoon.status} updated=${cocoon.updated_at} completed=${cocoon.completed_count} current=${cocoon.current_node ?? '-'}\n`
          );
        }
        return;
      }

      // Read canonical first, then legacy fallback
      const cocoon = await RunStore.readCocoon(runId, process.cwd());
      if (!cocoon) {
        process.stderr.write(`Run '${runId}' not found.\n`);
        process.exitCode = 1;
        return;
      }

      process.stdout.write(`${JSON.stringify(cocoon, null, 2)}\n`);

      // Show lineage if present
      const store = new RunStore(runId, process.cwd());
      const manifest = await store.readManifest();
      if (manifest?.restart_of || manifest?.restarted_to || manifest?.parent_run_id) {
        process.stdout.write('\nLineage:\n');
        if (manifest.restart_of) {
          process.stdout.write(`  Predecessor: ${manifest.restart_of}\n`);
        }
        if (manifest.restarted_to) {
          process.stdout.write(`  Successor: ${manifest.restarted_to}\n`);
        }
        if (manifest.restart_depth !== undefined) {
          process.stdout.write(`  Restart depth: ${manifest.restart_depth}\n`);
        }
        if (manifest.parent_run_id) {
          process.stdout.write(`  Parent run: ${manifest.parent_run_id} (node: ${manifest.parent_node_id ?? '?'})\n`);
        }
      }
    });
}
