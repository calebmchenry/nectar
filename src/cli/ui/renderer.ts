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
        this.write(`${this.theme.icons.bee} Pollinator buzzing...`);
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
        } else {
          const code = event.outcome.exit_code ?? 'unknown';
          const message = this.theme.fail(`${this.theme.icons.fail} wilted (exit code ${code})`);
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
            `${this.theme.icons.hibernating} Run ${event.run_id} hibernating. Resume with: pollinator resume ${event.run_id}`
          )
        );
        break;
      }
      case 'edge_selected': {
        break;
      }
      default: {
        break;
      }
    }
  }
}
