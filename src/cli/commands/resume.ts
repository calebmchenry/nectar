import { Command } from 'commander';
import { Interviewer } from '../../interviewer/types.js';
import { AutoApproveInterviewer } from '../../interviewer/auto-approve.js';
import { ConsoleInterviewer } from '../../interviewer/console.js';
import { UnifiedClient } from '../../llm/client.js';
import { EventRenderer } from '../ui/renderer.js';
import { createTheme } from '../ui/theme.js';
import { formatDiagnostic } from './shared.js';
import {
  PipelineConflictError,
  PipelineDiagnosticsError,
  PipelineNotFoundError,
  PipelineService,
} from '../../runtime/pipeline-service.js';

export function registerResumeCommand(program: Command): void {
  program
    .command('resume')
    .argument('[run-id]', 'Run ID to resume')
    .option('--force', 'Resume even if DOT graph hash changed', false)
    .option('--auto-approve', 'Auto-approve human gates (select default or first choice)', false)
    .description('Resume a hibernating run from its cocoon.')
    .action(async (runId: string | undefined, options: { force: boolean; autoApprove: boolean }) => {
      const service = new PipelineService(process.cwd());
      if (!runId) {
        const summaries = await service.listRuns();
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

      const interviewer: Interviewer = options.autoApprove
        ? new AutoApproveInterviewer()
        : new ConsoleInterviewer();

      const theme = createTheme(process.stdout, process.env);
      const renderer = new EventRenderer({ theme });
      const llmClient = UnifiedClient.from_env();
      try {
        const resumed = await service.resumePipeline({
          run_id: runId,
          force: options.force,
          interviewer,
          llm_client: llmClient,
          on_event: (event) => renderer.render(event),
        });
        if (resumed.run_result.status === 'failed') {
          process.exitCode = 1;
        }
      } catch (error) {
        if (error instanceof PipelineDiagnosticsError) {
          for (const diagnostic of error.diagnostics) {
            process.stderr.write(`${formatDiagnostic(diagnostic)}\n`);
          }
        } else if (error instanceof PipelineNotFoundError) {
          process.stderr.write(`${error.message}\n`);
        } else if (error instanceof PipelineConflictError) {
          process.stderr.write(`${error.message}\n`);
          if (error.message.includes('Graph hash mismatch')) {
            process.stderr.write(`\nTo resume anyway, run:\n  nectar resume ${runId} --force\n`);
          }
        } else {
          throw error;
        }
        process.exitCode = 1;
      }
    });
}
