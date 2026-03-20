import { describe, expect, it } from 'vitest';
import { SimulationProvider } from '../../src/llm/simulation.js';
import type { StreamEvent } from '../../src/llm/streaming.js';

describe('SimulationProvider', () => {
  it('returns a simulated response with prompt summary', async () => {
    const provider = new SimulationProvider();
    const result = await provider.generate({
      model: 'claude-sonnet-4-20250514',
      messages: [{ role: 'user', content: 'Write a poem about coding' }]
    });

    expect(result.content).toContain('Simulated response');
    expect(result.content).toContain('Write a poem about coding');
    expect(result.model).toContain('simulated');
  });

  it('returns deterministic usage stats', async () => {
    const provider = new SimulationProvider();
    const result = await provider.generate({
      model: 'test-model',
      messages: [{ role: 'user', content: 'Hello' }]
    });

    expect(result.usage).toBeDefined();
    expect(result.usage!.input_tokens).toBe(5); // length of 'Hello'
    expect(result.usage!.output_tokens).toBe(result.content.length);
    expect(result.stop_reason).toBe('end_turn');
  });

  it('handles multiple messages', async () => {
    const provider = new SimulationProvider();
    const result = await provider.generate({
      model: 'test-model',
      messages: [
        { role: 'user', content: 'First message' },
        { role: 'assistant', content: 'Response' },
        { role: 'user', content: 'Second message about testing' }
      ]
    });

    expect(result.content).toContain('Second message about testing');
    expect(result.usage!.input_tokens).toBe(
      'First message'.length + 'Response'.length + 'Second message about testing'.length
    );
  });

  it('implements ProviderAdapter interface', () => {
    const provider = new SimulationProvider();
    expect(provider.provider_name).toBe('simulation');
    expect(typeof provider.generate).toBe('function');
    expect(typeof provider.stream).toBe('function');
  });

  it('stream() yields correct event sequence', async () => {
    const provider = new SimulationProvider();
    const events: StreamEvent[] = [];

    for await (const event of provider.stream({
      messages: [{ role: 'user', content: 'Hello world' }]
    })) {
      events.push(event);
    }

    expect(events[0]!.type).toBe('stream_start');
    expect(events.some((e) => e.type === 'content_delta')).toBe(true);
    expect(events.some((e) => e.type === 'usage')).toBe(true);
    expect(events[events.length - 1]!.type).toBe('stream_end');

    // Accumulated content_delta texts should form the full response
    const text = events
      .filter((e): e is Extract<StreamEvent, { type: 'content_delta' }> => e.type === 'content_delta')
      .map((e) => e.text)
      .join('');
    expect(text).toContain('Simulated response');
  });

  it('returns GenerateResponse fields (message, provider)', async () => {
    const provider = new SimulationProvider();
    const result = await provider.generate({
      model: 'test',
      messages: [{ role: 'user', content: 'Hi' }]
    });

    expect(result.message).toBeDefined();
    expect(result.message.role).toBe('assistant');
    expect(result.provider).toBe('simulation');
  });
});
