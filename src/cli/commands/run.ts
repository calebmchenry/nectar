import { Command } from 'commander';
import { PipelineEngine } from '../../engine/engine.js';
import { RunStore } from '../../checkpoint/run-store.js';
import type { ManifestData } from '../../checkpoint/run-store.js';
import type { RunResult } from '../../engine/types.js';
import { Interviewer } from '../../interviewer/types.js';
import { AutoApproveInterviewer } from '../../interviewer/auto-approve.js';
import { ConsoleInterviewer } from '../../interviewer/console.js';
import { UnifiedClient } from '../../llm/client.js';
import { EventRenderer } from '../ui/renderer.js';
import { createTheme } from '../ui/theme.js';
import { formatDiagnostic, hasErrors, loadAndValidate } from './shared.js';
import type { GardenGraph } from '../../garden/types.js';

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

      let runResult = await runEngine(result.graph, result.graph_hash ?? '', process.cwd(), interviewer, llmClient, renderer);

      // Follow restart chains automatically
      while (runResult.restart) {
        const restart = runResult.restart;
        const successorStore = new RunStore(restart.successor_run_id, process.cwd());
        const successorManifest: ManifestData = {
          run_id: restart.successor_run_id,
          dot_file: result.graph.dotPath,
          graph_hash: result.graph_hash ?? '',
          graph_label: result.graph.graphAttributes.label,
          goal: result.graph.graphAttributes.goal,
          started_at: new Date().toISOString(),
          workspace_root: process.cwd(),
          restart_of: runResult.run_id,
          restart_depth: restart.restart_depth,
        };
        await successorStore.initialize(successorManifest);

        const successorEngine = new PipelineEngine({
          graph: result.graph,
          graph_hash: result.graph_hash ?? '',
          workspace_root: process.cwd(),
          interviewer,
          llm_client: llmClient,
          run_id: restart.successor_run_id,
          initial_context: restart.filtered_context,
          start_node_override: restart.target_node,
        });
        successorEngine.onEvent((event) => renderer.render(event));
        runResult = await successorEngine.run();
      }

      if (runResult.status === 'failed') {
        process.exitCode = 1;
      }
    });
}

function runEngine(
  graph: GardenGraph,
  graphHash: string,
  workspaceRoot: string,
  interviewer: Interviewer,
  llmClient: UnifiedClient,
  renderer: EventRenderer,
): Promise<RunResult> {
  const engine = new PipelineEngine({
    graph,
    graph_hash: graphHash,
    workspace_root: workspaceRoot,
    interviewer,
    llm_client: llmClient,
  });
  engine.onEvent((event) => renderer.render(event));
  return engine.run();
}
