/**
 * De-duplicated work queue shared by the lookups the timeline opens for itself:
 * one key is asked about once, the queue drains only while the socket is up,
 * and concurrency stays inside the relay's per-client `maxSubscriptions`.
 */

export interface RequestQueueOptions<T> {
  key(item: T): string;
  /** False while the socket is down, or the caller is stopped or suspended. */
  canStart(): boolean;
  /** Constant `true` for an unbounded queue. */
  hasCapacity(): boolean;
  start(item: T): void;
}

export class RequestQueue<T> {
  private readonly requested = new Set<string>();
  private pending: T[] = [];

  constructor(private readonly options: RequestQueueOptions<T>) {}

  /**
   * @returns Whether the item was new. Ignoring a repeat is de-duplication —
   *   the same card scrolls in and out — not a cache in front of the relay's.
   */
  request(item: T): boolean {
    const key = this.options.key(item);
    if (this.requested.has(key)) {
      return false;
    }
    this.requested.add(key);
    this.pending.push(item);
    this.pump();
    return true;
  }

  pump(): void {
    if (!this.options.canStart()) {
      return;
    }
    while (this.pending.length > 0 && this.options.hasCapacity()) {
      const item = this.pending.shift();
      if (item !== undefined) {
        this.options.start(item);
      }
    }
  }

  release(key: string): void {
    this.requested.delete(key);
  }

  /** Drop what is queued, keeping the de-duplication set. */
  clear(): void {
    this.pending = [];
  }

  /** Drop what is queued and let every key be asked for again. */
  reset(): void {
    this.pending = [];
    this.requested.clear();
  }
}
