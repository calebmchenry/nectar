import AjvModule from 'ajv';

// Handle both ESM default and CJS-style imports
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const Ajv = ((AjvModule as any).default ?? AjvModule) as any;
const ajv = new Ajv({ allErrors: true, strict: false });

const TOOL_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]*$/;
const TOOL_NAME_MAX_LEN = 64;

export interface ToolNameValidation {
  valid: boolean;
  error?: string;
}

export interface ToolCallRepairInput {
  tool_name: string;
  raw_arguments: string | Record<string, unknown> | undefined | null;
  schema?: Record<string, unknown>;
}

export interface RepairedToolCall {
  tool_name: string;
  arguments: Record<string, unknown>;
  changed: boolean;
  warning?: string;
}

export interface InvalidToolCall {
  code: 'invalid_tool_call';
  message: string;
}

export type ToolCallRepairResult =
  | { ok: true; call: RepairedToolCall }
  | { ok: false; error: InvalidToolCall };

export function validateToolName(name: string): ToolNameValidation {
  if (typeof name !== 'string' || name.length === 0) {
    return {
      valid: false,
      error: 'Tool name must be a non-empty string.',
    };
  }
  if (name.length > TOOL_NAME_MAX_LEN) {
    return {
      valid: false,
      error: `Tool name '${name}' exceeds ${TOOL_NAME_MAX_LEN} characters.`,
    };
  }
  if (!TOOL_NAME_PATTERN.test(name)) {
    return {
      valid: false,
      error: `Tool name '${name}' must match ${TOOL_NAME_PATTERN.source}.`,
    };
  }
  return { valid: true };
}

export function repairToolCall(input: ToolCallRepairInput): ToolCallRepairResult {
  const nameValidation = validateToolName(input.tool_name);
  if (!nameValidation.valid) {
    return invalidToolCall(nameValidation.error ?? `Invalid tool name '${input.tool_name}'.`);
  }

  const parsed = parseArgumentObject(input.raw_arguments);
  if (!parsed.ok) {
    return invalidToolCall(`Invalid arguments for '${input.tool_name}': ${parsed.error}`);
  }

  const coerced = applySchemaRepairs(parsed.value, input.schema);
  const validation = validateAgainstSchema(coerced.arguments, input.schema);
  if (!validation.ok) {
    return invalidToolCall(`Invalid arguments for '${input.tool_name}': ${validation.error}`);
  }

  const changed = parsed.changed || coerced.changed;
  return {
    ok: true,
    call: {
      tool_name: input.tool_name,
      arguments: coerced.arguments,
      changed,
      warning: changed
        ? `Tool call '${input.tool_name}' arguments were repaired before execution.`
        : undefined,
    },
  };
}

function invalidToolCall(message: string): ToolCallRepairResult {
  return {
    ok: false,
    error: {
      code: 'invalid_tool_call',
      message,
    },
  };
}

function parseArgumentObject(
  raw: string | Record<string, unknown> | undefined | null
): { ok: true; value: Record<string, unknown>; changed: boolean } | { ok: false; error: string } {
  if (raw === undefined || raw === null) {
    return { ok: true, value: {}, changed: true };
  }

  if (isRecord(raw)) {
    return { ok: true, value: { ...raw }, changed: false };
  }

  if (typeof raw !== 'string') {
    return { ok: false, error: 'arguments must be a JSON object string.' };
  }

  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return { ok: true, value: {}, changed: true };
  }

  const direct = tryParseObject(trimmed);
  if (direct.ok) {
    return { ok: true, value: direct.value, changed: false };
  }

  const cleaned = cleanupTrivialJson(trimmed);
  if (cleaned !== trimmed) {
    const repaired = tryParseObject(cleaned);
    if (repaired.ok) {
      return { ok: true, value: repaired.value, changed: true };
    }
  }

  return { ok: false, error: direct.error ?? 'could not parse JSON.' };
}

function tryParseObject(raw: string): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)) {
      return { ok: false, error: 'expected a JSON object.' };
    }
    return { ok: true, value: parsed };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function cleanupTrivialJson(raw: string): string {
  let value = raw;

  const fenced = value.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fenced?.[1]) {
    value = fenced[1];
  }

  // Remove trailing commas before object/array closure.
  value = value.replace(/,\s*([}\]])/g, '$1');
  return value.trim();
}

function applySchemaRepairs(
  input: Record<string, unknown>,
  schema?: Record<string, unknown>,
): { arguments: Record<string, unknown>; changed: boolean } {
  const output: Record<string, unknown> = { ...input };
  let changed = false;

  const properties = isRecord(schema?.properties) ? schema.properties as Record<string, unknown> : undefined;
  const disallowUnknown = schema?.additionalProperties === false;

  if (disallowUnknown && properties) {
    for (const key of Object.keys(output)) {
      if (!Object.prototype.hasOwnProperty.call(properties, key)) {
        delete output[key];
        changed = true;
      }
    }
  }

  if (properties) {
    for (const [key, value] of Object.entries(output)) {
      const propertySchema = properties[key];
      const coerced = coerceValue(value, propertySchema);
      if (coerced.changed) {
        output[key] = coerced.value;
        changed = true;
      }
    }
  }

  return { arguments: output, changed };
}

function coerceValue(
  value: unknown,
  schema: unknown,
): { changed: false; value: unknown } | { changed: true; value: unknown } {
  const types = extractTypes(schema);
  if (types.length === 0 || matchesAnyType(value, types)) {
    return { changed: false, value };
  }

  if (typeof value !== 'string') {
    return { changed: false, value };
  }

  const trimmed = value.trim();
  if (types.includes('integer') && isCanonicalInteger(trimmed)) {
    return { changed: true, value: Number.parseInt(trimmed, 10) };
  }
  if (types.includes('number') && isCanonicalNumber(trimmed)) {
    return { changed: true, value: Number(trimmed) };
  }
  if (types.includes('boolean') && (trimmed === 'true' || trimmed === 'false')) {
    return { changed: true, value: trimmed === 'true' };
  }

  return { changed: false, value };
}

function extractTypes(schema: unknown): string[] {
  if (!isRecord(schema) || schema.type === undefined) {
    return [];
  }
  if (typeof schema.type === 'string') {
    return [schema.type];
  }
  if (Array.isArray(schema.type)) {
    return schema.type.filter((entry): entry is string => typeof entry === 'string');
  }
  return [];
}

function matchesAnyType(value: unknown, types: string[]): boolean {
  return types.some((type) => matchesType(value, type));
}

function matchesType(value: unknown, type: string): boolean {
  switch (type) {
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'array':
      return Array.isArray(value);
    case 'object':
      return isRecord(value);
    case 'null':
      return value === null;
    default:
      return false;
  }
}

function isCanonicalInteger(value: string): boolean {
  return /^-?(0|[1-9]\d*)$/.test(value);
}

function isCanonicalNumber(value: string): boolean {
  if (!/^-?(0|[1-9]\d*)(\.\d+)?$/.test(value)) {
    return false;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed);
}

function validateAgainstSchema(
  args: Record<string, unknown>,
  schema?: Record<string, unknown>,
): { ok: true } | { ok: false; error: string } {
  const validate = ajv.compile({
    type: 'object',
    ...(schema ?? {}),
  });
  if (validate(args)) {
    return { ok: true };
  }
  const details = validate.errors
    ?.map((entry: { instancePath?: string; message?: string }) => `${entry.instancePath || '/'}: ${entry.message}`)
    .join('; ');
  return {
    ok: false,
    error: details ?? 'schema validation failed.',
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
