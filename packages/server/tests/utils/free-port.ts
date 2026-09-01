/**
 * 統合テスト用のポート確保ユーティリティ。
 *
 * `listen(0)` で番号をもらって閉じてから渡す方式は、vitest が spec を並列ワーカーで
 * 走らせるとカーネルの ephemeral 帯を取り合って EADDRINUSE になる。代わりに
 * **ワーカーごとに重ならない固定帯**を単調増加のカーソルで払い出し、ephemeral 帯の
 * 外に置く。無関係なプロセスと衝突していないかだけは、払い出し前に bind して確かめる。
 */

import { type Server, createServer } from 'node:net';

/**
 * 払い出し帯の下端。Linux 既定の ephemeral 範囲（32768-60999）より下に置き、
 * カーネルが `listen(0)` で勝手に配ってくる番号と重ならないようにする。
 */
const BAND_START = 20000;

/** 払い出し帯の上端（この番号は含まない）。 */
const BAND_END = 32000;

/** vitest ワーカー 1 つに与える帯幅。BAND 全体 12000 を 24 ワーカーぶんに分ける。 */
const WORKER_BAND_SIZE = 500;

/** 帯を分割するワーカー数の上限。これを超えるワーカー ID は折り返す。 */
const MAX_WORKERS = (BAND_END - BAND_START) / WORKER_BAND_SIZE;

/** リレー 1 台が消費するポート数（WebSocket 本体 + ヘルスチェックの PORT+1）。 */
const PORTS_PER_RELAY = 2;

/**
 * このワーカーの帯の下端。
 *
 * vitest は spec ファイルを並列ワーカーで実行し、各ワーカーに 1 起点の
 * `VITEST_WORKER_ID` を渡す。これで帯を分ければワーカー間の衝突は起こりえない。
 */
const workerBandStart = (() => {
  const workerId = Number(process.env.VITEST_WORKER_ID ?? '1');
  const index = (Number.isFinite(workerId) && workerId > 0 ? workerId - 1 : 0) % MAX_WORKERS;
  return BAND_START + index * WORKER_BAND_SIZE;
})();

/** 帯の中の次の払い出し位置（このワーカー内で単調増加）。 */
let cursor = 0;

