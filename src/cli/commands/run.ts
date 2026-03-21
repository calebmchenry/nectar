import { Command } from 'commander';
import { Interviewer } from '../../interviewer/types.js';
import { AutoApproveInterviewer } from '../../interviewer/auto-approve.js';
import { ConsoleInterviewer } from '../../interviewer/console.js';
import { UnifiedClient } from '../../llm/client.js';
import { EventRenderer } from '../ui/renderer.js';
import { createTheme } from '../ui/theme.js';
import { formatDiagnostic, hasErrors, loadAndValidate } from './shared.js';
import { PipelineService } from '../../runtime/pipeline-service.js';

export function registerRunCommand(program: Command): void {
  program
    .command('run')
    .argument('<file>', 'Path to DOT file')
    .option('--auto-approve', 'Auto-approve human gates (select default or first choice)', false)
    .description('Pollinate a DOT-defined garden.')
    .action(async (file: string, options: { autoApprove: boolean }) => {
      const result = await loadAndValidate(file);
      if (!result.graph || hasErrors(result.diagnostics)) {
        for (const diagnostic of result.diagnostics) {
          process.stderr.write(`${formatDiagnostic(diagnostic)}\n`);
        }
        process.exitCode = 1;
        return;
      }

      const interviewer: Interviewer = options.autoApprove
        ? new AutoApproveInterviewer()
        : new ConsoleInterviewer();

      const theme = createTheme(process.stdout, process.env);
      const renderer = new EventRenderer({ theme });
      const llmClient = UnifiedClient.from_env();
      const service = new PipelineService(process.cwd());
      const runResult = await service.executePipeline({
        graph: result.graph,
        graph_hash: result.graph_hash ?? '',
        graph_hash_kind: result.graph_hash_kind,
        prepared_dot: result.prepared_dot,
        source_files: result.source_files,
        interviewer,
        llm_client: llmClient,
        on_event: (event) => renderer.render(event),
      });

      if (runResult.status === 'failed') {
        process.exitCode = 1;
      }
    });
}
