export type QuestionType = 'YES_NO' | 'MULTIPLE_CHOICE' | 'FREEFORM' | 'CONFIRMATION';

export interface Choice {
  label: string;
  accelerator?: string;
  edge_target: string;
}

export interface Question {
  id: string;
  type: QuestionType;
  text: string;
  choices?: Choice[];
  default_choice?: string;
  timeout_ms?: number;
  node_id: string;
  run_id: string;
}

export enum AnswerValue {
  YES = 'YES',
  NO = 'NO',
  SKIPPED = 'SKIPPED',
  TIMEOUT = 'TIMEOUT',
}

export type AnswerSource = 'user' | 'timeout' | 'auto' | 'queue' | 'queue_exhausted';

export interface Answer {
  selected_label: string;
  source: AnswerSource;
  answer_value?: AnswerValue;
  selected_option?: number;
  text?: string;
}

export interface Interviewer {
  ask(question: Question): Promise<Answer>;
  ask_multiple(questions: Question[]): Promise<Answer[]>;
  inform(message: string, stage: string): Promise<void> | void;
}

export async function askSequentially(
  interviewer: Pick<Interviewer, 'ask'>,
  questions: Question[]
): Promise<Answer[]> {
  const answers: Answer[] = [];
  for (const question of questions) {
    answers.push(await interviewer.ask(question));
  }
  return answers;
}

/**
 * Parse accelerator key from a label.
 * Patterns: [X] Rest, X) Rest, X - Rest where X is a single alphanumeric character.
 */
export function parseAccelerator(label: string): { accelerator: string | null; cleanLabel: string } {
  // [X] prefix — single alphanumeric char in brackets
  const bracketMatch = label.match(/^\[([A-Za-z0-9])\]\s*(.*)/);
  if (bracketMatch) {
    return { accelerator: bracketMatch[1]!.toUpperCase(), cleanLabel: bracketMatch[2]!.trim() };
  }

  // X) prefix — single alphanumeric char followed by )
  const parenMatch = label.match(/^([A-Za-z0-9])\)\s*(.*)/);
  if (parenMatch) {
    return { accelerator: parenMatch[1]!.toUpperCase(), cleanLabel: parenMatch[2]!.trim() };
  }

  // X - prefix — single alphanumeric char followed by space-dash-space
  const dashMatch = label.match(/^([A-Za-z0-9])\s+-\s+(.*)/);
  if (dashMatch) {
    return { accelerator: dashMatch[1]!.toUpperCase(), cleanLabel: dashMatch[2]!.trim() };
  }

  return { accelerator: null, cleanLabel: label };
}

function normalizeChoiceLabel(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function toAnswerValue(value: unknown): AnswerValue | undefined {
  if (value === AnswerValue.YES || value === AnswerValue.NO || value === AnswerValue.SKIPPED || value === AnswerValue.TIMEOUT) {
    return value;
  }
  return undefined;
}

function inferChoiceValueFromNormalizedLabel(normalized: string): AnswerValue | undefined {
  if (!normalized) {
    return undefined;
  }

  if (normalized === 'yes' || normalized === 'y' || normalized === 'approve' || normalized === 'approved' || normalized === 'true') {
    return AnswerValue.YES;
  }
  if (normalized === 'no' || normalized === 'n' || normalized === 'reject' || normalized === 'rejected' || normalized === 'false') {
    return AnswerValue.NO;
  }
  if (normalized === 'skipped' || normalized === 'skip') {
    return AnswerValue.SKIPPED;
  }
  if (normalized === 'timeout' || normalized === 'timedout') {
    return AnswerValue.TIMEOUT;
  }

  return undefined;
}

export function inferAnswerValueFromLabel(label: string | undefined): AnswerValue | undefined {
  if (!label) {
    return undefined;
  }
  return inferChoiceValueFromNormalizedLabel(normalizeChoiceLabel(label));
}

function parseSelectedOption(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0) {
    return value;
  }
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
    return Number.parseInt(value.trim(), 10);
  }
  return undefined;
}

function resolveSelectedOption(question: Question, selectedLabel: string): number | undefined {
  if (!question.choices || question.choices.length === 0 || !selectedLabel) {
    return undefined;
  }
  const normalized = normalizeChoiceLabel(selectedLabel);
  const index = question.choices.findIndex((choice) => normalizeChoiceLabel(choice.label) === normalized);
  return index >= 0 ? index : undefined;
}

export function normalizeAnswer(
  question: Question,
  answer: Partial<Answer> & {
    selected_label?: string;
    selected_option?: number | string;
    text?: string;
    source?: AnswerSource;
  },
  fallbackSource: AnswerSource = 'user',
): Answer {
  const source = answer.source ?? fallbackSource;
  const explicitText = typeof answer.text === 'string' ? answer.text : undefined;

  let selectedOption = parseSelectedOption(answer.selected_option);
  if (selectedOption !== undefined && (!question.choices || selectedOption < 0 || selectedOption >= question.choices.length)) {
    selectedOption = undefined;
  }

  let selectedLabel = typeof answer.selected_label === 'string' ? answer.selected_label.trim() : '';
  if (!selectedLabel && selectedOption !== undefined && question.choices) {
    selectedLabel = question.choices[selectedOption]?.label ?? '';
  }
  if (!selectedLabel && question.type === 'FREEFORM' && explicitText && explicitText.trim().length > 0) {
    selectedLabel = explicitText.trim();
  }
  if (!selectedLabel && source === 'timeout' && question.default_choice) {
    selectedLabel = question.default_choice;
  }

  if (selectedOption === undefined) {
    selectedOption = resolveSelectedOption(question, selectedLabel);
  }

  let answerValue = toAnswerValue(answer.answer_value);
  if (!answerValue) {
    if (source === 'timeout') {
      answerValue = AnswerValue.TIMEOUT;
    } else if (source === 'queue_exhausted') {
      answerValue = AnswerValue.SKIPPED;
    } else if (question.type === 'YES_NO' && selectedOption !== undefined && question.choices) {
      const label = question.choices[selectedOption]?.label;
      answerValue = inferAnswerValueFromLabel(label);
    } else {
      answerValue = inferAnswerValueFromLabel(selectedLabel) ?? inferAnswerValueFromLabel(explicitText);
    }
  }

  if (!selectedLabel && answerValue === AnswerValue.SKIPPED) {
    selectedLabel = 'SKIPPED';
  }

  const text = explicitText && explicitText.trim().length > 0
    ? explicitText.trim()
    : (question.type === 'FREEFORM' && selectedLabel ? selectedLabel : undefined);

  return {
    selected_label: selectedLabel,
    source,
    answer_value: answerValue,
    selected_option: selectedOption,
    text,
  };
}
