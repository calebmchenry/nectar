import { access, mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { RunStore } from '../../checkpoint/run-store.js';
import type { RunEvent } from '../../engine/events.js';
import type { RunStatus } from '../../engine/types.js';
import { SeedActivityStore } from '../../seedbed/activity.js';
import { SeedLifecycleService } from '../../seedbed/lifecycle.js';
import { SeedStore } from '../../seedbed/store.js';
import {
  isValidPriority,
  isValidRunLaunchOrigin,
  isValidStatus,
  type LinkedRunSummary,
  type RunLaunchOrigin,
  type SeedPriority,
  type SeedStatus,
} from '../../seedbed/types.js';
import { sanitizeFilename } from '../../seedbed/attachments.js';
import { workspacePathsFromRoot } from '../../seedbed/paths.js';
import { appendAttachmentLinks } from '../../seedbed/markdown.js';
import { parseAnalysisDocument, type AnalysisDocument } from '../../seedbed/analysis-document.js';
import { synthesizeAnalyses } from '../../seedbed/synthesis.js';
import { SWARM_PROVIDERS } from '../../runtime/swarm-analysis-service.js';
import type { SwarmManager } from '../swarm-manager.js';
import type { RunManager } from '../run-manager.js';
import type { SwarmProvider, WorkspaceEventBus } from '../workspace-event-bus.js';
import { HttpError, Router } from '../router.js';

const MAX_UPLOAD_BYTES = 55 * 1024 * 1024;

export interface SeedRoutesOptions {
  workspace_root: string;
  run_manager?: RunManager;
  swarm_manager?: SwarmManager;
  event_bus?: WorkspaceEventBus;
}

export function registerSeedRoutes(router: Router, options: SeedRoutesOptions): void {
  const ws = workspacePathsFromRoot(options.workspace_root);
  const store = new SeedStore(ws);
  const activityStore = new SeedActivityStore(ws);
  const lifecycle = new SeedLifecycleService(store, activityStore);
  const runManager = options.run_manager;
  const swarmManager = options.swarm_manager;
  const eventBus = options.event_bus;
  const trackedSeedRuns = new Map<string, () => void>();

  router.register('GET', '/seeds', async (ctx) => {
    const listed = await store.list();
    ctx.sendJson(200, {
      seeds: listed.map((item) => ({
        ...item.meta,
        location: item.location,
      })),
    });
  });

  router.register('GET', '/seeds/activity', async (ctx) => {
    const limit = parsePositiveInt(ctx.query.get('limit'), 50, 200);
    const cursor = ctx.query.get('cursor') ?? undefined;
    const events = await activityStore.listWorkspace({
      limit,
      before: cursor,
    });
    const nextCursor = events.length >= limit ? events[events.length - 1]?.timestamp ?? null : null;
    ctx.sendJson(200, {
      events,
      next_cursor: nextCursor,
    });
  });

  router.register('GET', '/seeds/:id', async (ctx) => {
    const seedId = parseSeedId(ctx.params.id);
    const seed = await store.get(seedId);
    if (!seed) {
      throw new HttpError(404, 'NOT_FOUND', `Seed '${seedId}' not found.`);
    }

    const attachments = await listAttachments(seedId, path.join(seed.dirPath, 'attachments'));
    const analyses = await listAnalyses(path.join(seed.dirPath, 'analysis'));
    const linkedGardenSummaries = await listLinkedGardens(seed.meta.linked_gardens, ws.root);
    const linkedRunSummaries = await listLinkedRunSummaries(seed.meta.linked_runs, ws.root);
    const statusSuggestion = lifecycle.computeStatusSuggestion(seed.meta, linkedRunSummaries);
    const activity = await activityStore.list(seedId, { limit: 100 });

    ctx.sendJson(200, {
      meta: seed.meta,
      seed_md: seed.seedMd,
      attachments,
      analyses,
      linked_garden_summaries: linkedGardenSummaries,
      linked_run_summaries: linkedRunSummaries,
      status_suggestion: statusSuggestion,
      activity,
    });
  });

  router.register('GET', '/seeds/:id/synthesis', async (ctx) => {
    const seedId = parseSeedId(ctx.params.id);
    const seed = await store.get(seedId);
    if (!seed) {
      throw new HttpError(404, 'NOT_FOUND', `Seed '${seedId}' not found.`);
    }

    const analyses = await listAnalyses(path.join(seed.dirPath, 'analysis'));
    ctx.sendJson(200, synthesizeAnalyses(analyses));
  });

  router.register('POST', '/seeds', async (ctx) => {
    const body = await ctx.readJson<{
      title?: string;
      body?: string;
      priority?: SeedPriority;
      tags?: string[];
    }>();

    const seedBody = body.body?.trim();
    if (!seedBody) {
      throw new HttpError(400, 'VALIDATION_ERROR', 'Seed body is required.');
    }
    if (body.priority && !isValidPriority(body.priority)) {
      throw new HttpError(400, 'VALIDATION_ERROR', `Invalid priority '${body.priority}'.`);
    }
    if (body.tags !== undefined && (!Array.isArray(body.tags) || body.tags.some((tag) => typeof tag !== 'string'))) {
      throw new HttpError(400, 'VALIDATION_ERROR', 'tags must be an array of strings.');
    }

    const created = await store.create({
      title: body.title,
      body: seedBody,
      priority: body.priority,
      tags: Array.isArray(body.tags) ? body.tags : [],
    });
    await activityStore.append(created.id, {
      type: 'seed_created',
      actor: 'user',
      title: created.title,
      status: created.status,
      priority: created.priority,
    });

    eventBus?.emit({
      type: 'seed_created',
      seed_id: created.id,
      status: created.status,
      priority: created.priority,
    });

    ctx.sendJson(201, { seed: created });
  });

  router.register('PATCH', '/seeds/:id', async (ctx) => {
    const seedId = parseSeedId(ctx.params.id);
    const body = await ctx.readJson<{
      title?: string;
      body?: string;
      status?: SeedStatus;
      priority?: SeedPriority;
      tags?: string[];
      linked_gardens_add?: string[];
      linked_gardens_remove?: string[];
    }>();

    if (body.title !== undefined && body.title.trim().length === 0) {
      throw new HttpError(400, 'VALIDATION_ERROR', 'title must not be empty.');
    }
    if (body.body !== undefined && typeof body.body !== 'string') {
      throw new HttpError(400, 'VALIDATION_ERROR', 'body must be a string.');
    }
    if (body.status !== undefined && !isValidStatus(body.status)) {
      throw new HttpError(400, 'VALIDATION_ERROR', `Invalid status '${body.status}'.`);
    }
    if (body.priority !== undefined && !isValidPriority(body.priority)) {
      throw new HttpError(400, 'VALIDATION_ERROR', `Invalid priority '${body.priority}'.`);
    }
    if (body.tags !== undefined && (!Array.isArray(body.tags) || body.tags.some((tag) => typeof tag !== 'string'))) {
      throw new HttpError(400, 'VALIDATION_ERROR', 'tags must be an array of strings.');
    }
    if (
      body.linked_gardens_add !== undefined &&
      (!Array.isArray(body.linked_gardens_add) || body.linked_gardens_add.some((gardenPath) => typeof gardenPath !== 'string'))
    ) {
      throw new HttpError(400, 'VALIDATION_ERROR', 'linked_gardens_add must be an array of strings.');
    }
    if (
      body.linked_gardens_remove !== undefined &&
      (!Array.isArray(body.linked_gardens_remove) || body.linked_gardens_remove.some((gardenPath) => typeof gardenPath !== 'string'))
    ) {
      throw new HttpError(400, 'VALIDATION_ERROR', 'linked_gardens_remove must be an array of strings.');
    }

    const before = await store.get(seedId);
    if (!before) {
      throw new HttpError(404, 'NOT_FOUND', `Seed '${seedId}' not found.`);
    }

    let updated = before.meta;
    for (const gardenPath of body.linked_gardens_add ?? []) {
      updated = await lifecycle.linkGarden(seedId, gardenPath, 'user');
    }
    for (const gardenPath of body.linked_gardens_remove ?? []) {
      updated = await lifecycle.unlinkGarden(seedId, gardenPath, 'user');
    }

    const hasDirectPatch =
      body.title !== undefined ||
      body.body !== undefined ||
      body.status !== undefined ||
      body.priority !== undefined ||
      body.tags !== undefined;

    if (hasDirectPatch) {
      updated = await store.patch(seedId, {
        title: body.title,
        body: body.body,
        status: body.status,
        priority: body.priority,
        tags: body.tags,
      });
    }

    const changedFields = collectChangedFields(before.meta, updated, body);
    if (changedFields.length > 0) {
      await activityStore.append(seedId, {
        type: 'seed_updated',
        actor: 'user',
        fields: changedFields,
      });
    }
    if (before.meta.status !== updated.status) {
      await activityStore.append(seedId, {
        type: 'status_changed',
        actor: 'user',
        from: before.meta.status,
        to: updated.status,
      });
    }

    eventBus?.emit({
      type: 'seed_updated',
      seed_id: updated.id,
      status: updated.status,
      priority: updated.priority,
    });

    ctx.sendJson(200, { seed: updated });
  });

  router.register('POST', '/seeds/:id/run', async (ctx) => {
    if (!runManager) {
      throw new HttpError(503, 'UNAVAILABLE', 'Pipeline run manager is not available.');
    }

    const seedId = parseSeedId(ctx.params.id);
    const seed = await store.get(seedId);
    if (!seed) {
      throw new HttpError(404, 'NOT_FOUND', `Seed '${seedId}' not found.`);
    }

    const body = await ctx.readJson<{
      garden_path?: string;
      run_id?: string;
      auto_approve?: boolean;
      force?: boolean;
      launch_origin?: RunLaunchOrigin;
    }>();

    if (body.garden_path !== undefined && typeof body.garden_path !== 'string') {
      throw new HttpError(400, 'VALIDATION_ERROR', 'garden_path must be a string.');
    }
    if (body.run_id !== undefined && typeof body.run_id !== 'string') {
      throw new HttpError(400, 'VALIDATION_ERROR', 'run_id must be a string.');
    }
    if (body.auto_approve !== undefined && typeof body.auto_approve !== 'boolean') {
      throw new HttpError(400, 'VALIDATION_ERROR', 'auto_approve must be a boolean.');
    }
    if (body.force !== undefined && typeof body.force !== 'boolean') {
      throw new HttpError(400, 'VALIDATION_ERROR', 'force must be a boolean.');
    }
    if (body.launch_origin !== undefined && !isValidRunLaunchOrigin(body.launch_origin)) {
      throw new HttpError(400, 'VALIDATION_ERROR', `Invalid launch_origin '${body.launch_origin}'.`);
    }

    const selectedGarden = resolveSeedRunGardenPath(body.garden_path, seed.meta.linked_gardens, ws.root);
    const launchOrigin = body.launch_origin ?? 'seedbed';
    const seedDir = path.relative(ws.root, seed.dirPath).split(path.sep).join('/');

    let runId: string;
    let resumed = false;
    if (body.run_id && body.run_id.trim().length > 0) {
      const resumedResult = await runManager.resumePipeline({
        run_id: body.run_id,
        auto_approve: body.auto_approve,
        force: body.force,
        seed_id: seedId,
        seed_dir: seedDir,
        seed_garden: selectedGarden,
        launch_origin: launchOrigin,
      });
      runId = resumedResult.run_id;
      resumed = true;
    } else {
      await ensureGardenExists(selectedGarden, ws.root);
      const startedResult = await runManager.startPipeline({
        dot_path: selectedGarden,
        auto_approve: body.auto_approve,
        seed_id: seedId,
        seed_dir: seedDir,
        seed_garden: selectedGarden,
        launch_origin: launchOrigin,
      });
      runId = startedResult.run_id;
    }

    const updated = await lifecycle.attachRun(
      seedId,
      runId,
      selectedGarden,
      launchOrigin,
      resumed ? 'resume' : 'start',
    );
    trackSeedRunLifecycle({
      runManager,
      trackedSeedRuns,
      seedId,
      runId,
      gardenPath: selectedGarden,
      launchOrigin,
      lifecycle,
      eventBus,
      seedMeta: updated,
    });

    eventBus?.emit({
      type: 'seed_updated',
      seed_id: updated.id,
      status: updated.status,
      priority: updated.priority,
    });

    ctx.sendJson(202, {
      run_id: runId,
      status: 'running',
      seed_id: seedId,
      garden_path: selectedGarden,
      resumed,
    });
  });

  router.register('POST', '/seeds/:id/attachments', async (ctx) => {
    const seedId = parseSeedId(ctx.params.id);
    const seed = await store.get(seedId);
    if (!seed) {
      throw new HttpError(404, 'NOT_FOUND', `Seed '${seedId}' not found.`);
    }

    const contentType = ctx.req.headers['content-type'];
    const headerValue = Array.isArray(contentType) ? contentType[0] : contentType;
    const boundary = parseMultipartBoundary(headerValue);
    if (!boundary) {
      throw new HttpError(400, 'VALIDATION_ERROR', 'Expected multipart/form-data with boundary.');
    }

    const raw = await readRawBody(ctx.req, MAX_UPLOAD_BYTES);
    const filePart = parseMultipartFile(raw, boundary);
    if (!filePart) {
      throw new HttpError(400, 'VALIDATION_ERROR', 'No file part found in multipart payload.');
    }

    const attachmentsDir = path.join(seed.dirPath, 'attachments');
    await mkdir(attachmentsDir, { recursive: true });

    const sanitizedBase = sanitizeFilename(filePart.filename || 'attachment.bin');
    const uniqueName = await ensureUniqueFilename(attachmentsDir, sanitizedBase);
    const destination = path.join(attachmentsDir, uniqueName);
    await writeFile(destination, filePart.content);

    const seedMdPath = path.join(seed.dirPath, 'seed.md');
    const existingMarkdown = await readFile(seedMdPath, 'utf8').catch(() => '');
    const updatedMarkdown = appendAttachmentLinks(existingMarkdown, [
      {
        name: uniqueName,
        relativePath: `attachments/${uniqueName}`,
      },
    ]);
    await atomicWriteText(seedMdPath, updatedMarkdown);
    const updated = await store.patch(seedId, {});
    await activityStore.append(seedId, {
      type: 'seed_updated',
      actor: 'user',
      fields: ['attachments'],
    });

    eventBus?.emit({
      type: 'seed_updated',
      seed_id: updated.id,
      status: updated.status,
      priority: updated.priority,
    });

    ctx.sendJson(201, {
      filename: uniqueName,
      size: filePart.content.length,
      content_type: filePart.content_type,
      url: `/seeds/${seedId}/attachments/${encodeURIComponent(uniqueName)}`,
    });
  });

  router.register('POST', '/seeds/:id/analyze', async (ctx) => {
    if (!swarmManager) {
      throw new HttpError(503, 'UNAVAILABLE', 'Swarm analysis is not available.');
    }

    const seedId = parseSeedId(ctx.params.id);
    const seed = await store.get(seedId);
    if (!seed) {
      throw new HttpError(404, 'NOT_FOUND', `Seed '${seedId}' not found.`);
    }

    const body = await ctx.readJson<{ providers?: string[]; force?: boolean; include_attachments?: boolean }>();
    if (body.providers !== undefined && (!Array.isArray(body.providers) || body.providers.some((provider) => typeof provider !== 'string'))) {
      throw new HttpError(400, 'VALIDATION_ERROR', 'providers must be an array of strings.');
    }
    if (body.force !== undefined && typeof body.force !== 'boolean') {
      throw new HttpError(400, 'VALIDATION_ERROR', 'force must be a boolean.');
    }
    if (body.include_attachments !== undefined && typeof body.include_attachments !== 'boolean') {
      throw new HttpError(400, 'VALIDATION_ERROR', 'include_attachments must be a boolean.');
    }

    const providers = body.providers ?? [...SWARM_PROVIDERS];
    const invalidProviders = providers.filter((provider) => !SWARM_PROVIDERS.includes(provider as typeof SWARM_PROVIDERS[number]));
    if (invalidProviders.length > 0) {
      throw new HttpError(
        400,
        'VALIDATION_ERROR',
        `Unsupported providers: ${invalidProviders.join(', ')}. Allowed: ${SWARM_PROVIDERS.join(', ')}`
      );
    }

    const started = await swarmManager.start(seedId, {
      providers: providers as SwarmProvider[],
      force: body.force,
      include_attachments: body.include_attachments,
    });

    ctx.sendJson(202, started);
  });

  router.register('GET', '/seeds/:id/attachments/:filename', async (ctx) => {
    const seedId = parseSeedId(ctx.params.id);
    const seed = await store.get(seedId);
    if (!seed) {
      throw new HttpError(404, 'NOT_FOUND', `Seed '${seedId}' not found.`);
    }

    const requested = ctx.params.filename ?? '';
    const filename = path.basename(requested);
    if (!filename || filename !== requested) {
      throw new HttpError(400, 'VALIDATION_ERROR', 'Invalid attachment filename.');
    }

    const attachmentPath = path.join(seed.dirPath, 'attachments', filename);
    let content: Buffer;
    try {
      content = await readFile(attachmentPath);
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code === 'ENOENT') {
        throw new HttpError(404, 'NOT_FOUND', `Attachment '${filename}' not found.`);
      }
      throw error;
    }

    ctx.res.statusCode = 200;
    ctx.res.setHeader('Content-Type', contentTypeForFilename(filename));
    ctx.res.setHeader('Content-Length', content.length);
    ctx.res.end(content);
  });
}

