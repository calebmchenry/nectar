import { describe, expect, it } from 'vitest';
import { WaitHumanHandler } from '../../src/handlers/wait-human.js';
import { QueueInterviewer } from '../../src/interviewer/queue.js';
import { AutoApproveInterviewer } from '../../src/interviewer/auto-approve.js';
import { GardenEdge, GardenNode } from '../../src/garden/types.js';
import { HandlerExecutionInput } from '../../src/engine/types.js';

function makeNode(overrides: Partial<GardenNode> = {}): GardenNode {
  return {
    id: 'gate',
    kind: 'wait.human',
    label: 'Choose an option',
    attributes: {},
    ...overrides
  };
}

function makeEdge(label: string, target: string): GardenEdge {
  return {
    source: 'gate',
    target,
    label,
    weight: 0,
    attributes: {}
  };
}

function makeInput(node: GardenNode, edges: GardenEdge[]): HandlerExecutionInput {
  return {
    node,
    run_id: 'run-1',
    dot_file: 'test.dot',
    attempt: 1,
    run_dir: '/tmp/test',
    context: {},
    outgoing_edges: edges
  };
}

describe('WaitHumanHandler', () => {
  it('returns success with preferred_label from queue answer', async () => {
    const interviewer = new QueueInterviewer([{ selected_label: '[R] Reject', source: 'queue' }]);
    const handler = new WaitHumanHandler(interviewer);

    const node = makeNode();
    const edges = [makeEdge('[A] Approve', 'deploy'), makeEdge('[R] Reject', 'abort')];
    const outcome = await handler.execute(makeInput(node, edges));

    expect(outcome.status).toBe('success');
    expect(outcome.preferred_label).toBe('[R] Reject');
    expect(outcome.suggested_next).toEqual(['abort']);
    expect(outcome.context_updates?.['human.gate.selected']).toBe('1');
    expect(outcome.context_updates?.['human.gate.label']).toBe('[R] Reject');
  });

  it('detects YES_NO question type for yes/no choices', async () => {
    const interviewer = new QueueInterviewer([{ selected_label: 'Yes', source: 'queue' }]);
    const handler = new WaitHumanHandler(interviewer);

    const edges = [makeEdge('Yes', 'proceed'), makeEdge('No', 'stop')];
    const outcome = await handler.execute(makeInput(makeNode(), edges));

    expect(outcome.status).toBe('success');
    expect(outcome.preferred_label).toBe('Yes');
  });

  it('uses CONFIRMATION type for affirmative/decline choices and renders confirmation guidance', async () => {
    const askedQuestions: Array<{ type: string; text: string }> = [];
    const interviewer = {
      async ask(question: { type: string; text: string }) {
        askedQuestions.push({ type: question.type, text: question.text });
        return { selected_label: 'Approve', source: 'user' as const };
      },
      async ask_multiple() {
        return [];
      },
      inform() {
        // no-op
      },
    };
    const handler = new WaitHumanHandler(interviewer);

    const edges = [makeEdge('Approve', 'proceed'), makeEdge('Decline', 'stop')];
    const outcome = await handler.execute(makeInput(makeNode({ label: 'Deploy now?' }), edges));

    expect(outcome.status).toBe('success');
    expect(askedQuestions).toHaveLength(1);
    expect(askedQuestions[0]?.type).toBe('CONFIRMATION');
    expect(askedQuestions[0]?.text).toContain('affirmative option');
  });

  it('fails with 0 labeled edges', async () => {
    const interviewer = new AutoApproveInterviewer();
    const handler = new WaitHumanHandler(interviewer);

    const edges = [makeEdge('', 'deploy')]; // empty label
    const outcome = await handler.execute(makeInput(makeNode(), edges));

    expect(outcome.status).toBe('failure');
    expect(outcome.error_message).toMatch(/no outgoing edges with labels/);
  });

  it('fails with duplicate normalized labels', async () => {
    const interviewer = new AutoApproveInterviewer();
    const handler = new WaitHumanHandler(interviewer);

    const edges = [makeEdge('[A] Approve', 'x'), makeEdge('[B] Approve', 'y')];
    const outcome = await handler.execute(makeInput(makeNode(), edges));

    expect(outcome.status).toBe('failure');
    expect(outcome.error_message).toMatch(/duplicate normalized label/);
  });

  it('fails with duplicate accelerator keys', async () => {
    const interviewer = new AutoApproveInterviewer();
    const handler = new WaitHumanHandler(interviewer);

    const edges = [makeEdge('[A] Accept', 'x'), makeEdge('[A] Abort', 'y')];
    const outcome = await handler.execute(makeInput(makeNode(), edges));

    expect(outcome.status).toBe('failure');
    expect(outcome.error_message).toMatch(/duplicate accelerator/);
  });

  it('fails when default_choice matches no edge', async () => {
    const interviewer = new AutoApproveInterviewer();
    const handler = new WaitHumanHandler(interviewer);

    const node = makeNode({ humanDefaultChoice: 'nonexistent' });
    const edges = [makeEdge('Approve', 'deploy'), makeEdge('Reject', 'abort')];
    const outcome = await handler.execute(makeInput(node, edges));

    expect(outcome.status).toBe('failure');
    expect(outcome.error_message).toMatch(/matches no outgoing edge/);
  });

  it('auto-approve selects default_choice', async () => {
    const interviewer = new AutoApproveInterviewer();
    const handler = new WaitHumanHandler(interviewer);

    const node = makeNode({ humanDefaultChoice: 'Reject' });
    const edges = [makeEdge('Approve', 'deploy'), makeEdge('Reject', 'abort')];
    const outcome = await handler.execute(makeInput(node, edges));

    expect(outcome.status).toBe('success');
    expect(outcome.preferred_label).toBe('Reject');
  });

  it('returns SKIPPED success when queue is exhausted', async () => {
    const interviewer = new QueueInterviewer([]);
    const handler = new WaitHumanHandler(interviewer);

    const edges = [makeEdge('Go', 'next')];
    const outcome = await handler.execute(makeInput(makeNode(), edges));

    expect(outcome.status).toBe('success');
    expect(outcome.preferred_label).toBe('SKIPPED');
    expect(outcome.context_updates?.['human.gate.selected']).toBe('SKIPPED');
    expect(outcome.context_updates?.['human.gate.label']).toBe('SKIPPED');
  });
});
