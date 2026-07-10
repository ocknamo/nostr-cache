/**
 * Helpers for running the built Nostr relay server as a real child process.
 *
 * Unlike the in-process integration test, the E2E suite spawns
 * `node packages/server/dist/index.js` so the whole server entry point
 * (including PORT handling and signal shutdown) is exercised end to end.
 */

import { type ChildProcess, spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const currentDir = dirname(fileURLToPath(import.meta.url));

/** Path to the built server entry point. Requires `npm run build` first. */
export const SERVER_ENTRY = resolve(currentDir, '../../packages/server/dist/index.js');

/**
 * Handle for a running server child process.
 */
export interface RunningServer {
  /** Port the server is listening on. */
  port: number;
  /** The underlying child process. */
  process: ChildProcess;
  /** Stop the server (SIGINT, then SIGKILL fallback). Resolves with the exit code. */
  stop: () => Promise<number | null>;
}

/**
 * Reserve a currently-free TCP port by briefly binding to port 0.
 */
export function getFreePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const srv = createServer();
    srv.on('error', reject);
    srv.listen(0, () => {
      const address = srv.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      srv.close(() => {
        if (port) {
          resolvePort(port);
        } else {
          reject(new Error('Failed to acquire a free port'));
        }
      });
    });
  });
}

/**
 * Poll until a WebSocket connection to the given port succeeds.
 */
function waitForRelay(port: number, timeoutMs = 10000): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  return new Promise((resolveReady, reject) => {
    const attempt = () => {
      const socket = new WebSocket(`ws://127.0.0.1:${port}`);
      let settled = false;

      socket.on('open', () => {
        settled = true;
        socket.close();
        resolveReady();
      });

      socket.on('error', () => {
        if (settled) return;
        socket.terminate();
        if (Date.now() > deadline) {
          reject(new Error(`Relay did not become ready on port ${port} within ${timeoutMs}ms`));
          return;
        }
        setTimeout(attempt, 100);
      });
    };

    attempt();
  });
}

/**
 * Options for {@link startServer}.
 */
export interface StartServerOptions {
  /** Extra environment variables for the child process (e.g. NOSTR_DB_PATH). */
  env?: Record<string, string>;
}

/**
 * Spawn the built relay server on a free port and wait until it accepts connections.
 */
export async function startServer(options: StartServerOptions = {}): Promise<RunningServer> {
  const port = await getFreePort();
  const child = spawn(process.execPath, [SERVER_ENTRY], {
    env: { ...process.env, PORT: String(port), ...options.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  // If the process dies before it is ready, surface that instead of hanging.
  const earlyExit = new Promise<never>((_, reject) => {
    child.once('exit', (code) => {
      reject(new Error(`Server process exited early with code ${code}`));
    });
  });

  await Promise.race([waitForRelay(port), earlyExit]);

  const stop = () =>
    new Promise<number | null>((resolveStop) => {
      if (child.exitCode !== null || child.signalCode !== null) {
        resolveStop(child.exitCode);
        return;
      }

      const killTimer = setTimeout(() => {
        child.kill('SIGKILL');
      }, 5000);

      child.once('exit', (code) => {
        clearTimeout(killTimer);
        resolveStop(code);
      });

      child.kill('SIGINT');
    });

  return { port, process: child, stop };
}
