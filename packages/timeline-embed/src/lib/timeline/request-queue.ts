/**
 * De-duplicated work queue shared by the lookups the timeline opens for itself.
 *
 * They all have the same shape: a key that must not be asked for twice, a queue
 * that only drains while the socket is up, and a budget of concurrent requests
 * small enough for the relay's per-client `maxSubscriptions` to hold.
 */

export interface RequestQueueOptions<T> {
  key(item: T): string;
  /** False while the socket is down, or the caller is stopped or suspended. */
  canStart(): boolean;
  /** False once the concurrency budget is spent; constant `true` is unbounded. */
  hasCapacity(): boolean;
  start(item: T): void;
}

export class RequestQueue<T> {
  private readonly requested = new Set<string>();
  private pending: T[] = [];

  constructor(private readonly options: RequestQueueOptions<T>) {}

  /**
   * @returns Whether the item was new. A repeat is ignored, which is request
   *   de-duplication — the same card scrolls in and out — and not a second
   *   cache in front of the relay's.
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

  /** Start as many queued items as the budget allows. */
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

  /** Let one key be asked for again. */
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
