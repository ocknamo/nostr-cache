/**
 * Tests for relay option defaulting.
 */

import { DEFAULT_MAX_EVENTS, resolveRelayOptions } from './relay-options.js';

describe('resolveRelayOptions', () => {
  it('applies defaults when nothing is provided', () => {
    const resolved = resolveRelayOptions({});
    expect(resolved.validateEventsType).toBe('IMMEDIATELY');
    expect(resolved.maxSubscriptions).toBe(20);
    expect(resolved.maxEventsPerRequest).toBe(DEFAULT_MAX_EVENTS);
  });

  it('lets caller options override the defaults', () => {
    const resolved = resolveRelayOptions({
      validateEventsType: 'LAZY',
      maxSubscriptions: 5,
      maxEventsPerRequest: 10,
    });
    expect(resolved.validateEventsType).toBe('LAZY');
    expect(resolved.maxSubscriptions).toBe(5);
    expect(resolved.maxEventsPerRequest).toBe(10);
  });

  it('does not let an explicit undefined maxEventsPerRequest clobber the default', () => {
    const resolved = resolveRelayOptions({ maxEventsPerRequest: undefined });
    expect(resolved.maxEventsPerRequest).toBe(DEFAULT_MAX_EVENTS);
  });

  it('passes through unrelated options untouched', () => {
    const resolved = resolveRelayOptions({ ttl: 120, upstreamRelays: ['wss://x'] });
    expect(resolved.ttl).toBe(120);
    expect(resolved.upstreamRelays).toEqual(['wss://x']);
  });

  it('returns a new object without mutating the input', () => {
    const input = { maxSubscriptions: 3 };
    const resolved = resolveRelayOptions(input);
    expect(resolved).not.toBe(input);
    expect(input).toEqual({ maxSubscriptions: 3 });
  });
});
