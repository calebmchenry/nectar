import {
  BinaryOp,
  ConditionExpr,
  ConditionSyntaxError,
  collectVariableReferences,
  parseConditionExpression,
} from './condition-parser.js';

export type OutcomeStatus = 'success' | 'failure' | 'partial_success' | 'retry' | 'skipped';

export interface ConditionScope {
  outcome: OutcomeStatus;
  preferred_label?: string;
  context: Record<string, string>;
  steps?: Record<string, { status: string; output?: string }>;
  artifacts?: { has(key: string): boolean; get(key: string): string | undefined };
}

interface ResolvedValue {
  defined: boolean;
  value: string;
}

type EvaluatedValue =
  | { kind: 'string'; value: string }
  | { kind: 'boolean'; value: boolean };

export { ConditionSyntaxError };

export function parseConditionAst(expression: string): ConditionExpr {
  const trimmed = expression.trim();
  if (!trimmed) {
    throw new ConditionSyntaxError('Condition expression is empty.', 0);
  }
  const ast = parseConditionExpression(trimmed);
  if (ast.type === 'literal' || ast.type === 'variable') {
    throw new ConditionSyntaxError('Condition expression must include an operator.', 0);
  }
  return ast;
}

export function validateConditionExpression(expression: string): void {
  parseConditionAst(expression);
}

export function evaluateConditionExpression(expression: string, scope: ConditionScope): boolean {
  const trimmed = expression.trim();
  if (!trimmed) {
    return true;
  }

  const ast = parseConditionAst(trimmed);
  return evaluateConditionAst(ast, scope);
}

export function evaluateConditionAst(ast: ConditionExpr, scope: ConditionScope): boolean {
  return toBoolean(evaluateNode(ast, scope));
}

export function collectConditionVariablePaths(expression: string): string[][] {
  const ast = parseConditionAst(expression);
  return collectVariableReferences(ast).map((ref) => ref.path);
}

function evaluateNode(node: ConditionExpr, scope: ConditionScope): EvaluatedValue {
  if (node.type === 'literal') {
    return { kind: 'string', value: node.value };
  }

  if (node.type === 'variable') {
    const resolved = resolveVariable(node.path, scope);
    return { kind: 'string', value: resolved.value };
  }

  if (node.type === 'unary') {
    if (node.op === 'NOT') {
      return { kind: 'boolean', value: !toBoolean(evaluateNode(node.operand, scope)) };
    }

    if (node.operand.type !== 'variable') {
      return { kind: 'boolean', value: false };
    }

    if (node.operand.path[0] === 'artifacts') {
      const key = node.operand.path.slice(1).join('.');
      return { kind: 'boolean', value: key.length > 0 && (scope.artifacts?.has(key) ?? false) };
    }

    const resolved = resolveVariable(node.operand.path, scope);
    return { kind: 'boolean', value: resolved.defined && resolved.value.trim().length > 0 };
  }

  if (node.type === 'binary') {
    const left = toComparableString(evaluateNode(node.left, scope));
    const right = toComparableString(evaluateNode(node.right, scope));
    const normalizeOutcomeEquality = isOutcomeVariable(node.left) || isOutcomeVariable(node.right);
    return {
      kind: 'boolean',
      value: evaluateBinary(node.op, left, right, normalizeOutcomeEquality),
    };
  }

  if (node.op === '&&') {
    for (const child of node.children) {
      if (!toBoolean(evaluateNode(child, scope))) {
        return { kind: 'boolean', value: false };
      }
    }
    return { kind: 'boolean', value: true };
  }

  for (const child of node.children) {
    if (toBoolean(evaluateNode(child, scope))) {
      return { kind: 'boolean', value: true };
    }
  }
  return { kind: 'boolean', value: false };
}