function parseSeedId(raw: string | undefined): number {
  const parsed = Number.parseInt(raw ?? '', 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new HttpError(400, 'VALIDATION_ERROR', 'Seed id must be a positive integer.');
  }
  return parsed;
}

function parsePositiveInt(raw: string | null, fallback: number, max: number): number {
  if (!raw) {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.min(parsed, max);
}

function resolveSeedRunGardenPath(explicit: string | undefined, linkedGardens: string[], workspaceRoot: string): string {
  if (explicit && explicit.trim().length > 0) {
    return normalizeGardenRunPath(explicit, workspaceRoot);
  }
  if (linkedGardens.length === 1) {
    return linkedGardens[0]!;
  }
  if (linkedGardens.length > 1) {
    throw new HttpError(
      400,
      'VALIDATION_ERROR',
      'Seed has multiple linked gardens. Provide garden_path explicitly.',
    );
  }
  throw new HttpError(
    400,
    'VALIDATION_ERROR',
    'Seed has no linked gardens. Link a garden first or provide garden_path.',
  );
}

function normalizeGardenRunPath(rawPath: string, workspaceRoot: string): string {
  const trimmed = rawPath.trim();
  if (!trimmed) {
    throw new HttpError(400, 'VALIDATION_ERROR', 'garden_path must not be empty.');
  }
  const absolute = path.resolve(workspaceRoot, trimmed);
  const relative = path.relative(workspaceRoot, absolute);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new HttpError(400, 'VALIDATION_ERROR', `garden_path '${rawPath}' resolves outside workspace.`);
  }
  const normalized = relative.split(path.sep).join('/');
  if (!normalized.startsWith('gardens/')) {
    throw new HttpError(400, 'VALIDATION_ERROR', `garden_path '${rawPath}' must be inside gardens/.`);
  }
  if (!normalized.endsWith('.dot')) {
    throw new HttpError(400, 'VALIDATION_ERROR', `garden_path '${rawPath}' must end with .dot.`);
  }
  return normalized;
}

