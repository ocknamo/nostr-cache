import { describe, expect, it } from 'vitest';
import type { NostrMessageUnion, NostrResponseUnion } from './message.js';
import {
  NostrMessageType,
  isCloseMessage,
  isClosedResponse,
  isEoseResponse,
  isEventMessage,
  isNoticeResponse,
  isOkResponse,
  isReqMessage,
} from './message.js';
import type { NostrEvent } from './nostr.js';

const sampleEvent: NostrEvent = {
  id: 'id1',
  pubkey: 'pubkey1',
  created_at: 1700000000,
  kind: 1,
  tags: [],
  content: 'hello',
  sig: 'sig1',
};

const messages: Record<string, NostrMessageUnion | NostrResponseUnion> = {
  event: { type: NostrMessageType.EVENT, event: sampleEvent },
  req: { type: NostrMessageType.REQ, subscriptionId: 'sub1', filters: [] },
  close: { type: NostrMessageType.CLOSE, subscriptionId: 'sub1' },
  ok: { type: NostrMessageType.OK, eventId: 'id1', success: true },
  eose: { type: NostrMessageType.EOSE, subscriptionId: 'sub1' },
  closed: { type: NostrMessageType.CLOSED, subscriptionId: 'sub1' },
  notice: { type: NostrMessageType.NOTICE, message: 'hi' },
};

describe('message type guards', () => {
  const guards = [
    { name: 'isEventMessage', guard: isEventMessage, match: 'event' },
    { name: 'isReqMessage', guard: isReqMessage, match: 'req' },
    { name: 'isCloseMessage', guard: isCloseMessage, match: 'close' },
    { name: 'isOkResponse', guard: isOkResponse, match: 'ok' },
    { name: 'isEoseResponse', guard: isEoseResponse, match: 'eose' },
    { name: 'isClosedResponse', guard: isClosedResponse, match: 'closed' },
    { name: 'isNoticeResponse', guard: isNoticeResponse, match: 'notice' },
  ] as const;

  for (const { name, guard, match } of guards) {
    it(`${name} only returns true for its own message type`, () => {
      for (const [key, message] of Object.entries(messages)) {
        expect(guard(message)).toBe(key === match);
      }
    });
  }
});
