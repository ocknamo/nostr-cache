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

export interface RunningServer {
  /** Port the server is listening on. */
  port: number;
  /** The underlying child process. */
  process: ChildProcess;
  /** Stop the server (SIGINT, then SIGKILL fallback). Resolves with the exit code. */
  stop: () => Promise<number | null>;
}

/** Bind a throwaway server to `port` (0 = let the OS choose) and hand it back. */
function listenOnce(port: number): Promise<ReturnType<typeof createServer>> {
  return new Promise((resolveServer, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(port, () => {
      srv.removeAllListeners('error');
      resolveServer(srv);
    });
  });
}

function closeOnce(srv: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((done) => {
    srv.close(() => done());
  });
}

/**
 * Reserve a currently-free TCP port by briefly binding to port 0.
 *
 * The spawned server consumes *two* ports: `PORT` for the WebSocket relay and,
 * by default, `PORT + 1` for the health check endpoint. So the follow-on port is
 * probed too and a busy one sends us back for another draw — otherwise the
 * health endpoint silently fails to bind (the relay itself stays up, so the
 * failure would go unnoticed until something actually queried `/health`).
 */
export async function getFreePort(attempts = 20): Promise<number> {
  let lastError: unknown;

  for (let attempt = 0; attempt < attempts; attempt++) {
    const held: ReturnType<typeof createServer>[] = [];
    try {
      const first = await listenOnce(0);
      held.push(first);

      const address = first.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      if (!port) {
        throw new Error('Failed to acquire a free port');
      }

      // Health check endpoint defaults to PORT + 1; make sure it is free too.
      held.push(await listenOnce(port + 1));
      return port;
    } catch (error) {
      lastError = error;
    } finally {
      // Runs before the `return` above hands the number out, so the ports are
      // released by the time the caller uses them.
      await Promise.all(held.map(closeOnce));
    }
  }

  // The ES2020 target has no `cause` option on Error; fold the reason into the message.
  throw new Error(
    `Failed to acquire a free port pair after ${attempts} attempts` +
      ` (last error: ${lastError instanceof Error ? lastError.message : String(lastError)})`
  );
}

/** Poll until a WebSocket connection to the given port succeeds. */
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

/** Options for {@link startServer}. */
export interface StartServerOptions {
  /** Extra environment variables for the child process (e.g. NOSTR_DB_PATH). */
  env?: Record<string, string>;
}

/** Spawn the built relay server on a free port and wait until it accepts connections. */
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
