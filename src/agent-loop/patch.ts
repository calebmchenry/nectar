/**
 * v4a patch parser and transactional applicator.
 *
 * Parses the "*** Begin Patch" / "*** End Patch" format used by OpenAI models.
 * Applies patches atomically — all hunks succeed or zero files are modified.
 */

import path from 'node:path';
import type { ExecutionEnvironment } from './execution-environment.js';

// --- Types ---

export type PatchOperationType = 'add' | 'update' | 'delete' | 'move';

export interface PatchHunk {
  context_before: string[];
  remove_lines: string[];
  add_lines: string[];
  context_after: string[];
}

export interface PatchOperation {
  type: PatchOperationType;
  path: string;
  move_to?: string;
  hunks: PatchHunk[];
  new_content?: string; // For add operations
}

export interface PatchResult {
  success: boolean;
  operations: Array<{
    type: PatchOperationType;
    path: string;
    move_to?: string;
  }>;
  error?: string;
  files_modified: number;
  files_added: number;
  files_deleted: number;
}

// --- Parser ---

export function parsePatchV4A(raw: string): PatchOperation[] {
  if (!raw || raw.trim().length === 0) {
    throw new PatchParseError('Empty patch');
  }

  // Normalize line endings
  const normalized = raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines = normalized.split('\n');

  // Find envelope
  const beginIdx = lines.findIndex(l => l.trim() === '*** Begin Patch');
  let endIdx = -1;
  for (let j = lines.length - 1; j >= 0; j--) {
    if (lines[j]!.trim() === '*** End Patch') { endIdx = j; break; }
  }

  if (beginIdx === -1) {
    throw new PatchParseError('Missing "*** Begin Patch" header');
  }
  if (endIdx === -1 || endIdx <= beginIdx) {
    throw new PatchParseError('Missing "*** End Patch" footer');
  }

  const patchLines = lines.slice(beginIdx + 1, endIdx);
  const operations: PatchOperation[] = [];
  let i = 0;

  while (i < patchLines.length) {
    const line = patchLines[i]!;

    if (line.startsWith('*** Add File: ')) {
      const filePath = line.slice('*** Add File: '.length).trim();
      if (!filePath) throw new PatchParseError(`Empty file path at line ${beginIdx + 1 + i + 1}`);
      i++;

      // Collect all content lines until next operation or end
      const contentLines: string[] = [];
      while (i < patchLines.length && !patchLines[i]!.startsWith('*** ')) {
        contentLines.push(patchLines[i]!);
        i++;
      }

      operations.push({
        type: 'add',
        path: filePath,
        hunks: [],
        new_content: contentLines.join('\n'),
      });
    } else if (line.startsWith('*** Delete File: ')) {
      const filePath = line.slice('*** Delete File: '.length).trim();
      if (!filePath) throw new PatchParseError(`Empty file path at line ${beginIdx + 1 + i + 1}`);
      i++;
      operations.push({ type: 'delete', path: filePath, hunks: [] });
    } else if (line.startsWith('*** Update File: ')) {
      const filePath = line.slice('*** Update File: '.length).trim();
      if (!filePath) throw new PatchParseError(`Empty file path at line ${beginIdx + 1 + i + 1}`);
      i++;

      // Check for optional Move to
      let moveTo: string | undefined;
      if (i < patchLines.length && patchLines[i]!.startsWith('*** Move to: ')) {
        moveTo = patchLines[i]!.slice('*** Move to: '.length).trim();
        i++;
      }

      // Parse hunks
      const hunks: PatchHunk[] = [];
      while (i < patchLines.length && !patchLines[i]!.startsWith('*** ')) {
        if (patchLines[i]!.startsWith('@@')) {
          i++; // skip hunk header
          const hunk: PatchHunk = {
            context_before: [],
            remove_lines: [],
            add_lines: [],
            context_after: [],
          };

          let seenChange = false;
          let afterChange = false;

          while (i < patchLines.length && !patchLines[i]!.startsWith('@@') && !patchLines[i]!.startsWith('*** ')) {
            const hunkLine = patchLines[i]!;

            if (hunkLine.startsWith('-')) {
              seenChange = true;
              afterChange = false;
              hunk.remove_lines.push(hunkLine.slice(1));
            } else if (hunkLine.startsWith('+')) {
              seenChange = true;
              afterChange = false;
              hunk.add_lines.push(hunkLine.slice(1));
            } else if (hunkLine.startsWith(' ') || hunkLine === '') {
              const contextLine = hunkLine === '' ? '' : hunkLine.slice(1);
              if (!seenChange) {
                hunk.context_before.push(contextLine);
              } else {
                afterChange = true;
                hunk.context_after.push(contextLine);
              }
            } else {
              // Treat as context line (some models omit the space prefix)
              if (!seenChange) {
                hunk.context_before.push(hunkLine);
              } else {
                afterChange = true;
                hunk.context_after.push(hunkLine);
              }
            }
            i++;
          }

          hunks.push(hunk);
        } else {
          i++;
        }
      }

      if (hunks.length === 0) {
        throw new PatchParseError(`Update for '${filePath}' contains no hunks`);
      }

      const op: PatchOperation = { type: moveTo ? 'move' : 'update', path: filePath, hunks };
      if (moveTo) op.move_to = moveTo;
      operations.push(op);
    } else if (line.trim() === '' || line.trim().startsWith('#')) {
      // Skip blank lines and comments
      i++;
    } else {
      throw new PatchParseError(`Unexpected line at position ${beginIdx + 1 + i + 1}: "${line.slice(0, 60)}"`);
    }
  }

  if (operations.length === 0) {
    throw new PatchParseError('Patch contains no operations');
  }

  return operations;
}

