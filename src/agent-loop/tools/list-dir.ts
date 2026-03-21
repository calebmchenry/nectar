import type { ToolHandler } from '../tool-registry.js';

const DEFAULT_DEPTH = 1;
const MAX_DEPTH = 8;

export const listDirSchema = {
  properties: {
    path: { type: 'string', description: 'Directory path relative to workspace root' },
    depth: { type: 'integer', minimum: 0, maximum: MAX_DEPTH, default: DEFAULT_DEPTH },
  },
  required: ['path'],
  additionalProperties: false,
};

export const listDirHandler: ToolHandler = async (args, env) => {
  const requestedPath = args.path as string;
  const requestedDepth = (args.depth as number | undefined) ?? DEFAULT_DEPTH;
  const depth = Math.max(0, Math.min(MAX_DEPTH, requestedDepth));
  return env.list_directory(requestedPath, depth);
};

export const listDirDescription =
  'List directory contents as a tree up to a configurable depth. Respects workspace boundaries and .gitignore.';
