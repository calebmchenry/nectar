import { describe, expect, it } from 'vitest';
import { evaluateConditionExpression } from '../../src/engine/conditions.js';

describe('conditions', () => {
  it('evaluates outcome conditions', () => {
    expect(evaluateConditionExpression('outcome=success', { outcome: 'success', context: {} })).toBe(true);
    expect(evaluateConditionExpression('outcome=fail', { outcome: 'failure', context: {} })).toBe(true);
    expect(evaluateConditionExpression('outcome=success', { outcome: 'failure', context: {} })).toBe(false);
  });

  it('evaluates context conditions', () => {
    expect(
      evaluateConditionExpression('context.mode=fast && outcome=success', {
        outcome: 'success',
        context: { mode: 'fast' }
      })
    ).toBe(true);

    expect(
      evaluateConditionExpression('context.mode=slow || context.retry=yes', {
        outcome: 'success',
        context: { retry: 'yes' }
      })
    ).toBe(true);
  });

  it('evaluates != operator for outcomes', () => {
    expect(evaluateConditionExpression('outcome!=success', { outcome: 'failure', context: {} })).toBe(true);
    expect(evaluateConditionExpression('outcome!=success', { outcome: 'success', context: {} })).toBe(false);
    expect(evaluateConditionExpression('outcome!=failure', { outcome: 'success', context: {} })).toBe(true);
  });

  it('evaluates != operator for context', () => {
    expect(
      evaluateConditionExpression('context.status!=done', {
        outcome: 'success',
        context: { status: 'pending' }
      })
    ).toBe(true);

    expect(
      evaluateConditionExpression('context.status!=done', {
        outcome: 'success',
        context: { status: 'done' }
      })
    ).toBe(false);
  });

  it('evaluates extended outcome statuses', () => {
    expect(evaluateConditionExpression('outcome=partial_success', { outcome: 'partial_success', context: {} })).toBe(true);
    expect(evaluateConditionExpression('outcome=retry', { outcome: 'retry', context: {} })).toBe(true);
    expect(evaluateConditionExpression('outcome=skipped', { outcome: 'skipped', context: {} })).toBe(true);
  });

  it('rejects unsupported syntax', () => {
    expect(() => evaluateConditionExpression('(outcome=success)', { outcome: 'success', context: {} })).toThrow(
      /Parentheses/
    );
    expect(() => evaluateConditionExpression('context.=value', { outcome: 'success', context: {} })).toThrow(
      /Missing context key/
    );
  });
});
