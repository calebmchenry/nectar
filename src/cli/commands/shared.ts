import path from 'node:path';
import { GardenParseError, PipelinePreparer } from '../../garden/preparer.js';
import { Diagnostic, GardenGraph } from '../../garden/types.js';

export interface LoadValidationResult {
  graph: GardenGraph | null;
  diagnostics: Diagnostic[];
  graph_hash?: string;
  graph_hash_kind?: 'source' | 'prepared';
  prepared_dot?: string;
  source_files?: string[];
}

export async function loadAndValidate(dotFile: string): Promise<LoadValidationResult> {
  try {
    const preparer = new PipelinePreparer({ workspaceRoot: process.cwd() });
    const prepared = await preparer.prepareFromPath(dotFile);
    return {
      graph: prepared.graph,
      diagnostics: prepared.diagnostics,
      graph_hash: prepared.graph_hash,
      graph_hash_kind: 'prepared',
      prepared_dot: prepared.prepared_dot,
      source_files: prepared.source_files,
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
