import type { ToolHandler } from '../tool-registry.js';

export const editFileSchema = {
  properties: {
    path: { type: 'string', description: 'File path relative to workspace root' },
    old_string: { type: 'string', description: 'Exact string to find and replace' },
    new_string: { type: 'string', description: 'Replacement string' },
  },
  required: ['path', 'old_string', 'new_string'],
  additionalProperties: false,
};

export const editFileHandler: ToolHandler = async (args, env) => {
  const filePath = args.path as string;
  const oldString = args.old_string as string;
  const newString = args.new_string as string;

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

  if (matches.length === 0) {
    return `Error: old_string not found in ${filePath} — did the content change? Try read_file first.`;
  }

  if (matches.length > 1) {
    // Find line numbers for each match
    const lineNumbers = matches.map((idx) => {
      const before = content.slice(0, idx);
      return before.split('\n').length;
    });
    return `Error: found ${matches.length} matches for old_string at lines ${lineNumbers.join(', ')} in ${filePath} — provide more context to make the match unique.`;
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

export const editFileDescription = 'Replace an exact string match in a file. Fails if zero or multiple matches found.';
