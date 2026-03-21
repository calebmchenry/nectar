import { GardenEdge, GardenGraph, GardenNode, Subgraph } from './types.js';

export function serializeGardenGraph(graph: GardenGraph): string {
  const lines: string[] = ['digraph PreparedGarden {'];

  const graphAttributes = formatAttributes(graph.graphAttributes);
  if (graphAttributes) {
    lines.push(`  graph ${graphAttributes};`);
  }

  const sortedSubgraphs = graph.subgraphs.slice().sort((a, b) => a.id.localeCompare(b.id));
  for (const subgraph of sortedSubgraphs) {
    lines.push(renderSubgraph(subgraph));
  }

  const sortedNodes = graph.nodes.slice().sort((a, b) => a.id.localeCompare(b.id));
  for (const node of sortedNodes) {
    lines.push(`  ${escapeId(node.id)}${formatAttributes(node.attributes)};`);
  }

  const sortedEdges = graph.edges.slice().sort(compareEdges);
  for (const edge of sortedEdges) {
    lines.push(`  ${escapeId(edge.source)} -> ${escapeId(edge.target)}${formatAttributes(edge.attributes)};`);
  }

  lines.push('}');
  return `${lines.join('\n')}\n`;
}

function renderSubgraph(subgraph: Subgraph): string {
  const lines: string[] = [`  subgraph ${escapeId(subgraph.id)} {`];
  if (subgraph.label) {
    lines.push(`    label=${escapeValue(subgraph.label)};`);
  }
  for (const nodeId of subgraph.nodeIds.slice().sort((a, b) => a.localeCompare(b))) {
    lines.push(`    ${escapeId(nodeId)};`);
  }
  lines.push('  }');
  return lines.join('\n');
}

function compareEdges(a: GardenEdge, b: GardenEdge): number {
  const source = a.source.localeCompare(b.source);
  if (source !== 0) {
    return source;
  }
  const target = a.target.localeCompare(b.target);
  if (target !== 0) {
    return target;
  }
  const label = (a.label ?? '').localeCompare(b.label ?? '');
  if (label !== 0) {
    return label;
  }
  const condition = (a.condition ?? '').localeCompare(b.condition ?? '');
  if (condition !== 0) {
    return condition;
  }
  const weight = a.weight - b.weight;
  if (weight !== 0) {
    return weight;
  }
  const fidelity = (a.fidelity ?? '').localeCompare(b.fidelity ?? '');
  if (fidelity !== 0) {
    return fidelity;
  }
  const thread = (a.threadId ?? '').localeCompare(b.threadId ?? '');
  if (thread !== 0) {
    return thread;
  }
  if (a.loopRestart !== b.loopRestart) {
    return a.loopRestart ? 1 : -1;
  }

  const aAttributes = serializeAttributeSignature(a.attributes);
  const bAttributes = serializeAttributeSignature(b.attributes);
  return aAttributes.localeCompare(bAttributes);
}

function serializeAttributeSignature(attributes: Record<string, string>): string {
  return Object.entries(attributes)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join(',');
}

function formatAttributes(attributes: Record<string, string>): string {
  const entries = Object.entries(attributes)
    .filter(([, value]) => value !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${escapeId(key)}=${escapeValue(value)}`);

  if (entries.length === 0) {
    return '';
  }

  return ` [${entries.join(', ')}]`;
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
