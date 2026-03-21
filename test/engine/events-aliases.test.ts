import { describe, expect, it } from 'vitest';
import {
  ENGINE_EVENT_NAME_ALIASES,
  toPascalCaseEventName,
  toSnakeCaseEventName,
} from '../../src/engine/events.js';

describe('engine event aliases (A4)', () => {
  it('includes PascalCase aliases for snake_case engine events', () => {
    expect(ENGINE_EVENT_NAME_ALIASES.run_started).toBe('RunStarted');
    expect(ENGINE_EVENT_NAME_ALIASES.node_completed).toBe('NodeCompleted');
    expect(ENGINE_EVENT_NAME_ALIASES.pipeline_failed).toBe('PipelineFailed');
  });

  it('resolves names in both directions', () => {
    expect(toPascalCaseEventName('run_error')).toBe('RunError');
    expect(toSnakeCaseEventName('RunError')).toBe('run_error');
    expect(toSnakeCaseEventName('run_error')).toBe('run_error');
    expect(toSnakeCaseEventName('NotARealEvent')).toBeUndefined();
  });
});
