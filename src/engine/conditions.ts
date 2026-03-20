export type OutcomeStatus = 'success' | 'failure' | 'partial_success' | 'retry' | 'skipped';

export interface ConditionScope {
  outcome: OutcomeStatus;
  context: Record<string, string>;
}

interface OutcomeTerm {
  type: 'outcome';
  value: OutcomeStatus;
}

interface ContextTerm {
  type: 'context';
  key: string;
  value: string;
}

interface OutcomeNotEqualTerm {
  type: 'outcome_ne';
  value: OutcomeStatus;
}

interface ContextNotEqualTerm {
  type: 'context_ne';
  key: string;
  value: string;
}

type Term = OutcomeTerm | ContextTerm | OutcomeNotEqualTerm | ContextNotEqualTerm;

interface AndNode {
  type: 'and';
  terms: Term[];
}

interface OrNode {
  type: 'or';
  clauses: AndNode[];
}

export class ConditionSyntaxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConditionSyntaxError';
  }
}

export function validateConditionExpression(expression: string): void {
  parseConditionExpression(expression);
}

export function evaluateConditionExpression(expression: string, scope: ConditionScope): boolean {
  const parsed = parseConditionExpression(expression);
  return parsed.clauses.some((clause) => clause.terms.every((term) => evaluateTerm(term, scope)));
}

function parseConditionExpression(expression: string): OrNode {
  const trimmed = expression.trim();
  if (!trimmed) {
    throw new ConditionSyntaxError('Condition expression is empty.');
  }

  if (trimmed.includes('(') || trimmed.includes(')')) {
    throw new ConditionSyntaxError('Parentheses are not supported in this sprint.');
  }

  const orParts = splitByOperator(trimmed, '||');
  const clauses: AndNode[] = orParts.map((part) => {
    const andParts = splitByOperator(part, '&&');
    const terms = andParts.map((term) => parseTerm(term.trim()));
    if (terms.length === 0) {
      throw new ConditionSyntaxError('Condition contains an empty clause.');
    }
    return { type: 'and', terms };
  });

  if (clauses.length === 0) {
    throw new ConditionSyntaxError('Condition contains no clauses.');
  }

  return { type: 'or', clauses };
}

function splitByOperator(input: string, operator: '&&' | '||'): string[] {
  const parts: string[] = [];
  let cursor = '';
  let inQuote = false;
  let escaped = false;

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    const next = input[index + 1];

    if (inQuote) {
      cursor += char;
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inQuote = false;
      }
      continue;
    }

    if (char === '"') {
      inQuote = true;
      cursor += char;
      continue;
    }

    if (char === operator[0] && next === operator[1]) {
      const piece = cursor.trim();
      if (!piece) {
        throw new ConditionSyntaxError(`Invalid condition near '${operator}'.`);
      }
      parts.push(piece);
      cursor = '';
      index += 1;
      continue;
    }

    cursor += char;
  }

  const final = cursor.trim();
  if (!final) {
    throw new ConditionSyntaxError(`Condition cannot end with '${operator}'.`);
  }
  parts.push(final);

  return parts;
}

function parseTerm(input: string): Term {
  if (!input) {
    throw new ConditionSyntaxError('Condition contains an empty term.');
  }

  if (input.startsWith('outcome!=')) {
    const raw = input.slice('outcome!='.length).trim().toLowerCase();
    if (raw === 'success') {
      return { type: 'outcome_ne', value: 'success' };
    }
    if (raw === 'fail' || raw === 'failure') {
      return { type: 'outcome_ne', value: 'failure' };
    }
    if (raw === 'partial_success') {
      return { type: 'outcome_ne', value: 'partial_success' };
    }
    if (raw === 'retry') {
      return { type: 'outcome_ne', value: 'retry' };
    }
    if (raw === 'skipped') {
      return { type: 'outcome_ne', value: 'skipped' };
    }
    throw new ConditionSyntaxError(`Unsupported outcome '${raw}'.`);
  }

  if (input.startsWith('outcome=')) {
    const raw = input.slice('outcome='.length).trim().toLowerCase();
    if (raw === 'success') {
      return { type: 'outcome', value: 'success' };
    }
    if (raw === 'fail' || raw === 'failure') {
      return { type: 'outcome', value: 'failure' };
    }
    if (raw === 'partial_success') {
      return { type: 'outcome', value: 'partial_success' };
    }
    if (raw === 'retry') {
      return { type: 'outcome', value: 'retry' };
    }
    if (raw === 'skipped') {
      return { type: 'outcome', value: 'skipped' };
    }
    throw new ConditionSyntaxError(`Unsupported outcome '${raw}'. Expected success, fail, partial_success, retry, or skipped.`);
  }

  // GAP-16: preferred_label as a condition variable
  if (input.startsWith('preferred_label!=')) {
    const value = input.slice('preferred_label!='.length).trim();
    if (!value) {
      throw new ConditionSyntaxError(`Missing value in '${input}'.`);
    }
    return { type: 'context_ne', key: 'preferred_label', value: stripQuotes(value) };
  }

  if (input.startsWith('preferred_label=')) {
    const value = input.slice('preferred_label='.length).trim();
    if (!value) {
      throw new ConditionSyntaxError(`Missing value in '${input}'.`);
    }
    return { type: 'context', key: 'preferred_label', value: stripQuotes(value) };
  }

  if (input.startsWith('context.')) {
    const neIndex = input.indexOf('!=');
    const eqIndex = input.indexOf('=');

    if (neIndex !== -1 && (eqIndex === -1 || neIndex < eqIndex)) {
      const key = input.slice('context.'.length, neIndex).trim();
      if (!key) {
        throw new ConditionSyntaxError(`Missing context key in '${input}'.`);
      }
      const rawValue = input.slice(neIndex + 2).trim();
      if (!rawValue) {
        throw new ConditionSyntaxError(`Missing context value in '${input}'.`);
      }
      return { type: 'context_ne', key, value: stripQuotes(rawValue) };
    }

    if (eqIndex === -1) {
      throw new ConditionSyntaxError(`Missing '=' in context condition '${input}'.`);
    }

    const key = input.slice('context.'.length, eqIndex).trim();
    if (!key) {
      throw new ConditionSyntaxError(`Missing context key in '${input}'.`);
    }

    const rawValue = input.slice(eqIndex + 1).trim();
    if (!rawValue) {
      throw new ConditionSyntaxError(`Missing context value in '${input}'.`);
    }

    return {
      type: 'context',
      key,
      value: stripQuotes(rawValue)
    };
  }

  throw new ConditionSyntaxError(`Unsupported condition term '${input}'.`);
}

function evaluateTerm(term: Term, scope: ConditionScope): boolean {
  if (term.type === 'outcome') {
    return scope.outcome === term.value;
  }

  if (term.type === 'outcome_ne') {
    return scope.outcome !== term.value;
  }

  if (term.type === 'context_ne') {
    const current = scope.context[term.key];
    return current !== term.value;
  }

  const current = scope.context[term.key];
  return current === term.value;
}

function stripQuotes(value: string): string {
  if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
    return value.slice(1, -1);
  }
  return value;
}
