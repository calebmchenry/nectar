import type { AgentSession } from '../agent-loop/session.js';

const DEFAULT_LOCK_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

interface ThreadEntry {
  session: AgentSession;
  provider: string;
  model: string;
  /** Chain of sequential access promises */
  lockChain: Promise<void>;
}

export class SessionRegistry {
  private readonly threads = new Map<string, ThreadEntry>();
  private readonly lockTimeoutMs: number;

  constructor(lockTimeoutMs?: number) {
    this.lockTimeoutMs = lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
  }

  has(threadKey: string): boolean {
    return this.threads.has(threadKey);
  }

  getKeys(): string[] {
    return Array.from(this.threads.keys());
  }

  /**
   * Acquire a session for the given thread key.
   * If the thread already exists, waits for the FIFO lock before returning.
   * Returns a release function that MUST be called when done with the session.
   */
  async acquire(
    threadKey: string,
    provider: string,
    model: string,
    sessionFactory: () => AgentSession
  ): Promise<{ session: AgentSession; isNew: boolean; release: () => void }> {
    const existing = this.threads.get(threadKey);

    if (existing) {
      // Validate provider/model match
      if (existing.provider !== provider || existing.model !== model) {
        throw new Error(
          `Thread '${threadKey}' was created with provider='${existing.provider}', model='${existing.model}' ` +
          `but requested with provider='${provider}', model='${model}'. Provider/model mismatch on thread reuse.`
        );
      }

      // Wait for previous use to complete, then claim the lock
      let release: () => void = () => {};
      const myTurn = new Promise<void>((resolve) => {
        release = resolve;
      });

      const previousChain = existing.lockChain;
      existing.lockChain = myTurn;

      // Wait for previous chain with timeout
      const timeout = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`Thread lock timeout after ${this.lockTimeoutMs}ms`)), this.lockTimeoutMs)
      );

      await Promise.race([previousChain, timeout]);

      return { session: existing.session, isNew: false, release };
    }

    // Create new session — lock starts with a pending promise for the first user
    const session = sessionFactory();
    let release: () => void = () => {};
    const firstLock = new Promise<void>((resolve) => {
      release = resolve;
    });

    const entry: ThreadEntry = {
      session,
      provider,
      model,
      lockChain: firstLock,
    };
    this.threads.set(threadKey, entry);
    return { session, isNew: true, release };
  }

  async closeAll(): Promise<void> {
    for (const [, entry] of this.threads) {
      try {
        entry.session.close();
      } catch {
        // Best-effort cleanup
      }
    }
    this.threads.clear();
  }
}
