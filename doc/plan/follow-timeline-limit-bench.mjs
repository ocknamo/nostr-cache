/**
 * global 戦略の limit を振ると初期表示は速くなるか（doc/plan/follow-timeline.md §7.4）。
 *
 * 実行: node doc/plan/follow-timeline-limit-bench.mjs（リポジトリのルートから）
 *
 * 仮説: ならない。limit は「何件送るか」であって「最初の 1 件がいつ出始めるか」
 * ではないので first event は RTT 支配で一定のはず。そして「最初の *表示できる*
 * 1 件」は h で決まる位置（nos.lol は 43 件目）にあるので、limit を削っても
 * その位置は動かず、limit がその位置を下回った瞬間に表示可がゼロになるはず。
 *
 * 比較のため authors 案（limit 50 固定、authors 件数を振る）も並べる。
 */

import { WebSocket } from 'ws';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { decodeNip19 } from '../../packages/shared/dist/index.js';

const NPUB = 'npub1y6aja0kkc4fdvuxgqjcdv4fx0v7xv2epuqnddey2eyaxquznp9vq0tp75l';
const RELAYS = ['wss://nos.lol/', 'wss://yabu.me/'];
const LIMITS = [10, 20, 50, 100, 200, 500];
const ROUNDS = 4;

const agent = process.env.HTTPS_PROXY ? new HttpsProxyAgent(process.env.HTTPS_PROXY) : undefined;
const SUBJECT = decodeNip19(NPUB).pubkey;

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { agent });
    const t = setTimeout(() => {
      ws.terminate();
      reject(new Error('timeout'));
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

function req(ws, subId, filter, isUsable) {
  return new Promise((resolve) => {
    let firstMs;
    let firstUsableMs;
    let firstUsableIndex = -1;
    let usable = 0;
    let count = 0;
    let bytes = 0;
    const started = Date.now();
    const finish = () => {
      ws.off('message', on);
      clearTimeout(timer);
      try {
        ws.send(JSON.stringify(['CLOSE', subId]));
      } catch {
        /* noop */
      }
      resolve({ firstMs, firstUsableMs, firstUsableIndex, usable, count, bytes, eoseMs });
    };
    let eoseMs;
    const timer = setTimeout(finish, 20_000);
    const on = (raw) => {
      const text = raw.toString();
      let m;
      try {
        m = JSON.parse(text);
      } catch {
        return;
      }
      if (m[1] !== subId) return;
      bytes += Buffer.byteLength(text);
      if (m[0] === 'EVENT') {
        count += 1;
        if (firstMs === undefined) firstMs = Date.now() - started;
        if (isUsable(m[2])) {
          usable += 1;
          if (firstUsableMs === undefined) {
            firstUsableMs = Date.now() - started;
            firstUsableIndex = count;
          }
        }
      } else if (m[0] === 'EOSE') {
        eoseMs = Date.now() - started;
        finish();
      } else if (m[0] === 'CLOSED') finish();
    };
    ws.on('message', on);
    ws.send(JSON.stringify(['REQ', subId, filter]));
  });
}

const med = (v) => {
  const s = v.filter((x) => x !== undefined && x >= 0).sort((a, b) => a - b);
  if (!s.length) return undefined;
  return s[Math.floor(s.length / 2)];
};

async function follows() {
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
  const set = await follows();
  const authors = [...set];
  const isUsable = (ev) => set.has(ev.pubkey);
  console.log(`フォロー ${authors.length} 人 / 各 ${ROUNDS} サンプル中央値\n`);

  for (const url of RELAYS) {
    const ws = await connect(url);
    await req(ws, 'warm', { kinds: [1], limit: 100 }, isUsable); // 暖機

    console.log(`=== ${url} ===`);
    console.log('  B: global, limit を振る');
    console.log('   limit | first | 表示可1件目 | その位置 | 表示可 | eose | 受信');
    for (const limit of LIMITS) {
      const runs = [];
      for (let i = 0; i < ROUNDS; i++) {
        runs.push(await req(ws, `g${limit}_${i}`, { kinds: [1], limit }, isUsable));
      }
      const fu = med(runs.map((r) => r.firstUsableMs));
      console.log(
        `   ${String(limit).padStart(5)} | ${String(med(runs.map((r) => r.firstMs))).padStart(5)}ms | ` +
          `${String(fu ?? '(無し)').padStart(9)}${fu !== undefined ? 'ms' : '  '} | ` +
          `${String(med(runs.map((r) => r.firstUsableIndex)) ?? '-').padStart(6)}件目 | ` +
          `${String(med(runs.map((r) => r.usable))).padStart(4)}件 | ` +
          `${String(med(runs.map((r) => r.eoseMs))).padStart(4)}ms | ` +
          `${(med(runs.map((r) => r.bytes)) / 1024).toFixed(0)}KB`
      );
    }

    console.log('  A: authors, limit=50 固定で authors 件数を振る');
    console.log('   authors | first | 表示可 | eose | 受信');
    for (const n of [100, 500, authors.length]) {
      const runs = [];
      for (let i = 0; i < ROUNDS; i++) {
        runs.push(
          await req(ws, `a${n}_${i}`, { kinds: [1], authors: authors.slice(0, n), limit: 50 }, isUsable)
        );
      }
      console.log(
        `   ${String(n).padStart(7)} | ${String(med(runs.map((r) => r.firstMs))).padStart(5)}ms | ` +
          `${String(med(runs.map((r) => r.usable))).padStart(4)}件 | ` +
          `${String(med(runs.map((r) => r.eoseMs))).padStart(4)}ms | ` +
          `${(med(runs.map((r) => r.bytes)) / 1024).toFixed(0)}KB`
      );
    }
    ws.close();
    console.log('');
  }
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  }
);