function resolveVariable(path: string[], scope: ConditionScope): ResolvedValue {
  const root = path[0];
  if (!root) {
    return { defined: false, value: '' };
  }

  if (root === 'outcome' && path.length === 1) {
    return { defined: true, value: scope.outcome };
  }

  if (root === 'preferred_label' && path.length === 1) {
    const fallback = scope.context['preferred_label'];
    return {
      defined: scope.preferred_label !== undefined || fallback !== undefined,
      value: scope.preferred_label ?? fallback ?? '',
    };
  }

  if (root === 'context') {
    const key = path.slice(1).join('.');
    if (!key) {
      return { defined: false, value: '' };
    }

    const hasKey = Object.prototype.hasOwnProperty.call(scope.context, key);
    return {
      defined: hasKey,
      value: hasKey ? scope.context[key] ?? '' : '',
    };
  }

  if (root === 'steps') {
    if (path.length < 3) {
      return { defined: false, value: '' };
    }

    const step = scope.steps?.[path[1]!];
    if (!step) {
      return { defined: false, value: '' };
    }

    const field = path.slice(2).join('.');
    if (field === 'status') {
      return {
        defined: step.status !== undefined,
        value: step.status ?? '',
      };
    }

    if (field === 'output') {
      return {
        defined: true,
        value: step.output ?? '',
      };
    }

    return { defined: false, value: '' };
  }

  if (root === 'artifacts') {
    const key = path.slice(1).join('.');
    if (!key || !scope.artifacts) {
      return { defined: false, value: '' };
    }

    const exists = scope.artifacts.has(key);
    const value = exists ? scope.artifacts.get(key) : undefined;
    return {
      defined: exists,
      value: value ?? '',
    };
  }

  return { defined: false, value: '' };
}

function evaluateBinary(op: BinaryOp, left: string, right: string, normalizeOutcomeEquality: boolean): boolean {
  if (op === '=') {
    if (normalizeOutcomeEquality) {
      return normalizeEqualityOperand(left) === normalizeEqualityOperand(right);
    }
    return left === right;
  }

  if (op === '!=') {
    if (normalizeOutcomeEquality) {
      return normalizeEqualityOperand(left) !== normalizeEqualityOperand(right);
    }
    return left !== right;
  }

  if (op === 'CONTAINS') {
    return left.includes(right);
  }

  if (op === 'STARTS_WITH') {
    return left.startsWith(right);
  }

  if (op === 'ENDS_WITH') {
    return left.endsWith(right);
  }

  const comparison = compareValues(left, right);
  if (op === '<') {
    return comparison < 0;
  }
  if (op === '>') {
    return comparison > 0;
  }
  if (op === '<=') {
    return comparison <= 0;
  }
  return comparison >= 0;
}

function compareValues(left: string, right: string): number {
  const leftNumber = Number(left);
  const rightNumber = Number(right);

  if (!Number.isFinite(leftNumber) || !Number.isFinite(rightNumber)) {
    return left.localeCompare(right);
  }

  if (leftNumber === rightNumber) {
    return 0;
  }
  return leftNumber < rightNumber ? -1 : 1;
}

function toBoolean(value: EvaluatedValue): boolean {
  if (value.kind === 'boolean') {
    return value.value;
  }
  return value.value.length > 0;
}

function toComparableString(value: EvaluatedValue): string {
  if (value.kind === 'boolean') {
    return value.value ? 'true' : 'false';
  }
  return value.value;
}

function normalizeEqualityOperand(value: string): string {
  const normalizedOutcome = normalizeOutcomeValue(value);
  return normalizedOutcome ?? value;
}

function normalizeOutcomeValue(value: string): string | null {
  const lowered = value.toLowerCase();
  if (lowered === 'fail' || lowered === 'failure') {
    return 'failure';
  }
  if (lowered === 'success' || lowered === 'partial_success' || lowered === 'retry' || lowered === 'skipped') {
    return lowered;
  }
  return null;
}

function isOutcomeVariable(expression: ConditionExpr): boolean {
  return expression.type === 'variable'
    && expression.path.length === 1
    && expression.path[0] === 'outcome';
}