// --- Applicator ---

export async function applyParsedPatch(
  ops: PatchOperation[],
  env: ExecutionEnvironment
): Promise<PatchResult> {
  // Phase 1: Validate all operations
  const staged = new Map<string, string>(); // path -> new content
  const deletions: string[] = [];
  const renames: Array<{ from: string; to: string }> = [];

  let filesModified = 0;
  let filesAdded = 0;
  let filesDeleted = 0;

  for (const op of ops) {
    // Validate path is within workspace
    try {
      await env.resolvePath(op.path);
    } catch (err) {
      return errorResult(ops, `Path traversal blocked: ${op.path}`);
    }

    if (op.move_to) {
      try {
        await env.resolvePath(op.move_to);
      } catch (err) {
        return errorResult(ops, `Path traversal blocked: ${op.move_to}`);
      }
    }

    switch (op.type) {
      case 'add': {
        const exists = await env.fileExists(op.path);
        if (exists) {
          return errorResult(ops, `Cannot add file '${op.path}': file already exists`);
        }
        staged.set(op.path, op.new_content ?? '');
        filesAdded++;
        break;
      }
      case 'delete': {
        const exists = await env.fileExists(op.path);
        if (!exists) {
          return errorResult(ops, `Cannot delete file '${op.path}': file does not exist`);
        }
        deletions.push(op.path);
        filesDeleted++;
        break;
      }
      case 'update':
      case 'move': {
        const exists = await env.fileExists(op.path);
        if (!exists) {
          return errorResult(ops, `Cannot update file '${op.path}': file does not exist`);
        }

        if (op.move_to) {
          const targetExists = await env.fileExists(op.move_to);
          if (targetExists) {
            return errorResult(ops, `Cannot move to '${op.move_to}': target already exists`);
          }
        }

        // Read file and apply hunks
        let content = await env.readFile(op.path);
        // Detect line ending
        const lineEnding = detectLineEnding(content);
        // Normalize to \n for processing
        content = content.replace(/\r\n/g, '\n');
        const fileLines = content.split('\n');

        let currentLines = [...fileLines];
        for (const hunk of op.hunks) {
          const result = applyHunk(currentLines, hunk);
          if (!result.success) {
            return errorResult(ops, `Hunk failed in '${op.path}': ${result.error}`);
          }
          currentLines = result.lines!;
        }

        // Restore original line endings
        let newContent = currentLines.join('\n');
        if (lineEnding === '\r\n') {
          newContent = newContent.replace(/\n/g, '\r\n');
        }

        if (op.move_to) {
          staged.set(op.move_to, newContent);
          deletions.push(op.path);
          renames.push({ from: op.path, to: op.move_to });
          filesModified++;
        } else {
          staged.set(op.path, newContent);
          filesModified++;
        }
        break;
      }
    }
  }

  // Phase 2: Commit all writes atomically
  try {
    // Writes first
    for (const [filePath, content] of staged) {
      await env.writeFile(filePath, content);
    }
    // Then deletions
    for (const filePath of deletions) {
      if (!staged.has(filePath)) {
        // Only delete if we didn't also write to this path (move case: delete source)
        await env.deleteFile(filePath);
      } else {
        // For moves, we wrote to the target; delete the source if different
      }
    }
    // Handle move deletions: delete source files that were moved
    for (const rename of renames) {
      // Source was already added to deletions; delete it if it wasn't overwritten
      if (!staged.has(rename.from)) {
        // already handled above
      }
      try {
        await env.deleteFile(rename.from);
      } catch {
        // Source may have already been cleaned up
      }
    }
  } catch (err) {
    return errorResult(ops, `Failed to write changes: ${err instanceof Error ? err.message : String(err)}`);
  }

  return {
    success: true,
    operations: ops.map(o => ({ type: o.type, path: o.path, move_to: o.move_to })),
    files_modified: filesModified,
    files_added: filesAdded,
    files_deleted: filesDeleted,
  };
}

