import { describe, expect, it } from 'vitest';
import { makeEvent } from '../test-fixtures.ts';
import { parseRefs, replyParentAddress, replyParentId } from './event-refs.ts';

const ROOT = 'a'.repeat(64);
const PARENT = 'b'.repeat(64);
const QUOTED = 'c'.repeat(64);
const MENTIONED = 'd'.repeat(64);
const ADDRESS = `30023:${'e'.repeat(64)}:my-article`;

describe('parseRefs', () => {
  it('finds nothing on a standalone note', () => {
    expect(parseRefs(makeEvent())).toEqual([]);
  });

  it('prefers the "reply" marker over "root"', () => {
    const event = makeEvent({
      tags: [
        ['e', ROOT, '', 'root'],
        ['e', PARENT, '', 'reply'],
      ],
    });

    expect(parseRefs(event)).toEqual([{ kind: 'reply', id: PARENT }]);
  });

  it('treats a lone "root" marker as the reply target', () => {
    const event = makeEvent({ tags: [['e', ROOT, '', 'root']] });

    expect(parseRefs(event)).toEqual([{ kind: 'reply', id: ROOT }]);
  });

  it('uses the last e tag in the deprecated positional form', () => {
    const event = makeEvent({
      tags: [
        ['e', ROOT],
        ['e', PARENT],
      ],
    });

    expect(parseRefs(event)).toEqual([{ kind: 'reply', id: PARENT }]);
  });

  it('never treats a mention as a reply target', () => {
    const event = makeEvent({ tags: [['e', MENTIONED, '', 'mention']] });

    expect(parseRefs(event)).toEqual([]);
  });

  it('reports q tags as quotes', () => {
    const event = makeEvent({ tags: [['q', QUOTED, 'wss://relay.example']] });

    expect(parseRefs(event)).toEqual([{ kind: 'quote', id: QUOTED }]);
  });

  it('reports the reply before the quotes', () => {
    const event = makeEvent({
      tags: [
        ['q', QUOTED],
        ['e', PARENT, '', 'reply'],
      ],
    });

    expect(parseRefs(event)).toEqual([
      { kind: 'reply', id: PARENT },
      { kind: 'quote', id: QUOTED },
    ]);
  });

  it('does not report the same id twice', () => {
    const event = makeEvent({
      tags: [
        ['e', PARENT, '', 'reply'],
        ['q', PARENT],
        ['q', QUOTED],
        ['q', QUOTED],
      ],
    });

    expect(parseRefs(event)).toEqual([
      { kind: 'reply', id: PARENT },
      { kind: 'quote', id: QUOTED },
    ]);
  });

  it('ignores a self-reference', () => {
    const event = makeEvent({ id: ROOT, tags: [['e', ROOT, '', 'reply']] });

    expect(parseRefs(event)).toEqual([]);
  });

  it('drops ids that are not 64-char lowercase hex', () => {
    const event = makeEvent({
      tags: [
        ['e', 'too-short'],
        ['e', ROOT.toUpperCase()],
        ['q', ''],
        ['q', QUOTED],
      ],
    });

    expect(parseRefs(event)).toEqual([{ kind: 'quote', id: QUOTED }]);
  });

  it('ignores tags of other kinds', () => {
    const event = makeEvent({
      tags: [
        ['p', ROOT],
        ['t', 'nostr'],
      ],
    });

    expect(parseRefs(event)).toEqual([]);
  });
});

describe('replyParentId', () => {
  it('prefers the "reply" marker over "root"', () => {
    const event = makeEvent({
      tags: [
        ['e', ROOT, '', 'root'],
        ['e', PARENT, '', 'reply'],
      ],
    });

    expect(replyParentId(event)).toBe(PARENT);
  });

  it('falls back to the last unmarked e tag', () => {
    const event = makeEvent({
      tags: [
        ['e', ROOT],
        ['e', PARENT],
      ],
    });

    expect(replyParentId(event)).toBe(PARENT);
  });

  it('ignores a marker it does not understand, rather than guessing', () => {
    const event = makeEvent({ tags: [['e', PARENT, '', 'quote']] });

    expect(replyParentId(event)).toBeUndefined();
  });

  it('has no parent for a mention or a standalone note', () => {
    expect(replyParentId(makeEvent({ tags: [['e', MENTIONED, '', 'mention']] }))).toBeUndefined();
    expect(replyParentId(makeEvent())).toBeUndefined();
  });
});

describe('replyParentAddress', () => {
  it('reads the coordinate a reply to an addressable event names', () => {
    const event = makeEvent({ tags: [['a', ADDRESS, '', 'root']] });

    expect(replyParentAddress(event)).toBe(ADDRESS);
  });

  it('rejects an a tag that is not a kind:pubkey:d coordinate', () => {
    const event = makeEvent({ tags: [['a', 'not-a-coordinate']] });

    expect(replyParentAddress(event)).toBeUndefined();
  });
});
