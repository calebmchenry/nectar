import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { UnifiedClient, createLLMClient } from '../llm/client.js';
import type { LLMClient } from '../llm/types.js';
import { HandlerExecutionInput, NodeOutcome, NodeStatus } from '../engine/types.js';
import { deserializeParallelResults, ParallelResults } from '../engine/parallel-results.js';
import { NodeHandler } from './registry.js';

const STATUS_RANK: Record<string, number> = {
  success: 0,
  partial_success: 1,
  retry: 2,
  failure: 3,
  skipped: 4
};

interface BranchCandidate {
  branchId: string;
  status: NodeStatus;
  notes: string;
  lastResponseExcerpt: string;
}

interface FanInSelection {
  selected_branch_id: string;
  rationale: string;
}

export class FanInHandler implements NodeHandler {
  private readonly client: UnifiedClient | LLMClient;

  constructor(client?: UnifiedClient | LLMClient) {
    this.client = client ?? createLLMClient();
  }

  async execute(input: HandlerExecutionInput): Promise<NodeOutcome> {
    const hasResultsEntries = hasParallelResultsEntries(input.context);
    const branches = collectBranches(input.context);
    if (branches.length === 0) {
      return {
        status: 'failure',
        error_message: hasResultsEntries
          ? 'Fan-in node found no branches in parallel results.'
          : 'Fan-in node found no parallel.results entries in context.'
      };
    }

    if (!input.node.prompt) {
      return this.runHeuristicPath(input.node.id, branches);
    }

    return this.runPromptedPath(input, branches);
  }

  private runHeuristicPath(nodeId: string, allBranches: Array<{ branchId: string; status: NodeStatus }>): NodeOutcome {
    const ranked = allBranches.slice();
    ranked.sort((a, b) => {
      const rankA = STATUS_RANK[a.status] ?? 99;
      const rankB = STATUS_RANK[b.status] ?? 99;
      if (rankA !== rankB) {
        return rankA - rankB;
      }
      return a.branchId.localeCompare(b.branchId);
    });

    const best = ranked[0]!;
    const rationale = `Selected '${best.branchId}' by heuristic status ranking (${best.status}).`;
    return {
      status: 'success',
      notes: rationale,
      context_updates: {
        'parallel.fan_in.best_id': best.branchId,
        'parallel.fan_in.best_outcome': best.status,
        'parallel.fan_in.rationale': rationale,
        [`${nodeId}.rationale`]: rationale,
        'fan_in_selected_branch': best.branchId,
        'fan_in_selected_status': best.status,
      }
    };
  }

  private async runPromptedPath(
    input: HandlerExecutionInput,
    branches: Array<{ branchId: string; status: NodeStatus; contextSnapshot: Record<string, string> }>
  ): Promise<NodeOutcome> {
    if (!(this.client instanceof UnifiedClient)) {
      return {
        status: 'failure',
        error_message: 'Prompted fan-in requires UnifiedClient support.',
      };
    }

    const candidates = branches.map((branch) => ({
      branchId: branch.branchId,
      status: branch.status,
      notes: buildNotes(branch.contextSnapshot),
      lastResponseExcerpt: extractLastResponseExcerpt(branch.contextSnapshot),
    }));

    const selectionSchema = {
      type: 'object',
      additionalProperties: false,
      properties: {
        selected_branch_id: {
          type: 'string',
          enum: candidates.map((candidate) => candidate.branchId),
        },
        rationale: {
          type: 'string',
          minLength: 0,
          maxLength: 2000,
        },
      },
      required: ['selected_branch_id', 'rationale'],
    };

    const promptPayload = {
      rubric: input.node.prompt,
      candidates: candidates.map((candidate) => ({
        branch_id: candidate.branchId,
        status: candidate.status,
        notes: candidate.notes,
        last_response_excerpt: candidate.lastResponseExcerpt,
      })),
    };
    const provider = input.node.llmProvider ?? input.node.attributes.llm_provider?.trim() ?? undefined;
    const model = input.node.llmModel ?? input.node.attributes.llm_model?.trim() ?? undefined;

    try {
      const response = await this.client.generateObject<FanInSelection>({
        provider,
        model,
        // Root cause note (Sprint 025 Phase 1): fan-in stalls happened when malformed
        // structured responses retried repeatedly. Keep retries finite and explicit.
        max_validation_retries: 2,
        reasoning_effort: resolveReasoningEffort(
          input.node.reasoningEffort ?? input.node.attributes.reasoning_effort?.trim()
        ),
        system:
          'You are evaluating parallel pipeline branch outcomes. Select the single best branch and explain the decision.',
        messages: [
          {
            role: 'user',
            content: JSON.stringify(promptPayload, null, 2),
          },
        ],
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: 'fan_in_selection',
            schema: selectionSchema,
            strict: true,
          },
        },
      });

