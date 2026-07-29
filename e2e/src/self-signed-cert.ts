/**
 * Generates a throwaway self-signed certificate for the https E2E server.
 *
 * Generated at run time rather than checked in: a committed private key trips
 * secret scanners and would eventually expire. The key never leaves the
 * machine's temp directory and is only ever presented to a browser launched
 * with `ignoreHTTPSErrors`.
 */

import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

export interface SelfSignedCert {
  key: Buffer;
  cert: Buffer;
  /** Remove the generated files. */
  cleanup: () => Promise<void>;
}

/**
 * Create a self-signed certificate for `localhost` / `127.0.0.1`.
 *
 * @throws If `openssl` is unavailable
 */
export async function createSelfSignedCert(): Promise<SelfSignedCert> {
  const dir = await mkdtemp(join(tmpdir(), 'nostr-cache-e2e-tls-'));
  const keyPath = join(dir, 'key.pem');
  const certPath = join(dir, 'cert.pem');

  await run('openssl', [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-keyout',
    keyPath,
    '-out',
    certPath,
    '-days',
    '1',
    '-nodes',
    '-subj',
    '/CN=localhost',
    '-addext',
    'subjectAltName=DNS:localhost,IP:127.0.0.1',
  ]);

  return {
    key: await readFile(keyPath),
    cert: await readFile(certPath),
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

/**
 * Whether `openssl` is available, so a suite can skip rather than fail on a
 * machine without it.
 */
export async function hasOpenssl(): Promise<boolean> {
  try {
    await run('openssl', ['version']);
    return true;
  } catch {
    return false;
  }
}
