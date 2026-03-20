import { readFile } from 'node:fs/promises';
import path from 'node:path';

const MAX_BUDGET = 32 * 1024; // 32KB

interface InstructionFile {
  path: string;
  content: string;
  specificity: number; // higher = more specific (provider-specific > generic)
}

/**
 * Discover project instruction files for a given provider.
 * Walks from workspace root upward, collecting AGENTS.md and provider-specific files.
 */
export async function discoverInstructions(
  workspaceRoot: string,
  providerName: string
): Promise<string> {
  const files: InstructionFile[] = [];

  // Determine which files to look for based on provider
  const genericFile = 'AGENTS.md';
  const providerFiles: string[] = [];
  switch (providerName) {
    case 'anthropic':
      providerFiles.push('CLAUDE.md');
      break;
    case 'gemini':
      providerFiles.push('GEMINI.md');
      break;
    case 'openai':
      providerFiles.push(path.join('.codex', 'instructions.md'));
      break;
  }

  // Walk from workspace root upward
  let currentDir = workspaceRoot;
  let depth = 0;

  while (true) {
    // Provider-specific files (higher specificity)
    for (const pf of providerFiles) {
      const content = await tryReadFile(path.join(currentDir, pf));
      if (content !== null) {
        files.push({
          path: path.join(currentDir, pf),
          content,
          specificity: 100 - depth, // closer to workspace root = more specific for provider files
        });
      }
    }

    // Generic AGENTS.md (lower specificity)
    const genericContent = await tryReadFile(path.join(currentDir, genericFile));
    if (genericContent !== null) {
      files.push({
        path: path.join(currentDir, genericFile),
        content: genericContent,
        specificity: 50 - depth, // generic always less specific than provider-specific
      });
    }

    // Move up one directory
    const parent = path.dirname(currentDir);
    if (parent === currentDir) break; // reached filesystem root
    currentDir = parent;
    depth++;
  }

  if (files.length === 0) return '';

  // Sort: most specific first
  files.sort((a, b) => b.specificity - a.specificity);

  // Apply budget: truncate least-specific files first
  return applyBudget(files, MAX_BUDGET);
}

function applyBudget(files: InstructionFile[], budget: number): string {
  let totalSize = files.reduce((sum, f) => sum + f.content.length, 0);

  // If within budget, concat all
  if (totalSize <= budget) {
    return files
      .map((f) => `--- ${f.path} ---\n${f.content}`)
      .join('\n\n');
  }

  // Truncate from least specific (end of sorted array)
  const included = [...files];
  while (totalSize > budget && included.length > 1) {
    const removed = included.pop()!;
    totalSize -= removed.content.length;
  }

  // If still over budget, truncate the last remaining file
  if (totalSize > budget && included.length === 1) {
    included[0] = {
      ...included[0]!,
      content: included[0]!.content.slice(0, budget - 100) + '\n\n[... truncated to fit 32KB budget ...]',
    };
  }

  return included
    .map((f) => `--- ${f.path} ---\n${f.content}`)
    .join('\n\n');
}

async function tryReadFile(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, 'utf8');
  } catch {
    return null;
  }
}
