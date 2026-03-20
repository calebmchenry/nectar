export type QuestionType = 'YES_NO' | 'MULTIPLE_CHOICE' | 'FREEFORM' | 'CONFIRMATION';

export interface Choice {
  label: string;
  accelerator?: string;
  edge_target: string;
}

export interface Question {
  type: QuestionType;
  text: string;
  choices?: Choice[];
  default_choice?: string;
  timeout_ms?: number;
  node_id: string;
  run_id: string;
}

export interface Answer {
  selected_label: string;
  source: 'user' | 'timeout' | 'auto' | 'queue';
}

export interface Interviewer {
  ask(question: Question): Promise<Answer>;
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
