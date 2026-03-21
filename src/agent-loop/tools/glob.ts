import type { ToolHandler } from '../tool-registry.js';
import { runGlobSearch } from '../search.js';

export const globSchema = {
  properties: {
    pattern: { type: 'string', description: 'Glob pattern to match files (e.g. "**/*.ts", "src/*.js")' },
    max_results: { type: 'integer', default: 200, description: 'Maximum number of results' },
  },
  required: ['pattern'],
  additionalProperties: false,
};

export const globHandler: ToolHandler = async (args, env) => {
  const pattern = args.pattern as string;
  const maxResults = (args.max_results as number | undefined) ?? 200;
  const results = await runGlobSearch(env, pattern, maxResults);

  if (results.length === 0) {
    return `No files matching pattern '${pattern}'.`;
  }

  return results.join('\n');
};

export const globDescription = 'Find files matching a glob pattern in the workspace. Returns workspace-relative paths. Respects .gitignore.';
