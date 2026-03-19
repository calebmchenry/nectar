import { Command } from 'commander';
import { PipelineEngine } from '../../engine/engine.js';
import { EventRenderer } from '../ui/renderer.js';
import { createTheme } from '../ui/theme.js';
import { formatDiagnostic, hasErrors, loadAndValidate } from './shared.js';

export function registerRunCommand(program: Command): void {
  program
    .command('run')
    .argument('<file>', 'Path to DOT file')
    .description('Pollinate a DOT-defined garden.')
    .action(async (file: string) => {
      const result = await loadAndValidate(file);
      if (!result.graph || hasErrors(result.diagnostics)) {
        for (const diagnostic of result.diagnostics) {
          process.stderr.write(`${formatDiagnostic(diagnostic)}\n`);
        }
        process.exitCode = 1;
        return;
      }

      const theme = createTheme(process.stdout, process.env);
      const renderer = new EventRenderer({ theme });
      const engine = new PipelineEngine({
        graph: result.graph,
        graph_hash: result.graph_hash ?? '',
        workspace_root: process.cwd()
      });

      engine.onEvent((event) => renderer.render(event));

      const runResult = await engine.run();
      if (runResult.status === 'failed') {
        process.exitCode = 1;
      }
    });
}
