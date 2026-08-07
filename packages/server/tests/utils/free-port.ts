/**
 * 空きポート確保のテストユーティリティ。
 *
 * 統合テストは原則 `port: 0`（OS 任せ）で起動して `getPort()` / `getHealthPort()`
 * で実ポートを読み戻す。乱数で採番すると、帯の幅 10000 に対して N 回起動した
 * ときの衝突確率が誕生日のパラドックスで N²/20000 に膨らみ（1 帯で 100 回
 * 起動すればおよそ 5 割）、EADDRINUSE でフレークするため。
 *
 * ここにあるヘルパーは「具体的なポート番号が要る」ごく少数のテスト専用の
 * 逃げ道であって、既定の手段ではない。
 */

import { type Server, createServer } from 'node:net';

const HOST = '127.0.0.1';

/** 指定ポート（0 なら OS 任せ）で待ち受ける捨てサーバーを起動する。 */
function listen(port: number): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(port, HOST, () => {
      server.removeAllListeners('error');
      resolve(server);
    });
  });
}

/** 捨てサーバーを閉じる。 */
function close(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}

/** 待ち受け中の捨てサーバーのポート番号を取り出す。 */
function portOf(server: Server): number {
  const address = server.address();
  if (typeof address !== 'object' || address === null) {
    throw new Error('probe server is not listening on a TCP port');
  }
  return address.port;
}

/**
 * 連続した `count` 個の空きポートの先頭を返す。
 *
 * OS に 1 つ選ばせたうえで、後続のポートも実際に bind して空きを確かめる。
 * どこかが埋まっていれば別の ephemeral ポートで引き直すため、乱数採番と違って
 * 「すでに使われているポート」を返すことはない。
 *
 * ただし、確保した捨てサーバーを閉じてから呼び出し側が bind するまでの隙間は
 * 塞げない。**`port: 0` で足りるテストでは使わないこと**。ヘルスチェックの
 * 既定ポート（WebSocket ポート + 1）のように、番号そのものを検証したい
 * テストでのみ使う。
 *
 * @param count 必要な連番ポート数（既定 2）
 * @param attempts 引き直しの上限回数（既定 20）
 * @returns 連番の先頭ポート番号
 */
export async function findFreePortRange(count = 2, attempts = 20): Promise<number> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const held: Server[] = [];
    try {
      const first = await listen(0);
      held.push(first);
      const start = portOf(first);

      for (let offset = 1; offset < count; offset++) {
        held.push(await listen(start + offset));
      }
      return start;
    } catch {
      // 連番のどこかが埋まっていた（あるいは 65535 を超えた）。引き直す
    } finally {
      // return するときも finally が先に走るので、呼び出し側が受け取る時点では
      // 確保していたポートはすべて解放されている
      await Promise.all(held.map(close));
    }
  }

  throw new Error(`Could not find ${count} consecutive free ports after ${attempts} attempts`);
}
