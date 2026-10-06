import type { NostrEvent } from '@nostr-cache/shared';
import { describe, expect, it } from 'vitest';
import { MAX_LIST_RELAYS, normalizeRelayUrl, parseRelayList } from './relay-list.js';

function relayList(tags: string[][], kind = 10002): NostrEvent {
  return { id: 'id', pubkey: 'pk', created_at: 0, kind, tags, content: '', sig: '' };
}

describe('normalizeRelayUrl', () => {
  it.each([
    ['wss://relay.example.com', 'wss://relay.example.com'],
    ['wss://Relay.Example.com/', 'wss://relay.example.com'],
    ['  wss://relay.example.com//  ', 'wss://relay.example.com'],
    ['wss://relay.example.com:443', 'wss://relay.example.com'],
    ['wss://relay.example.com:4848/nostr/', 'wss://relay.example.com:4848/nostr'],
    ['wss://relay.example.com/?a=1#frag', 'wss://relay.example.com?a=1'],
    ['wss://8.8.8.8', 'wss://8.8.8.8'],
  ])('%s → %s', (raw, expected) => {
    expect(normalizeRelayUrl(raw)).toBe(expected);
  });

  it.each([
    'ws://relay.example.com',
    'https://relay.example.com',
    'not a url',
    'wss://user:pass@relay.example.com',
    'wss://localhost',
    'wss://relay',
    'wss://abc.onion',
    'wss://nostr-cache.invalid',
    'wss://printer.local',
    'wss://127.0.0.1',
    'wss://10.0.0.5',
    'wss://172.20.1.1',
    'wss://192.168.1.10',
    'wss://169.254.0.1',
    'wss://100.64.0.1',
    'wss://0x7f000001',
    'wss://[::1]',
    'wss://localhost./',
    'wss://foo.local.',
    'wss://relay.example.com.',
    'wss://localhost.localdomain',
    'wss://198.18.0.1',
    'wss://192.0.0.8',
    'wss://[2001:db8::1]',
  ])('rejects %s', (raw) => {
    expect(normalizeRelayUrl(raw)).toBeUndefined();
  });
});

describe('parseRelayList', () => {
  it('splits r tags by marker, an unmarked or empty marker counting as both', () => {
    const list = parseRelayList(
      relayList([
        ['r', 'wss://both.example.com'],
        ['r', 'wss://read.example.com', 'read'],
        ['r', 'wss://write.example.com', 'write'],
        ['r', 'wss://empty.example.com', ''],
      ])
    );

    expect(list.read).toEqual([
      'wss://both.example.com',
      'wss://read.example.com',
      'wss://empty.example.com',
    ]);
    expect(list.write).toEqual([
      'wss://both.example.com',
      'wss://write.example.com',
      'wss://empty.example.com',
    ]);
  });

  it('drops unknown markers, other tags, unusable urls and duplicates', () => {
    const list = parseRelayList(
      relayList([
        ['r', 'wss://odd.example.com', 'inbox'],
        ['p', 'wss://not-r.example.com'],
        ['r', 'ws://plain.example.com'],
        ['r'],
        ['r', 'wss://dup.example.com/'],
        ['r', 'wss://DUP.example.com'],
      ])
    );

    expect(list).toEqual({ read: ['wss://dup.example.com'], write: ['wss://dup.example.com'] });
  });

  it('caps each side', () => {
    const tags = Array.from({ length: MAX_LIST_RELAYS + 5 }, (_, i) => [
      'r',
      `wss://r${i}.example.com`,
    ]);

    const list = parseRelayList(relayList(tags));

    expect(list.read).toHaveLength(MAX_LIST_RELAYS);
    expect(list.write).toHaveLength(MAX_LIST_RELAYS);
  });

  it('reads nothing from another kind', () => {
    expect(parseRelayList(relayList([['r', 'wss://a.example.com']], 3))).toEqual({
      read: [],
      write: [],
    });
  });
});
