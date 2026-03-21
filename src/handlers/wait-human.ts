import { randomUUID } from 'node:crypto';
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
    const questionId = randomUUID();
    const stage = input.context['last_stage'] || input.node.id;

    const question: Question = {
      id: questionId,
      type: questionType,
      text: input.node.label ?? input.node.id,
      choices,
      default_choice: defaultChoice,
      timeout_ms: input.node.timeoutMs,
      node_id: input.node.id,
      run_id: input.run_id
    };

    const askedAt = Date.now();
    input.emitEvent?.({
      type: 'interview_started',
      run_id: input.run_id,
      node_id: input.node.id,
      question_id: question.id,
      question_text: question.text,
      stage,
    });

    let answer: Answer;
    try {
      answer = await this.interviewer.ask(question);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/timed out/i.test(message)) {
        input.emitEvent?.({
          type: 'interview_timeout',
          run_id: input.run_id,
          node_id: input.node.id,
          question_id: question.id,
          stage,
          duration_ms: Date.now() - askedAt,
        });
      }
      return {
        status: 'failure',
        error_message: message
      };
    }

    const selectedOption = Number.isInteger(answer.selected_option) ? answer.selected_option : undefined;
    const selectedByOption = selectedOption !== undefined && selectedOption >= 0 && selectedOption < choices.length
      ? choices[selectedOption]
      : undefined;
    const preferredLabel = selectedByOption?.label ?? answer.selected_label;
    if (answer.source === 'timeout') {
      input.emitEvent?.({
        type: 'interview_timeout',
        run_id: input.run_id,
        node_id: input.node.id,
        question_id: question.id,
        stage,
        duration_ms: Date.now() - askedAt,
      });
    } else {
      input.emitEvent?.({
        type: 'interview_completed',
        run_id: input.run_id,
        node_id: input.node.id,
        question_id: question.id,
        answer: preferredLabel,
        duration_ms: Date.now() - askedAt,
      });
    }

    // Find the target for the selected label
    const normalizedSelected = normalizeLabel(preferredLabel);
    const matchedChoice = selectedByOption ?? choices.find((c) => normalizeLabel(c.label) === normalizedSelected);
    const target = matchedChoice?.edge_target;
    const selectedValue = selectedOption !== undefined
      ? String(selectedOption)
      : (answer.text ?? preferredLabel);

    return {
      status: 'success',
      preferred_label: preferredLabel,
      suggested_next: target ? [target] : undefined,
      context_updates: {
        'human.gate.selected': selectedValue,
        'human.gate.label': matchedChoice?.label ?? preferredLabel,
      },
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
