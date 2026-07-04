/**
 * Minimal NIP-01 WebSocket client for Node E2E tests.
 *
 * Wraps the `ws` library with promise-based helpers for opening a
 * connection, sending wire messages, and waiting for a matching response.
 */

import WebSocket from 'ws';

type WireMessage = unknown[];

/**
 * A test client connected to a relay over a real WebSocket.
 */
export class WsClient {
  private socket: WebSocket;
  private messages: WireMessage[] = [];
  private waiters: Array<{
    predicate: (m: WireMessage) => boolean;
    resolve: (m: WireMessage) => void;
  }> = [];

  private constructor(socket: WebSocket) {
    this.socket = socket;
    this.socket.on('message', (data) => {
      const message = JSON.parse(data.toString()) as WireMessage;
      this.messages.push(message);
      for (let i = this.waiters.length - 1; i >= 0; i--) {
        if (this.waiters[i].predicate(message)) {
          this.waiters[i].resolve(message);
          this.waiters.splice(i, 1);
        }
      }
    });
  }

  /**
   * Open a connection and resolve once it is established.
   */
  static connect(port: number): Promise<WsClient> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(`ws://127.0.0.1:${port}`);
      socket.once('open', () => resolve(new WsClient(socket)));
      socket.once('error', reject);
    });
  }

  /**
   * Send a wire message (a JSON array such as ['EVENT', event]).
   */
  send(message: WireMessage): void {
    this.socket.send(JSON.stringify(message));
  }

  /**
   * Wait for the first (already-received or future) message matching the predicate.
   */
  waitFor(predicate: (m: WireMessage) => boolean, timeoutMs = 5000): Promise<WireMessage> {
    const existing = this.messages.find(predicate);
    if (existing) return Promise.resolve(existing);

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Timed out waiting for message after ${timeoutMs}ms`));
      }, timeoutMs);

      this.waiters.push({
        predicate,
        resolve: (message) => {
          clearTimeout(timer);
          resolve(message);
        },
      });
    });
  }

  /**
   * Assert that no message matching the predicate arrives within the window.
   */
  async expectNone(predicate: (m: WireMessage) => boolean, windowMs = 300): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, windowMs));
    if (this.messages.some(predicate)) {
      throw new Error('Received a message that was expected not to arrive');
    }
  }

  close(): void {
    this.socket.close();
  }
}
