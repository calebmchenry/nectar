import { describe, expect, it } from 'vitest';
import {
  DraftValidationError,
  GardenDraftService,
  type GardenDraftEvent,
} from '../../src/runtime/garden-draft-service.js';

describe('GardenDraftService', () => {
  it('rejects draft_complete when generated DOT violates single-exit validation', async () => {
    const invalidDot = `digraph InvalidDraft {
      start [shape=Mdiamond]
      done_a [shape=Msquare]
      done_b [shape=Msquare]
      start -> done_a
      start -> done_b
    }`;

    const service = new GardenDraftService(
      {
        available_providers: () => ['stub'],
        stream: async function* () {
          yield { type: 'content_delta', text: invalidDot };
          yield {
            type: 'stream_end',
            stop_reason: 'end_turn',
            message: { role: 'assistant', content: [{ type: 'text', text: invalidDot }] },
            response: { message: { role: 'assistant', content: [{ type: 'text', text: invalidDot }] } },
          };
        },
      } as any,
    );

    const collect = async () => {
      const events: GardenDraftEvent[] = [];
      for await (const event of service.streamDraft({ prompt: 'draft a release graph', provider: 'stub' })) {
        events.push(event);
      }
      return events;
    };

    try {
      await collect();
      expect.unreachable('expected DraftValidationError');
    } catch (error) {
      expect(error).toBeInstanceOf(DraftValidationError);
      const validation = error as DraftValidationError;
      expect(validation.diagnostics.some((diagnostic) => diagnostic.code === 'EXIT_NODE_COUNT')).toBe(true);
    }
  });

  it('emits draft_complete for valid simulation drafts', async () => {
    const service = new GardenDraftService(
      {
        available_providers: () => ['simulation'],
      } as any,
    );

    const events: GardenDraftEvent[] = [];
    for await (const event of service.streamDraft({ prompt: 'Create a valid draft', provider: 'simulation' })) {
      events.push(event);
    }

    expect(events.some((event) => event.type === 'draft_complete')).toBe(true);
    expect(events.some((event) => event.type === 'draft_start')).toBe(true);
    const complete = events.find((event): event is Extract<GardenDraftEvent, { type: 'draft_complete' }> => event.type === 'draft_complete');
    expect(complete?.dot_source).toContain('tool_command=');
    expect(complete?.dot_source).not.toContain('script=');
  });
});
