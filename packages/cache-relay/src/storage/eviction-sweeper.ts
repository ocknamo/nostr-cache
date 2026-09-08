/**
 * `storageMaxSize` の定期チェック。
 *
 * 保存のたびに退避すると、上限に張り付いたキャッシュではイベント 1 件ごとに
 * ストレージの排他トランザクション（件数の数え上げと退避順の走査）が入り、同じ
 * ストアを読む REQ がその後ろに並ぶ。上限は厳密である必要がないので、超過を
 * しばらく許して定期的にまとめて落とす。
 */

import { logger } from '@nostr-cache/shared';
import type { CachePriority } from './priority.js';
import type { CacheStrategy, StorageAdapter } from './storage-adapter.js';

/** Default interval between eviction sweeps, in seconds. */
export const DEFAULT_STORAGE_SWEEP_INTERVAL = 600;

/**
 * 初回スイープまでの猶予（秒）。起動直後はキャッシュの読み出しが最も混み合う
 * ところで、そこへ退避を重ねるのがこのスイープの避けたいことそのもの。
 */
export const DEFAULT_STORAGE_SWEEP_DELAY = 30;

/**
 * 上限を超えたときに落とす先の割合。等倍だと超過のたびに退避が走り、
 * 定期化しても 1 件ずつの退避に戻ってしまう。
 */
export const EVICTION_TARGET_RATIO = 0.9;

export interface EvictionSweeperOptions {
  /** これを超えたときだけ退避する。 */
  maxSize: number;
  /** Interval between sweeps, in seconds. Defaults to 600. */
  intervalSeconds?: number;
  /** Delay before the first sweep, in seconds. Defaults to 30. */
  initialDelaySeconds?: number;
  strategy?: CacheStrategy;
  /** Cache priority config; matching events are evicted last. */
  priority?: CachePriority;
}

/** 上限超過を定期的に検査し、超えていれば低水位までまとめて退避する。 */
export class EvictionSweeper {
  private readonly maxSize: number;
  /** 超過を検知したときに落とす件数。 */
  private readonly target: number;
  private readonly intervalSeconds: number;
  private readonly initialDelaySeconds: number;
  private readonly strategy?: CacheStrategy;
  /** 実行時に setPriority で差し替え可能（次回スイープから反映） */
  private priority: CachePriority | undefined;
  private delayTimer: ReturnType<typeof setTimeout> | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  /** Guards against overlapping sweeps. */
  private sweeping = false;
  /** Ensures the "storage does not support enforceLimit" warning logs once. */
  private unsupportedWarned = false;

  constructor(
    private readonly storage: StorageAdapter,
    options: EvictionSweeperOptions
  ) {
    this.maxSize = options.maxSize;
    // 1 件は下回らせない。maxSize が 1 のとき floor が 0 になり、
    // enforceLimit が「上限なし」と解釈して退避しなくなる
    this.target = Math.max(1, Math.floor(options.maxSize * EVICTION_TARGET_RATIO));
    this.intervalSeconds =
      options.intervalSeconds && options.intervalSeconds > 0
        ? options.intervalSeconds
        : DEFAULT_STORAGE_SWEEP_INTERVAL;
    this.initialDelaySeconds =
      options.initialDelaySeconds !== undefined && options.initialDelaySeconds >= 0
        ? options.initialDelaySeconds
        : DEFAULT_STORAGE_SWEEP_DELAY;
    this.strategy = options.strategy;
    this.priority = options.priority;
  }

  /**
   * Start the periodic sweep. Idempotent.
   *
   * 起動直後に 1 回走らせないのは {@link DEFAULT_STORAGE_SWEEP_DELAY} の理由による。
   */
  start(): void {
    if (this.delayTimer !== undefined || this.timer !== undefined) {
      return;
    }

    this.delayTimer = setTimeout(() => {
      this.delayTimer = undefined;
      this.runSweep();
      this.timer = setInterval(() => {
        this.runSweep();
      }, this.intervalSeconds * 1000);
      this.timer.unref?.();
    }, this.initialDelaySeconds * 1000);

    // Don't keep the Node.js event loop alive solely for this timer
    this.delayTimer.unref?.();
  }

  /**
   * Stop the periodic sweep. Idempotent. A sweep already in flight is allowed
   * to finish.
   */
  stop(): void {
    if (this.delayTimer !== undefined) {
      clearTimeout(this.delayTimer);
      this.delayTimer = undefined;
    }
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /**
   * Replace the cache priority config. Takes effect from the next sweep
   * (a sweep already in flight keeps the config it started with).
   */
  setPriority(priority?: CachePriority): void {
    this.priority = priority;
  }

  /** Evict down to the low-water mark, but only if `maxSize` is exceeded. */
  async sweep(): Promise<number> {
    if (!(this.maxSize > 0)) {
      return 0;
    }

    if (typeof this.storage.enforceLimit !== 'function') {
      if (!this.unsupportedWarned) {
        logger.warn(
          'storageMaxSize is configured but the storage adapter does not support enforceLimit'
        );
        this.unsupportedWarned = true;
      }
      return 0;
    }

    // 超過していない間は数え上げだけで済ませる。退避順の走査は行の値を読むので、
    // 件数を数えるのとは桁が違う
    const count = await this.storage.count();
    if (count <= this.maxSize) {
      return 0;
    }

    return this.storage.enforceLimit(this.target, this.strategy, this.priority);
  }

  private runSweep(): void {
    if (this.sweeping) {
      return;
    }
    this.sweeping = true;
    this.sweep()
      .catch((error) => {
        logger.error('Eviction sweep failed:', error);
      })
      .finally(() => {
        this.sweeping = false;
      });
  }
}
