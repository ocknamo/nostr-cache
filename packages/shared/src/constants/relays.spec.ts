import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CONNECTION_TIMEOUT,
  DEFAULT_MAX_CONCURRENT_RELAYS,
  DEFAULT_RELAY_URLS,
  DEFAULT_REQUEST_TIMEOUT,
  DEFAULT_SUBSCRIPTION_TIMEOUT,
} from './relays.js';

describe('relay constants', () => {
  it('exposes a non-empty list of secure relay URLs', () => {
    expect(DEFAULT_RELAY_URLS.length).toBeGreaterThan(0);
    for (const url of DEFAULT_RELAY_URLS) {
      expect(url).toMatch(/^wss:\/\//);
    }
  });

  it('uses positive timeout and concurrency defaults', () => {
    expect(DEFAULT_CONNECTION_TIMEOUT).toBeGreaterThan(0);
    expect(DEFAULT_SUBSCRIPTION_TIMEOUT).toBeGreaterThan(0);
    expect(DEFAULT_REQUEST_TIMEOUT).toBeGreaterThan(0);
    expect(DEFAULT_MAX_CONCURRENT_RELAYS).toBeGreaterThan(0);
  });
});
