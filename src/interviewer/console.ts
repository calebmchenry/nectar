import { createInterface } from 'node:readline';
import { Answer, Interviewer, Question, askSequentially, normalizeAnswer } from './types.js';

export class ConsoleInterviewer implements Interviewer {
  async ask(question: Question): Promise<Answer> {
    // Non-TTY guard: select default_choice or fail immediately
    if (!process.stdin.isTTY) {
      if (question.default_choice) {
        return normalizeAnswer(question, { selected_label: question.default_choice, source: 'auto' }, 'auto');
      }
      throw new Error('Human input required but no TTY available.');
    }

    const choices = question.choices ?? [];
    const prompt = this.buildPrompt(question);

    return new Promise<Answer>((resolve, reject) => {
      const rl = createInterface({
        input: process.stdin,
        output: process.stderr,
        terminal: false
      });

      let timeoutId: ReturnType<typeof setTimeout> | undefined;
      let resolved = false;

      const cleanup = () => {
        if (timeoutId) {
          clearTimeout(timeoutId);
        }
        rl.close();
      };

      const finish = (answer: Answer) => {
        if (resolved) return;
        resolved = true;
        cleanup();
        resolve(answer);
      };

      // Set up timeout
      if (question.timeout_ms && question.timeout_ms > 0) {
        timeoutId = setTimeout(() => {
          if (resolved) return;
          if (question.default_choice) {
            finish(normalizeAnswer(question, { selected_label: question.default_choice, source: 'timeout' }, 'timeout'));
          } else {
            resolved = true;
            cleanup();
            reject(new Error('Human input timed out with no default choice.'));
          }
        }, question.timeout_ms);
      }

      // Write prompt to stderr (not stdout, to avoid polluting piped output)
      process.stderr.write(prompt);

      rl.on('line', (line) => {
        if (resolved) return;
        const input = line.trim();
        if (!input) return;

        if (question.type === 'FREEFORM' || choices.length === 0) {
          finish(normalizeAnswer(question, { selected_label: input, text: input, source: 'user' }, 'user'));
          return;
        }

        // Try matching by number
        const num = parseInt(input, 10);
        if (!isNaN(num) && num >= 1 && num <= choices.length) {
          const choice = choices[num - 1]!;
          finish(normalizeAnswer(
            question,
            { selected_label: choice.label, selected_option: num - 1, source: 'user' },
            'user',
          ));
          return;
        }

        // Try matching by accelerator key (case-insensitive)
        const upperInput = input.toUpperCase();
        const accelMatch = choices.find((c) => c.accelerator && c.accelerator.toUpperCase() === upperInput);
        if (accelMatch) {
          finish(normalizeAnswer(
            question,
            { selected_label: accelMatch.label, selected_option: choices.indexOf(accelMatch), source: 'user' },
            'user',
          ));
          return;
        }

        // Try matching by full label (case-insensitive)
        const labelMatch = choices.find((c) => c.label.toLowerCase() === input.toLowerCase());
        if (labelMatch) {
          finish(normalizeAnswer(
            question,
            { selected_label: labelMatch.label, selected_option: choices.indexOf(labelMatch), source: 'user' },
            'user',
          ));
          return;
        }

        // No match — prompt again
        process.stderr.write(`Invalid choice: "${input}". Please try again.\n`);
      });

      rl.on('close', () => {
        if (!resolved) {
          resolved = true;
          if (question.default_choice) {
            resolve(normalizeAnswer(question, { selected_label: question.default_choice, source: 'auto' }, 'auto'));
          } else {
            reject(new Error('stdin closed before a choice was made.'));
          }
        }
      });
    });
  }

  ask_multiple(questions: Question[]): Promise<Answer[]> {
    return askSequentially(this, questions);
  }

  inform(message: string, stage: string): void {
    process.stderr.write(`[${stage}] ${message}\n`);
  }

  private buildPrompt(question: Question): string {
    const lines: string[] = [];
    lines.push(`\n${question.text}\n`);

    const choices = question.choices ?? [];
    for (let i = 0; i < choices.length; i++) {
      const choice = choices[i]!;
      const accel = choice.accelerator ? ` (${choice.accelerator})` : '';
      lines.push(`  [${i + 1}] ${choice.label}${accel}`);
    }

    if (question.default_choice) {
      lines.push(`  Default: ${question.default_choice}`);
    }
    if (question.timeout_ms) {
      lines.push(`  Timeout: ${(question.timeout_ms / 1000).toFixed(0)}s`);
    }

    lines.push('\nYour choice: ');
    return lines.join('\n');
  }
}
