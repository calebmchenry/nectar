import path from 'node:path';
import { GardenParseError, hashDotSource, parseGardenFile } from '../../garden/parse.js';
import { validateGarden } from '../../garden/validate.js';
import { Diagnostic, GardenGraph } from '../../garden/types.js';

export interface LoadValidationResult {
  graph: GardenGraph | null;
  diagnostics: Diagnostic[];
  graph_hash?: string;
}

export async function loadAndValidate(dotFile: string): Promise<LoadValidationResult> {
  try {
    const graph = await parseGardenFile(dotFile);
    const diagnostics = validateGarden(graph);
    return {
      graph,
      diagnostics,
      graph_hash: hashDotSource(graph.dotSource)
    };
  } catch (error) {
    if (error instanceof GardenParseError) {
      const location = error.location;
      return {
        graph: null,
        diagnostics: [
          {
            severity: 'error',
            code: 'DOT_PARSE_ERROR',
            message: error.message,
            file: path.resolve(dotFile),
            location
          }
        ]
      };
    }
    throw error;
  }
}

export function formatDiagnostic(diagnostic: Diagnostic): string {
  const file = diagnostic.file ?? '<unknown>';
  const line = diagnostic.location?.line ?? 1;
  const col = diagnostic.location?.col ?? 1;
  return `${file}:${line}:${col} ${diagnostic.severity.toUpperCase()} ${diagnostic.code} ${diagnostic.message}`;
}

export function hasErrors(diagnostics: Diagnostic[]): boolean {
  return diagnostics.some((diagnostic) => diagnostic.severity === 'error');
}