async function ensureGardenExists(gardenPath: string, workspaceRoot: string): Promise<void> {
  try {
    await access(path.resolve(workspaceRoot, gardenPath));
  } catch {
    throw new HttpError(404, 'NOT_FOUND', `Garden '${gardenPath}' not found.`);
  }
}

function collectChangedFields(
  previous: {
    title: string;
    status: SeedStatus;
    priority: SeedPriority;
    tags: string[];
    linked_gardens: string[];
    linked_runs: string[];
  },
  next: {
    title: string;
    status: SeedStatus;
    priority: SeedPriority;
    tags: string[];
    linked_gardens: string[];
    linked_runs: string[];
  },
  patchBody: { body?: string; title?: string; status?: SeedStatus; priority?: SeedPriority; tags?: string[] }
): string[] {
  const fields: string[] = [];
  if (patchBody.title !== undefined && previous.title !== next.title) {
    fields.push('title');
  }
  if (patchBody.body !== undefined) {
    fields.push('body');
  }
  if (patchBody.status !== undefined && previous.status !== next.status) {
    fields.push('status');
  }
  if (patchBody.priority !== undefined && previous.priority !== next.priority) {
    fields.push('priority');
  }
  if (patchBody.tags !== undefined && !arrayEquals(previous.tags, next.tags)) {
    fields.push('tags');
  }
  if (!arrayEquals(previous.linked_gardens, next.linked_gardens)) {
    fields.push('linked_gardens');
  }
  if (!arrayEquals(previous.linked_runs, next.linked_runs)) {
    fields.push('linked_runs');
  }
  return fields;
}

