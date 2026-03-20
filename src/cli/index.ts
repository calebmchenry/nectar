#!/usr/bin/env node

import { Command } from 'commander';
import { pathToFileURL } from 'node:url';
import { NECTAR_VERSION } from '../generated/version.js';
import { registerRunCommand } from './commands/run.js';
import { registerResumeCommand } from './commands/resume.js';
import { registerStatusCommand } from './commands/status.js';
import { registerValidateCommand } from './commands/validate.js';
import { registerSeedCommand } from './commands/seed.js';
import { registerSeedsCommand } from './commands/seeds.js';
import { registerUpgradeCommand } from './commands/upgrade.js';

export function createProgram(): Command {
  const program = new Command();

  program
    .name('nectar')
    .version(NECTAR_VERSION)
    .description('Nectar CLI: grow your garden, avoid the wilt, harvest honey.');

  registerRunCommand(program);
  registerResumeCommand(program);
  registerValidateCommand(program);
  registerStatusCommand(program);
  registerSeedCommand(program);
  registerSeedsCommand(program);
  registerUpgradeCommand(program);
  return program;
}

async function main(): Promise<void> {
  const program = createProgram();
  await program.parseAsync(process.argv);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