/** 指定ポートで待ち受ける捨てサーバーを起動する（host 未指定＝リレー本体と同じ全 IF）。 */
function listen(port: number): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(port, () => {
      server.removeAllListeners('error');
      resolve(server);
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}

function portOf(server: Server): number {
  const address = server.address();
  if (typeof address !== 'object' || address === null) {
    throw new Error('probe server is not listening on a TCP port');
  }
  return address.port;
}

/** 帯の中の次の枠を返し、カーソルを進める。帯を使い切ったら先頭へ折り返す。 */
function nextSlot(portsPerRelay: number): number {
  if (cursor + portsPerRelay > WORKER_BAND_SIZE) {
    // 帯を一巡した。ここまで来る頃には先頭側のサーバーは停止済みなので再利用してよい
    cursor = 0;
  }
  const port = workerBandStart + cursor;
  cursor += portsPerRelay;
  return port;
}

/**
 * リレー 1 台ぶんの空きポートを確保して返す。
 *
 * カーソルが単調増加するので、続けて呼んでも同じ番号は返らない（1 テストで複数の
 * サーバーを立てる spec でも自己衝突しない）。念のため各枠は実際に bind して空きを
 * 確かめ、無関係なプロセスに埋められていれば次の枠へ進む。
 */
async function allocateSlot(portsPerRelay: number, attempts: number): Promise<number> {
  let lastError: unknown;

  for (let attempt = 0; attempt < attempts; attempt++) {
    const base = nextSlot(portsPerRelay);
    const held: Server[] = [];
    try {
      for (let offset = 0; offset < portsPerRelay; offset++) {
        held.push(await listen(base + offset));
      }
      return base;
    } catch (error) {
      // 無関係なプロセスがこの枠を使っている。次の枠へ進む。
      // 打ち切ったときの調査用に最後の原因だけ残す（EADDRINUSE の空振りと、
      // RangeError のようなプログラミングエラーを取り違えないため）
      lastError = error;
    } finally {
      // return するときも finally が先に走るので、呼び出し側が bind する時点では
      // 解放済み。この隙間に割り込めるのは「同じ帯を狙う無関係なプロセス」だけで、
      // カーネルの ephemeral 割り当ても他ワーカーもこの帯には来ない
      await Promise.all(held.map(close));
    }
  }

  // ES2020 ターゲットのため Error の cause オプションは使えない。原因はメッセージに畳む
  throw new Error(
    `Could not allocate ${portsPerRelay} consecutive free ports in band` +
      ` ${workerBandStart}-${workerBandStart + WORKER_BAND_SIZE} after ${attempts} attempts` +
      ` (last error: ${lastError instanceof Error ? lastError.message : String(lastError)})`
  );
}

/** 起動・停止できる最小のリレー的インターフェース（具象型に依存しないため）。 */
interface StartStoppable {
  start(): Promise<void>;
  stop(): Promise<void>;
}

function isAddressInUse(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === 'EADDRINUSE';
}

/**
 * ポートを確保してリレーを起動する。`EADDRINUSE` で失敗したら別の枠で自動リトライする。
 *
 * ワーカー帯の分割で潰せるのは「このテスト実行の中での衝突」だけ。
 * **同じマシンで同じスイートを同時に走らせた場合**（別プロセスなのでどちらも
 * ワーカー 1 の帯から始まる）や、無関係なプロセスが帯を使っている場合は、
 * 確保と bind の隙間で取られうる。そこは事前確認では原理的に塞げないので、
 * 失敗を検出して別の枠で取り直す。実測でも 3 スイート同時実行では
 * このリトライが効いている（帯分割だけでは 18 回中 5 回落ちた）。
 *
 * ヘルスチェック用ポート（`PORT + 1`）の確保失敗は本番実装が握り潰して警告ログだけを
 * 出す仕様のため、ここでは検出できない。ヘルスチェックを検証する spec は
 * `healthCheck.port` を明示すること。
 */
export async function startRelayServer<T extends StartStoppable>(
  create: (port: number) => T,
  options: { portsPerRelay?: number; attempts?: number } = {}
): Promise<{ server: T; port: number }> {
  const portsPerRelay = options.portsPerRelay ?? PORTS_PER_RELAY;
  const attempts = options.attempts ?? 10;
  let lastError: unknown;

  for (let attempt = 0; attempt < attempts; attempt++) {
    const port = await allocateSlot(portsPerRelay, 50);
    const server = create(port);
    try {
      await server.start();
      return { server, port };
    } catch (error) {
      // 起動途中で確保したリソース（ストレージのハンドル等）を解放してから取り直す
      await server.stop().catch(() => {});
      if (!isAddressInUse(error)) {
        throw error;
      }
      lastError = error;
    }
  }

  // ES2020 ターゲットのため Error の cause オプションは使えない。原因はメッセージに畳む
  throw new Error(
    `Relay server failed to start after ${attempts} port attempts` +
      ` (last error: ${lastError instanceof Error ? lastError.message : String(lastError)})`
  );
}

/** {@link reservePort} が返す、掴んだままの空きポート。 */
export interface ReservedPort {
  port: number;
  release(): Promise<void>;
}

/**
 * 空きポートを 1 つ、`release()` を呼ぶまで**掴んだまま**返す。
 *
 * 「このポートでは誰も待ち受けていない」ことを検証するテスト向け。掴んだままなので
 * ここでは ephemeral 帯（`listen(0)`）で構わない — 解放しない限り誰にも割り当て
 * られないため。番号を取ってすぐ解放すると、同じテスト内で起動するサーバーに OS が
 * 同じ番号を割り当ててしまい、検証が偽陰性で落ちうる。
 */
export async function reservePort(): Promise<ReservedPort> {
  const server = await listen(0);
  return {
    port: portOf(server),
    release: () => close(server),
  };
}