      await persistPromptedArtifacts(input.run_dir, input.node.id, {
        request: promptPayload,
        response: {
          provider: response.provider,
          model: response.model,
          raw_text: response.raw_text,
          object: response.object,
          usage: response.usage,
        },
      });

      const selected = candidates.find((candidate) => candidate.branchId === response.object.selected_branch_id);
      if (!selected) {
        return {
          status: 'failure',
          error_message: `Prompted fan-in selected unknown branch '${response.object.selected_branch_id}'.`,
        };
      }

      const rationale = response.object.rationale.trim();
      const contextUpdates = {
        'parallel.fan_in.best_id': selected.branchId,
        'parallel.fan_in.best_outcome': selected.status,
        'parallel.fan_in.rationale': rationale,
        [`${input.node.id}.rationale`]: rationale,
        'fan_in_selected_branch': selected.branchId,
        'fan_in_selected_status': selected.status,
      };

      return {
        status: 'success',
        notes: rationale,
        context_updates: contextUpdates,
      };
    } catch (error) {
      return {
        status: 'failure',
        error_message: `Prompted fan-in evaluation failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }
}

function hasParallelResultsEntries(context: Record<string, string>): boolean {
  if (typeof context['parallel.results'] === 'string' && context['parallel.results'].length > 0) {
    return true;
  }
  return Object.keys(context).some((key) => key.startsWith('parallel.results.'));
}

function collectBranches(
  context: Record<string, string>
): Array<{ branchId: string; status: NodeStatus; contextSnapshot: Record<string, string> }> {
  const branches: Array<{ branchId: string; status: NodeStatus; contextSnapshot: Record<string, string> }> = [];

  const serializedValues: string[] = context['parallel.results']
    ? [context['parallel.results']]
    : Object.entries(context)
      .filter(([key]) => key.startsWith('parallel.results.'))
      .map(([, value]) => value);

  for (const serialized of serializedValues) {
    if (!serialized) {
      continue;
    }

    try {
      const results: ParallelResults = deserializeParallelResults(serialized);
      for (const branch of results.branches) {
        branches.push({
          branchId: branch.branchId,
          status: branch.status,
          contextSnapshot: branch.contextSnapshot,
        });
      }
    } catch {
      // Skip malformed entries.
    }
  }

  return branches;
}

function buildNotes(snapshot: Record<string, string>): string {
  const noteParts: string[] = [];
  if (snapshot['outcome']) {
    noteParts.push(`outcome=${snapshot['outcome']}`);
  }
  if (snapshot['preferred_label']) {
    noteParts.push(`preferred_label=${snapshot['preferred_label']}`);
  }
  if (snapshot['last_stage']) {
    noteParts.push(`last_stage=${snapshot['last_stage']}`);
  }
  return noteParts.join(', ');
}

function extractLastResponseExcerpt(snapshot: Record<string, string>): string {
  if (snapshot['last_response']) {
    return snapshot['last_response'].slice(0, 500);
  }

  const responseEntry = Object.entries(snapshot)
    .filter(([key, value]) => key.endsWith('.response') && value.trim().length > 0)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .at(-1);
  return responseEntry?.[1].slice(0, 500) ?? '';
}

function resolveReasoningEffort(value: string | undefined): 'low' | 'medium' | 'high' | undefined {
  if (!value) {
    return undefined;
  }
  if (value === 'low' || value === 'medium' || value === 'high') {
    return value;
  }
  return undefined;
}

async function persistPromptedArtifacts(
  runDir: string,
  nodeId: string,
  payload: { request: unknown; response: unknown }
): Promise<void> {
  const nodeDir = path.join(runDir, nodeId);
  await mkdir(nodeDir, { recursive: true });
  await writeFile(path.join(nodeDir, 'fan-in-evaluation.request.json'), JSON.stringify(payload.request, null, 2), 'utf8');
  await writeFile(path.join(nodeDir, 'fan-in-evaluation.response.json'), JSON.stringify(payload.response, null, 2), 'utf8');
}
