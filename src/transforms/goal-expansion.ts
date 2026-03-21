import { Diagnostic, GardenGraph } from '../garden/types.js';
import type { Transform, TransformContext } from './types.js';

export interface TransformResult {
  graph: GardenGraph;
  diagnostics: Diagnostic[];
}

export function expandGoalVariables(graph: GardenGraph): TransformResult {
  const diagnostics: Diagnostic[] = [];
  const goal = graph.graphAttributes.goal;

  for (const node of graph.nodes) {
    if (node.prompt && node.prompt.includes('$goal')) {
      if (!goal) {
        diagnostics.push({
          severity: 'warning',
          code: 'GOAL_UNDEFINED',
          message: `Node '${node.id}' references $goal but no graph-level 'goal' attribute is defined.`,
          file: graph.dotPath,
          location: node.location
        });
        continue;
      }
      node.prompt = node.prompt.replace(/\$goal/g, goal);
    }

    if (node.attributes.prompt && node.attributes.prompt.includes('$goal')) {
      if (!goal) {
        continue;
      }
      node.attributes.prompt = node.attributes.prompt.replace(/\$goal/g, goal);
    }
  }

  return { graph, diagnostics };
}

export class GoalExpansionTransform implements Transform {
  readonly name = 'goal-expansion';

  apply(graph: GardenGraph, _context: TransformContext): TransformResult {
    return expandGoalVariables(graph);
  }
}
