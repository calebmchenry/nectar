import { Command } from 'commander';
import { formatDiagnostic, hasErrors, loadAndValidate } from './shared.js';

export function registerValidateCommand(program: Command): void {
  program
    .command('validate')
    .argument('<file>', 'Path to DOT file')
    .description('Check a garden for structural validity.')
    .action(async (file: string) => {
      const result = await loadAndValidate(file);
      if (!result.graph || result.diagnostics.length > 0) {
        for (const diagnostic of result.diagnostics) {
          process.stderr.write(`${formatDiagnostic(diagnostic)}\n`);
        }

        if (hasErrors(result.diagnostics)) {
          process.exitCode = 1;
          return;
        }
      }

      process.stdout.write(`OK: ${file}\n`);
    });
}
