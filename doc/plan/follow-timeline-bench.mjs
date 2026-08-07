/**
 * フォロータイムライン: authors 案 vs global 案の実測。
 *
 * doc/plan/follow-timeline.md §7.2 の数値を出したスクリプト。**上流リレーへ直接**
 * NIP-01 を話すだけで、cache-relay もブラウザも通らない（リレー側の挙動を単体で見る）。
 *
 *   A: authors 案  REQ {kinds:[1], authors:[...follows], limit:50}
 *   B: global 案   REQ {kinds:[1], limit:500}  → クライアント側でフォロー先だけ残す
 *
 * 「最初の表示可」= フォロー先が書いた最初の 1 件が届くまでの時間。global 案は
 * 表示できない投稿が先に届くので、単なる first event では比較にならない。
 *
 * 実行:
 *   node doc/plan/follow-timeline-bench.mjs
 * （リポジトリのルートから。ws / https-proxy-agent / packages/shared のビルドが要る）
 *
 * 注意: 一度きりの計測用で CI には載せていない。実リレーへ接続するため、
 * 数値は計測時点のもの（h は時刻によって振れる）。
 *
 * --- 元の検証メモ ---
 * 順序バイアスを除くための構成:
 *
 * 実測 2 では各ラウンドで必ず A → B の順に投げていた。A の round1 が 532ms、
 * round3 が 288ms と明らかに暖機の影響を受けており、「B が 2 倍速い」は
 * 測定順のアーティファクトの疑いがある。
 *
 * 対策:
 *  - 接続直後に捨て測定を 1 回入れて暖機する
 *  - A B B A の順で投げ、順序効果を相殺する
 *  - ラウンド数を増やし、中央値に加えて最小値も見る（最小値は暖機の影響が最も小さい）
 */

import { WebSocket } from 'ws';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { decodeNip19 } from '../../packages/shared/dist/index.js';

const NPUB = 'npub1y6aja0kkc4fdvuxgqjcdv4fx0v7xv2epuqnddey2eyaxquznp9vq0tp75l';
const RELAYS = ['wss://nos.lol/', 'wss://yabu.me/'];
const CAP = 500;
const LIMIT = 50;
const ROUNDS = 6; // A B B A を 6 セット = 各戦略 12 サンプル

const agent = process.env.HTTPS_PROXY ? new HttpsProxyAgent(process.env.HTTPS_PROXY) : undefined;
const SUBJECT = decodeNip19(NPUB).pubkey;

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { agent });
    const t = setTimeout(() => {
      ws.terminate();
      reject(new Error('connect timeout'));
    }, 15_000);
    ws.on('open', () => {
      clearTimeout(t);
      resolve(ws);
    });
    ws.on('error', (e) => {
      clearTimeout(t);
      reject(e);
    });
  });
}

function request(ws, subId, filters, isUsable) {
  return new Promise((resolve) => {
    let firstUsableMs;
    let eoseMs;
    let usable = 0;
    let count = 0;
    let bytes = 0;
    const reqText = JSON.stringify(['REQ', subId, ...filters]);
    const started = Date.now();
    const finish = () => {
      ws.off('message', onMessage);
      clearTimeout(timer);
      try {
        ws.send(JSON.stringify(['CLOSE', subId]));
      } catch {
        /* 計測に影響しない */
      }
      resolve({ firstUsableMs, eoseMs, usable, count, bytes });
    };
    const timer = setTimeout(finish, 20_000);
    const onMessage = (raw) => {
      const text = raw.toString();
      let msg;
      try {
        msg = JSON.parse(text);
      } catch {
        return;
      }
      if (msg[1] !== subId) return;
      bytes += Buffer.byteLength(text);
      if (msg[0] === 'EVENT') {
        count += 1;
        if (isUsable(msg[2])) {
          usable += 1;
          if (firstUsableMs === undefined) firstUsableMs = Date.now() - started;
        }
      } else if (msg[0] === 'EOSE') {
        eoseMs = Date.now() - started;
        finish();
      } else if (msg[0] === 'CLOSED') {
        finish();
      }
    };
    ws.on('message', onMessage);
    ws.send(reqText);
  });
}

const stat = (v) => {
  const s = v.filter((x) => x !== undefined).sort((a, b) => a - b);
  if (!s.length) return { med: undefined, min: undefined };
  const m = Math.floor(s.length / 2);
  return { med: s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2), min: s[0] };
};

async function fetchFollows() {
  const ws = await connect(RELAYS[0]);
  const evs = await new Promise((resolve) => {
    const acc = [];
    const on = (raw) => {
      const m = JSON.parse(raw.toString());
      if (m[1] !== 'f') return;
      if (m[0] === 'EVENT') acc.push(m[2]);
      else if (m[0] === 'EOSE') {
        ws.off('message', on);
        resolve(acc);
      }
    };
    ws.on('message', on);
    ws.send(JSON.stringify(['REQ', 'f', { kinds: [3], authors: [SUBJECT] }]));
  });
  ws.close();
  const newest = evs.sort((a, b) => b.created_at - a.created_at)[0];
  const s = new Set();
  for (const t of newest.tags) {
    if (t[0] === 'p' && /^[0-9a-f]{64}$/i.test(t[1] ?? '')) s.add(t[1].toLowerCase());
  }
  return s;
}

async function main() {
  const follows = await fetchFollows();
  const authors = [...follows];
  const isUsable = (ev) => follows.has(ev.pubkey);
  console.log(`フォロー ${authors.length} 人 / 各戦略 ${ROUNDS * 2} サンプル / 順序 A B B A\n`);

  for (const url of RELAYS) {
    const ws = await connect(url);
    const A = { kinds: [1], authors, limit: LIMIT };
    const B = { kinds: [1], limit: CAP };

    // 暖機（結果は捨てる）
    await request(ws, 'warm-a', [A], isUsable);
    await request(ws, 'warm-b', [B], isUsable);

    const a = [];
    const b = [];
    for (let i = 0; i < ROUNDS; i++) {
      a.push(await request(ws, `a${i}x`, [A], isUsable));
      b.push(await request(ws, `b${i}x`, [B], isUsable));
      b.push(await request(ws, `b${i}y`, [B], isUsable));
      a.push(await request(ws, `a${i}y`, [A], isUsable));
    }
    ws.close();

    const af = stat(a.map((r) => r.firstUsableMs));
    const ae = stat(a.map((r) => r.eoseMs));
    const bf = stat(b.map((r) => r.firstUsableMs));
    const be = stat(b.map((r) => r.eoseMs));
    const h = (stat(b.map((r) => r.usable)).med / stat(b.map((r) => r.count)).med) * 100;

    console.log(`--- ${url}  h=${h.toFixed(2)}% ---`);
    console.log(
      `  A authors : 最初の表示可 med=${af.med}ms min=${af.min}ms | eose med=${ae.med}ms min=${ae.min}ms | ` +
        `表示可=${stat(a.map((r) => r.usable)).med}件 | 受信=${(stat(a.map((r) => r.bytes)).med / 1024).toFixed(0)}KB`
    );
    console.log(
      `  B global  : 最初の表示可 med=${bf.med}ms min=${bf.min}ms | eose med=${be.med}ms min=${be.min}ms | ` +
        `表示可=${stat(b.map((r) => r.usable)).med}件 | 受信=${(stat(b.map((r) => r.bytes)).med / 1024).toFixed(0)}KB`
    );
    console.log(
      `  生データ A first: ${a.map((r) => r.firstUsableMs).join(', ')}\n` +
        `  生データ B first: ${b.map((r) => r.firstUsableMs).join(', ')}\n`
    );
  }
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  }
);