function arrayEquals(valuesA: string[], valuesB: string[]): boolean {
  if (valuesA.length !== valuesB.length) {
    return false;
  }
  for (let index = 0; index < valuesA.length; index += 1) {
    if (valuesA[index] !== valuesB[index]) {
      return false;
    }
  }
  return true;
}

async function listLinkedGardens(
  linkedGardens: string[],
  workspaceRoot: string
): Promise<Array<{ garden: string; status: 'ok' | 'unknown' }>> {
  const summaries: Array<{ garden: string; status: 'ok' | 'unknown' }> = [];
  for (const garden of linkedGardens) {
    const absolute = path.resolve(workspaceRoot, garden);
    const relative = path.relative(workspaceRoot, absolute);
    const normalized = relative.split(path.sep).join('/');
    if (relative.startsWith('..') || path.isAbsolute(relative) || !normalized.startsWith('gardens/')) {
      summaries.push({ garden, status: 'unknown' });
      continue;
    }

    try {
      await access(absolute);
      summaries.push({ garden: normalized, status: 'ok' });
    } catch {
      summaries.push({ garden: normalized, status: 'unknown' });
    }
  }
  return summaries;
}

async function listLinkedRunSummaries(linkedRuns: string[], workspaceRoot: string): Promise<LinkedRunSummary[]> {
  const summaries: LinkedRunSummary[] = [];

  for (const runId of linkedRuns) {
    const store = new RunStore(runId, workspaceRoot);
    const [manifest, cocoon] = await Promise.all([store.readManifest(), store.readCheckpoint()]);
    if (!manifest && !cocoon) {
      summaries.push({
        run_id: runId,
        status: 'unknown',
      });
      continue;
    }

    summaries.push({
      run_id: runId,
      status: normalizeRunStatus(cocoon?.status),
      dot_file: manifest?.dot_file ?? cocoon?.dot_file,
      started_at: manifest?.started_at ?? cocoon?.started_at,
      updated_at: cocoon?.updated_at,
      seed_garden: manifest?.seed_garden,
      launch_origin: manifest?.launch_origin,
    });
  }

  return summaries;
}

