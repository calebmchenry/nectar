import type { ToolHandler } from '../tool-registry.js';

export const writeFileSchema = {
  properties: {
    path: { type: 'string', description: 'File path relative to workspace root' },
    content: { type: 'string', description: 'Content to write to the file' },
  },
  required: ['path', 'content'],
  additionalProperties: false,
};

export const writeFileHandler: ToolHandler = async (args, env) => {
  const filePath = args.path as string;
  const content = args.content as string;

  await env.writeFile(filePath, content);
  const bytes = Buffer.byteLength(content, 'utf8');
  return `Wrote ${bytes} bytes to ${filePath}`;
};

export const writeFileDescription = 'Write content to a file, creating parent directories if needed. Overwrites existing files.';
