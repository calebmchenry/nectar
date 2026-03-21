import { GardenParseError } from '../garden/parse.js';
import { PipelinePreparer } from '../garden/preparer.js';
import type { Diagnostic } from '../garden/types.js';
import { GraphRenderer } from '../server/graph-renderer.js';

export interface GardenPreviewInput {
  dot_source: string;
  dot_path?: string;
}

export interface GardenPreviewMetadata {
  node_count: number;
  edge_count: number;
}

export interface GardenPreviewResult {
  parse_ok: boolean;
  valid: boolean;
  diagnostics: Diagnostic[];
  metadata: GardenPreviewMetadata;
  svg?: string;
}

export class GardenPreviewService {
  private readonly renderer: GraphRenderer;
  private readonly preparer: PipelinePreparer;

  constructor(renderer?: GraphRenderer, preparer?: PipelinePreparer) {
    this.renderer = renderer ?? new GraphRenderer();
    this.preparer = preparer ?? new PipelinePreparer();
  }

  async preview(input: GardenPreviewInput): Promise<GardenPreviewResult> {
    const dotSource = input.dot_source ?? '';
    if (dotSource.trim().length === 0) {
      return {
        parse_ok: false,
        valid: false,
        diagnostics: [
          {
            severity: 'error',
            code: 'DOT_EMPTY',
            message: 'dot_source is required.',
          },
        ],
        metadata: {
          node_count: 0,
          edge_count: 0,
        },
      };
    }

    try {
      const prepared = await this.preparer.prepareFromSource(dotSource, input.dot_path ?? '<preview>');
      const { diagnostics } = prepared;
      const valid = diagnostics.every((diagnostic) => diagnostic.severity !== 'error');

      let svg: string | undefined;
      try {
        svg = await this.renderer.render(prepared.prepared_dot);
      } catch {
        // Rendering fallback is best-effort in preview mode.
      }

      return {
        parse_ok: true,
        valid,
        diagnostics,
        metadata: {
          node_count: prepared.graph.nodes.length,
          edge_count: prepared.graph.edges.length,
        },
        svg,
      };
    } catch (error) {
      if (error instanceof GardenParseError) {
        return {
          parse_ok: false,
          valid: false,
          diagnostics: [
            {
              severity: 'error',
              code: 'DOT_PARSE_ERROR',
              message: error.message,
              location: error.location,
              file: input.dot_path ?? '<preview>',
            },
          ],
          metadata: {
            node_count: 0,
            edge_count: 0,
          },
        };
      }
      throw error;
    }
  }
}
