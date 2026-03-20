import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Cocoon, CocoonSummary, PendingTransition } from './types.js';
import { ArtifactStore } from '../artifacts/store.js';

export interface ManifestData {
  run_id: string;
  dot_file: string;
  graph_hash: string;
  graph_label?: string;
  goal?: string;
  started_at: string;
  workspace_root: string;
  restart_of?: string;
  restarted_to?: string;
  restart_depth?: number;
  parent_run_id?: string;
  parent_node_id?: string;
}

export class RunStore {
  private readonly cocoonRoot: string;
  private readonly runDir: string;
  private readonly runId: string;
  private readonly legacyPath: string;
  private artifactIdCounter = 0;
  private _artifactStore?: ArtifactStore;

  constructor(runId: string, workspaceRoot: string) {
    this.runId = runId;
    this.cocoonRoot = path.join(workspaceRoot, '.nectar', 'cocoons');
    this.runDir = path.join(this.cocoonRoot, runId);
    this.legacyPath = path.join(this.cocoonRoot, `${runId}.json`);
  }

  getRunDir(): string {
    return this.runDir;
  }

  async initialize(manifest: ManifestData): Promise<void> {
    await mkdir(this.runDir, { recursive: true });
    await mkdir(path.join(this.runDir, 'artifacts'), { recursive: true });
    const manifestPath = path.join(this.runDir, 'manifest.json');
    await writeAtomicJson(manifestPath, manifest);
  }

  async writeCheckpoint(cocoon: Cocoon): Promise<void> {
    const canonicalPath = path.join(this.runDir, 'checkpoint.json');
    await mkdir(this.runDir, { recursive: true });
    await writeAtomicJson(canonicalPath, cocoon);
  }

  async writeLegacyMirror(cocoon: Cocoon): Promise<void> {
    await mkdir(this.cocoonRoot, { recursive: true });
    await writeAtomicJson(this.legacyPath, cocoon);
  }

  async readCheckpoint(): Promise<Cocoon | null> {
    // Canonical first
    const canonicalPath = path.join(this.runDir, 'checkpoint.json');
    const canonical = await readJsonSafe<Cocoon>(canonicalPath);
    if (canonical) return canonical;
    // Legacy fallback
    return readJsonSafe<Cocoon>(this.legacyPath);
  }

  async readManifest(): Promise<ManifestData | null> {
    const manifestPath = path.join(this.runDir, 'manifest.json');
    return readJsonSafe<ManifestData>(manifestPath);
  }

  artifactStore(): ArtifactStore {
    if (!this._artifactStore) {
      this._artifactStore = new ArtifactStore(path.join(this.runDir, 'artifacts'));
    }
    return this._artifactStore;
  }

  nextArtifactId(nodeId: string, purpose: string): string {
    this.artifactIdCounter++;
    return `${nodeId}-${purpose}-${String(this.artifactIdCounter).padStart(4, '0')}`;
  }

  static async listRuns(workspaceRoot: string): Promise<CocoonSummary[]> {
    const cocoonRoot = path.join(workspaceRoot, '.nectar', 'cocoons');
    const summaries: CocoonSummary[] = [];
    const seenRunIds = new Set<string>();

    try {
      const entries = await readdir(cocoonRoot, { withFileTypes: true });

      // Canonical directories first
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const runId = entry.name;
        const checkpointPath = path.join(cocoonRoot, runId, 'checkpoint.json');
        const cocoon = await readJsonSafe<Cocoon>(checkpointPath);
        if (!cocoon) continue;
        seenRunIds.add(runId);
        summaries.push({
          run_id: cocoon.run_id,
          dot_file: cocoon.dot_file,
          status: cocoon.status,
          updated_at: cocoon.updated_at,
          current_node: cocoon.current_node,
          completed_count: cocoon.completed_nodes.length,
        });
      }

      // Legacy flat files
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
        const runId = entry.name.slice(0, -5);
        if (seenRunIds.has(runId)) continue;
        const legacyPath = path.join(cocoonRoot, `${runId}.json`);
        const cocoon = await readJsonSafe<Cocoon>(legacyPath);
        if (!cocoon) continue;
        summaries.push({
          run_id: cocoon.run_id,
          dot_file: cocoon.dot_file,
          status: cocoon.status,
          updated_at: cocoon.updated_at,
          current_node: cocoon.current_node,
          completed_count: cocoon.completed_nodes.length,
        });
      }
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code === 'ENOENT') return [];
      throw error;
    }

    return summaries.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  }

  async ensureControlDir(): Promise<string> {
    const controlDir = path.join(this.runDir, 'control');
    await mkdir(controlDir, { recursive: true });
    return controlDir;
  }

  async writeControlFile(filename: string, data: unknown): Promise<void> {
    const controlDir = await this.ensureControlDir();
    await writeAtomicJson(path.join(controlDir, filename), data);
  }

  async readControlFile<T>(filename: string): Promise<T | null> {
    const controlDir = path.join(this.runDir, 'control');
    return readJsonSafe<T>(path.join(controlDir, filename));
  }

  async deleteControlFile(filename: string): Promise<void> {
    const controlDir = path.join(this.runDir, 'control');
    try {
      await unlink(path.join(controlDir, filename));
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code !== 'ENOENT') throw error;
    }
  }

  async updateManifest(updates: Partial<ManifestData>): Promise<void> {
    const current = await this.readManifest();
    if (!current) return;
    const updated = { ...current, ...updates };
    const manifestPath = path.join(this.runDir, 'manifest.json');
    await writeAtomicJson(manifestPath, updated);
  }

  static async readCocoon(runId: string, workspaceRoot: string): Promise<Cocoon | null> {
    const store = new RunStore(runId, workspaceRoot);
    return store.readCheckpoint();
  }
}

async function writeAtomicJson(filePath: string, data: unknown): Promise<void> {
  const dir = path.dirname(filePath);
  await mkdir(dir, { recursive: true });
  const tempPath = path.join(dir, `${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
  const payload = `${JSON.stringify(data, null, 2)}\n`;
  await writeFile(tempPath, payload, 'utf8');
  try {
    await rename(tempPath, filePath);
  } catch (error) {
    try { await unlink(tempPath); } catch { /* ignore */ }
    throw error;
  }
}

async function readJsonSafe<T>(filePath: string): Promise<T | null> {
  try {
    const raw = await readFile(filePath, 'utf8');
    return JSON.parse(raw) as T;
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') return null;
    throw error;
  }
}
