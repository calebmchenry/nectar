import type { ProviderAdapter } from './adapters/types.js';
import type { ContentPart, GenerateRequest, GenerateResponse, LLMClient, LLMRequest, LLMResponse } from './types.js';
import type { StreamEvent } from './streaming.js';

const PROVIDER = 'simulation';

/**
 * Generate a minimal valid JSON object matching a JSON Schema.
 */
function generateMinimalObject(schema: Record<string, unknown>): unknown {
  const type = schema.type as string | undefined;

  switch (type) {
    case 'string':
      if (schema.enum && Array.isArray(schema.enum) && schema.enum.length > 0) {
        return schema.enum[0];
      }
      return '';
    case 'number':
    case 'integer':
      return 0;
    case 'boolean':
      return false;
    case 'array':
      return [];
    case 'object': {
      const result: Record<string, unknown> = {};
      const properties = schema.properties as Record<string, Record<string, unknown>> | undefined;
      const required = (schema.required as string[]) ?? [];
      if (properties) {
        for (const key of required) {
          const propSchema = properties[key];
          if (propSchema) {
            result[key] = generateMinimalObject(propSchema);
          }
        }
      }
      return result;
    }
    default:
      return null;
  }
}

export class SimulationProvider implements ProviderAdapter, LLMClient {
  readonly provider_name = PROVIDER;

  // Legacy LLMClient interface
  async generate(request: LLMRequest | GenerateRequest): Promise<LLMResponse & GenerateResponse> {
    const messages = request.messages;
    const lastMessage = messages[messages.length - 1];
    const lastContent = lastMessage
      ? typeof lastMessage.content === 'string'
        ? lastMessage.content
        : lastMessage.content
            .filter((p: { type: string }) => p.type === 'text')
            .map((p: { type: string; text?: string }) => p.text ?? '')
            .join('')
      : '';
    const promptSummary = lastContent.slice(0, 100);

    const model = ('model' in request && request.model) ? request.model : 'simulation';

    // Check for structured output request
    const genRequest = request as GenerateRequest;
    const responseFormat = genRequest.response_format;

    let content: string;
    let contentParts: ContentPart[] | undefined;

    if (responseFormat?.type === 'json_schema') {
      const schema = responseFormat.json_schema.schema;
      const obj = generateMinimalObject(schema);
      content = JSON.stringify(obj);
    } else if (responseFormat?.type === 'json') {
      content = JSON.stringify({ result: 'simulated' });
    } else {
      content = `[Simulated response for model=${model}]\n\nPrompt summary: ${promptSummary}...\n\nThis is a simulated LLM response. No API key was configured, so the SimulationProvider was used. In production, this would contain the actual model output.`;
    }

    // Build content parts, including thinking with signature if reasoning_effort is set
    const parts: ContentPart[] = [];
    if (genRequest.reasoning_effort) {
      parts.push({
        type: 'thinking',
        thinking: `Simulated thinking for ${promptSummary}...`,
        signature: 'sim-signature-placeholder'
      });
    }
    parts.push({ type: 'text', text: content });
    contentParts = parts;

    const inputTokens = messages.reduce((sum, m) => {
      const c = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
      return sum + c.length;
    }, 0);

    const usage = {
      input_tokens: inputTokens,
      output_tokens: content.length
    };

    return {
      // Legacy LLMResponse fields
      content,
      model: `${model}-simulated`,
      usage,
      stop_reason: 'end_turn' as const,
      // New GenerateResponse fields
      message: { role: 'assistant' as const, content: contentParts ?? content },
      provider: PROVIDER
    };
  }

  async *stream(request: GenerateRequest): AsyncIterable<StreamEvent> {
    const result = await this.generate(request);
    const text = typeof result.message.content === 'string'
      ? result.message.content
      : result.message.content
          .filter((p) => p.type === 'text')
          .map((p) => ('text' in p ? p.text : ''))
          .join('');

    yield { type: 'stream_start', model: result.model };

    // Yield text in chunks to simulate streaming
    const chunkSize = 20;
    for (let i = 0; i < text.length; i += chunkSize) {
      yield { type: 'content_delta', text: text.slice(i, i + chunkSize) };
    }

    yield { type: 'usage', usage: result.usage };
    yield {
      type: 'stream_end',
      stop_reason: 'end_turn',
      message: result.message
    };
  }
}
