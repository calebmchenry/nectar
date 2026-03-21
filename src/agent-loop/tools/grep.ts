import type { ToolHandler } from '../tool-registry.js';
import { runGrepSearch } from '../search.js';

export const grepSchema = {
  properties: {
    pattern: { type: 'string', description: 'Regex pattern to search for' },
    path: { type: 'string', description: 'Subdirectory to search (relative to workspace root)' },
    include: { type: 'string', description: 'Glob pattern to filter files (e.g. "*.ts")' },
    case_insensitive: { type: 'boolean', default: false, description: 'Enable case-insensitive matching' },
    max_results: { type: 'integer', default: 200, description: 'Maximum number of results' },
  },
  required: ['pattern'],
  additionalProperties: false,
};

export const grepHandler: ToolHandler = async (args, env) => {
  const pattern = args.pattern as string;
  const searchPath = args.path as string | undefined;
  const include = args.include as string | undefined;
  const caseInsensitive = args.case_insensitive === true;
  const maxResults = (args.max_results as number | undefined) ?? 200;

  let matches;
  try {
    matches = await runGrepSearch(env, pattern, {
      path: searchPath,
      include,
      caseInsensitive,
      maxResults,
    });
  } catch (error) {
    return `Error: Invalid regex pattern '${pattern}': ${(error as Error).message}`;
  }

  if (matches.length === 0) {
    return `No matches found for pattern '${pattern}'.`;
  }

  return matches.map((match) => `${match.relative_path}:${match.line}:${match.content}`).join('\n');
};

export const grepDescription = 'Search files for a regex pattern. Returns file:line:content format. Respects .gitignore.';
