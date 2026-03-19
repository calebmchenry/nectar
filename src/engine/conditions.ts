export type OutcomeStatus = 'success' | 'failure';

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

type Term = OutcomeTerm | ContextTerm;

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

  if (input.startsWith('outcome=')) {
    const raw = input.slice('outcome='.length).trim().toLowerCase();
    if (raw === 'success') {
      return { type: 'outcome', value: 'success' };
    }
    if (raw === 'fail' || raw === 'failure') {
      return { type: 'outcome', value: 'failure' };
    }
    throw new ConditionSyntaxError(`Unsupported outcome '${raw}'. Expected success or fail.`);
  }

  if (input.startsWith('context.')) {
    const equalsIndex = input.indexOf('=');
    if (equalsIndex === -1) {
      throw new ConditionSyntaxError(`Missing '=' in context condition '${input}'.`);
    }

    const key = input.slice('context.'.length, equalsIndex).trim();
    if (!key) {
      throw new ConditionSyntaxError(`Missing context key in '${input}'.`);
    }

    const rawValue = input.slice(equalsIndex + 1).trim();
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

  const current = scope.context[term.key];
  return current === term.value;
}

function stripQuotes(value: string): string {
  if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
    return value.slice(1, -1);
  }
  return value;
}