function normalizeRunStatus(status: RunStatus | undefined): LinkedRunSummary['status'] {
  if (!status) {
    return 'unknown';
  }
  if (status === 'running' || status === 'completed' || status === 'failed' || status === 'interrupted') {
    return status;
  }
  return 'unknown';
}

function trackSeedRunLifecycle(params: {
  runManager: RunManager;
  trackedSeedRuns: Map<string, () => void>;
  seedId: number;
  runId: string;
  gardenPath: string;
  launchOrigin: RunLaunchOrigin;
  lifecycle: SeedLifecycleService;
  eventBus?: WorkspaceEventBus;
  seedMeta: { id: number; status: string; priority: string };
}): void {
  if (params.trackedSeedRuns.has(params.runId)) {
    return;
  }

  const unsubscribe = params.runManager.subscribe(params.runId, (envelope) => {
    void handleTrackedSeedRunEvent(params, envelope.event);
  });
  if (!unsubscribe) {
    return;
  }

  params.trackedSeedRuns.set(params.runId, unsubscribe);
}

async function handleTrackedSeedRunEvent(
  params: {
    trackedSeedRuns: Map<string, () => void>;
    seedId: number;
    runId: string;
    gardenPath: string;
    launchOrigin: RunLaunchOrigin;
    lifecycle: SeedLifecycleService;
    eventBus?: WorkspaceEventBus;
    seedMeta: { id: number; status: string; priority: string };
  },
  event: RunEvent,
): Promise<void> {
  if (event.type === 'run_interrupted') {
    await params.lifecycle.recordRunTransition(params.seedId, {
      run_id: params.runId,
      transition: 'run_interrupted',
      reason: event.reason,
      garden: params.gardenPath,
      launch_origin: params.launchOrigin,
    });
    closeTrackedRun(params.trackedSeedRuns, params.runId);
    params.eventBus?.emit({
      type: 'seed_updated',
      seed_id: params.seedMeta.id,
      status: params.seedMeta.status,
      priority: params.seedMeta.priority,
    });
    return;
  }

  if (event.type === 'run_completed') {
    await params.lifecycle.recordRunTransition(params.seedId, {
      run_id: params.runId,
      transition: 'run_completed',
      garden: params.gardenPath,
      launch_origin: params.launchOrigin,
    });
    closeTrackedRun(params.trackedSeedRuns, params.runId);
    params.eventBus?.emit({
      type: 'seed_updated',
      seed_id: params.seedMeta.id,
      status: params.seedMeta.status,
      priority: params.seedMeta.priority,
    });
    return;
  }

  if (event.type === 'run_error') {
    await params.lifecycle.recordRunTransition(params.seedId, {
      run_id: params.runId,
      transition: 'run_failed',
      message: event.message,
      garden: params.gardenPath,
      launch_origin: params.launchOrigin,
    });
    closeTrackedRun(params.trackedSeedRuns, params.runId);
    params.eventBus?.emit({
      type: 'seed_updated',
      seed_id: params.seedMeta.id,
      status: params.seedMeta.status,
      priority: params.seedMeta.priority,
    });
  }
}

