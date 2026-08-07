/**
 * 細い回線での挙動を推定するための分解計測（doc/plan/follow-timeline.md §7.3）。
 *
 * 実行: node doc/plan/follow-timeline-link-bench.mjs（リポジトリのルートから）
 *
 * 実測した「29KB / 400KB」「REQ 59KB」は太い回線での値なので、帯域と RTT に
 * 分解し直さないとモバイルの予測ができない。推定の精度を大きく左右するのは:
 *
 *  1. permessage-deflate が実際にネゴシエートされるか
 *     → 効くなら A の 59KB 上りは hex 主体なので大幅に縮む
 *  2. 実 RTT（往復回数がいくつ効くか）
 *  3. 1 イベントあたりの平均バイト数（B が最初の表示可へ到達するまでの下り量）
 */

import { WebSocket } from 'ws';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { deflateRawSync } from 'node:zlib';
import { decodeNip19 } from '../../packages/shared/dist/index.js';

const NPUB = 'npub1y6aja0kkc4fdvuxgqjcdv4fx0v7xv2epuqnddey2eyaxquznp9vq0tp75l';
const RELAYS = ['wss://nos.lol/', 'wss://yabu.me/'];
const agent = process.env.HTTPS_PROXY ? new HttpsProxyAgent(process.env.HTTPS_PROXY) : undefined;
const SUBJECT = decodeNip19(NPUB).pubkey;

function connect(url, perMessageDeflate) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { agent, perMessageDeflate });
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

function collect(ws, subId, filter) {
  return new Promise((resolve) => {
    const sizes = [];
    let eoseMs;
    const started = Date.now();
    const finish = () => {
      ws.off('message', on);
      clearTimeout(timer);
      try {
        ws.send(JSON.stringify(['CLOSE', subId]));
      } catch {
        /* noop */
      }
      resolve({ sizes, eoseMs });
    };
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
      if (m[0] === 'EVENT') sizes.push(Buffer.byteLength(text));
      else if (m[0] === 'EOSE') {
        eoseMs = Date.now() - started;
        finish();
      } else if (m[0] === 'CLOSED') finish();
    };
    ws.on('message', on);
    ws.send(JSON.stringify(['REQ', subId, filter]));
  });
}

async function followsOf() {
  const ws = await connect(RELAYS[0], false);
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
  return [...s];
}

async function rtt(url) {
  const ws = await connect(url, false);
  const samples = [];
  for (let i = 0; i < 5; i++) {
    const t0 = Date.now();
    await new Promise((resolve) => {
      ws.once('pong', resolve);
      ws.ping();
    });
    samples.push(Date.now() - t0);
  }
  ws.close();
  samples.sort((a, b) => a - b);
  return samples[Math.floor(samples.length / 2)];
}

async function main() {
  const follows = await followsOf();
  console.log(`フォロー ${follows.length} 人\n`);

  // --- 1. REQ の圧縮率（上り） ---
  console.log('== REQ サイズと deflate 後 ==');
  for (const n of [100, 500, follows.length]) {
    const req = JSON.stringify(['REQ', 'x', { kinds: [1], authors: follows.slice(0, n), limit: 50 }]);
    const raw = Buffer.byteLength(req);
    const comp = deflateRawSync(Buffer.from(req)).length;
    console.log(
      `  authors=${String(n).padStart(4)}  raw=${String(raw).padStart(6)}B  ` +
        `deflate=${String(comp).padStart(6)}B  (${((comp / raw) * 100).toFixed(1)}%)`
    );
  }

  // --- 2. permessage-deflate がネゴシエートされるか ---
  console.log('\n== permessage-deflate のネゴシエーション ==');
  for (const url of RELAYS) {
    const ws = await connect(url, true);
    const ext = ws.extensions;
    console.log(`  ${url}: ${ext && Object.keys(ext).length ? JSON.stringify(ext) : '(無し)'}`);
    ws.close();
  }

  // --- 3. RTT ---
  console.log('\n== RTT (WebSocket ping/pong 中央値) ==');
  const rtts = {};
  for (const url of RELAYS) {
    rtts[url] = await rtt(url);
    console.log(`  ${url}: ${rtts[url]}ms`);
  }

  // --- 4. 1 イベントの平均サイズと、B が最初の表示可に至るまでの下り量 ---
  console.log('\n== イベントサイズと B の「最初の表示可までの下り量」 ==');
  const followSet = new Set(follows);
  for (const url of RELAYS) {
    const ws = await connect(url, false);
    // global を 500 件引き、フォロー先が最初に現れるまでに何バイト流れるかを数える
    const g = await collect(ws, 'g', { kinds: [1], limit: 500 });
    ws.close();

    const ws2 = await connect(url, false);
    const events = await new Promise((resolve) => {
      const acc = [];
      const on = (raw) => {
        const text = raw.toString();
        const m = JSON.parse(text);
        if (m[1] !== 'g2') return;
        if (m[0] === 'EVENT') acc.push({ ev: m[2], bytes: Buffer.byteLength(text) });
        else if (m[0] === 'EOSE') {
          ws2.off('message', on);
          resolve(acc);
        }
      };
      ws2.on('message', on);
      ws2.send(JSON.stringify(['REQ', 'g2', { kinds: [1], limit: 500 }]));
    });
    ws2.close();

    const avg = g.sizes.reduce((a, b) => a + b, 0) / (g.sizes.length || 1);
    let bytesToFirstUsable = 0;
    let idx = -1;
    for (let i = 0; i < events.length; i++) {
      bytesToFirstUsable += events[i].bytes;
      if (followSet.has(events[i].ev.pubkey)) {
        idx = i;
        break;
      }
    }
    const total = events.reduce((a, e) => a + e.bytes, 0);
    const usable = events.filter((e) => followSet.has(e.ev.pubkey)).length;
    console.log(
      `  ${url}: 平均 ${avg.toFixed(0)}B/件  500件で ${(total / 1024).toFixed(0)}KB  ` +
        `表示可 ${usable}件\n` +
        `    最初の表示可は ${idx + 1} 件目 → そこまでの下り ${(bytesToFirstUsable / 1024).toFixed(1)}KB`
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
