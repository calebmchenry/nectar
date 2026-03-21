import { once } from 'node:events';
import http from 'node:http';
import path from 'node:path';
import { PipelineService } from '../runtime/pipeline-service.js';
import { SwarmAnalysisService } from '../runtime/swarm-analysis-service.js';
import { GraphRenderer } from './graph-renderer.js';
import { Router } from './router.js';
import { RunManager } from './run-manager.js';
import { SwarmManager } from './swarm-manager.js';
import { WorkspaceEventBus } from './workspace-event-bus.js';
import { registerPipelineRoutes } from './routes/pipelines.js';
import { registerGardenRoutes } from './routes/gardens.js';
import { registerSeedRoutes } from './routes/seeds.js';
import { registerWorkspaceEventRoutes } from './routes/events.js';
import { tryServeHiveAsset } from './static-assets.js';

export interface StartServerOptions {
  host?: string;
  port?: number;
  workspace_root?: string;
  max_concurrent_runs?: number;
  completed_ttl_ms?: number;
}

export interface NectarServer {
  host: string;
  port: number;
  base_url: string;
  workspace_root: string;
  run_manager: RunManager;
  swarm_manager: SwarmManager;
  close(): Promise<void>;
  waitForShutdown(): Promise<void>;
}

export async function startServer(options: StartServerOptions = {}): Promise<NectarServer> {
  const host = options.host ?? '127.0.0.1';
  const requestedPort = options.port ?? 4140;
  const workspaceRoot = path.resolve(options.workspace_root ?? process.cwd());

  const pipelineService = new PipelineService(workspaceRoot);
  const runManager = new RunManager({
    workspace_root: workspaceRoot,
    pipeline_service: pipelineService,
    max_concurrent_runs: options.max_concurrent_runs,
    completed_ttl_ms: options.completed_ttl_ms,
  });
  const orphaned = await runManager.markOrphanedRuns();
  const workspaceEventBus = new WorkspaceEventBus();
  const swarmAnalysisService = new SwarmAnalysisService({
    workspace_root: workspaceRoot,
    event_bus: workspaceEventBus,
  });
  const swarmManager = new SwarmManager({
    workspace_root: workspaceRoot,
    analysis_service: swarmAnalysisService,
  });
  const staleAnalysesRecovered = await swarmManager.recoverStaleRunningStatuses();

  const router = new Router();
  const graphRenderer = new GraphRenderer();

  registerPipelineRoutes(router, {
    run_manager: runManager,
    graph_renderer: graphRenderer,
  });
  registerGardenRoutes(router, {
    workspace_root: workspaceRoot,
    run_manager: runManager,
  });
  registerSeedRoutes(router, {
    workspace_root: workspaceRoot,
    run_manager: runManager,
    swarm_manager: swarmManager,
    event_bus: workspaceEventBus,
  });
  registerWorkspaceEventRoutes(router, {
    workspace_root: workspaceRoot,
    event_bus: workspaceEventBus,
  });
  router.register('GET', '/health', (ctx) => {
    ctx.sendJson(200, { ok: true });
  });

  const server = http.createServer((req, res) => {
    if (tryServeHiveAsset(req, res)) {
      return;
    }
    void router.handle(req, res);
  });

  await listen(server, host, requestedPort);

  const address = server.address();
  const boundPort = typeof address === 'object' && address ? address.port : requestedPort;
  const baseUrl = `http://${host}:${boundPort}`;

  process.stdout.write(`🐝 Hive online at ${baseUrl}\n`);
  process.stdout.write(`🌼 Workspace: ${workspaceRoot}\n`);
  if (orphaned > 0) {
    process.stdout.write(`⚠️ Marked ${orphaned} orphaned runs as interrupted\n`);
  }
  if (staleAnalysesRecovered > 0) {
    process.stdout.write(`⚠️ Marked ${staleAnalysesRecovered} stale seed analysis task(s) as failed\n`);
  }
  if (host !== '127.0.0.1' && host !== 'localhost') {
    process.stdout.write('⚠️ Server is exposed on a non-localhost interface.\n');
  }

  let closing = false;
  let shutdownResolve: (() => void) | undefined;
  const shutdownPromise = new Promise<void>((resolve) => {
    shutdownResolve = resolve;
  });

  const close = async (): Promise<void> => {
    if (closing) {
      return shutdownPromise;
    }
    closing = true;

    const closePromise = new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });

    try {
      await closePromise;
    } catch {
      // If server is already closed we can still continue shutdown.
    }

    await runManager.shutdown();
    await swarmManager.shutdown();
    shutdownResolve?.();
    return shutdownPromise;
  };

  const onSigint = () => {
    void close();
  };
  const onSigterm = () => {
    void close();
  };

  process.on('SIGINT', onSigint);
  process.on('SIGTERM', onSigterm);

  server.on('close', () => {
    process.off('SIGINT', onSigint);
    process.off('SIGTERM', onSigterm);
    shutdownResolve?.();
  });

  return {
    host,
    port: boundPort,
    base_url: baseUrl,
    workspace_root: workspaceRoot,
    run_manager: runManager,
    swarm_manager: swarmManager,
    close,
    waitForShutdown: async () => {
      await shutdownPromise;
    },
  };
}

async function listen(server: http.Server, host: string, port: number): Promise<void> {
  const listening = once(server, 'listening');
  const errored = once(server, 'error').then(([error]) => {
    throw error;
  });

  server.listen(port, host);

  try {
    await Promise.race([listening, errored]);
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === 'EADDRINUSE') {
      throw new Error(`Port ${port} is already in use on ${host}. Use --port to choose another port.`);
    }
    throw error;
  }
}
