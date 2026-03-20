import { Command } from 'commander';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createTheme } from '../ui/theme.js';
import { SeedStore } from '../../seedbed/store.js';
import { workspacePathsFromCwd } from '../../seedbed/paths.js';
import { importAttachment } from '../../seedbed/attachments.js';
import { appendAttachmentLinks } from '../../seedbed/markdown.js';
import { isValidPriority, isValidStatus, SeedPriority, SEED_PRIORITIES, SEED_STATUSES } from '../../seedbed/types.js';

const MAX_STDIN_BYTES = 1024 * 1024; // 1 MB

export function registerSeedCommand(program: Command): void {
  const seed = program
    .command('seed')
    .description('Capture and manage seeds (ideas).');

  // Default action: create a seed
  seed
    .argument('[text...]', 'Seed text (or pipe via stdin)')
    .option('--title <title>', 'Override derived title')
    .option('--priority <priority>', 'Priority: low, normal, high, queens_order')
    .option('--tag <tag...>', 'Tags (repeatable)')
    .option('--attach <path...>', 'Attach files (repeatable, max 50MB each)')
    .action(async (textParts: string[], options: { title?: string; priority?: string; tag?: string[]; attach?: string[] }) => {
      const theme = createTheme(process.stdout, process.env);
      const ws = workspacePathsFromCwd();
      const store = new SeedStore(ws);

      let body = textParts.join(' ').trim();

      // Read from stdin if no text provided and stdin is piped
      if (!body && !process.stdin.isTTY) {
        body = await readStdin();
      }

      if (!body && !options.title) {
        process.stderr.write('Error: No seed text provided. Pass text as an argument or pipe via stdin.\n');
        process.exitCode = 1;
        return;
      }

      if (options.priority && !isValidPriority(options.priority)) {
        process.stderr.write(`Error: Invalid priority "${options.priority}". Valid: ${SEED_PRIORITIES.join(', ')}\n`);
        process.exitCode = 1;
        return;
      }

      const meta = await store.create({
        title: options.title,
        body: body || '',
        priority: options.priority as SeedPriority | undefined,
        tags: options.tag,
      });

      // Handle attachments
      if (options.attach && options.attach.length > 0) {
        const seedResult = await store.get(meta.id);
        if (seedResult) {
          const attachDir = path.join(seedResult.dirPath, 'attachments');
          const links: { name: string; relativePath: string }[] = [];

          for (const attachPath of options.attach) {
            try {
              const link = await importAttachment(path.resolve(attachPath), attachDir);
              links.push(link);
            } catch (err) {
              process.stderr.write(`Warning: Failed to attach "${attachPath}": ${err instanceof Error ? err.message : String(err)}\n`);
            }
          }

          if (links.length > 0) {
            const mdPath = path.join(seedResult.dirPath, 'seed.md');
            const existing = await readFile(mdPath, 'utf8');
            const updated = appendAttachmentLinks(existing, links);
            await writeFile(mdPath, updated, 'utf8');
          }
        }
      }

      process.stdout.write(`${theme.icons.bee} Seed ${meta.id} created: ${theme.info(meta.title)}\n`);
      process.stdout.write(`   ${theme.muted(`seedbed/${String(meta.id).padStart(3, '0')}-${meta.slug}/`)}\n`);
    });

  // Show a seed
  seed
    .command('show')
    .argument('<id>', 'Seed ID')
    .description('Show seed details.')
    .action(async (idStr: string) => {
      const theme = createTheme(process.stdout, process.env);
      const ws = workspacePathsFromCwd();
      const store = new SeedStore(ws);
      const id = Number.parseInt(idStr, 10);

      if (Number.isNaN(id)) {
        process.stderr.write(`Error: Invalid seed ID "${idStr}".\n`);
        process.exitCode = 1;
        return;
      }

      const result = await store.get(id);
      if (!result) {
        process.stderr.write(`Error: Seed ${id} not found.\n`);
        process.exitCode = 1;
        return;
      }

      const { meta, seedMd } = result;
      process.stdout.write(`${theme.info(`Seed ${meta.id}`)}: ${meta.title}\n`);
      process.stdout.write(`  Status:   ${meta.status}\n`);
      process.stdout.write(`  Priority: ${meta.priority}\n`);
      if (meta.tags.length > 0) {
        process.stdout.write(`  Tags:     ${meta.tags.join(', ')}\n`);
      }
      process.stdout.write(`  Created:  ${meta.created_at}\n`);
      process.stdout.write(`  Updated:  ${meta.updated_at}\n`);
      process.stdout.write(`\n${seedMd}`);
    });

  // Set status
  seed
    .command('set-status')
    .argument('<id>', 'Seed ID')
    .argument('<status>', `Status: ${SEED_STATUSES.join(', ')}`)
    .description('Update seed status.')
    .action(async (idStr: string, status: string) => {
      const theme = createTheme(process.stdout, process.env);
      const ws = workspacePathsFromCwd();
      const store = new SeedStore(ws);
      const id = Number.parseInt(idStr, 10);

      if (Number.isNaN(id)) {
        process.stderr.write(`Error: Invalid seed ID "${idStr}".\n`);
        process.exitCode = 1;
        return;
      }

      if (!isValidStatus(status)) {
        process.stderr.write(`Error: Invalid status "${status}". Valid: ${SEED_STATUSES.join(', ')}\n`);
        process.exitCode = 1;
        return;
      }

      try {
        const meta = await store.updateMeta(id, { status });
        process.stdout.write(`${theme.icons.bee} Seed ${meta.id} status → ${theme.info(meta.status)}\n`);
      } catch (err) {
        process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
        process.exitCode = 1;
      }
    });

  // Set priority
  seed
    .command('set-priority')
    .argument('<id>', 'Seed ID')
    .argument('<priority>', `Priority: ${SEED_PRIORITIES.join(', ')}`)
    .description('Update seed priority.')
    .action(async (idStr: string, priority: string) => {
      const theme = createTheme(process.stdout, process.env);
      const ws = workspacePathsFromCwd();
      const store = new SeedStore(ws);
      const id = Number.parseInt(idStr, 10);

      if (Number.isNaN(id)) {
        process.stderr.write(`Error: Invalid seed ID "${idStr}".\n`);
        process.exitCode = 1;
        return;
      }

      if (!isValidPriority(priority)) {
        process.stderr.write(`Error: Invalid priority "${priority}". Valid: ${SEED_PRIORITIES.join(', ')}\n`);
        process.exitCode = 1;
        return;
      }

      try {
        const meta = await store.updateMeta(id, { priority: priority as SeedPriority });
        process.stdout.write(`${theme.icons.bee} Seed ${meta.id} priority → ${theme.info(meta.priority)}\n`);
      } catch (err) {
        process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
        process.exitCode = 1;
      }
    });
}

async function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalSize = 0;

    process.stdin.on('data', (chunk: Buffer) => {
      totalSize += chunk.length;
      if (totalSize > MAX_STDIN_BYTES) {
        process.stdin.destroy();
        reject(new Error('Stdin input exceeds 1 MB limit.'));
        return;
      }
      chunks.push(chunk);
    });

    process.stdin.on('end', () => {
      resolve(Buffer.concat(chunks).toString('utf8'));
    });

    process.stdin.on('error', reject);
  });
}
