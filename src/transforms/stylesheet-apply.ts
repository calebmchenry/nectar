import { Diagnostic, GardenGraph } from '../garden/types.js';
import { parseStylesheet, resolveNodeStyle } from '../garden/stylesheet.js';

export interface TransformResult {
  graph: GardenGraph;
  diagnostics: Diagnostic[];
}

export function applyStylesheet(graph: GardenGraph): TransformResult {
  const diagnostics: Diagnostic[] = [];
  const raw = graph.modelStylesheet;

  if (!raw) {
    return { graph, diagnostics };
  }

  const { rules, errors } = parseStylesheet(raw, graph.dotPath);
  diagnostics.push(...errors);

  // Apply resolved styles to each node (only if not already set inline)
  for (const node of graph.nodes) {
    const style = resolveNodeStyle(rules, node);

    if (style.llmModel && !node.llmModel) {
      node.llmModel = style.llmModel;
      node.attributes.llm_model = style.llmModel;
    }

    if (style.llmProvider && !node.llmProvider) {
      node.llmProvider = style.llmProvider;
      node.attributes.llm_provider = style.llmProvider;
    }

    if (style.reasoningEffort && !node.reasoningEffort) {
      node.reasoningEffort = style.reasoningEffort;
      node.attributes.reasoning_effort = style.reasoningEffort;
    }
  }

  return { graph, diagnostics };
}
