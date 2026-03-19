export type NodeKind = 'start' | 'exit' | 'tool' | 'unknown';

export type Severity = 'error' | 'warning';

export interface SourceLocation {
  line: number;
  col: number;
}

export interface Diagnostic {
  severity: Severity;
  code: string;
  message: string;
  file?: string;
  location?: SourceLocation;
}

export interface GardenNode {
  id: string;
  label?: string;
  shape?: string;
  type?: string;
  kind: NodeKind;
  maxRetries?: number;
  timeoutMs?: number;
  attributes: Record<string, string>;
  location?: SourceLocation;
}

export interface GardenEdge {
  source: string;
  target: string;
  label?: string;
  condition?: string;
  weight: number;
  attributes: Record<string, string>;
  location?: SourceLocation;
}

export interface GardenGraph {
  dotPath: string;
  dotSource: string;
  graphAttributes: Record<string, string>;
  nodes: GardenNode[];
  edges: GardenEdge[];
  nodeMap: Map<string, GardenNode>;
  outgoing: Map<string, GardenEdge[]>;
  incoming: Map<string, GardenEdge[]>;
}

export interface ParsedStatement {
  text: string;
  line: number;
  col: number;
}

export const SUPPORTED_SHAPES = new Set<string>(['mdiamond', 'msquare', 'parallelogram']);

export function normalizeShape(shape?: string): string | undefined {
  if (!shape) {
    return undefined;
  }
  return shape.trim().toLowerCase();
}

export function normalizeNodeKind(shape?: string, typeOverride?: string): NodeKind {
  const type = typeOverride?.trim().toLowerCase();
  if (type === 'start') {
    return 'start';
  }
  if (type === 'exit') {
    return 'exit';
  }
  if (type === 'tool') {
    return 'tool';
  }

  const normalizedShape = normalizeShape(shape);
  if (normalizedShape === 'mdiamond') {
    return 'start';
  }
  if (normalizedShape === 'msquare') {
    return 'exit';
  }
  if (normalizedShape === 'parallelogram') {
    return 'tool';
  }

  return 'unknown';
}
