import type { NodeStatus } from './types.js';
import type { CompletedNodeState } from './types.js';

export const OUTPUT_PREVIEW_MAX_CHARS = 1024;

export interface StepResultState {
  node_id: string;
  status: NodeStatus;
  output_preview?: string;
  output_artifact_id?: string;
  updated_at: string;
}

export function tailPreservingPreview(value: string | undefined, maxChars = OUTPUT_PREVIEW_MAX_CHARS): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (maxChars <= 0) {
    return '';
  }
  if (value.length <= maxChars) {
    return value;
  }
  return value.slice(0, maxChars);
}

export function toOutputPreview(value: string | undefined): string | undefined {
  return tailPreservingPreview(value, OUTPUT_PREVIEW_MAX_CHARS);
}

export function createStepResultState(input: {
  node_id: string;
  status: NodeStatus;
  updated_at?: string;
  output_preview?: string;
  output_artifact_id?: string;
}): StepResultState {
  const preview = tailPreservingPreview(input.output_preview);
  return {
    node_id: input.node_id,
    status: input.status,
    updated_at: input.updated_at ?? new Date().toISOString(),
    output_preview: preview && preview.length > 0 ? preview : undefined,
    output_artifact_id: input.output_artifact_id,
  };
}

export function toConditionSteps(
  stepResults: Record<string, StepResultState>
): Record<string, { status: string; output?: string }> {
  const scope: Record<string, { status: string; output?: string }> = {};
  for (const [nodeId, state] of Object.entries(stepResults)) {
    scope[nodeId] = {
      status: state.status,
      output: state.output_preview,
    };
  }
  return scope;
}

export function stepResultsToConditionState(
  stepResults: Record<string, StepResultState>
): Record<string, { status: string; output?: string }> {
  return toConditionSteps(stepResults);
}

export function buildLegacyStepResults(
  completedNodes: CompletedNodeState[],
  context: Record<string, string>
): Record<string, StepResultState> {
  const result: Record<string, StepResultState> = {};

  for (const node of completedNodes) {
    const output = toOutputPreview(
      context[`${node.node_id}.response`]
      ?? context[`${node.node_id}.stdout`]
      ?? context[`${node.node_id}.stderr`]
      ?? context['tool.output']
      ?? context['tool.stderr']
      ?? context[`${node.node_id}.rationale`]
    );

    result[node.node_id] = createStepResultState({
      node_id: node.node_id,
      status: node.status,
      output_preview: output,
      updated_at: node.completed_at,
    });
  }

  return result;
}
