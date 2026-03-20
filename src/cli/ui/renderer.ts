import ora, { Ora } from 'ora';
import { RunEvent } from '../../engine/events.js';
import { Theme } from './theme.js';

export interface RendererOptions {
  theme: Theme;
  write?: (line: string) => void;
}

export class EventRenderer {
  private readonly theme: Theme;
  private readonly write: (line: string) => void;
  private readonly spinners = new Map<string, Ora>();

  constructor(options: RendererOptions) {
    this.theme = options.theme;
    this.write = options.write ?? ((line: string) => process.stdout.write(`${line}\n`));
  }

  render(event: RunEvent): void {
    switch (event.type) {
      case 'run_started': {
        this.write(`${this.theme.icons.bee} Nectar buzzing...`);
        this.write(this.theme.info(`${this.theme.icons.loaded} Garden loaded: ${event.dot_file}`));
        break;
      }
      case 'node_started': {
        const message = `${this.theme.icons.node} Petal [${event.node_id}] blooming...`;
        if (this.theme.use_spinner) {
          const spinner = ora({ text: message }).start();
          this.spinners.set(event.node_id, spinner);
        } else {
          this.write(message);
        }
        break;
      }
      case 'node_completed': {
        const spinner = this.spinners.get(event.node_id);
        const seconds = (event.duration_ms / 1000).toFixed(2);

        if (event.outcome.status === 'success') {
          const message = this.theme.success(`${this.theme.icons.success} sweet success (${seconds}s)`);
          if (spinner) {
            spinner.succeed(message);
          } else {
            this.write(message);
          }
        } else if (event.outcome.status === 'partial_success') {
          const message = this.theme.warn(`${this.theme.icons.success} partial success (${seconds}s)`);
          if (spinner) {
            spinner.succeed(message);
          } else {
            this.write(message);
          }
        } else {
          const detail = event.outcome.timed_out
            ? 'timed out'
            : `exit code ${event.outcome.exit_code ?? 'unknown'}`;
          const message = this.theme.fail(`${this.theme.icons.fail} wilted (${detail})`);
          if (spinner) {
            spinner.fail(message);
          } else {
            this.write(message);
          }
        }

        if (spinner) {
          this.spinners.delete(event.node_id);
        }
        break;
      }
      case 'node_retrying': {
        this.write(
          this.theme.warn(
            `${this.theme.icons.retry} Re-pollinating [${event.node_id}] (attempt ${event.attempt}/${event.max_retries})...`
          )
        );
        break;
      }
      case 'run_completed': {
        const seconds = (event.duration_ms / 1000).toFixed(2);
        this.write(
          this.theme.success(
            `${this.theme.icons.honey} Garden pollinated! ${event.completed_nodes} petals, ${seconds}s total`
          )
        );
        break;
      }
      case 'run_error': {
        this.write(this.theme.fail(`${this.theme.icons.wilted} Pipeline wilted: ${event.message}`));
        break;
      }
      case 'run_interrupted': {
        this.write(this.theme.warn('Saving cocoon...'));
        this.write(
          this.theme.warn(
            `${this.theme.icons.hibernating} Run ${event.run_id} hibernating. Resume with: nectar resume ${event.run_id}`
          )
        );
        break;
      }
      case 'human_question': {
        // Pause any active spinner
        for (const spinner of this.spinners.values()) {
          spinner.stop();
        }
        const choiceLines = event.choices.map((c, i) => {
          const accel = c.accelerator ? ` (${c.accelerator})` : '';
          return `  [${i + 1}] ${c.label}${accel}`;
        });
        const defaultLine = event.default_choice ? `  Default: ${event.default_choice}` : '';
        const timeoutLine = event.timeout_ms ? `  Timeout: ${(event.timeout_ms / 1000).toFixed(0)}s` : '';
        this.write(this.theme.info(`${this.theme.icons.bee} Human gate [${event.node_id}]: ${event.text}`));
        for (const line of choiceLines) {
          this.write(this.theme.info(line));
        }
        if (defaultLine) {
          this.write(this.theme.muted(defaultLine));
        }
        if (timeoutLine) {
          this.write(this.theme.muted(timeoutLine));
        }
        break;
      }
      case 'human_answer': {
        const sourceTag = event.source === 'user' ? '' : ` (${event.source})`;
        this.write(this.theme.success(`${this.theme.icons.success} Selected: ${event.selected_label}${sourceTag}`));
        break;
      }
      case 'parallel_started': {
        this.write(
          this.theme.info(
            `${this.theme.icons.bee} Parallel fan-out [${event.node_id}]: ${event.branch_count} branches (${event.join_policy}, max ${event.max_parallel})`
          )
        );
        break;
      }
      case 'parallel_branch_started': {
        this.write(this.theme.info(`    ${this.theme.icons.node} Branch [${event.branch_id}] starting...`));
        break;
      }
      case 'parallel_branch_completed': {
        const seconds = (event.duration_ms / 1000).toFixed(2);
        if (event.status === 'success' || event.status === 'partial_success') {
          this.write(this.theme.success(`    ${this.theme.icons.success} Branch [${event.branch_id}] ${event.status} (${seconds}s)`));
        } else {
          this.write(this.theme.fail(`    ${this.theme.icons.fail} Branch [${event.branch_id}] ${event.status} (${seconds}s)`));
        }
        break;
      }
      case 'parallel_completed': {
        const seconds = (event.duration_ms / 1000).toFixed(2);
        this.write(
          this.theme.info(
            `${this.theme.icons.bee} Parallel complete [${event.node_id}]: ${event.succeeded}/${event.total_branches} succeeded (${seconds}s) → ${event.status}`
          )
        );
        break;
      }
      case 'agent_session_started': {
        this.write(this.theme.info(`    Agent session started (${event.provider}, ${event.model})`));
        break;
      }
      case 'agent_tool_called': {
        const argSummary = Object.entries(event.arguments)
          .map(([k, v]) => {
            const vs = String(v);
            return `${k}=${vs.length > 40 ? vs.slice(0, 37) + '...' : vs}`;
          })
          .join(', ');
        this.write(this.theme.muted(`    ${event.tool_name}(${argSummary})`));
        break;
      }
      case 'agent_tool_completed': {
        const seconds = (event.duration_ms / 1000).toFixed(2);
        if (event.is_error) {
          this.write(this.theme.fail(`    ${event.tool_name}: error (${seconds}s)`));
        } else {
          this.write(this.theme.muted(`    ${event.tool_name} (${seconds}s)`));
        }
        break;
      }
      case 'agent_loop_detected': {
        this.write(this.theme.fail('    Loop detected — aborting session'));
        break;
      }
      case 'agent_session_completed': {
        const seconds = (event.duration_ms / 1000).toFixed(2);
        this.write(
          this.theme.info(
            `    Agent finished: ${event.turn_count} turns, ${event.tool_call_count} tool calls (${seconds}s)`
          )
        );
        break;
      }
      case 'checkpoint_saved': {
        // Terse: don't spam the user
        break;
      }
      case 'auto_status_applied': {
        this.write(this.theme.warn(`    auto_status applied: ${event.node_id} → success`));
        break;
      }
      case 'edge_selected': {
        break;
      }
      case 'child_run_started': {
        this.write(this.theme.info(`    Child run started: ${event.child_run_id} (${event.child_dotfile})`));
        break;
      }
      case 'child_snapshot_observed': {
        this.write(this.theme.muted(`    Child snapshot: ${event.child_status} node=${event.child_current_node ?? '-'} completed=${event.completed_count} cycle=${event.cycle}`));
        break;
      }
      case 'child_steer_note_written': {
        this.write(this.theme.info(`    Steering note written: ${event.tuple_key}`));
        break;
      }
      case 'run_restarted': {
        this.write(this.theme.warn(`\u{1f504} Run restarting -> [${event.target_node}] (depth ${event.restart_depth})`));
        break;
      }
      case 'tool_hook_blocked': {
        this.write(this.theme.fail(`    Tool call blocked by pre-hook: ${event.tool_name} (exit ${event.hook_exit_code})`));
        break;
      }
      default: {
        break;
      }
    }
  }
}
