import type { ToolHandler } from '../tool-registry.js';

export const readFileSchema = {
  properties: {
    file_path: { type: 'string', description: 'File path relative to workspace root' },
    path: { type: 'string', description: 'Deprecated alias for file_path' },
    offset: { type: 'integer', minimum: 1, description: 'Line number to start reading from' },
    limit: { type: 'integer', minimum: 1, description: 'Number of lines to read' },
  },
  additionalProperties: false,
};

export const readFileHandler: ToolHandler = async (args, env) => {
  const filePath = (args.file_path ?? args.path) as string;
  const offset = args.offset as number | undefined;
  const limit = args.limit as number | undefined;

  const resolved = await env.resolvePath(filePath);
  const content = await env.readFile(filePath);

  // Binary detection: check for null bytes in first 8KB
  const checkSize = Math.min(content.length, 8192);
  for (let i = 0; i < checkSize; i++) {
    if (content.charCodeAt(i) === 0) {
      return `Error: '${filePath}' appears to be a binary file. Cannot display binary content.`;
    }
  }

  const lines = content.split('\n');
  const startLine = offset ? offset - 1 : 0;
  const endLine = limit ? startLine + limit : lines.length;
  const slice = lines.slice(startLine, endLine);

  // Return line-numbered text
  return slice
    .map((line, i) => {
      const lineNum = startLine + i + 1;
      const padded = String(lineNum).padStart(String(endLine).length, ' ');
      return `${padded}\t${line}`;
    })
    .join('\n');
};

export const readFileDescription = 'Read a file and return its contents with line numbers. Detects and rejects binary files.';
