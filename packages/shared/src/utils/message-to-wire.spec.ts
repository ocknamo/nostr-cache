import { describe, expect, it } from 'vitest';
import type {
  CloseMessage,
  ClosedResponse,
  EoseResponse,
  EventMessage,
  NoticeResponse,
  OkResponse,
  ReqMessage,
} from '../types/message.js';
import { NostrMessageType } from '../types/message.js';
import type { NostrEvent } from '../types/nostr.js';
import { messageToWire } from './message-to-wire.js';

const sampleEvent: NostrEvent = {
  id: 'id1',
  pubkey: 'pubkey1',
  created_at: 1700000000,
  kind: 1,
  tags: [['e', 'event-ref']],
  content: 'hello',
  sig: 'sig1',
};

describe('messageToWire', () => {
  it('converts an EVENT message without subscriptionId', () => {
    const message: EventMessage = { type: NostrMessageType.EVENT, event: sampleEvent };

    expect(messageToWire(message)).toEqual(['EVENT', sampleEvent]);
  });

  it('converts an EVENT message with subscriptionId', () => {
    const message: EventMessage = {
      type: NostrMessageType.EVENT,
      event: sampleEvent,
      subscriptionId: 'sub1',
    };

    expect(messageToWire(message)).toEqual(['EVENT', 'sub1', sampleEvent]);
  });

  it('converts a REQ message spreading filters', () => {
    const message: ReqMessage = {
      type: NostrMessageType.REQ,
      subscriptionId: 'sub1',
      filters: [{ kinds: [1] }, { authors: ['a'] }],
    };

    expect(messageToWire(message)).toEqual(['REQ', 'sub1', { kinds: [1] }, { authors: ['a'] }]);
  });

  it('converts a CLOSE message', () => {
    const message: CloseMessage = { type: NostrMessageType.CLOSE, subscriptionId: 'sub1' };

    expect(messageToWire(message)).toEqual(['CLOSE', 'sub1']);
  });

  it('converts an OK response, defaulting message to empty string', () => {
    const message: OkResponse = { type: NostrMessageType.OK, eventId: 'id1', success: true };

    expect(messageToWire(message)).toEqual(['OK', 'id1', true, '']);
  });

  it('converts an OK response preserving its message', () => {
    const message: OkResponse = {
      type: NostrMessageType.OK,
      eventId: 'id1',
      success: false,
      message: 'invalid: bad sig',
    };

    expect(messageToWire(message)).toEqual(['OK', 'id1', false, 'invalid: bad sig']);
  });

  it('converts an EOSE response', () => {
    const message: EoseResponse = { type: NostrMessageType.EOSE, subscriptionId: 'sub1' };

    expect(messageToWire(message)).toEqual(['EOSE', 'sub1']);
  });

  it('converts a CLOSED response without a message', () => {
    const message: ClosedResponse = { type: NostrMessageType.CLOSED, subscriptionId: 'sub1' };

    expect(messageToWire(message)).toEqual(['CLOSED', 'sub1']);
  });

  it('converts a CLOSED response with a message', () => {
    const message: ClosedResponse = {
      type: NostrMessageType.CLOSED,
      subscriptionId: 'sub1',
      message: 'rate-limited',
    };

    expect(messageToWire(message)).toEqual(['CLOSED', 'sub1', 'rate-limited']);
  });

  it('converts a NOTICE response', () => {
    const message: NoticeResponse = { type: NostrMessageType.NOTICE, message: 'hello world' };

    expect(messageToWire(message)).toEqual(['NOTICE', 'hello world']);
  });

  it('throws for an unknown message type', () => {
    const message = { type: 'UNKNOWN' } as unknown as OkResponse;

    expect(() => messageToWire(message)).toThrow('Unknown message type');
  });
});
