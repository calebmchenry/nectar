import { execFile as execFileCallback } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const MAX_BUDGET = 32 * 1024; // 32KB
const execFile = promisify(execFileCallback);

interface InstructionFile {
  path: string;
  content: string;
}

type RepoRootResolver = (cwd: string) => Promise<string | null>;

/**
 * Discover project instruction files for a provider.
 * Precedence:
 * 1) Shallower directories first, deeper directories last
 * 2) Within a directory: AGENTS.md first, provider-specific file second
 * 3) Later entries override earlier ones
 *
 * Budgeting preserves highest-precedence entries by dropping from the front
 * (lowest precedence) first.
 */
export async function discoverInstructions(
  workspaceRoot: string,
  providerName: string,
  startDir: string = workspaceRoot,
  resolveRepoRoot: RepoRootResolver = resolveRepoRootWithGit,
): Promise<string> {
  const normalizedWorkspaceRoot = path.resolve(workspaceRoot);
  const normalizedStartDir = path.resolve(startDir);
  const effectiveCwd = isWithin(normalizedWorkspaceRoot, normalizedStartDir)
    ? normalizedStartDir
    : normalizedWorkspaceRoot;

  const repoRoot = await resolveRepoRoot(effectiveCwd).catch(() => null);
  const walkRoot = repoRoot && isWithin(repoRoot, effectiveCwd)
    ? repoRoot
    : normalizedWorkspaceRoot;
  const directories = enumerateDirectories(walkRoot, effectiveCwd);

  const providerFiles = providerSpecificFiles(providerName);
  const files: InstructionFile[] = [];

  for (const directory of directories) {
    const genericPath = path.join(directory, 'AGENTS.md');
    const genericContent = await tryReadFile(genericPath);
    if (genericContent !== null) {
      files.push({ path: genericPath, content: genericContent });
    }

    for (const providerFile of providerFiles) {
      const providerPath = path.join(directory, providerFile);
      const providerContent = await tryReadFile(providerPath);
      if (providerContent !== null) {
        files.push({ path: providerPath, content: providerContent });
      }
    }
  }

  if (files.length === 0) {
    return '';
  }

  return applyBudget(files, MAX_BUDGET);
}

function providerSpecificFiles(providerName: string): string[] {
  switch (providerName) {
    case 'anthropic':
      return ['CLAUDE.md'];
    case 'gemini':
      return ['GEMINI.md'];
    case 'openai':
    case 'openai_compatible':
      return [path.join('.codex', 'instructions.md')];
    default:
      return [];
  }
}

function enumerateDirectories(root: string, target: string): string[] {
  const normalizedRoot = path.resolve(root);
  const normalizedTarget = path.resolve(target);
  if (!isWithin(normalizedRoot, normalizedTarget)) {
    return [normalizedRoot];
  }

  const relative = path.relative(normalizedRoot, normalizedTarget);
  if (!relative) {
    return [normalizedRoot];
  }

  const segments = relative.split(path.sep).filter((segment) => segment.length > 0);
  const directories = [normalizedRoot];
  let current = normalizedRoot;
  for (const segment of segments) {
    current = path.join(current, segment);
    directories.push(current);
  }
  return directories;
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative.length === 0 || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

async function resolveRepoRootWithGit(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await execFile('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], {
      timeout: 1000,
      windowsHide: true,
    });
    const resolved = stdout.trim();
    return resolved.length > 0 ? path.resolve(resolved) : null;
  } catch {
    return null;
  }
}

function applyBudget(files: InstructionFile[], budget: number): string {
  let included = files.slice();
  let payload = formatInstructionFiles(included);

  while (included.length > 1 && payload.length > budget) {
    included = included.slice(1);
    payload = formatInstructionFiles(included);
  }

  if (payload.length <= budget) {
    return payload;
  }

  const only = included[0]!;
  const header = `--- ${only.path} ---\n`;
  const suffix = '\n\n[... truncated to fit 32KB budget ...]';
  const available = Math.max(0, budget - header.length - suffix.length);
  return `${header}${only.content.slice(0, available)}${suffix}`;
}

function formatInstructionFiles(files: InstructionFile[]): string {
  return files
    .map((file) => `--- ${file.path} ---\n${file.content}`)
    .join('\n\n');
}

async function tryReadFile(filePath: string): Promise<string | null> {
  try {
    const bytes = await readFile(filePath);
    const maxCheck = Math.min(bytes.length, 1024);
    for (let i = 0; i < maxCheck; i += 1) {
      if (bytes[i] === 0) {
        return null;
      }
    }
    return bytes.toString('utf8');
  } catch {
    return null;
  }
}
