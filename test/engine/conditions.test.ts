import { describe, expect, it } from 'vitest';
import { evaluateConditionExpression, validateConditionExpression } from '../../src/engine/conditions.js';

function makeScope(overrides?: {
  outcome?: 'success' | 'failure' | 'partial_success' | 'retry' | 'skipped';
  preferred_label?: string;
  context?: Record<string, string>;
  steps?: Record<string, { status: string; output?: string }>;
  artifacts?: Record<string, string | undefined>;
}) {
  const artifacts = overrides?.artifacts ?? {};
  return {
    outcome: overrides?.outcome ?? 'success',
    preferred_label: overrides?.preferred_label ?? '',
    context: overrides?.context ?? {},
    steps: overrides?.steps ?? {},
    artifacts: {
      has: (key: string) => Object.prototype.hasOwnProperty.call(artifacts, key),
      get: (key: string) => artifacts[key],
    },
  };
}

describe('conditions', () => {
  it('keeps backward compatibility for =, !=, &&, ||, and fail alias', () => {
    const scope = makeScope({
      outcome: 'failure',
      context: { mode: 'fast', retry: 'yes' },
    });

    expect(evaluateConditionExpression('outcome=fail', scope)).toBe(true);
    expect(evaluateConditionExpression('outcome!=success && context.mode=fast', scope)).toBe(true);
    expect(evaluateConditionExpression('context.mode=slow || context.retry=yes', scope)).toBe(true);
  });

  it('evaluates numeric comparisons when both sides are finite numbers', () => {
    const scope = makeScope({ context: { coverage: '85' } });
    expect(evaluateConditionExpression('context.coverage > 80', scope)).toBe(true);
    expect(evaluateConditionExpression('context.coverage <= 80', scope)).toBe(false);
  });

  it('falls back to lexicographic comparison when either side is not a finite number', () => {
    const scope = makeScope({ context: { stage: 'beta' } });
    expect(evaluateConditionExpression('context.stage > "alpha"', scope)).toBe(true);
    expect(evaluateConditionExpression('context.stage < "alpha"', scope)).toBe(false);
  });

  it('resolves steps.<node>.status and steps.<node>.output', () => {
    const scope = makeScope({
      steps: {
        review: { status: 'success', output: 'LGTM approved' },
      },
    });

    expect(evaluateConditionExpression('steps.review.status = "success"', scope)).toBe(true);
    expect(evaluateConditionExpression('steps.review.output CONTAINS "approved"', scope)).toBe(true);
  });

  it('supports artifacts references with EXISTS and value comparisons', () => {
    const scope = makeScope({
      artifacts: {
        report: 'build green',
        empty_alias: undefined,
      },
    });

    expect(evaluateConditionExpression('EXISTS artifacts.report', scope)).toBe(true);
    expect(evaluateConditionExpression('artifacts.report CONTAINS "green"', scope)).toBe(true);
    expect(evaluateConditionExpression('EXISTS artifacts.empty_alias', scope)).toBe(true);
    expect(evaluateConditionExpression('EXISTS artifacts.missing', scope)).toBe(false);
  });

  it('treats missing step output as empty string and EXISTS=false', () => {
    const scope = makeScope({
      steps: {
        review: { status: 'failure' },
      },
    });

    expect(evaluateConditionExpression('steps.review.output = ""', scope)).toBe(true);
    expect(evaluateConditionExpression('EXISTS steps.review.output', scope)).toBe(false);
    expect(evaluateConditionExpression('steps.missing.output = ""', scope)).toBe(true);
  });

  it('supports NOT and parentheses precedence', () => {
    const scope = makeScope({
      outcome: 'success',
      context: { a: '1', b: '0' },
    });

    expect(evaluateConditionExpression('NOT outcome=failure', scope)).toBe(true);
    expect(evaluateConditionExpression('(context.a="1" || context.b="2") && outcome=success', scope)).toBe(true);
  });

  it('supports string matching operators', () => {
    const scope = makeScope({ context: { name: 'test-file.ts' } });
    expect(evaluateConditionExpression('context.name STARTS_WITH "test"', scope)).toBe(true);
    expect(evaluateConditionExpression('context.name ENDS_WITH ".ts"', scope)).toBe(true);
  });

  it('resolves unqualified keys from context', () => {
    const scope = makeScope({ context: { my_flag: 'true' } });
    expect(evaluateConditionExpression('my_flag=true', scope)).toBe(true);
  });

  it('resolves dotted unqualified keys from context', () => {
    const scope = makeScope({ context: { 'build.release_ready': 'yes' } });
    expect(evaluateConditionExpression('build.release_ready=yes', scope)).toBe(true);
  });

  it('keeps reserved roots authoritative over colliding context keys', () => {
    const scope = makeScope({
      outcome: 'success',
      context: {
        outcome: 'failure',
        'steps.review.status': 'success',
      },
      steps: {},
    });

    expect(evaluateConditionExpression('outcome=success', scope)).toBe(true);
    expect(evaluateConditionExpression('outcome=failure', scope)).toBe(false);
    expect(evaluateConditionExpression('steps.review.status=success', scope)).toBe(false);
  });

  it('rejects malformed expressions with position information', () => {
    expect(() => validateConditionExpression('context.coverage >')).toThrow(/position/i);
    expect(() => validateConditionExpression('outcome=success && && context.x=1')).toThrow(/position/i);
    expect(() => validateConditionExpression('EXISTS "report"')).toThrow(/EXISTS/i);
  });
});