function closeTrackedRun(trackedSeedRuns: Map<string, () => void>, runId: string): void {
  const unsubscribe = trackedSeedRuns.get(runId);
  unsubscribe?.();
  trackedSeedRuns.delete(runId);
}

async function listFilenames(dirPath: string): Promise<string[]> {
  try {
    const entries = await readdir(dirPath, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b));
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') {
      return [];
    }
    throw error;
  }
}

async function listAttachments(
  seedId: number,
  dirPath: string
): Promise<Array<{ filename: string; size: number; content_type: string; url: string; is_image: boolean }>> {
  const files = await listFilenames(dirPath);
  const resources: Array<{ filename: string; size: number; content_type: string; url: string; is_image: boolean }> = [];

  for (const filename of files) {
    const info = await stat(path.join(dirPath, filename));
    resources.push({
      filename,
      size: info.size,
      content_type: contentTypeForFilename(filename),
      url: `/seeds/${seedId}/attachments/${encodeURIComponent(filename)}`,
      is_image: isImageFilename(filename),
    });
  }

  return resources;
}

async function listAnalyses(dirPath: string): Promise<AnalysisDocument[]> {
  const files = (await listFilenames(dirPath)).filter((filename) => filename.endsWith('.md'));
  const analyses: AnalysisDocument[] = [];

  for (const filename of files) {
    const provider = path.basename(filename, '.md');
    const analysisPath = path.join(dirPath, filename);

    try {
      const raw = await readFile(analysisPath, 'utf8');
      analyses.push(parseAnalysisDocument(raw));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      analyses.push({
        provider,
        generated_at: new Date(0).toISOString(),
        status: 'parse_error',
        error: `Invalid analysis document '${filename}': ${message}`,
        summary: 'Analysis document could not be parsed.',
        implementation_approach: 'Not available.',
        risks: 'Not available.',
        open_questions: 'Not available.',
        body_md: '',
      });
    }
  }

  return analyses;
}

