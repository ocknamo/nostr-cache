import { describe, expect, it } from 'vitest';
import { makeEvent } from '../test-fixtures.ts';
import { isRepost, repostTargetId } from './reposts.ts';

const REPOSTED = 'a'.repeat(64);
const OTHER = 'b'.repeat(64);

describe('isRepost', () => {
  it('holds for kind 6 and kind 16', () => {
    expect(isRepost(makeEvent({ kind: 6 }))).toBe(true);
    expect(isRepost(makeEvent({ kind: 16 }))).toBe(true);
  });

  it('does not hold for a note or a reaction', () => {
    expect(isRepost(makeEvent({ kind: 1 }))).toBe(false);
    expect(isRepost(makeEvent({ kind: 7 }))).toBe(false);
  });
});

describe('repostTargetId', () => {
  it('reads the e tag, relay hint and all', () => {
    const event = makeEvent({ kind: 6, tags: [['e', REPOSTED, 'wss://relay.example']] });

    expect(repostTargetId(event)).toBe(REPOSTED);
  });

  it('takes the last e tag when a client wrote several', () => {
    const event = makeEvent({
      kind: 6,
      tags: [
        ['e', OTHER],
        ['e', REPOSTED],
        ['p', OTHER],
      ],
    });

    expect(repostTargetId(event)).toBe(REPOSTED);
  });

  it('ignores anything that is not an event id', () => {
    const event = makeEvent({
      kind: 6,
      tags: [
        ['e', REPOSTED],
        ['e', 'not-an-id'],
      ],
    });

    expect(repostTargetId(event)).toBe(REPOSTED);
  });

  it('is undefined when nothing addressable was named', () => {
    expect(repostTargetId(makeEvent({ kind: 6, tags: [['p', OTHER]] }))).toBeUndefined();
    expect(
      repostTargetId(makeEvent({ kind: 16, tags: [['a', `30023:${OTHER}:slug`]] }))
    ).toBeUndefined();
  });
});
