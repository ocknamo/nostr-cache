/**
 * Folds the embed bundle into the demo site's build output.
 *
 * GitHub Pages deploys a single directory, so `nostr-timeline.js` and the
 * iframe host page have to live alongside the SPA — that is also what makes the
 * published `<script src>` and `<iframe src>` URLs same-origin with the demo.
 */

import { access, cp } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const embedDist = resolve(packageDir, '../timeline-embed/dist');
const siteDist = resolve(packageDir, 'dist');

try {
  await access(embedDist);
} catch {
  console.error(
    `Embed bundle not found at ${embedDist}.\nBuild it first: npm run build:embed (from the repo root).`
  );
  process.exit(1);
}

await cp(embedDist, siteDist, { recursive: true });
console.log(`Copied embed bundle into ${siteDist}`);
