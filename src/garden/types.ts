export type NodeKind = 'start' | 'exit' | 'tool' | 'codergen' | 'conditional' | 'wait.human' | 'parallel' | 'parallel.fan_in' | 'stack.manager_loop' | 'unknown';

export type Severity = 'error' | 'warning' | 'info';

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
  fix?: string;
  node_id?: string;
  edge?: {
    source: string;
    target: string;
    label?: string;
    condition?: string;
  };
}

export interface NodeProvenance {
  dotPath: string;
  originalId: string;
}

export interface EdgeProvenance {
  dotPath: string;
  originalSource: string;
  originalTarget: string;
}

export interface SubgraphProvenance {
  dotPath: string;
  originalId: string;
}

export interface GardenNode {
  id: string;
  label?: string;
  shape?: string;
  type?: string;
  kind: NodeKind;
  maxRetries?: number;
  retryPolicy?: string;
  timeoutMs?: number;
  goalGate?: boolean;
  retryTarget?: string;
  fallbackRetryTarget?: string;
  prompt?: string;
  allowPartial?: boolean;
  humanDefaultChoice?: string;
  joinPolicy?: string;
  maxParallel?: number;
  llmModel?: string;
  llmProvider?: string;
  reasoningEffort?: string;
  autoStatus?: boolean;
  fidelity?: string;
  threadId?: string;
  toolCommand?: string;
  toolCommandFromScript?: boolean;
  assertExists?: string[];
  managerPollIntervalMs?: number;
  managerMaxCycles?: number;
  managerStopCondition?: string;
  managerActions?: string[];
  childAutostart?: boolean;
  toolHooksPre?: string;
  toolHooksPost?: string;
  classes: string[];
  attributes: Record<string, string>;
  location?: SourceLocation;
  provenance?: NodeProvenance;
}

export interface GardenEdge {
  source: string;
  target: string;
  label?: string;
  condition?: string;
  weight: number;
  fidelity?: string;
  threadId?: string;
  loopRestart: boolean;
  attributes: Record<string, string>;
  location?: SourceLocation;
  provenance?: EdgeProvenance;
}

export interface Subgraph {
  id: string;
  label?: string;
  nodeIds: string[];
  provenance?: SubgraphProvenance;
}

export interface GardenGraph {
  dotPath: string;
  dotSource: string;
  graphAttributes: Record<string, string>;
  defaultMaxRetries?: number;
  defaultRetryPolicy?: string;
  defaultFidelity?: string;
  modelStylesheet?: string;
  childDotfile?: string;
  childWorkdir?: string;
  toolHooksPre?: string;
  toolHooksPost?: string;
  maxRestartDepth?: number;
  nodes: GardenNode[];
  edges: GardenEdge[];
  subgraphs: Subgraph[];
  nodeMap: Map<string, GardenNode>;
  outgoing: Map<string, GardenEdge[]>;
  incoming: Map<string, GardenEdge[]>;
}

export interface ParsedStatement {
  text: string;
  line: number;
  col: number;
}

export const SUPPORTED_SHAPES = new Set<string>(['mdiamond', 'msquare', 'parallelogram', 'box', 'diamond', 'hexagon', 'component', 'tripleoctagon', 'house']);

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
  if (normalizedShape === 'box') {
    return 'codergen';
  }
  if (normalizedShape === 'diamond') {
    return 'conditional';
  }
  if (normalizedShape === 'hexagon') {
    return 'wait.human';
  }
  if (normalizedShape === 'component') {
    return 'parallel';
  }
  if (normalizedShape === 'tripleoctagon') {
    return 'parallel.fan_in';
  }
  if (normalizedShape === 'house') {
    return 'stack.manager_loop';
  }

  return 'unknown';
}
