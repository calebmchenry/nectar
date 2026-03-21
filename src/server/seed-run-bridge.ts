import type { RunEvent } from '../engine/events.js';
import { SeedLifecycleService } from '../seedbed/lifecycle.js';
import { SeedStore } from '../seedbed/store.js';
import type { RunLaunchOrigin } from '../seedbed/types.js';
import type { RunManager } from './run-manager.js';
import type { WorkspaceEventBus } from './workspace-event-bus.js';

export interface SeedRunBridgeOptions {
  run_manager: RunManager;
  lifecycle: SeedLifecycleService;
  seed_store: SeedStore;
  event_bus?: WorkspaceEventBus;
}

export interface SeedRunBridgeAttachInput {
  seed_id: number;
  run_id: string;
  garden_path: string;
  launch_origin: RunLaunchOrigin;
}

export class SeedRunBridge {
  private readonly runManager: RunManager;
  private readonly lifecycle: SeedLifecycleService;
  private readonly seedStore: SeedStore;
  private readonly eventBus?: WorkspaceEventBus;
  private readonly subscriptions = new Map<string, () => void>();
  private readonly eventChains = new Map<string, Promise<void>>();

  constructor(options: SeedRunBridgeOptions) {
    this.runManager = options.run_manager;
    this.lifecycle = options.lifecycle;
    this.seedStore = options.seed_store;
    this.eventBus = options.event_bus;
  }

  async attach(input: SeedRunBridgeAttachInput): Promise<void> {
    const key = this.keyFor(input.seed_id, input.run_id);
    if (!this.subscriptions.has(key)) {
      const unsubscribe = this.runManager.subscribe(input.run_id, (envelope) => {
        this.queueEvent(key, input, envelope.event);
      });
      if (unsubscribe) {
        this.subscriptions.set(key, unsubscribe);
      }
    }

    const status = await this.runManager.getStatus(input.run_id);
    if (!status || status.status === 'running') {
      return;
    }

    if (status.status === 'interrupted') {
      await this.lifecycle.recordRunTransition(input.seed_id, {
        run_id: input.run_id,
        transition: 'run_interrupted',
        reason: status.interruption_reason,
        garden: input.garden_path,
        launch_origin: input.launch_origin,
      });
      await this.emitFreshSeedUpdate(input.seed_id);
      this.detach(key);
      return;
    }

    if (status.status === 'completed') {
      await this.lifecycle.recordRunTransition(input.seed_id, {
        run_id: input.run_id,
        transition: 'run_completed',
        garden: input.garden_path,
        launch_origin: input.launch_origin,
      });
      await this.emitFreshSeedUpdate(input.seed_id);
      this.detach(key);
      return;
    }

    if (status.status === 'failed') {
      await this.lifecycle.recordRunTransition(input.seed_id, {
        run_id: input.run_id,
        transition: 'run_failed',
        message: `Linked run '${input.run_id}' failed.`,
        garden: input.garden_path,
        launch_origin: input.launch_origin,
      });
      await this.emitFreshSeedUpdate(input.seed_id);
      this.detach(key);
    }
  }

  async close(): Promise<void> {
    for (const unsubscribe of this.subscriptions.values()) {
      unsubscribe();
    }
    this.subscriptions.clear();
    await Promise.allSettled(this.eventChains.values());
    this.eventChains.clear();
  }

  private queueEvent(key: string, input: SeedRunBridgeAttachInput, event: RunEvent): void {
    const chain = this.eventChains.get(key) ?? Promise.resolve();
    const next = chain
      .then(async () => {
        await this.handleEvent(key, input, event);
      })
      .catch(() => {
        // Keep event processing best-effort and avoid breaking future transitions.
      });
    this.eventChains.set(key, next);
  }

  private async handleEvent(key: string, input: SeedRunBridgeAttachInput, event: RunEvent): Promise<void> {
    if (event.type === 'run_interrupted') {
      await this.lifecycle.recordRunTransition(input.seed_id, {
        run_id: input.run_id,
        transition: 'run_interrupted',
        reason: event.reason,
        garden: input.garden_path,
        launch_origin: input.launch_origin,
      });
      await this.emitFreshSeedUpdate(input.seed_id);
      this.detach(key);
      return;
    }

    if (event.type === 'run_completed') {
      await this.lifecycle.recordRunTransition(input.seed_id, {
        run_id: input.run_id,
        transition: 'run_completed',
        garden: input.garden_path,
        launch_origin: input.launch_origin,
      });
      await this.emitFreshSeedUpdate(input.seed_id);
      this.detach(key);
      return;
    }

    if (event.type === 'run_error') {
      await this.lifecycle.recordRunTransition(input.seed_id, {
        run_id: input.run_id,
        transition: 'run_failed',
        message: event.message,
        garden: input.garden_path,
        launch_origin: input.launch_origin,
      });
      await this.emitFreshSeedUpdate(input.seed_id);
      this.detach(key);
    }
  }

  private async emitFreshSeedUpdate(seedId: number): Promise<void> {
    if (!this.eventBus) {
      return;
    }
    const current = await this.seedStore.get(seedId);
    if (!current) {
      return;
    }
    this.eventBus.emit({
      type: 'seed_updated',
      seed_id: current.meta.id,
      status: current.meta.status,
      priority: current.meta.priority,
    });
  }

  private detach(key: string): void {
    this.subscriptions.get(key)?.();
    this.subscriptions.delete(key);
    this.eventChains.delete(key);
  }

  private keyFor(seedId: number, runId: string): string {
    return `${seedId}:${runId}`;
  }
}
