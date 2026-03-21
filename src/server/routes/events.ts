import { mkdir, stat } from 'node:fs/promises';
import { watch, type FSWatcher } from 'node:fs';
import path from 'node:path';
import { Router } from '../router.js';
import { createPersistentSseStream } from '../sse.js';
import { WorkspaceEventBus } from '../workspace-event-bus.js';

export interface WorkspaceEventRoutesOptions {
  workspace_root: string;
  event_bus?: WorkspaceEventBus;
}

interface PendingFsEvent {
  scope: 'garden' | 'seed';
  event_type: 'rename' | 'change';
  filename: string;
  absolute_path: string;
}

export function registerWorkspaceEventRoutes(router: Router, options: WorkspaceEventRoutesOptions): void {
  const workspaceRoot = options.workspace_root;
  const eventBus = options.event_bus;

  router.register('GET', '/events', async (ctx) => {
    const gardensDir = path.join(workspaceRoot, 'gardens');
    const seedbedDir = path.join(workspaceRoot, 'seedbed');

    await mkdir(gardensDir, { recursive: true });
    await mkdir(seedbedDir, { recursive: true });

    const stream = createPersistentSseStream({
      req: ctx.req,
      res: ctx.res,
    });

    let nextPayloadId = 1;
    const pending = new Map<string, PendingFsEvent>();
    let flushTimer: ReturnType<typeof setTimeout> | undefined;

    const emit = (eventName: string, payload: object) => {
      const wrote = stream.send(eventName, {
        id: nextPayloadId,
        timestamp: new Date().toISOString(),
        ...(payload as Record<string, unknown>),
      });
      if (wrote) {
        nextPayloadId += 1;
      }
    };

    const scheduleFlush = () => {
      if (stream.isClosed()) {
        return;
      }
      if (flushTimer) {
        clearTimeout(flushTimer);
      }
      flushTimer = setTimeout(() => {
        void flushPending();
      }, 100);
      flushTimer.unref?.();
    };

    const flushPending = async () => {
      if (stream.isClosed()) {
        return;
      }
      const items = Array.from(pending.values());
      pending.clear();

      for (const event of items) {
        if (stream.isClosed()) {
          break;
        }
        if (event.scope === 'garden') {
          if (!event.filename.endsWith('.dot')) {
            continue;
          }
          emit('garden_changed', {
            path: path.posix.join('gardens', event.filename),
            change: event.event_type,
          });
          continue;
        }

        if (event.event_type === 'change') {
          emit('seed_updated', {
            path: path.posix.join('seedbed', event.filename),
          });
          continue;
        }

        const exists = await pathExists(event.absolute_path);
        emit(exists ? 'seed_created' : 'seed_deleted', {
          path: path.posix.join('seedbed', event.filename),
        });
      }
    };

    const watchers: FSWatcher[] = [];
    watchers.push(createWatcher(gardensDir, 'garden', pending, scheduleFlush));
    watchers.push(createWatcher(seedbedDir, 'seed', pending, scheduleFlush));

    const unsubscribeSemantic = eventBus?.subscribe((event) => {
      emit(event.type, event);
    });
    stream.onClose(() => {
      if (flushTimer) {
        clearTimeout(flushTimer);
      }
      for (const watcher of watchers) {
        watcher.close();
      }
      unsubscribeSemantic?.();
    });
  });
}

function createWatcher(
  targetDir: string,
  scope: PendingFsEvent['scope'],
  pending: Map<string, PendingFsEvent>,
  scheduleFlush: () => void
): FSWatcher {
  return watch(targetDir, { persistent: false }, (eventType, filename) => {
    if (!filename) {
      return;
    }

    const normalized = filename.toString();
    if (!normalized || normalized.startsWith('.')) {
      return;
    }

    const absolutePath = path.join(targetDir, normalized);
    pending.set(`${scope}:${normalized}`, {
      scope,
      event_type: eventType === 'rename' ? 'rename' : 'change',
      filename: normalized,
      absolute_path: absolutePath,
    });
    scheduleFlush();
  });
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await stat(targetPath);
    return true;
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}
