import type { ToolHandler } from '../tool-registry.js';

const MAX_FILES_PER_CALL = 20;

export const readManyFilesSchema = {
  properties: {
    paths: {
      type: 'array',
      items: { type: 'string' },
      minItems: 1,
      maxItems: MAX_FILES_PER_CALL,
      description: 'File paths relative to workspace root',
    },
    offset: { type: 'integer', minimum: 1, description: 'Line number to start reading from' },
    limit: { type: 'integer', minimum: 1, description: 'Number of lines to read from each file' },
  },
  required: ['paths'],
  additionalProperties: false,
};

export const readManyFilesHandler: ToolHandler = async (args, env) => {
  const paths = args.paths as string[];
  const offset = args.offset as number | undefined;
  const limit = args.limit as number | undefined;

  if (paths.length > MAX_FILES_PER_CALL) {
    return `Error: read_many_files accepts at most ${MAX_FILES_PER_CALL} paths per call.`;
  }

  const sections = await Promise.all(paths.map(async (filePath) => {
    try {
      const content = await env.readFile(filePath);
      const formatted = formatLineNumberedSlice(content, offset, limit);
      return `=== ${filePath} ===\n${formatted}`;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return `=== ${filePath} ===\nError: ${message}`;
    }
  }));

  return sections.join('\n\n');
};

export const readManyFilesDescription =
  'Read multiple files in one call and return line-numbered content sections with path headers.';

function formatLineNumberedSlice(content: string, offset?: number, limit?: number): string {
  // Keep read_file behavior for binary detection so this tool fails safely on non-text input.
  const checkSize = Math.min(content.length, 8192);
  for (let i = 0; i < checkSize; i++) {
    if (content.charCodeAt(i) === 0) {
      return 'Error: appears to be a binary file. Cannot display binary content.';
    }
  }

  const lines = content.split('\n');
  const startLine = offset ? offset - 1 : 0;
  const endLine = limit ? startLine + limit : lines.length;
  const slice = lines.slice(startLine, endLine);

  return slice
    .map((line, i) => {
      const lineNum = startLine + i + 1;
      const padded = String(lineNum).padStart(String(endLine).length, ' ');
      return `${padded}\t${line}`;
    })
    .join('\n');
}
