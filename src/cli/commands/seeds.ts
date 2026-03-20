import { Command } from 'commander';
import { createTheme } from '../ui/theme.js';
import { SeedStore } from '../../seedbed/store.js';
import { workspacePathsFromCwd } from '../../seedbed/paths.js';
import { checkConsistency } from '../../seedbed/consistency.js';
import { isValidPriority, isValidStatus } from '../../seedbed/types.js';

export function registerSeedsCommand(program: Command): void {
  program
    .command('seeds')
    .description('List all seeds.')
    .option('--status <status>', 'Filter by status')
    .option('--priority <priority>', 'Filter by priority')
    .option('--check', 'Show only inconsistencies and exit non-zero if any found')
    .action(async (options: { status?: string; priority?: string; check?: boolean }) => {
      const theme = createTheme(process.stdout, process.env);
      const ws = workspacePathsFromCwd();

      if (options.check) {
        const issues = await checkConsistency(ws);
        if (issues.length === 0) {
          process.stdout.write(`${theme.icons.success} No consistency issues found.\n`);
          return;
        }

        for (const issue of issues) {
          process.stdout.write(`${theme.icons.fail} [${issue.code}] Seed ${issue.seedId}: ${issue.message}\n`);
        }
        process.exitCode = 1;
        return;
      }

      const store = new SeedStore(ws);
      let seeds = await store.list();

      if (options.status) {
        if (!isValidStatus(options.status)) {
          process.stderr.write(`Error: Invalid status filter "${options.status}".\n`);
          process.exitCode = 1;
          return;
        }
        seeds = seeds.filter((s) => s.meta.status === options.status);
      }

      if (options.priority) {
        if (!isValidPriority(options.priority)) {
          process.stderr.write(`Error: Invalid priority filter "${options.priority}".\n`);
          process.exitCode = 1;
          return;
        }
        seeds = seeds.filter((s) => s.meta.priority === options.priority);
      }

      if (seeds.length === 0) {
        process.stdout.write(`${theme.muted('No seeds found.')}\n`);
        return;
      }

      // Check for inline consistency warnings
      const issues = await checkConsistency(ws);
      const issuesByDir = new Map<string, string[]>();
      for (const issue of issues) {
        const msgs = issuesByDir.get(issue.directory) ?? [];
        msgs.push(issue.message);
        issuesByDir.set(issue.directory, msgs);
      }

      for (const seed of seeds) {
        const statusIcon = seed.meta.status === 'honey' ? theme.icons.honey
          : seed.meta.status === 'wilted' ? theme.icons.wilted
          : theme.icons.bee;

        const priorityStr = seed.meta.priority === 'queens_order'
          ? theme.warn('queens_order')
          : seed.meta.priority === 'high'
          ? theme.warn(seed.meta.priority)
          : seed.meta.priority;

        process.stdout.write(
          `${statusIcon} ${theme.info(String(seed.meta.id).padStart(3, '0'))} ${seed.meta.title} [${seed.meta.status}] [${priorityStr}]`
        );

        if (seed.meta.tags.length > 0) {
          process.stdout.write(` ${theme.muted(seed.meta.tags.join(', '))}`);
        }

        process.stdout.write('\n');

        // Show inline warnings
        const dirIssues = issuesByDir.get(seed.dirPath);
        if (dirIssues) {
          for (const msg of dirIssues) {
            process.stdout.write(`     ${theme.warn('⚠ ' + msg)}\n`);
          }
        }
      }
    });
}
