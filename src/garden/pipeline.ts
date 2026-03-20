import { Diagnostic, GardenGraph } from './types.js';
import { validateGarden } from './validate.js';
import { expandGoalVariables } from '../transforms/goal-expansion.js';
import { applyStylesheet } from '../transforms/stylesheet-apply.js';

export interface PipelineResult {
  graph: GardenGraph;
  diagnostics: Diagnostic[];
}

export function transformAndValidate(graph: GardenGraph): PipelineResult {
  const allDiagnostics: Diagnostic[] = [];

  // Transform phase: apply AST transforms
  const goalResult = expandGoalVariables(graph);
  allDiagnostics.push(...goalResult.diagnostics);

  // Apply model stylesheet (after goal expansion, before validation)
  const stylesheetResult = applyStylesheet(goalResult.graph);
  allDiagnostics.push(...stylesheetResult.diagnostics);

  // Validate phase: run structural validation rules
  const validationDiagnostics = validateGarden(stylesheetResult.graph);
  allDiagnostics.push(...validationDiagnostics);

  return {
    graph: stylesheetResult.graph,
    diagnostics: allDiagnostics
  };
}
