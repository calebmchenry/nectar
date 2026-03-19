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

  it('rejects unsupported syntax', () => {
    expect(() => evaluateConditionExpression('(outcome=success)', { outcome: 'success', context: {} })).toThrow(
      /Parentheses/
    );
    expect(() => evaluateConditionExpression('context.=value', { outcome: 'success', context: {} })).toThrow(
      /Missing context key/
    );
  });
});
