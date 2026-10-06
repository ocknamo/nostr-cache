import type { NostrEvent } from '@nostr-cache/shared';
import { describe, expect, it } from 'vitest';
import type { RelayList } from './relay-list.js';
import {
  MAX_INBOX_RECIPIENTS,
  MAX_WRITE_TARGETS,
  RELAYS_PER_INBOX,
  inboxRecipients,
  writeTargets,
} from './write-targets.js';

const pk = (n: number) => n.toString(16).padStart(64, '0');
const AUTHOR = pk(1);

function event(kind: number, tags: string[][] = []): NostrEvent {
  return { id: 'id', pubkey: AUTHOR, created_at: 0, kind, tags, content: '', sig: '' };
}

const list = (read: string[], write: string[]): RelayList => ({ read, write });

describe('inboxRecipients', () => {
  it('collects the people a note notifies, without the author or duplicates', () => {
    const note = event(1, [
      ['p', pk(2)],
      ['p', pk(2).toUpperCase()],
      ['p', AUTHOR],
      ['p', 'not-hex'],
      ['e', pk(3)],
      ['p', pk(4)],
    ]);

    expect(inboxRecipients(note)).toEqual([pk(2), pk(4)]);
  });

  it.each([3, 10000, 10002, 30000, 0])('expands nobody for kind %i', (kind) => {
    expect(inboxRecipients(event(kind, [['p', pk(2)]]))).toEqual([]);
  });

  it('caps the recipients of a long thread', () => {
    const tags = Array.from({ length: MAX_INBOX_RECIPIENTS + 5 }, (_, i) => ['p', pk(i + 10)]);

    expect(inboxRecipients(event(1, tags))).toHaveLength(MAX_INBOX_RECIPIENTS);
  });
});

describe('writeTargets', () => {
  it("sends to the author's write relays and the recipients' read relays", () => {
    const lists = new Map([
      [AUTHOR, list(['wss://author-read'], ['wss://author-write'])],
      [pk(2), list(['wss://r2a', 'wss://r2b'], ['wss://w2'])],
    ]);

    expect(writeTargets(event(7, [['p', pk(2)]]), lists)).toEqual([
      'wss://author-write',
      'wss://r2a',
      'wss://r2b',
    ]);
  });

  it('uses only the first few read relays of each recipient', () => {
    const reads = Array.from({ length: RELAYS_PER_INBOX + 2 }, (_, i) => `wss://r${i}`);
    const lists = new Map([[pk(2), list(reads, [])]]);

    expect(writeTargets(event(1, [['p', pk(2)]]), lists)).toEqual(reads.slice(0, RELAYS_PER_INBOX));
  });

  it('skips excluded relays and people without a list', () => {
    const lists = new Map([[AUTHOR, list([], ['wss://default', 'wss://mine'])]]);

    expect(writeTargets(event(1, [['p', pk(2)]]), lists, new Set(['wss://default']))).toEqual([
      'wss://mine',
    ]);
  });

  it("caps the total, keeping the author's own relays first", () => {
    const writes = Array.from({ length: 20 }, (_, i) => `wss://w${i}`);
    const lists = new Map<string, RelayList>([[AUTHOR, list([], writes)]]);
    const tags: string[][] = [];
    for (let i = 0; i < 10; i += 1) {
      const recipient = pk(i + 100);
      tags.push(['p', recipient]);
      lists.set(recipient, list([`wss://in${i}a`, `wss://in${i}b`], []));
    }

    const targets = writeTargets(event(1, tags), lists);

    expect(targets).toHaveLength(MAX_WRITE_TARGETS);
    expect(targets.slice(0, 20)).toEqual(writes);
  });
});
