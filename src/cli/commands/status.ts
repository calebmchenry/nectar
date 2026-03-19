import { Command } from 'commander';
import { listCocoons, readCocoon } from '../../checkpoint/cocoon.js';

export function registerStatusCommand(program: Command): void {
  program
    .command('status')
    .argument('[run-id]', 'Run ID to inspect')
    .description('Inspect cocoon status.')
    .action(async (runId: string | undefined) => {
      if (!runId) {
        const cocoons = await listCocoons(process.cwd());
        if (cocoons.length === 0) {
          process.stdout.write('No cocoons found.\n');
          return;
        }

        for (const cocoon of cocoons) {
          process.stdout.write(
            `${cocoon.run_id} ${cocoon.status} updated=${cocoon.updated_at} completed=${cocoon.completed_count} current=${cocoon.current_node ?? '-'}\n`
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

      process.stdout.write(`${JSON.stringify(cocoon, null, 2)}\n`);
    });
}
