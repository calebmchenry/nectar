import { SeedActivityStore } from './activity.js';
import { SeedStore } from './store.js';
import type {
  LinkedRunSummary,
  RunLaunchOrigin,
  SeedActivityActor,
  SeedMeta,
  SeedStatus,
  SeedStatusSuggestion,
} from './types.js';

type AttachRunKind = 'start' | 'resume';

export interface RecordRunTransitionInput {
  run_id: string;
  transition: 'run_interrupted' | 'run_completed' | 'run_failed';
  actor?: SeedActivityActor;
  reason?: string;
  message?: string;
  garden?: string;
  launch_origin?: RunLaunchOrigin;
}

export class SeedLifecycleService {
  constructor(
    private readonly store: SeedStore,
    private readonly activity: SeedActivityStore,
  ) {}

  async linkGarden(seedId: number, gardenPath: string, actor: SeedActivityActor = 'user'): Promise<SeedMeta> {
    const before = await this.store.get(seedId);
    if (!before) {
      throw new Error(`Seed ${seedId} not found.`);
    }

    const updated = await this.store.patch(seedId, {
      linked_gardens_add: [gardenPath],
    });

    const added = updated.linked_gardens.find((garden) => !before.meta.linked_gardens.includes(garden));
    if (added) {
      await this.activity.append(seedId, {
        type: 'garden_linked',
        actor,
        garden: added,
      });
    }

    return updated;
  }

  async unlinkGarden(seedId: number, gardenPath: string, actor: SeedActivityActor = 'user'): Promise<SeedMeta> {
    const before = await this.store.get(seedId);
    if (!before) {
      throw new Error(`Seed ${seedId} not found.`);
    }

    const removedSet = new Set(before.meta.linked_gardens);
    const updated = await this.store.patch(seedId, {
      linked_gardens_remove: [gardenPath],
    });

    for (const linked of updated.linked_gardens) {
      removedSet.delete(linked);
    }

    for (const removed of removedSet) {
      await this.activity.append(seedId, {
        type: 'garden_unlinked',
        actor,
        garden: removed,
      });
    }

    return updated;
  }

  async attachRun(
    seedId: number,
    runId: string,
    gardenPath: string | undefined,
    origin: RunLaunchOrigin,
    kind: AttachRunKind,
    actor: SeedActivityActor = 'system',
  ): Promise<SeedMeta> {
    const before = await this.store.get(seedId);
    if (!before) {
      throw new Error(`Seed ${seedId} not found.`);
    }

    const nextStatus = autoPromoteStatus(before.meta.status);
    const updated = await this.store.patch(seedId, {
      status: nextStatus,
      linked_runs_add: [runId],
      linked_gardens_add: gardenPath ? [gardenPath] : undefined,
    });

    const activityType = kind === 'resume' ? 'run_resumed' : 'run_started';
    await this.activity.append(seedId, {
      type: activityType,
      actor,
      run_id: runId,
      garden: gardenPath,
      launch_origin: origin,
      idempotency_key: `${seedId}:${runId}:${activityType}`,
    });

    if (before.meta.status !== updated.status) {
      await this.activity.append(seedId, {
        type: 'status_changed',
        actor: 'system',
        from: before.meta.status,
        to: updated.status,
        reason: `Auto-promoted on ${kind}.`,
      });
    }

    return updated;
  }

  async recordRunTransition(seedId: number, input: RecordRunTransitionInput): Promise<void> {
    if (input.transition === 'run_interrupted') {
      await this.activity.append(seedId, {
        type: 'run_interrupted',
        actor: input.actor ?? 'system',
        run_id: input.run_id,
        garden: input.garden,
        launch_origin: input.launch_origin,
        reason: input.reason,
        idempotency_key: `${seedId}:${input.run_id}:run_interrupted`,
      });
      return;
    }

    if (input.transition === 'run_completed') {
      await this.activity.append(seedId, {
        type: 'run_completed',
        actor: input.actor ?? 'system',
        run_id: input.run_id,
        garden: input.garden,
        launch_origin: input.launch_origin,
        idempotency_key: `${seedId}:${input.run_id}:run_completed`,
      });
      return;
    }

    await this.activity.append(seedId, {
      type: 'run_failed',
      actor: input.actor ?? 'system',
      run_id: input.run_id,
      garden: input.garden,
      launch_origin: input.launch_origin,
      status: 'failed',
      message: input.message ?? 'Linked run failed.',
      idempotency_key: `${seedId}:${input.run_id}:run_failed`,
    });
  }

  computeStatusSuggestion(seedMeta: SeedMeta, linkedRunSummaries: LinkedRunSummary[]): SeedStatusSuggestion | null {
    if (seedMeta.status === 'honey' || seedMeta.status === 'wilted') {
      return null;
    }

    const latest = linkedRunSummaries[0];
    if (!latest || latest.status !== 'completed') {
      return null;
    }

    return {
      suggested_status: 'honey',
      based_on_run_id: latest.run_id,
      reason: `Latest linked run ${latest.run_id} completed successfully.`,
    };
  }
}

function autoPromoteStatus(current: SeedStatus): SeedStatus {
  if (current === 'seedling' || current === 'sprouting') {
    return 'blooming';
  }
  return current;
}
