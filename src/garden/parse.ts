import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parse as parseDot } from '@ts-graphviz/parser';
import {
  GardenEdge,
  GardenGraph,
  GardenNode,
  ParsedStatement,
  SourceLocation,
  normalizeNodeKind
} from './types.js';

export class GardenParseError extends Error {
  readonly location?: SourceLocation;

  constructor(message: string, location?: SourceLocation) {
    super(message);
    this.name = 'GardenParseError';
    this.location = location;
  }
}

export async function parseGardenFile(dotPath: string): Promise<GardenGraph> {
  const absolutePath = path.resolve(dotPath);
  const source = await readFile(absolutePath, 'utf8');
  return parseGardenSource(source, absolutePath);
}

export function parseGardenSource(source: string, dotPath = '<memory>'): GardenGraph {
  validateDotSyntax(source);

  const graphAttributes: Record<string, string> = {};
  const nodes: GardenNode[] = [];
  const edges: GardenEdge[] = [];

  for (const statement of collectStatements(source)) {
    const parsed = parseStatement(statement.text);
    if (!parsed) {
      continue;
    }

    if (parsed.kind === 'graph') {
      Object.assign(graphAttributes, parsed.attributes);
      continue;
    }

    if (parsed.kind === 'assignment') {
      graphAttributes[parsed.key] = parsed.value;
      continue;
    }

    if (parsed.kind === 'node') {
      const attributes = parsed.attributes;
      const shape = attributes.shape;
      const type = attributes.type;
      const maxRetries = parseInteger(attributes.max_retries);
      const timeoutMs = parseTimeoutMs(attributes.timeout);

      nodes.push({
        id: parsed.id,
        label: attributes.label,
        shape,
        type,
        kind: normalizeNodeKind(shape, type),
        maxRetries,
        timeoutMs,
        attributes,
        location: { line: statement.line, col: statement.col }
      });
      continue;
    }

    if (parsed.kind === 'edge') {
      for (let index = 0; index < parsed.path.length - 1; index += 1) {
        const sourceId = parsed.path[index];
        const targetId = parsed.path[index + 1];
        if (!sourceId || !targetId) {
          continue;
        }

        const attrs = { ...parsed.attributes };
        const weight = parseNumber(attrs.weight) ?? 0;

        edges.push({
          source: sourceId,
          target: targetId,
          label: attrs.label,
          condition: attrs.condition,
          weight,
          attributes: attrs,
          location: { line: statement.line, col: statement.col }
        });
      }
    }
  }

  const nodeMap = new Map<string, GardenNode>();
  const outgoing = new Map<string, GardenEdge[]>();
  const incoming = new Map<string, GardenEdge[]>();

  for (const node of nodes) {
    if (!nodeMap.has(node.id)) {
      nodeMap.set(node.id, node);
    }
    if (!outgoing.has(node.id)) {
      outgoing.set(node.id, []);
    }
    if (!incoming.has(node.id)) {
      incoming.set(node.id, []);
    }
  }

  for (const edge of edges) {
    const out = outgoing.get(edge.source);
    if (out) {
      out.push(edge);
    }

    const inc = incoming.get(edge.target);
    if (inc) {
      inc.push(edge);
    }
  }

  return {
    dotPath,
    dotSource: source,
    graphAttributes,
    nodes,
    edges,
    nodeMap,
    outgoing,
    incoming
  };
}

export function hashDotSource(source: string): string {
  return createHash('sha256').update(source).digest('hex');
}

function validateDotSyntax(source: string): void {
  try {
    parseDot(source);
  } catch (error) {
    const err = error as {
      message?: string;
      location?: { start?: { line?: number; column?: number } };
      line?: number;
      column?: number;
      col?: number;
    };

    const line = err.location?.start?.line ?? err.line;
    const col = err.location?.start?.column ?? err.column ?? err.col;
    throw new GardenParseError(err.message ?? 'Failed to parse DOT source.', line && col ? { line, col } : undefined);
  }
}

function collectStatements(source: string): ParsedStatement[] {
  const statements: ParsedStatement[] = [];
  const openBraceIndex = source.indexOf('{');
  const closeBraceIndex = source.lastIndexOf('}');

  if (openBraceIndex === -1 || closeBraceIndex === -1 || closeBraceIndex <= openBraceIndex) {
    throw new GardenParseError('DOT graph body is missing braces.');
  }

  const body = source.slice(openBraceIndex + 1, closeBraceIndex);
  const prefix = source.slice(0, openBraceIndex + 1);
  const baseLine = prefix.split(/\r?\n/).length;

  let buffer = '';
  let statementLine = baseLine;
  let statementCol = 1;
  let bracketDepth = 0;

  const lines = body.split(/\r?\n/);
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const rawLine = stripComments(lines[lineIndex] ?? '');
    const trimmed = rawLine.trim();
    if (!buffer && trimmed.length === 0) {
      continue;
    }

    if (!buffer) {
      statementLine = baseLine + lineIndex;
      const firstNonWhitespace = rawLine.search(/\S/);
      statementCol = firstNonWhitespace >= 0 ? firstNonWhitespace + 1 : 1;
    }

    buffer = buffer ? `${buffer}\n${rawLine}` : rawLine;
    bracketDepth += countDelta(rawLine, '[', ']');

    if (bracketDepth > 0) {
      continue;
    }

    if (trimmed.length === 0) {
      continue;
    }

    statements.push({
      text: cleanStatement(buffer),
      line: statementLine,
      col: statementCol
    });
    buffer = '';
  }

  if (buffer.trim().length > 0) {
    statements.push({
      text: cleanStatement(buffer),
      line: statementLine,
      col: statementCol
    });
  }

  return statements.filter((statement) => statement.text.length > 0);
}

