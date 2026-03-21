import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { startServer, type NectarServer } from '../../src/server/server.js';
import { canListenOnLoopback } from '../helpers/network.js';

const tempDirs: string[] = [];
const servers: NectarServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(async (server) => server.close()));
  await Promise.all(tempDirs.splice(0).map(async (dir) => rm(dir, { recursive: true, force: true })));
});

async function createWorkspace(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'nectar-workspace-config-route-'));
  tempDirs.push(dir);
  await mkdir(path.join(dir, 'gardens'), { recursive: true });
  await mkdir(path.join(dir, '.nectar'), { recursive: true });
  return dir;
}

async function boot(workspaceRoot: string): Promise<NectarServer | null> {
  try {
    const server = await startServer({
      host: '127.0.0.1',
      port: 0,
      workspace_root: workspaceRoot,
    });
    servers.push(server);
    return server;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('EPERM')) {
      return null;
    }
    throw error;
  }
}

describe('/workspace/config', () => {
  it('returns resolved non-secret config with diagnostics and provider availability', async () => {
    if (!(await canListenOnLoopback())) {
      return;
    }

    const workspace = await createWorkspace();
    await writeFile(
      path.join(workspace, '.nectar', 'config.yaml'),
      [
        'draft:',
        '  provider: simulation',
        '  model: simulation',
        '  api_key: leaked-value',
      ].join('\n'),
      'utf8',
    );

    const server = await boot(workspace);
    if (!server) {
      return;
    }

    const response = await fetch(`${server.base_url}/workspace/config`);
    expect(response.status).toBe(200);

    const payload = await response.json() as {
      config: { draft: { provider: string; model: string } };
      diagnostics: Array<{ code: string; path?: string }>;
      provider_availability: { llm: Record<string, boolean> };
    };

    expect(payload.config.draft.provider).toBe('simulation');
    expect(payload.config.draft.model).toBe('simulation');
    expect(payload.provider_availability.llm.simulation).toBe(true);
    expect(payload.diagnostics.some((diag) => diag.code === 'SECRET_FIELD' && diag.path === 'draft.api_key')).toBe(true);

    const serialized = JSON.stringify(payload);
    expect(serialized.includes('leaked-value')).toBe(false);
  });
});
