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
  Subgraph,
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

// --- Scope stack for default blocks and subgraph scoping ---

interface AttributeScope {
  nodeDefaults: Record<string, string>;
  edgeDefaults: Record<string, string>;
}

function emptyScope(): AttributeScope {
  return { nodeDefaults: {}, edgeDefaults: {} };
}

function cloneScope(scope: AttributeScope): AttributeScope {
  return {
    nodeDefaults: { ...scope.nodeDefaults },
    edgeDefaults: { ...scope.edgeDefaults },
  };
}

export function parseGardenSource(source: string, dotPath = '<memory>'): GardenGraph {
  const stripped = stripBlockComments(source);
  validateDotSyntax(source);

  const graphAttributes: Record<string, string> = {};
  const nodes: GardenNode[] = [];
  const edges: GardenEdge[] = [];
  const subgraphs: Subgraph[] = [];

  // Scope stack and subgraph tracking
  const scopeStack: AttributeScope[] = [emptyScope()];
  const subgraphStack: { id: string; label?: string; nodeIds: string[]; classes: string[] }[] = [];

  function currentScope(): AttributeScope {
    return scopeStack[scopeStack.length - 1]!;
  }

  function currentClasses(): string[] {
    const classes: string[] = [];
    for (const sg of subgraphStack) {
      classes.push(...sg.classes);
    }
    return classes;
  }

  for (const statement of collectStatements(stripped)) {
    const text = statement.text;

    // Handle subgraph open: "subgraph <name> {"
    const subgraphMatch = text.match(/^subgraph\s+(\S+)\s*\{?\s*$/i);
    if (subgraphMatch?.[1]) {
      const sgId = parseIdentifier(subgraphMatch[1]);
      scopeStack.push(cloneScope(currentScope()));
      const className = normalizeClassName(sgId.startsWith('cluster_') ? sgId.slice(8) : sgId);
      subgraphStack.push({ id: sgId, nodeIds: [], classes: [className] });
      continue;
    }

    // Handle standalone open brace after subgraph (already consumed)
    if (text === '{') {
      continue;
    }

    // Handle subgraph close: "}"
    if (text === '}') {
      if (subgraphStack.length > 0) {
        scopeStack.pop();
        const sg = subgraphStack.pop()!;
        // Extract label from scope if set
        const subgraphRecord: Subgraph = {
          id: sg.id,
          label: sg.label,
          nodeIds: sg.nodeIds,
        };
        subgraphs.push(subgraphRecord);
        // Add node IDs to parent subgraph if nested
        if (subgraphStack.length > 0) {
          subgraphStack[subgraphStack.length - 1]!.nodeIds.push(...sg.nodeIds);
        }
      }
      continue;
    }

    const parsed = parseStatement(text);
    if (!parsed) {
      continue;
    }

    if (parsed.kind === 'graph') {
      Object.assign(graphAttributes, parsed.attributes);
      continue;
    }

    if (parsed.kind === 'assignment') {
      graphAttributes[parsed.key] = parsed.value;
      // Check if this is a label inside a subgraph
      if (parsed.key === 'label' && subgraphStack.length > 0) {
        const sg = subgraphStack[subgraphStack.length - 1]!;
        sg.label = parsed.value;
        // Override class name with label
        sg.classes = [normalizeClassName(parsed.value)];
      }
      continue;
    }

    if (parsed.kind === 'node_default') {
      Object.assign(currentScope().nodeDefaults, parsed.attributes);
      continue;
    }

    if (parsed.kind === 'edge_default') {
      Object.assign(currentScope().edgeDefaults, parsed.attributes);
      continue;
    }

    if (parsed.kind === 'node') {
      // Merge defaults then explicit attributes
      const mergedAttributes = { ...currentScope().nodeDefaults, ...parsed.attributes };
      const shape = mergedAttributes.shape;
      const type = mergedAttributes.type;
      const maxRetries = parseInteger(mergedAttributes.max_retries);
      const retryPolicy = mergedAttributes.retry_policy?.trim() || undefined;
      const timeoutMs = parseTimeoutMs(mergedAttributes.timeout);
      const goalGate = mergedAttributes.goal_gate?.trim().toLowerCase() === 'true' ? true : undefined;
      const retryTarget = mergedAttributes.retry_target?.trim() || undefined;
      const fallbackRetryTarget = mergedAttributes.fallback_retry_target?.trim() || undefined;
      const prompt = mergedAttributes.prompt?.trim() || undefined;
      const allowPartial = mergedAttributes.allow_partial?.trim().toLowerCase() === 'true' ? true : undefined;
      const humanDefaultChoice = mergedAttributes['human.default_choice']?.trim() || undefined;
      const joinPolicy = mergedAttributes.join_policy?.trim() || undefined;
      const maxParallel = parseInteger(mergedAttributes.max_parallel);
      const llmModel = mergedAttributes.llm_model?.trim()
        || mergedAttributes['llm.model']?.trim()
        || mergedAttributes.model?.trim()
        || undefined;
      const llmProvider = mergedAttributes.llm_provider?.trim() || mergedAttributes['llm.provider']?.trim() || undefined;
      const reasoningEffort = mergedAttributes.reasoning_effort?.trim() || mergedAttributes['llm.reasoning_effort']?.trim() || undefined;
      const autoStatus = mergedAttributes.auto_status?.trim().toLowerCase() === 'true' ? true : undefined;
      const fidelity = mergedAttributes.fidelity?.trim() || undefined;
      const threadId = mergedAttributes.thread_id?.trim() || undefined;
      const explicitToolCommand = mergedAttributes.tool_command?.trim();
      const legacyScript = mergedAttributes.script?.trim();
      const toolCommand = explicitToolCommand || legacyScript || undefined;
      const toolCommandFromScript = !explicitToolCommand && Boolean(legacyScript);
      const assertExistsRaw = mergedAttributes.assert_exists?.trim();
      const assertExists = assertExistsRaw
        ? assertExistsRaw.split(',').map((segment) => segment.trim()).filter(Boolean)
        : undefined;
      const managerPollIntervalMs = parseTimeoutMs(mergedAttributes['manager.poll_interval']);
      const managerMaxCycles = parseInteger(mergedAttributes['manager.max_cycles']);
      const managerStopCondition = mergedAttributes['manager.stop_condition']?.trim() || undefined;
      const managerActionsRaw = mergedAttributes['manager.actions']?.trim();
      const managerActions = managerActionsRaw
        ? managerActionsRaw.split(',').map(a => a.trim()).filter(Boolean)
        : undefined;
      const childAutostartRaw = mergedAttributes['stack.child_autostart']?.trim().toLowerCase();
      const childAutostart = childAutostartRaw === 'false' ? false : childAutostartRaw === 'true' ? true : undefined;
      const nodeToolHooksPre = mergedAttributes['tool_hooks.pre']?.trim() || undefined;
      const nodeToolHooksPost = mergedAttributes['tool_hooks.post']?.trim() || undefined;
      // Merge subgraph-derived classes with explicit class attribute (deduplicated, normalized)
      const subgraphClasses = currentClasses().map(normalizeClassName);
      const classAttr = mergedAttributes.class?.trim();
      const classes: string[] = [...subgraphClasses];
      if (classAttr) {
        for (const cls of classAttr.split(',')) {
          const normalized = normalizeClassName(cls.trim());
          if (normalized && !classes.includes(normalized)) {
            classes.push(normalized);
          }
        }
      }

      nodes.push({
        id: parsed.id,
        label: mergedAttributes.label,
        shape,
        type,
        kind: normalizeNodeKind(shape, type),
        maxRetries,
        retryPolicy,
        timeoutMs,
        goalGate,
        retryTarget,
        fallbackRetryTarget,
        prompt,
        allowPartial,
        humanDefaultChoice,
        joinPolicy,
        maxParallel,
        llmModel,
        llmProvider,
        reasoningEffort,
        autoStatus,
        fidelity,
        threadId,
        toolCommand,
        toolCommandFromScript,
        assertExists,
        managerPollIntervalMs,
        managerMaxCycles,
        managerStopCondition,
        managerActions,
        childAutostart,
        toolHooksPre: nodeToolHooksPre,
        toolHooksPost: nodeToolHooksPost,
        classes,
        attributes: mergedAttributes,
        location: { line: statement.line, col: statement.col }
      });

      // Track node in subgraph
      if (subgraphStack.length > 0) {
        subgraphStack[subgraphStack.length - 1]!.nodeIds.push(parsed.id);
      }
      continue;
    }

    if (parsed.kind === 'edge') {
      // Merge edge defaults
      const mergedAttributes = { ...currentScope().edgeDefaults, ...parsed.attributes };

      for (let index = 0; index < parsed.path.length - 1; index += 1) {
        const sourceId = parsed.path[index];
        const targetId = parsed.path[index + 1];
        if (!sourceId || !targetId) {
          continue;
        }

        const attrs = { ...mergedAttributes };
        const weight = parseNumber(attrs.weight) ?? 0;
        const edgeFidelity = attrs.fidelity?.trim() || undefined;
        const edgeThreadId = attrs.thread_id?.trim() || undefined;
        const loopRestart = attrs.loop_restart?.trim().toLowerCase() === 'true';

        edges.push({
          source: sourceId,
          target: targetId,
          label: attrs.label,
          condition: attrs.condition,
          weight,
          fidelity: edgeFidelity,
          threadId: edgeThreadId,
          loopRestart,
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

  const defaultMaxRetries = parseInteger(graphAttributes.default_max_retries) ??
    parseInteger(graphAttributes.default_max_retry);
  const defaultRetryPolicy = graphAttributes.default_retry_policy?.trim() || undefined;

  const defaultFidelity = graphAttributes.default_fidelity?.trim() || undefined;
  const modelStylesheet = graphAttributes.model_stylesheet?.trim() || undefined;
  const childDotfile = graphAttributes['stack.child_dotfile']?.trim() || undefined;
  const childWorkdir = graphAttributes['stack.child_workdir']?.trim() || undefined;
  const graphToolHooksPre = graphAttributes['tool_hooks.pre']?.trim() || undefined;
  const graphToolHooksPost = graphAttributes['tool_hooks.post']?.trim() || undefined;
  const maxRestartDepthRaw = graphAttributes['max_restart_depth']?.trim();
  const maxRestartDepth = maxRestartDepthRaw && /^\d+$/.test(maxRestartDepthRaw)
    ? Number.parseInt(maxRestartDepthRaw, 10)
    : undefined;

  return {
    dotPath,
    dotSource: source,
    graphAttributes,
    defaultMaxRetries,
    defaultRetryPolicy,
    defaultFidelity,
    modelStylesheet,
    childDotfile,
    childWorkdir,
    toolHooksPre: graphToolHooksPre,
    toolHooksPost: graphToolHooksPost,
    maxRestartDepth,
    nodes,
    edges,
    subgraphs,
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

// --- Block comment stripping ---

export function stripBlockComments(source: string): string {
  let result = '';
  let inQuote = false;
  let escaped = false;
  let inBlock = false;

  for (let i = 0; i < source.length; i++) {
    const char = source[i]!;
    const next = source[i + 1];

    if (inBlock) {
      if (char === '*' && next === '/') {
        inBlock = false;
        i++; // skip '/'
        // Replace with a space to preserve token separation
        result += ' ';
      }
      continue;
    }

    if (inQuote) {
      result += char;
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
      result += char;
      continue;
    }

    if (char === '/' && next === '*') {
      inBlock = true;
      i++; // skip '*'
      continue;
    }

    result += char;
  }

  if (inBlock) {
    throw new GardenParseError('Unclosed block comment at end of file.');
  }

  return result;
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
  let braceDepth = 0;

  const lines = body.split(/\r?\n/);
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const rawLine = stripLineComments(lines[lineIndex] ?? '');
    const trimmed = rawLine.trim();

    if (!buffer && trimmed.length === 0) {
      continue;
    }

    if (!buffer) {
      statementLine = baseLine + lineIndex;
      const firstNonWhitespace = rawLine.search(/\S/);
      statementCol = firstNonWhitespace >= 0 ? firstNonWhitespace + 1 : 1;
    }

    // Process character by character for braces and semicolons
    for (let ci = 0; ci < rawLine.length; ci++) {
      const ch = rawLine[ci]!;

      // Track quotes
      if (ch === '"') {
        buffer += ch;
        ci++;
        while (ci < rawLine.length) {
          buffer += rawLine[ci]!;
          if (rawLine[ci] === '\\') {
            ci++;
            if (ci < rawLine.length) buffer += rawLine[ci]!;
          } else if (rawLine[ci] === '"') {
            break;
          }
          ci++;
        }
        continue;
      }

      if (ch === '[') {
        bracketDepth++;
        buffer += ch;
        continue;
      }
      if (ch === ']') {
        bracketDepth--;
        buffer += ch;
        continue;
      }

      if (bracketDepth > 0) {
        buffer += ch;
        continue;
      }

      if (ch === '{') {
        braceDepth++;
        // Flush what's before the brace as part of the statement
        const beforeBrace = buffer.trim();
        if (beforeBrace) {
          statements.push({
            text: cleanStatement(beforeBrace + ' {'),
            line: statementLine,
            col: statementCol,
          });
        }
        buffer = '';
        statementLine = baseLine + lineIndex;
        statementCol = ci + 2;
        continue;
      }

      if (ch === '}') {
        // Flush buffer
        if (buffer.trim()) {
          statements.push({
            text: cleanStatement(buffer),
            line: statementLine,
            col: statementCol,
          });
          buffer = '';
        }
        braceDepth--;
        statements.push({
          text: '}',
          line: baseLine + lineIndex,
          col: ci + 1,
        });
        statementLine = baseLine + lineIndex;
        statementCol = ci + 2;
        continue;
      }

      if (ch === ';') {
        if (buffer.trim()) {
          statements.push({
            text: cleanStatement(buffer),
            line: statementLine,
            col: statementCol,
          });
          buffer = '';
        }
        statementLine = baseLine + lineIndex;
        statementCol = ci + 2;
        continue;
      }

      buffer += ch;
    }

    // Add newline between lines if buffering multi-line
    if (buffer.trim() && bracketDepth > 0) {
      buffer += '\n';
    } else if (buffer.trim() && lineIndex < lines.length - 1) {
      // Check if next line continues this statement
      const nextTrimmed = stripLineComments(lines[lineIndex + 1] ?? '').trim();
      if (nextTrimmed && bracketDepth <= 0 && !nextTrimmed.startsWith('}') && !nextTrimmed.startsWith('{')) {
        // Flush current buffer as statement
        statements.push({
          text: cleanStatement(buffer),
          line: statementLine,
          col: statementCol,
        });
        buffer = '';
      }
    }
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

function stripLineComments(line: string): string {
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
  | { kind: 'edge'; path: string[]; attributes: Record<string, string> }
  | { kind: 'node_default'; attributes: Record<string, string> }
  | { kind: 'edge_default'; attributes: Record<string, string> };

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

  // Detect default blocks: "node [...]" and "edge [...]"
  if (normalizedHead.toLowerCase() === 'node' && Object.keys(attributes).length > 0) {
    return { kind: 'node_default', attributes };
  }

  if (normalizedHead.toLowerCase() === 'edge' && Object.keys(attributes).length > 0) {
    return { kind: 'edge_default', attributes };
  }

  if (normalizedHead.includes('->')) {
    const path = splitEdgePath(normalizedHead).map(parseIdentifier).filter(Boolean) as string[];
    return { kind: 'edge', path, attributes };
  }

  const assignmentIndex = normalizedHead.indexOf('=');
  if (assignmentIndex !== -1 && !hasUnquotedSpace(normalizedHead.slice(0, assignmentIndex))) {
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

    if (char === ',' || char === '\n' || char === ';') {
      const trimmed = cursor.trim();
      if (trimmed) {
        entries.push(trimmed);
      }
      cursor = '';
      continue;
    }

    // Space-separated attributes: if we see a space after a complete key=value
    // and the rest starts with a new key= pattern, split here.
    if (char === ' ' || char === '\t') {
      const trimmed = cursor.trim();
      if (trimmed && trimmed.includes('=')) {
        // Look ahead: skip whitespace, check if next non-ws chars form key=
        let ahead = index + 1;
        while (ahead < input.length && (input[ahead] === ' ' || input[ahead] === '\t')) ahead++;
        if (ahead < input.length && input[ahead] !== '=' && input[ahead] !== '"') {
          // Check if there's an '=' coming before the next space/comma/end
          let eqPos = -1;
          for (let j = ahead; j < input.length; j++) {
            if (input[j] === '=') { eqPos = j; break; }
            if (input[j] === ' ' || input[j] === ',' || input[j] === '\n') break;
          }
          if (eqPos > ahead) {
            entries.push(trimmed);
            cursor = '';
            continue;
          }
        }
      }
      cursor += char;
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

    const key = stripOuterQuotes(entry.slice(0, eqIndex).trim());
    const value = stripOuterQuotes(entry.slice(eqIndex + 1).trim());
    if (!key) {
      continue;
    }
    attributes[key] = value;
  }

  return attributes;
}

function hasUnquotedSpace(text: string): boolean {
  let inQuote = false;
  let escaped = false;
  for (const ch of text) {
    if (inQuote) {
      if (escaped) { escaped = false; }
      else if (ch === '\\') { escaped = true; }
      else if (ch === '"') { inQuote = false; }
      continue;
    }
    if (ch === '"') { inQuote = true; continue; }
    if (ch === ' ' || ch === '\t') { return true; }
  }
  return false;
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

/**
 * Normalize a class name to lowercase alphanumeric with hyphens.
 * Spaces and punctuation are replaced with hyphens, consecutive hyphens collapsed.
 */
export function normalizeClassName(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
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

export function parseTimeoutMs(value?: string): number | undefined {
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

  const match = trimmed.match(/^(\d+)(ms|s|m|h|d)$/);
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
  if (unit === 'm') {
    return amount * 60_000;
  }
  if (unit === 'h') {
    return amount * 3_600_000;
  }
  // d
  return amount * 86_400_000;
}
