import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { WorkspaceConfigLoader } from '../../config/workspace.js';
import { parseGardenSource } from '../../garden/parse.js';
import { PipelinePreparer } from '../../garden/preparer.js';
import type { UnifiedClient } from '../../llm/client.js';
import { DraftValidationError, GardenDraftService } from '../../runtime/garden-draft-service.js';
import { GardenPreviewService } from '../../runtime/garden-preview-service.js';
import { Router, HttpError, type RouteContext } from '../router.js';
import { RunManager } from '../run-manager.js';
import { createFiniteSseStream } from '../sse.js';
import { DRAFT_TERMINAL_EVENT_TYPES } from '../types.js';

export interface GardenRoutesOptions {
  workspace_root: string;
  run_manager: RunManager;
  config_loader: WorkspaceConfigLoader;
  client: UnifiedClient;
}

export function registerGardenRoutes(router: Router, options: GardenRoutesOptions): void {
  const workspaceRoot = options.workspace_root;
  const runManager = options.run_manager;
  const previewPreparer = new PipelinePreparer({ workspaceRoot });
  const previewService = new GardenPreviewService(undefined, previewPreparer);
  const draftService = new GardenDraftService(options.client, undefined, options.config_loader);

  router.register('GET', '/gardens', async (ctx) => {
    const gardensDir = path.join(workspaceRoot, 'gardens');
    let entries;
    try {
      entries = await readdir(gardensDir, { withFileTypes: true });
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code === 'ENOENT') {
        ctx.sendJson(200, { gardens: [] });
        return;
      }
      throw error;
    }

    const gardens: Array<{ name: string; size: number; modified_at: string; node_count: number }> = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.dot')) {
        continue;
      }

      const targetPath = path.join(gardensDir, entry.name);
      const fileStat = await stat(targetPath);
      const source = await readFile(targetPath, 'utf8');
      let nodeCount = 0;
      try {
        const parsed = parseGardenSource(source, targetPath);
        nodeCount = parsed.nodes.length;
      } catch {
        // Keep node_count at zero if parse fails.
      }

      gardens.push({
        name: entry.name,
        size: fileStat.size,
        modified_at: fileStat.mtime.toISOString(),
        node_count: nodeCount,
      });
    }

    gardens.sort((a, b) => a.name.localeCompare(b.name));
    ctx.sendJson(200, { gardens });
  });

  router.register('GET', '/gardens/:name', async (ctx) => {
    const gardenPath = resolveGardenPath(workspaceRoot, ctx.params.name!);

    let source: string;
    try {
      source = await readFile(gardenPath, 'utf8');
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code === 'ENOENT') {
        throw new HttpError(404, 'NOT_FOUND', `Garden '${ctx.params.name}' not found.`);
      }
      throw error;
    }

    let metadata: Record<string, unknown> = { valid: false, node_count: 0, edge_count: 0 };
    try {
      const parsed = parseGardenSource(source, gardenPath);
      metadata = {
        valid: true,
        node_count: parsed.nodes.length,
        edge_count: parsed.edges.length,
        graph_attributes: parsed.graphAttributes,
      };
    } catch {
      // Keep invalid metadata if parse fails.
    }

    ctx.sendJson(200, {
      name: path.basename(gardenPath),
      path: path.relative(workspaceRoot, gardenPath),
      dot_source: source,
      metadata,
    });
  });

  router.register('POST', '/gardens/preview', async (ctx) => {
    const body = await ctx.readJson<{ dot_source?: string; dot_path?: string }>();
    const result = await previewService.preview({
      dot_source: body.dot_source ?? '',
      dot_path: body.dot_path,
    });
    ctx.sendJson(200, result);
  });

  router.register('POST', '/gardens/draft', async (ctx) => {
    const body = await ctx.readJson<{ prompt?: string; provider?: string; model?: string }>();
    if (!body.prompt || body.prompt.trim().length === 0) {
      throw new HttpError(400, 'VALIDATION_ERROR', 'prompt is required.');
    }

    const tabId = resolveDraftTabId(ctx);
    const previous = activeDraftsByTab.get(tabId);
    previous?.abort();

    const abortController = new AbortController();
    activeDraftsByTab.set(tabId, abortController);

    const stream = createFiniteSseStream({
      req: ctx.req,
      res: ctx.res,
      terminal_events: DRAFT_TERMINAL_EVENT_TYPES,
    });

    let closed = false;
    const onClose = () => {
      if (closed) {
        return;
      }
      closed = true;
      abortController.abort();
      if (activeDraftsByTab.get(tabId) === abortController) {
        activeDraftsByTab.delete(tabId);
      }
      ctx.res.off('close', onClose);
    };
    ctx.res.on('close', onClose);
    stream.onClose(onClose);

    try {
      for await (const event of draftService.streamDraft(
        {
          prompt: body.prompt,
          provider: body.provider,
          model: body.model,
        },
        abortController.signal
      )) {
        if (stream.isClosed()) {
          break;
        }
        stream.send(event.type, event);
      }
      if (!stream.terminalEmitted() && !stream.isClosed()) {
        stream.send('draft_error', {
          type: 'draft_error',
          error: 'Draft stream ended without a terminal event.',
        });
      }
    } catch (error) {
      if (!stream.terminalEmitted() && !stream.isClosed()) {
        const message = error instanceof Error ? error.message : String(error);
        if (error instanceof DraftValidationError) {
          stream.send('draft_error', {
            type: 'draft_error',
            error: message,
            diagnostics: error.diagnostics,
          });
        } else {
          stream.send('draft_error', {
            type: 'draft_error',
            error: message,
          });
        }
      }
    } finally {
      if (activeDraftsByTab.get(tabId) === abortController) {
        activeDraftsByTab.delete(tabId);
      }
    }
  });

  router.register('PUT', '/gardens/:name', async (ctx) => {
    const gardenPath = resolveGardenPath(workspaceRoot, ctx.params.name!);
    const body = await ctx.readJson<{ dot_source?: string }>();
    const dotSource = body.dot_source;
    if (!dotSource || dotSource.trim().length === 0) {
      throw new HttpError(400, 'VALIDATION_ERROR', 'dot_source is required.');
    }

    const prepared = await previewPreparer.prepareFromSource(dotSource, gardenPath);
    const { diagnostics } = prepared;
    const errors = diagnostics.filter((diagnostic) => diagnostic.severity === 'error');
    if (errors.length > 0) {
      throw new HttpError(400, 'VALIDATION_ERROR', 'Garden failed validation.', { diagnostics });
    }

    await mkdir(path.dirname(gardenPath), { recursive: true });
    await writeFile(gardenPath, dotSource, 'utf8');
    ctx.sendJson(200, {
      name: path.basename(gardenPath),
      path: path.relative(workspaceRoot, gardenPath),
      diagnostics,
    });
  });

  router.register('DELETE', '/gardens/:name', async (ctx) => {
    const gardenPath = resolveGardenPath(workspaceRoot, ctx.params.name!);

    const running = runManager
      .listActive()
      .find((activeRun) => activeRun.status === 'running' && path.resolve(activeRun.dot_file) === gardenPath);
    if (running) {
      throw new HttpError(
        409,
        'CONFLICT',
        `Garden '${ctx.params.name}' is in use by active run '${running.run_id}'.`
      );
    }

    try {
      await rm(gardenPath);
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code === 'ENOENT') {
        throw new HttpError(404, 'NOT_FOUND', `Garden '${ctx.params.name}' not found.`);
      }
      throw error;
    }

    ctx.sendJson(200, { deleted: true });
  });
}

const activeDraftsByTab = new Map<string, AbortController>();

function resolveDraftTabId(ctx: RouteContext): string {
  const fromHeader = ctx.req.headers['x-hive-tab-id'];
  const headerValue = (Array.isArray(fromHeader) ? fromHeader[0] : fromHeader)?.trim();
  if (headerValue) {
    return headerValue;
  }

  const queryValue = ctx.query.get('tab_id')?.trim();
  if (queryValue) {
    return queryValue;
  }

  return 'default';
}

function resolveGardenPath(workspaceRoot: string, name: string): string {
  if (!name || !name.endsWith('.dot')) {
    throw new HttpError(400, 'VALIDATION_ERROR', 'Garden name must end with .dot');
  }

  const gardensRoot = path.join(workspaceRoot, 'gardens');
  const absolute = path.resolve(gardensRoot, name);
  const relative = path.relative(gardensRoot, absolute);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new HttpError(400, 'VALIDATION_ERROR', 'Garden path escapes workspace gardens directory.');
  }

  return absolute;
}
