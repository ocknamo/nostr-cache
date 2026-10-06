import type { Filter } from '@nostr-cache/shared';
import { describe, expect, it } from 'vitest';
import { MAX_READ_RELAYS, RELAYS_PER_AUTHOR, planReads, readLookups } from './read-plan.js';
import type { RelayList } from './relay-list.js';

const pk = (n: number) => n.toString(16).padStart(64, '0');
const id = (n: number) => `e${n}`.padEnd(64, '0');
const DEFAULT = 'wss://default.example.com';

const writes = (...relays: string[]): RelayList => ({ read: [], write: relays });
const reads = (...relays: string[]): RelayList => ({ read: relays, write: [] });

function plan(
  filters: Filter[],
  lists: Array<[string, RelayList]>,
  { referenced = [] as Array<[string, string]>, unreachable = [] as string[] } = {}
) {
  return planReads(filters, {
    lists: new Map(lists),
    referencedAuthors: new Map(referenced),
    isDefault: (relay) => relay === DEFAULT,
    canReach: (relay) => !unreachable.includes(relay),
  });
}

describe('readLookups', () => {
  it('collects the people and events the routable filters point at', () => {
    expect(
      readLookups([
        { kinds: [1], authors: [pk(1), pk(2)] },
        { kinds: [1, 6, 7], '#p': [pk(3)] },
        { kinds: [7], '#e': [id(1)] },
        { kinds: [0], authors: [pk(4)] },
        { ids: [id(2)], authors: [pk(5)] },
      ])
    ).toEqual({ pubkeys: [pk(1), pk(2), pk(3)], eventIds: [id(1)] });
  });
});

describe('planReads', () => {
  it("splits an authors filter by each author's write relays, keeping the rest of the filter", () => {
    const parts = plan(
      [{ kinds: [1, 6], authors: [pk(1), pk(2)], limit: 50 }],
      [
        [pk(1), writes('wss://a')],
        [pk(2), writes('wss://b')],
      ]
    );

    expect(parts).toEqual([
      { relay: 'wss://a', filters: [{ kinds: [1, 6], authors: [pk(1)], limit: 50 }] },
      { relay: 'wss://b', filters: [{ kinds: [1, 6], authors: [pk(2)], limit: 50 }] },
    ]);
  });

  it('adds nothing for someone who also writes to a default upstream', () => {
    expect(plan([{ kinds: [1], authors: [pk(1)] }], [[pk(1), writes('wss://a', DEFAULT)]])).toEqual(
      []
    );
  });

  it('prefers relays that cover many authors, up to two per author', () => {
    const parts = plan(
      [{ kinds: [1], authors: [pk(1), pk(2), pk(3)] }],
      [
        [pk(1), writes('wss://shared', 'wss://x1', 'wss://y1')],
        [pk(2), writes('wss://shared', 'wss://x2')],
        [pk(3), writes('wss://shared', 'wss://other', 'wss://x3')],
      ]
    );

    expect(parts[0]).toEqual({
      relay: 'wss://shared',
      filters: [{ kinds: [1], authors: [pk(1), pk(2), pk(3)] }],
    });
    const perAuthor = new Map<string, number>();
    for (const part of parts) {
      for (const author of part.filters[0].authors ?? []) {
        perAuthor.set(author, (perAuthor.get(author) ?? 0) + 1);
      }
    }
    expect([...perAuthor.values()]).toEqual([
      RELAYS_PER_AUTHOR,
      RELAYS_PER_AUTHOR,
      RELAYS_PER_AUTHOR,
    ]);
  });

  it('caps the relays one REQ adds', () => {
    const lists: Array<[string, RelayList]> = Array.from({ length: 20 }, (_, i) => [
      pk(i + 1),
      writes(`wss://only${i}`),
    ]);

    const parts = plan([{ kinds: [1], authors: lists.map(([author]) => author) }], lists);

    expect(parts).toHaveLength(MAX_READ_RELAYS);
  });

  it('reaches everyone once before adding second relays when the cap bites', () => {
    // 2 本ずつ共有する 7 組（14 人）と、宛先が 1 本だけの 1 人
    const lists: Array<[string, RelayList]> = [];
    for (let group = 0; group < 7; group += 1) {
      for (const member of [0, 1]) {
        lists.push([pk(group * 2 + member + 1), writes(`wss://g${group}a`, `wss://g${group}b`)]);
      }
    }
    lists.push([pk(99), writes('wss://lonely')]);

    const parts = plan([{ kinds: [1], authors: lists.map(([author]) => author) }], lists);

    const reached = new Set(parts.flatMap((part) => part.filters[0].authors ?? []));
    expect(parts).toHaveLength(MAX_READ_RELAYS);
    expect(reached.size).toBe(lists.length);
  });

  it('skips relays that cannot be reached and people without a list', () => {
    const parts = plan(
      [{ kinds: [1], authors: [pk(1), pk(2)] }],
      [[pk(1), writes('wss://down', 'wss://up')]],
      { unreachable: ['wss://down'] }
    );

    expect(parts).toEqual([{ relay: 'wss://up', filters: [{ kinds: [1], authors: [pk(1)] }] }]);
  });

  it("reads mentions from the mentioned person's read relays", () => {
    expect(
      plan(
        [{ kinds: [1, 7], '#p': [pk(1)] }],
        [[pk(1), { read: ['wss://inbox'], write: ['wss://out'] }]]
      )
    ).toEqual([{ relay: 'wss://inbox', filters: [{ kinds: [1, 7], '#p': [pk(1)] }] }]);
  });

  it("reads replies and reactions from the referenced author's read relays", () => {
    expect(
      plan([{ kinds: [1, 7], '#e': [id(1), id(2)] }], [[pk(1), reads('wss://inbox')]], {
        referenced: [[id(1), pk(1)]],
      })
    ).toEqual([{ relay: 'wss://inbox', filters: [{ kinds: [1, 7], '#e': [id(1)] }] }]);
  });

  it("reads quotes and replies of an addressable event from its author's read relays", () => {
    const address = `30023:${pk(1)}:my-article`;

    expect(readLookups([{ kinds: [1], '#q': [address] }]).pubkeys).toEqual([pk(1)]);
    expect(plan([{ kinds: [1, 7], '#a': [address] }], [[pk(1), reads('wss://inbox')]])).toEqual([
      { relay: 'wss://inbox', filters: [{ kinds: [1, 7], '#a': [address] }] },
    ]);
  });

  it.each<[string, Filter]>([
    ['replaceable kinds only', { kinds: [0, 3, 10002], authors: [pk(1)] }],
    ['ids', { ids: [id(1)], authors: [pk(1)] }],
    ['no routable field', { kinds: [1], '#t': ['nostr'] }],
  ])('leaves %s to the default upstreams', (_, filter) => {
    expect(plan([filter], [[pk(1), writes('wss://a')]])).toEqual([]);
  });

  it('keeps each filter separate on a shared relay', () => {
    const parts = plan(
      [
        { kinds: [1], authors: [pk(1)] },
        { kinds: [7], '#p': [pk(1)] },
      ],
      [[pk(1), { read: ['wss://same'], write: ['wss://same'] }]]
    );

    expect(parts).toEqual([
      {
        relay: 'wss://same',
        filters: [
          { kinds: [1], authors: [pk(1)] },
          { kinds: [7], '#p': [pk(1)] },
        ],
      },
    ]);
  });
});
