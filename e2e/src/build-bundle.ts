/**
 * Bundles the browser entry point into a single IIFE for injection into the
 * test page. Uses deep source imports and an alias for the shared package so
 * no prior workspace build is required.
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const currentDir = dirname(fileURLToPath(import.meta.url));

/**
 * Build the browser bundle and return the output file path.
 */
export async function buildBrowserBundle(): Promise<string> {
  const outfile = resolve(currentDir, '../dist/browser-bundle.js');

  await build({
    entryPoints: [resolve(currentDir, 'browser-entry.ts')],
    bundle: true,
    format: 'iife',
    globalName: 'NostrE2E',
    platform: 'browser',
    target: 'es2020',
    outfile,
    logLevel: 'silent',
    alias: {
      '@nostr-cache/shared': resolve(currentDir, '../../packages/shared/src/index.ts'),
    },
  });

  return outfile;
}
