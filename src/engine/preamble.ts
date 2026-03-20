import type { FidelityMode } from './fidelity.js';
import { getFidelityBudget } from './fidelity.js';
import type { CompletedNodeState } from './types.js';

export interface PreambleInput {
  mode: FidelityMode;
  goal?: string;
  run_id: string;
  completed_nodes: CompletedNodeRecord[];
  context: Record<string, string>;
}

export interface CompletedNodeRecord {
  node_id: string;
  status: string;
  started_at: string;
  completed_at: string;
  retries: number;
  context_snippet?: string;
  is_human_answer?: boolean;
  human_answer?: string;
}

export function buildPreamble(input: PreambleInput): string {
  switch (input.mode) {
    case 'full':
      return buildFullPreamble(input);
    case 'truncate':
      return buildTruncatePreamble(input);
    case 'compact':
      return buildCompactPreamble(input);
    case 'summary:low':
      return buildSummaryLow(input);
    case 'summary:medium':
      return buildSummaryMedium(input);
    case 'summary:high':
      return buildSummaryHigh(input);
  }
}

function buildFullPreamble(input: PreambleInput): string {
  // full fidelity: minimal — goal only
  if (input.goal) {
    return `You are continuing an existing conversation.\nGoal: ${input.goal}`;
  }
  return 'You are continuing an existing conversation.';
}

function buildTruncatePreamble(input: PreambleInput): string {
  const budget = getFidelityBudget('truncate') ?? 400;
  let text = '';
  if (input.goal) {
    text += `Goal: ${input.goal}\n`;
  }
  text += `Run: ${input.run_id}`;
  return truncate(text, budget);
}

function buildCompactPreamble(input: PreambleInput): string {
  const budget = getFidelityBudget('compact') ?? 3200;
  const lines: string[] = [];

  // Header
  if (input.goal) {
    lines.push(`# Pipeline Context`);
    lines.push(`Goal: ${input.goal}`);
    lines.push(`Run: ${input.run_id}`);
  } else {
    lines.push(`# Pipeline Context`);
    lines.push(`Run: ${input.run_id}`);
  }
  lines.push('');

  if (input.completed_nodes.length === 0) {
    lines.push('No prior nodes completed.');
    return truncateWithPriority(lines.join('\n'), budget, input);
  }

  // Table
  lines.push('| Node | Status | Duration | Notes |');
  lines.push('|------|--------|----------|-------|');

  for (const node of input.completed_nodes) {
    const duration = computeDuration(node.started_at, node.completed_at);
    const notes = buildNotes(node);
    lines.push(`| ${node.node_id} | ${node.status} | ${duration} | ${notes} |`);
  }

  return truncateWithPriority(lines.join('\n'), budget, input);
}

function buildSummaryLow(input: PreambleInput): string {
  const budget = getFidelityBudget('summary:low') ?? 2400;
  const lines: string[] = [];

  if (input.goal) lines.push(`Goal: ${input.goal}`);
  lines.push(`Run: ${input.run_id}`);
  lines.push('');

  for (const node of input.completed_nodes) {
    lines.push(`- ${node.node_id}: ${node.status}${node.retries > 0 ? ` (${node.retries} retries)` : ''}`);
  }

  return truncateWithPriority(lines.join('\n'), budget, input);
}

function buildSummaryMedium(input: PreambleInput): string {
  const budget = getFidelityBudget('summary:medium') ?? 6000;
  const lines: string[] = [];

  if (input.goal) lines.push(`Goal: ${input.goal}`);
  lines.push(`Run: ${input.run_id}`);
  lines.push('');

  for (const node of input.completed_nodes) {
    const duration = computeDuration(node.started_at, node.completed_at);
    let detail = `**${node.node_id}**: ${node.status} (${duration})`;
    if (node.retries > 0) detail += ` — ${node.retries} retries`;
    if (node.is_human_answer && node.human_answer) detail += ` — answered: "${node.human_answer}"`;
    if (node.context_snippet) detail += `\n  Context: ${node.context_snippet}`;
    lines.push(detail);
    lines.push('');
  }

  return truncateWithPriority(lines.join('\n'), budget, input);
}