async function ensureUniqueFilename(dirPath: string, preferred: string): Promise<string> {
  const existing = new Set(await listFilenames(dirPath));
  if (!existing.has(preferred)) {
    return preferred;
  }

  const ext = path.extname(preferred);
  const base = path.basename(preferred, ext);
  for (let counter = 1; counter < 10_000; counter += 1) {
    const candidate = `${base}-${counter}${ext}`;
    if (!existing.has(candidate)) {
      return candidate;
    }
  }

  throw new HttpError(409, 'CONFLICT', 'Unable to allocate a unique attachment filename.');
}

async function readRawBody(req: NodeJS.ReadableStream, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;

  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > maxBytes) {
      throw new HttpError(413, 'PAYLOAD_TOO_LARGE', `Upload exceeds ${maxBytes} bytes.`);
    }
    chunks.push(buffer);
  }

  return Buffer.concat(chunks);
}

function parseMultipartBoundary(contentType: string | undefined): string | null {
  if (!contentType || !contentType.toLowerCase().includes('multipart/form-data')) {
    return null;
  }
  const match = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
  return (match?.[1] ?? match?.[2] ?? null)?.trim() || null;
}

function parseMultipartFile(
  payload: Buffer,
  boundary: string
): { filename: string; content_type?: string; content: Buffer } | null {
  const delimiter = `--${boundary}`;
  const allParts = payload.toString('binary').split(delimiter);

  for (const rawPart of allParts) {
    const part = rawPart.trim();
    if (!part || part === '--') {
      continue;
    }

    const separatorIndex = part.indexOf('\r\n\r\n');
    if (separatorIndex < 0) {
      continue;
    }

    const headerBlock = part.slice(0, separatorIndex);
    const bodyBlock = part.slice(separatorIndex + 4).replace(/\r\n$/, '');

    const disposition = headerBlock.match(/content-disposition:[^\r\n]*/i)?.[0] ?? '';
    const filename = disposition.match(/filename="([^"]*)"/i)?.[1];
    if (!filename) {
      continue;
    }

    const parsedContentType = headerBlock.match(/content-type:\s*([^\r\n]+)/i)?.[1]?.trim();
    return {
      filename,
      content_type: parsedContentType,
      content: Buffer.from(bodyBlock, 'binary'),
    };
  }

  return null;
}

function contentTypeForFilename(filename: string): string {
  const ext = path.extname(filename).toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.gif') return 'image/gif';
  if (ext === '.svg') return 'image/svg+xml';
  if (ext === '.txt' || ext === '.md') return 'text/plain; charset=utf-8';
  if (ext === '.json') return 'application/json; charset=utf-8';
  return 'application/octet-stream';
}

function isImageFilename(filename: string): boolean {
  const ext = path.extname(filename).toLowerCase();
  return ext === '.png' || ext === '.jpg' || ext === '.jpeg' || ext === '.gif' || ext === '.svg' || ext === '.webp';
}

async function atomicWriteText(filePath: string, content: string): Promise<void> {
  const tempPath = `${filePath}.tmp`;
  await writeFile(tempPath, content, 'utf8');
  await rename(tempPath, filePath);
}