function stripComments(line: string): string {
  let inQuote = false;
  let escaped = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (inQuote) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inQuote = false;
      }
      continue;
    }

    if (char === '"') {
      inQuote = true;
      continue;
    }

    if (char === '/' && line[index + 1] === '/') {
      return line.slice(0, index);
    }

    if (char === '#') {
      return line.slice(0, index);
    }
  }

  return line;
}

function countDelta(line: string, openChar: string, closeChar: string): number {
  let delta = 0;
  let inQuote = false;
  let escaped = false;

  for (const char of line) {
    if (inQuote) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inQuote = false;
      }
      continue;
    }

    if (char === '"') {
      inQuote = true;
      continue;
    }

    if (char === openChar) {
      delta += 1;
    } else if (char === closeChar) {
      delta -= 1;
    }
  }

  return delta;
}

function cleanStatement(input: string): string {
  return input.trim().replace(/;\s*$/, '').trim();
}

type ParsedStatementData =
  | { kind: 'graph'; attributes: Record<string, string> }
  | { kind: 'assignment'; key: string; value: string }
  | { kind: 'node'; id: string; attributes: Record<string, string> }
  | { kind: 'edge'; path: string[]; attributes: Record<string, string> };

function parseStatement(statement: string): ParsedStatementData | null {
  const trimmed = statement.trim();
  if (!trimmed) {
    return null;
  }

  const { head, attributes } = splitHeadAndAttributes(trimmed);
  const normalizedHead = head.trim();

  if (normalizedHead.toLowerCase() === 'graph') {
    return { kind: 'graph', attributes };
  }

  if (normalizedHead.includes('->')) {
    const path = splitEdgePath(normalizedHead).map(parseIdentifier).filter(Boolean) as string[];
    return { kind: 'edge', path, attributes };
  }

  const assignmentIndex = normalizedHead.indexOf('=');
  if (assignmentIndex !== -1 && !normalizedHead.includes(' ')) {
    const key = normalizedHead.slice(0, assignmentIndex).trim();
    const value = stripOuterQuotes(normalizedHead.slice(assignmentIndex + 1).trim());
    return { kind: 'assignment', key, value };
  }

  const firstToken = normalizedHead.split(/\s+/)[0];
  if (!firstToken) {
    return null;
  }
  const nodeId = parseIdentifier(firstToken);
  if (!nodeId) {
    return null;
  }

  return {
    kind: 'node',
    id: nodeId,
    attributes
  };
}

function splitHeadAndAttributes(input: string): { head: string; attributes: Record<string, string> } {
  const firstBracket = input.indexOf('[');
  if (firstBracket === -1) {
    return { head: input, attributes: {} };
  }

  const lastBracket = input.lastIndexOf(']');
  if (lastBracket === -1 || lastBracket <= firstBracket) {
    return { head: input, attributes: {} };
  }

  const head = input.slice(0, firstBracket).trim();
  const attrs = input.slice(firstBracket + 1, lastBracket);
  return {
    head,
    attributes: parseAttributes(attrs)
  };
}

function splitEdgePath(input: string): string[] {
  const parts: string[] = [];
  let cursor = '';
  let inQuote = false;
  let escaped = false;

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    const next = input[index + 1];

    if (inQuote) {
      cursor += char;
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inQuote = false;
      }
      continue;
    }

    if (char === '"') {
      inQuote = true;
      cursor += char;
      continue;
    }

    if (char === '-' && next === '>') {
      parts.push(cursor.trim());
      cursor = '';
      index += 1;
      continue;
    }

    cursor += char;
  }

  if (cursor.trim().length > 0) {
    parts.push(cursor.trim());
  }

  return parts;
}

function parseAttributes(input: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  const entries: string[] = [];

  let cursor = '';
  let inQuote = false;
  let escaped = false;

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];

    if (inQuote) {
      cursor += char;
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inQuote = false;
      }
      continue;
    }

    if (char === '"') {
      inQuote = true;
      cursor += char;
      continue;
    }

    if (char === ',' || char === '\n') {
      const trimmed = cursor.trim();
      if (trimmed) {
        entries.push(trimmed);
      }
      cursor = '';
      continue;
    }

    cursor += char;
  }

  const final = cursor.trim();
  if (final) {
    entries.push(final);
  }

  for (const entry of entries) {
    const eqIndex = entry.indexOf('=');
    if (eqIndex === -1) {
      continue;
    }

    const key = entry.slice(0, eqIndex).trim();
    const value = stripOuterQuotes(entry.slice(eqIndex + 1).trim());
    if (!key) {
      continue;
    }
    attributes[key] = value;
  }

  return attributes;
}

function stripOuterQuotes(value: string): string {
  if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
    return value.slice(1, -1);
  }
  return value;
}

function parseIdentifier(raw: string): string {
  return stripOuterQuotes(raw.trim());
}

function parseInteger(value?: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!/^-?\d+$/.test(value.trim())) {
    return undefined;
  }
  return Number.parseInt(value, 10);
}

function parseNumber(value?: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const numeric = Number.parseFloat(value);
  return Number.isFinite(numeric) ? numeric : undefined;
}

function parseTimeoutMs(value?: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  const trimmed = value.trim().toLowerCase();
  if (!trimmed) {
    return undefined;
  }

  if (/^\d+$/.test(trimmed)) {
    return Number.parseInt(trimmed, 10) * 1000;
  }

  const match = trimmed.match(/^(\d+)(ms|s|m)$/);
  if (!match) {
    return undefined;
  }

  const amount = Number.parseInt(match[1]!, 10);
  const unit = match[2]!;

  if (unit === 'ms') {
    return amount;
  }
  if (unit === 's') {
    return amount * 1000;
  }
  return amount * 60_000;
}
