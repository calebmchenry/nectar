import type { ToolHandler } from '../tool-registry.js';

export const editFileSchema = {
  properties: {
    path: { type: 'string', description: 'File path relative to workspace root' },
    old_string: { type: 'string', description: 'Exact string to find and replace' },
    new_string: { type: 'string', description: 'Replacement string' },
    replace_all: { type: 'boolean', default: false, description: 'When true, replace every occurrence of old_string' },
  },
  required: ['path', 'old_string', 'new_string'],
  additionalProperties: false,
};

export const editFileHandler: ToolHandler = async (args, env) => {
  const filePath = args.path as string;
  const oldString = args.old_string as string;
  const newString = args.new_string as string;
  const replaceAll = (args.replace_all as boolean | undefined) ?? false;

  if (oldString.length === 0) {
    if (replaceAll) {
      return `Error: old_string cannot be empty when replace_all=true for ${filePath}.`;
    }
    return `Error: old_string cannot be empty for ${filePath}.`;
  }

  const content = await env.readFile(filePath);

  // Find all occurrences
  const matches: number[] = [];
  let searchFrom = 0;
  while (true) {
    const idx = content.indexOf(oldString, searchFrom);
    if (idx === -1) break;
    matches.push(idx);
    searchFrom = idx + 1;
  }

  const notFoundMessage = `Error: old_string not found in ${filePath} — did the content change? Try read_file first.`;
  if (matches.length === 0) {
    if (!replaceAll) {
      // Root cause note (Sprint 025 GAP-3): exact-only matching caused retry loops when
      // whitespace drift (tabs/trailing spaces/space runs) was the only difference.
      const fuzzy = findUniqueFuzzyRange(content, oldString);
      if (fuzzy.type === 'unique') {
        const updated = content.slice(0, fuzzy.start) + newString + content.slice(fuzzy.end);
        await env.writeFile(filePath, updated);
        const beforeLine = content.slice(0, fuzzy.start).split('\n').length;
        const oldLines = oldString.split('\n').length;
        const newLines = newString.split('\n').length;
        return `Edited ${filePath}: replaced ${oldLines} line(s) with ${newLines} line(s) starting at line ${beforeLine}. fuzzy_matched: true`;
      }
    }
    return notFoundMessage;
  }

  if (matches.length > 1 && !replaceAll) {
    // Find line numbers for each match
    const lineNumbers = matches.map((idx) => {
      const before = content.slice(0, idx);
      return before.split('\n').length;
    });
    return `Error: found ${matches.length} matches for old_string at lines ${lineNumbers.join(', ')} in ${filePath} — provide more context to make the match unique.`;
  }

  if (replaceAll) {
    const updated = content.replaceAll(oldString, newString);
    await env.writeFile(filePath, updated);
    return `Edited ${filePath}: replaced ${matches.length} occurrence(s) of old_string with ${newString.split('\n').length} line(s) each.`;
  }

  // Exactly one match — replace
  const matchIdx = matches[0]!;
  const updated = content.slice(0, matchIdx) + newString + content.slice(matchIdx + oldString.length);
  await env.writeFile(filePath, updated);

  // Return diff-style summary
  const beforeLine = content.slice(0, matchIdx).split('\n').length;
  const oldLines = oldString.split('\n').length;
  const newLines = newString.split('\n').length;
  return `Edited ${filePath}: replaced ${oldLines} line(s) with ${newLines} line(s) starting at line ${beforeLine}.`;
};

export const editFileDescription = 'Replace text in a file. Defaults to exactly one match; set replace_all=true for bulk replacement.';

type FuzzyRangeResult =
  | { type: 'none' }
  | { type: 'ambiguous' }
  | { type: 'unique'; start: number; end: number };

export function normalizeWhitespace(text: string): string {
  return normalizeWhitespaceWithMap(text).normalized;
}

function findUniqueFuzzyRange(content: string, oldString: string): FuzzyRangeResult {
  const normalizedOld = normalizeWhitespace(oldString);
  if (normalizedOld.length === 0) {
    return { type: 'none' };
  }

  const normalizedContent = normalizeWhitespaceWithMap(content);
  const matches: number[] = [];

  let searchFrom = 0;
  while (true) {
    const idx = normalizedContent.normalized.indexOf(normalizedOld, searchFrom);
    if (idx === -1) {
      break;
    }
    matches.push(idx);
    searchFrom = idx + 1;
  }

  if (matches.length === 0) {
    return { type: 'none' };
  }
  if (matches.length > 1) {
    return { type: 'ambiguous' };
  }

  const normalizedStart = matches[0]!;
  const normalizedEnd = normalizedStart + normalizedOld.length;
  const start = normalizedContent.map[normalizedStart];
  if (start === undefined) {
    return { type: 'none' };
  }
  const end = normalizedEnd < normalizedContent.map.length
    ? normalizedContent.map[normalizedEnd]!
    : content.length;

  if (end < start) {
    return { type: 'none' };
  }

  return { type: 'unique', start, end };
}

function normalizeWhitespaceWithMap(text: string): { normalized: string; map: number[] } {
  let normalized = '';
  const map: number[] = [];

  let lineStart = 0;
  for (let i = 0; i <= text.length; i++) {
    if (i !== text.length && text[i] !== '\n') {
      continue;
    }

    const line = text.slice(lineStart, i);
    const lineNormalized = normalizeLine(line, lineStart);
    normalized += lineNormalized.normalized;
    map.push(...lineNormalized.map);

    if (i < text.length) {
      normalized += '\n';
      map.push(i);
    }

    lineStart = i + 1;
  }

  return { normalized, map };
}

function normalizeLine(line: string, absoluteStart: number): { normalized: string; map: number[] } {
  let normalized = '';
  const map: number[] = [];

  let pendingSpaceOriginalIndex: number | null = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (ch === ' ' || ch === '\t') {
      if (pendingSpaceOriginalIndex === null) {
        pendingSpaceOriginalIndex = absoluteStart + i;
      }
      continue;
    }

    if (pendingSpaceOriginalIndex !== null) {
      normalized += ' ';
      map.push(pendingSpaceOriginalIndex);
      pendingSpaceOriginalIndex = null;
    }

    normalized += ch;
    map.push(absoluteStart + i);
  }

  // Intentionally drop pending space at end-of-line to trim trailing whitespace.
  return { normalized, map };
}
