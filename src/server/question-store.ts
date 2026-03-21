import { mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { normalizeAnswer, type Answer, type Question } from '../interviewer/types.js';
import type { StoredQuestionResource } from './types.js';

interface PendingResolution {
  resolve: (answer: Answer) => void;
  reject: (error: Error) => void;
  timeout?: ReturnType<typeof setTimeout>;
}

export class QuestionNotFoundError extends Error {
  constructor(questionId: string) {
    super(`Question '${questionId}' was not found.`);
    this.name = 'QuestionNotFoundError';
  }
}

export class QuestionConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'QuestionConflictError';
  }
}

export class QuestionStore {
  private readonly questionsDir: string;
  private readonly pending = new Map<string, PendingResolution>();

  constructor(runDir: string) {
    this.questionsDir = path.join(runDir, 'questions');
  }

  async initialize(): Promise<void> {
    await mkdir(this.questionsDir, { recursive: true });
  }

  async ask(question: Question, stage = question.node_id): Promise<Answer> {
    const pending = await this.register(question, stage);
    return pending;
  }

  async ask_multiple(questions: Question[], stage = 'batch'): Promise<Answer[]> {
    const pending = await Promise.all(questions.map(async (question) => this.register(question, stage)));
    return Promise.all(pending);
  }

  async listPending(): Promise<StoredQuestionResource[]> {
    await this.initialize();
    const entries = await readdir(this.questionsDir, { withFileTypes: true });
    const pending: StoredQuestionResource[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) {
        continue;
      }
      const record = await this.readQuestion(entry.name.replace(/\.json$/, ''));
      if (record && record.status === 'pending') {
        pending.push(record);
      }
    }
    pending.sort((a, b) => a.created_at.localeCompare(b.created_at));
    return pending;
  }

  async submitAnswer(
    questionId: string,
    input: string | (Partial<Answer> & { selected_label?: string; selected_option?: number | string; text?: string }),
    source: Answer['source'] = 'user'
  ): Promise<StoredQuestionResource> {
    const record = await this.readQuestion(questionId);
    if (!record) {
      throw new QuestionNotFoundError(questionId);
    }

    if (record.status !== 'pending') {
      throw new QuestionConflictError(
        `Question '${questionId}' is already ${record.status} and cannot accept another answer.`
      );
    }

    const resolution = this.pending.get(questionId);
    if (!resolution) {
      throw new QuestionConflictError(
        `Question '${questionId}' is not currently awaiting an in-process answer.`
      );
    }

    if (resolution.timeout) {
      clearTimeout(resolution.timeout);
    }

    const answerInput = typeof input === 'string'
      ? { selected_label: input, source }
      : { ...input, source: input.source ?? source };
    const normalizedAnswer = normalizeAnswer(toQuestion(record), answerInput, answerInput.source);

    const now = new Date().toISOString();
    const answered: StoredQuestionResource = {
      ...record,
      status: 'answered',
      updated_at: now,
      answered_at: now,
      answer: normalizedAnswer,
    };
    await this.writeQuestion(answered);

    this.pending.delete(questionId);
    resolution.resolve(normalizedAnswer);
    return answered;
  }

  async close(reason = 'Question store closed'): Promise<void> {
    for (const [questionId, pending] of this.pending) {
      if (pending.timeout) {
        clearTimeout(pending.timeout);
      }
      pending.reject(new Error(reason));
      this.pending.delete(questionId);
      try {
        const record = await this.readQuestion(questionId);
        if (record && record.status === 'pending') {
          const now = new Date().toISOString();
          await this.writeQuestion({
            ...record,
            status: 'timed_out',
            updated_at: now,
          });
        }
      } catch {
        // best-effort
      }
    }
  }

  private async register(question: Question, stage: string): Promise<Promise<Answer>> {
    await this.initialize();

    const now = new Date().toISOString();
    const record: StoredQuestionResource = {
      question_id: question.id,
      run_id: question.run_id,
      node_id: question.node_id,
      stage,
      text: question.text,
      choices: (question.choices ?? []).map((choice) => ({
        label: choice.label,
        accelerator: choice.accelerator,
        edge_target: choice.edge_target,
      })),
      default_choice: question.default_choice,
      timeout_ms: question.timeout_ms,
      status: 'pending',
      created_at: now,
      updated_at: now,
    };
    await this.writeQuestion(record);

    return new Promise<Answer>((resolve, reject) => {
      const pending: PendingResolution = { resolve, reject };
      this.pending.set(question.id, pending);

      if (question.timeout_ms && question.timeout_ms > 0) {
        pending.timeout = setTimeout(() => {
          void this.onTimeout(question.id, question.default_choice);
        }, question.timeout_ms);
      }
    });
  }

  private async onTimeout(questionId: string, defaultChoice?: string): Promise<void> {
    const resolution = this.pending.get(questionId);
    if (!resolution) {
      return;
    }

    const record = await this.readQuestion(questionId);
    if (!record || record.status !== 'pending') {
      this.pending.delete(questionId);
      return;
    }

    const now = new Date().toISOString();
    const timedOutAnswer = defaultChoice
      ? normalizeAnswer(
          toQuestion(record),
          { selected_label: defaultChoice, source: 'timeout' },
          'timeout',
        )
      : undefined;
    const timedOut: StoredQuestionResource = {
      ...record,
      status: 'timed_out',
      updated_at: now,
      answer: timedOutAnswer,
    };
    await this.writeQuestion(timedOut);

    this.pending.delete(questionId);
    if (timedOutAnswer) {
      resolution.resolve(timedOutAnswer);
      return;
    }

    resolution.reject(new Error('Human input timed out with no default choice.'));
  }

  private questionPath(questionId: string): string {
    return path.join(this.questionsDir, `${questionId}.json`);
  }

  private async readQuestion(questionId: string): Promise<StoredQuestionResource | null> {
    try {
      const raw = await readFile(this.questionPath(questionId), 'utf8');
      return JSON.parse(raw) as StoredQuestionResource;
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code === 'ENOENT') {
        return null;
      }
      throw error;
    }
  }

  private async writeQuestion(record: StoredQuestionResource): Promise<void> {
    await this.initialize();
    const targetPath = this.questionPath(record.question_id);
    const tempPath = `${targetPath}.${process.pid}.${Date.now()}.tmp`;
    const payload = `${JSON.stringify(record, null, 2)}\n`;
    await writeFile(tempPath, payload, 'utf8');
    try {
      await rename(tempPath, targetPath);
    } catch (error) {
      try {
        await unlink(tempPath);
      } catch {
        // ignore cleanup errors
      }
      throw error;
    }
  }
}

export type StoredQuestion = StoredQuestionResource;

function toQuestion(resource: StoredQuestionResource): Question {
  return {
    id: resource.question_id,
    type: resource.choices.length > 0 ? 'MULTIPLE_CHOICE' : 'FREEFORM',
    text: resource.text,
    choices: resource.choices.map((choice) => ({
      label: choice.label,
      accelerator: choice.accelerator,
      edge_target: choice.edge_target ?? '',
    })),
    default_choice: resource.default_choice,
    timeout_ms: resource.timeout_ms,
    node_id: resource.node_id,
    run_id: resource.run_id,
  };
}
