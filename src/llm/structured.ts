import type { GenerateResponse, Message } from './types.js';
import { getTextContent } from './types.js';
import AjvModule from 'ajv';

const Ajv = AjvModule.default ?? AjvModule;
const ajv = new Ajv({ allErrors: true });

/**
 * Extract JSON text from a GenerateResponse, handling markdown code fences
 * and leading/trailing whitespace.
 */
export function extractJsonText(response: GenerateResponse): string {
  let text = getTextContent(response.message.content).trim();

  // Strip markdown code fences if present
  const fenceMatch = text.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?\s*```$/);
  if (fenceMatch) {
    text = fenceMatch[1]!.trim();
  }

  return text;
}

/**
 * Validate data against a JSON Schema using ajv.
 */
export function validateAgainstSchema(
  data: unknown,
  schema: Record<string, unknown>
): { valid: boolean; errors: string[] } {
  const validate = ajv.compile(schema);
  const valid = validate(data);

  if (valid) {
    return { valid: true, errors: [] };
  }

  const errors = (validate.errors ?? []).map((e) => {
    const path = e.instancePath || '/';
    return `${path}: ${e.message ?? 'unknown error'}`;
  });

  return { valid: false, errors };
}

/**
 * Build retry messages that append validation error context to the original messages.
 */
export function buildValidationRetryMessages(
  originalMessages: Message[],
  rawText: string,
  errors: string[]
): Message[] {
  return [
    ...originalMessages,
    { role: 'assistant' as const, content: rawText },
    {
      role: 'user' as const,
      content: `Your previous response was not valid JSON matching the schema. Errors:\n${errors.join('\n')}\n\nPlease try again, responding with ONLY valid JSON.`
    }
  ];
}