function buildSummaryHigh(input: PreambleInput): string {
  const budget = getFidelityBudget('summary:high') ?? 12000;
  const lines: string[] = [];

  lines.push('# Execution Summary');
  lines.push('');
  if (input.goal) lines.push(`**Goal:** ${input.goal}`);
  lines.push(`**Run ID:** ${input.run_id}`);
  lines.push(`**Nodes completed:** ${input.completed_nodes.length}`);
  lines.push('');

  for (const node of input.completed_nodes) {
    const duration = computeDuration(node.started_at, node.completed_at);
    lines.push(`## ${node.node_id}`);
    lines.push(`- **Status:** ${node.status}`);
    lines.push(`- **Duration:** ${duration}`);
    if (node.retries > 0) lines.push(`- **Retries:** ${node.retries}`);
    if (node.is_human_answer && node.human_answer) lines.push(`- **Human answer:** "${node.human_answer}"`);
    if (node.context_snippet) lines.push(`- **Context:** ${node.context_snippet}`);
    lines.push('');
  }

  // Add relevant context keys
  const contextKeys = Object.entries(input.context).filter(
    ([k]) => !k.startsWith('internal.') && !k.startsWith('_')
  );
  if (contextKeys.length > 0) {
    lines.push('## Context State');
    for (const [k, v] of contextKeys) {
      const preview = v.length > 200 ? v.slice(0, 197) + '...' : v;
      lines.push(`- **${k}:** ${preview}`);
    }
  }

  return truncateWithPriority(lines.join('\n'), budget, input);
}

function computeDuration(startedAt: string, completedAt: string): string {
  try {
    const ms = new Date(completedAt).getTime() - new Date(startedAt).getTime();
    if (ms < 1000) return `${ms}ms`;
    return `${(ms / 1000).toFixed(1)}s`;
  } catch {
    return '?';
  }
}

function buildNotes(node: CompletedNodeRecord): string {
  const parts: string[] = [];
  if (node.retries > 0) parts.push(`${node.retries} retries`);
  if (node.is_human_answer && node.human_answer) parts.push(`answer: "${node.human_answer}"`);
  if (node.context_snippet) parts.push(node.context_snippet.slice(0, 60));
  return parts.join('; ') || '-';
}

function truncate(text: string, budget: number): string {
  if (text.length <= budget) return text;
  return text.slice(0, budget - 3) + '...';
}

function truncateWithPriority(text: string, budget: number, input: PreambleInput): string {
  if (text.length <= budget) return text;

  // Rebuild with priority: header → recent failures → human answers → recent successes → drop oldest
  const lines: string[] = [];

  // Always keep header
  if (input.goal) {
    lines.push(`Goal: ${input.goal}`);
  }
  lines.push(`Run: ${input.run_id}`);
  lines.push('');

  // Sort: failures first, then human answers, then recent successes
  const failures = input.completed_nodes.filter(n => n.status === 'failure' || n.status === 'retry');
  const humanAnswers = input.completed_nodes.filter(n => n.is_human_answer);
  const successes = input.completed_nodes.filter(n =>
    n.status === 'success' || n.status === 'partial_success'
  );

  // Add most recent failure
  const recentFailure = failures[failures.length - 1];
  if (recentFailure) {
    lines.push(`Recent failure: ${recentFailure.node_id} (${recentFailure.status}, ${recentFailure.retries} retries)`);
  }

  // Add most recent human answer
  const recentHuman = humanAnswers[humanAnswers.length - 1];
  if (recentHuman && recentHuman.human_answer) {
    lines.push(`Human answer at ${recentHuman.node_id}: "${recentHuman.human_answer}"`);
  }

  // Add recent successes (newest first) until budget
  const reversedSuccesses = [...successes].reverse();
  for (const node of reversedSuccesses) {
    const candidate = `${node.node_id}: ${node.status}`;
    if (lines.join('\n').length + candidate.length + 1 > budget - 10) break;
    lines.push(candidate);
  }

  return truncate(lines.join('\n'), budget);
}
