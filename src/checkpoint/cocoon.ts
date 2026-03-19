import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Cocoon, CocoonSummary } from './types.js';

export function cocoonRoot(workspaceRoot = process.cwd()): string {
  return path.join(workspaceRoot, '.nectar', 'cocoons');
}

export function cocoonPath(runId: string, workspaceRoot = process.cwd()): string {
  return path.join(cocoonRoot(workspaceRoot), `${runId}.json`);
}

export async function writeCocoon(cocoon: Cocoon, workspaceRoot = process.cwd()): Promise<void> {
  const root = cocoonRoot(workspaceRoot);
  await mkdir(root, { recursive: true });

  const finalPath = cocoonPath(cocoon.run_id, workspaceRoot);
  const tempPath = path.join(root, `${cocoon.run_id}.${process.pid}.${Date.now()}.tmp`);
  const payload = `${JSON.stringify(cocoon, null, 2)}\n`;

  await writeFile(tempPath, payload, 'utf8');
  try {
    await rename(tempPath, finalPath);
  } catch (error) {
    await safeUnlink(tempPath);
    throw error;
  }
}

export async function readCocoon(runId: string, workspaceRoot = process.cwd()): Promise<Cocoon | null> {
  const targetPath = cocoonPath(runId, workspaceRoot);
  try {
    const raw = await readFile(targetPath, 'utf8');
    const parsed = JSON.parse(raw) as Cocoon;
    return parsed;
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

export async function listCocoons(workspaceRoot = process.cwd()): Promise<CocoonSummary[]> {
  const root = cocoonRoot(workspaceRoot);
  try {
    const entries = await readdir(root, { withFileTypes: true });
    const summaries: CocoonSummary[] = [];

    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) {
        continue;
      }

      const runId = entry.name.slice(0, -5);
      const cocoon = await readCocoon(runId, workspaceRoot);
      if (!cocoon) {
        continue;
      }

      summaries.push({
        run_id: cocoon.run_id,
        dot_file: cocoon.dot_file,
        status: cocoon.status,
        updated_at: cocoon.updated_at,
        current_node: cocoon.current_node,
        completed_count: cocoon.completed_nodes.length
      });
    }

    return summaries.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') {
      return [];
    }
    throw error;
  }
}

export async function writeNodeAttemptLogs(
  runId: string,
  nodeId: string,
  attempt: number,
  stdout: string,
  stderr: string,
  workspaceRoot = process.cwd()
): Promise<void> {
  const baseDir = path.join(cocoonRoot(workspaceRoot), runId, nodeId);
  await mkdir(baseDir, { recursive: true });

  const stdoutPath = path.join(baseDir, `attempt-${attempt}.stdout.log`);
  const stderrPath = path.join(baseDir, `attempt-${attempt}.stderr.log`);

  await writeAtomicText(stdoutPath, stdout);
  await writeAtomicText(stderrPath, stderr);
}

export async function ensureCocoonRoot(workspaceRoot = process.cwd()): Promise<void> {
  await mkdir(cocoonRoot(workspaceRoot), { recursive: true });
}

async function writeAtomicText(filePath: string, value: string): Promise<void> {
  const dir = path.dirname(filePath);
  await mkdir(dir, { recursive: true });

  const tempPath = path.join(dir, `${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
  await writeFile(tempPath, value, 'utf8');
  try {
    await rename(tempPath, filePath);
  } catch (error) {
    await safeUnlink(tempPath);
    throw error;
  }
}

async function safeUnlink(targetPath: string): Promise<void> {
  try {
    await unlink(targetPath);
  } catch {
    // Ignore cleanup errors.
  }
}

export async function cocoonExists(runId: string, workspaceRoot = process.cwd()): Promise<boolean> {
  try {
    await stat(cocoonPath(runId, workspaceRoot));
    return true;
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}
