import { parseGardenSource } from '../garden/parse.js';
import type { CompletedNodeState } from '../engine/types.js';
import type { GraphExecutionState } from './types.js';

interface VizInstance {
  renderString(dot: string): string;
}

type RenderState = 'completed' | 'running' | 'failed' | 'pending';

const COLOR_BY_STATE: Record<RenderState, { fill: string; stroke: string; font: string }> = {
  completed: { fill: '#C8E6C9', stroke: '#2E7D32', font: '#1B5E20' },
  running: { fill: '#FFF3C4', stroke: '#F9A825', font: '#7A5A00' },
  failed: { fill: '#FFCDD2', stroke: '#C62828', font: '#B71C1C' },
  pending: { fill: '#ECEFF1', stroke: '#90A4AE', font: '#37474F' },
};

export class GraphRenderer {
  private viz: Promise<VizInstance | null> | null = null;

  async render(dotSource: string, executionState?: GraphExecutionState): Promise<string> {
    const decoratedDot = executionState
      ? decorateDotSource(dotSource, executionState)
      : dotSource;

    const viz = await this.getViz();
    if (viz) {
      return viz.renderString(decoratedDot);
    }

    return renderFallbackSvg(dotSource, executionState);
  }

  private async getViz(): Promise<VizInstance | null> {
    if (!this.viz) {
      this.viz = loadVizInstance();
    }
    return this.viz;
  }
}

function decorateDotSource(dotSource: string, executionState: GraphExecutionState): string {
  const graph = parseGardenSource(dotSource, '<graph-render>');
  const completedByNode = new Map<string, CompletedNodeState>();
  for (const completed of executionState.completed_nodes) {
    completedByNode.set(completed.node_id, completed);
  }

  const lines: string[] = ['digraph RenderedGarden {'];

  for (const [key, value] of Object.entries(graph.graphAttributes)) {
    lines.push(`  ${escapeId(key)}=${escapeValue(value)};`);
  }

  for (const node of graph.nodes) {
    const state = resolveState(node.id, executionState, completedByNode);
    const colors = COLOR_BY_STATE[state];
    const nodeAttributes = {
      ...node.attributes,
      style: mergeStyle(node.attributes.style, 'filled,rounded'),
      fillcolor: colors.fill,
      color: colors.stroke,
      fontcolor: colors.font,
    };
    lines.push(`  ${escapeId(node.id)}${formatAttributes(nodeAttributes)};`);
  }

  for (const edge of graph.edges) {
    lines.push(`  ${escapeId(edge.source)} -> ${escapeId(edge.target)}${formatAttributes(edge.attributes)};`);
  }

  lines.push('}');
  return lines.join('\n');
}

function resolveState(
  nodeId: string,
  executionState: GraphExecutionState,
  completedByNode: Map<string, CompletedNodeState>
): RenderState {
  const completed = completedByNode.get(nodeId);
  if (completed) {
    if (completed.status === 'failure' || completed.status === 'retry') {
      return 'failed';
    }
    return 'completed';
  }

  if (executionState.status === 'running' && executionState.current_node === nodeId) {
    return 'running';
  }

  return 'pending';
}

function formatAttributes(attributes: Record<string, string | undefined>): string {
  const parts = Object.entries(attributes)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${escapeId(key)}=${escapeValue(value ?? '')}`);
  if (parts.length === 0) {
    return '';
  }
  return ` [${parts.join(', ')}]`;
}

function mergeStyle(existing: string | undefined, required: string): string {
  const set = new Set<string>();
  for (const chunk of (existing ?? '').split(',')) {
    const style = chunk.trim();
    if (style) {
      set.add(style);
    }
  }
  for (const chunk of required.split(',')) {
    const style = chunk.trim();
    if (style) {
      set.add(style);
    }
  }
  return Array.from(set).join(',');
}

function escapeId(value: string): string {
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
    return value;
  }
  return escapeValue(value);
}

function escapeValue(value: string): string {
  const escaped = value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n');
  return `"${escaped}"`;
}

async function loadVizInstance(): Promise<VizInstance | null> {
  try {
    const dynamicImport = new Function('modulePath', 'return import(modulePath)') as (
      modulePath: string
    ) => Promise<{ instance?: () => Promise<{ renderString: (dot: string) => string }> }>;
    const mod = await dynamicImport('@viz-js/viz');
    if (!mod.instance) {
      return null;
    }
    const viz = await mod.instance();
    return {
      renderString(dot: string): string {
        return viz.renderString(dot);
      },
    };
  } catch {
    return null;
  }
}

function renderFallbackSvg(dotSource: string, executionState?: GraphExecutionState): string {
  const graph = parseGardenSource(dotSource, '<graph-fallback-render>');
  const completedByNode = new Map<string, CompletedNodeState>();
  for (const completed of executionState?.completed_nodes ?? []) {
    completedByNode.set(completed.node_id, completed);
  }

  const nodeWidth = 240;
  const nodeHeight = 48;
  const marginX = 32;
  const marginY = 24;
  const spacingY = 86;
  const width = marginX * 2 + nodeWidth;
  const height = Math.max(140, marginY * 2 + graph.nodes.length * spacingY);

  const positions = new Map<string, { x: number; y: number }>();
  for (let index = 0; index < graph.nodes.length; index += 1) {
    const node = graph.nodes[index]!;
    positions.set(node.id, { x: marginX, y: marginY + index * spacingY });
  }

  const edgeLines: string[] = [];
  for (const edge of graph.edges) {
    const from = positions.get(edge.source);
    const to = positions.get(edge.target);
    if (!from || !to) {
      continue;
    }
    const x1 = from.x + nodeWidth / 2;
    const y1 = from.y + nodeHeight;
    const x2 = to.x + nodeWidth / 2;
    const y2 = to.y;
    edgeLines.push(
      `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#64748b" stroke-width="1.5" marker-end="url(#arrow)" />`
    );
  }

  const nodes: string[] = [];
  for (const node of graph.nodes) {
    const position = positions.get(node.id);
    if (!position) {
      continue;
    }
    const state = executionState
      ? resolveState(node.id, executionState, completedByNode)
      : 'pending';
    const colors = COLOR_BY_STATE[state];
    nodes.push(
      `<g>\n  <rect x="${position.x}" y="${position.y}" rx="8" ry="8" width="${nodeWidth}" height="${nodeHeight}" fill="${colors.fill}" stroke="${colors.stroke}" stroke-width="1.8" />\n  <text x="${position.x + 12}" y="${position.y + 30}" font-family="ui-sans-serif, -apple-system, sans-serif" font-size="13" fill="${colors.font}">${escapeXml(
        node.label ?? node.id
      )}</text>\n</g>`
    );
  }

  return `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">\n  <defs>\n    <marker id="arrow" markerWidth="10" markerHeight="8" refX="8" refY="4" orient="auto">\n      <path d="M0,0 L10,4 L0,8 z" fill="#64748b" />\n    </marker>\n  </defs>\n  <rect x="0" y="0" width="${width}" height="${height}" fill="#f8fafc" />\n  ${edgeLines.join('\n  ')}\n  ${nodes.join('\n  ')}\n</svg>\n`;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