// --- Hunk application ---

interface HunkResult {
  success: boolean;
  lines?: string[];
  error?: string;
}

function applyHunk(fileLines: string[], hunk: PatchHunk): HunkResult {
  // Build the pattern to search for: context_before + remove_lines + context_after
  const searchPattern = [
    ...hunk.context_before,
    ...hunk.remove_lines,
    ...hunk.context_after,
  ];

  if (searchPattern.length === 0 && hunk.add_lines.length > 0) {
    // Pure insertion at the end of file
    return { success: true, lines: [...fileLines, ...hunk.add_lines] };
  }

  // Find the match position
  const matchIdx = findPatternInLines(fileLines, searchPattern);
  if (matchIdx === -1) {
    const patternPreview = searchPattern.slice(0, 3).map(l => `  "${l}"`).join('\n');
    return {
      success: false,
      error: `Context lines do not match. Expected to find:\n${patternPreview}${searchPattern.length > 3 ? '\n  ...' : ''}`,
    };
  }

  // Build the replacement: context_before + add_lines + context_after
  const replacement = [
    ...hunk.context_before,
    ...hunk.add_lines,
    ...hunk.context_after,
  ];

  const result = [
    ...fileLines.slice(0, matchIdx),
    ...replacement,
    ...fileLines.slice(matchIdx + searchPattern.length),
  ];

  return { success: true, lines: result };
}

function findPatternInLines(fileLines: string[], pattern: string[]): number {
  if (pattern.length === 0) return fileLines.length; // append at end
  if (pattern.length > fileLines.length) return -1;

  for (let i = 0; i <= fileLines.length - pattern.length; i++) {
    let match = true;
    for (let j = 0; j < pattern.length; j++) {
      if (fileLines[i + j] !== pattern[j]) {
        match = false;
        break;
      }
    }
    if (match) return i;
  }
  return -1;
}

function detectLineEnding(content: string): string {
  const crlf = (content.match(/\r\n/g) || []).length;
  const lf = (content.match(/(?<!\r)\n/g) || []).length;
  return crlf > lf ? '\r\n' : '\n';
}

function errorResult(ops: PatchOperation[], error: string): PatchResult {
  return {
    success: false,
    operations: ops.map(o => ({ type: o.type, path: o.path, move_to: o.move_to })),
    error,
    files_modified: 0,
    files_added: 0,
    files_deleted: 0,
  };
}

// --- Error class ---

export class PatchParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PatchParseError';
  }
}
