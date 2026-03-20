import { HandlerExecutionInput, NodeOutcome } from '../engine/types.js';
import { normalizeLabel } from '../engine/edge-selector.js';
import { Answer, Choice, Interviewer, Question, QuestionType, parseAccelerator } from '../interviewer/types.js';
import { NodeHandler } from './registry.js';

const YES_NO_LABELS = new Set(['yes', 'no', 'y', 'n']);

export class WaitHumanHandler implements NodeHandler {
  private readonly interviewer: Interviewer;

  constructor(interviewer: Interviewer) {
    this.interviewer = interviewer;
  }

  async execute(input: HandlerExecutionInput): Promise<NodeOutcome> {
    const outgoing = input.outgoing_edges ?? [];

    // Filter to edges with labels
    const labeledEdges = outgoing.filter((e) => e.label && e.label.trim().length > 0);
    if (labeledEdges.length === 0) {
      return {
        status: 'failure',
        error_message: `Human gate '${input.node.id}' has no outgoing edges with labels.`
      };
    }

    // Build choices from edges
    const choices: Choice[] = labeledEdges.map((edge) => {
      const { accelerator, cleanLabel: _cleanLabel } = parseAccelerator(edge.label!);
      return {
        label: edge.label!,
        accelerator: accelerator ?? undefined,
        edge_target: edge.target
      };
    });

    // Validate: no duplicate normalized labels
    const normalizedLabels = new Set<string>();
    for (const choice of choices) {
      const normalized = normalizeLabel(choice.label);
      if (normalizedLabels.has(normalized)) {
        return {
          status: 'failure',
          error_message: `Human gate '${input.node.id}' has duplicate normalized label '${normalized}'.`
        };
      }
      normalizedLabels.add(normalized);
    }

    // Validate: no duplicate accelerator keys
    const accelerators = new Set<string>();
    for (const choice of choices) {
      if (choice.accelerator) {
        const upper = choice.accelerator.toUpperCase();
        if (accelerators.has(upper)) {
          return {
            status: 'failure',
            error_message: `Human gate '${input.node.id}' has duplicate accelerator key '${upper}'.`
          };
        }
        accelerators.add(upper);
      }
    }

    // Validate: default_choice matches an edge
    const defaultChoice = input.node.humanDefaultChoice;
    if (defaultChoice) {
      const normalizedDefault = normalizeLabel(defaultChoice);
      const matchesDefault = choices.some((c) => normalizeLabel(c.label) === normalizedDefault);
      if (!matchesDefault) {
        return {
          status: 'failure',
          error_message: `Human gate '${input.node.id}' has human.default_choice '${defaultChoice}' which matches no outgoing edge.`
        };
      }
    }

    // Determine question type
    const questionType = detectQuestionType(choices);

    const question: Question = {
      type: questionType,
      text: input.node.label ?? input.node.id,
      choices,
      default_choice: defaultChoice,
      timeout_ms: input.node.timeoutMs,
      node_id: input.node.id,
      run_id: input.run_id
    };

    let answer: Answer;
    try {
      answer = await this.interviewer.ask(question);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        status: 'failure',
        error_message: message
      };
    }

    // Find the target for the selected label
    const normalizedSelected = normalizeLabel(answer.selected_label);
    const matchedChoice = choices.find((c) => normalizeLabel(c.label) === normalizedSelected);
    const target = matchedChoice?.edge_target;

    return {
      status: 'success',
      preferred_label: answer.selected_label,
      suggested_next: target ? [target] : undefined
    };
  }
}

function detectQuestionType(choices: Choice[]): QuestionType {
  if (choices.length === 2) {
    const labels = choices.map((c) => normalizeLabel(c.label));
    if (labels.every((l) => YES_NO_LABELS.has(l))) {
      return 'YES_NO';
    }
  }
  return 'MULTIPLE_CHOICE';
}
