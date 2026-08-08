/**
 * WebSocket Integration Tests
 *
 * Tests the interaction between WebSocketServer and MessageHandler
 */

import { type NostrEvent, NostrMessageType, type NostrWireMessage } from '@nostr-cache/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { IntegrationTestBase, createTestEvent } from './utils/base.integration.js';

describe('WebSocket Integration', () => {
  let testBase: IntegrationTestBase;
  let events: { [key: string]: NostrEvent } = {};
  let relayUrl: string;
  const port = 3000;

  // メッセージ応答を待つヘルパー関数
  const waitForMessage = (
    ws: WebSocket,
    messageType: NostrMessageType
  ): Promise<NostrWireMessage> => {
    return new Promise((resolve) => {
      const messageHandler = (event: MessageEvent) => {
        const message = JSON.parse(event.data) as NostrWireMessage;
        if (message[0] === messageType) {
          ws.removeEventListener('message', messageHandler);
          resolve(message);
        }
      };
      ws.addEventListener('message', messageHandler);
    });
  };

  beforeEach(async () => {
    testBase = new IntegrationTestBase(port);
    await testBase.setup();
    relayUrl = testBase.getServerUrl();

    events = {
      basic: await createTestEvent(),
      replaceable: await createTestEvent(undefined, {
        kind: 0, // Replaceable event
      }),
      ephemeral: await createTestEvent(undefined, {
        kind: 20000, // Ephemeral event
      }),
    };
  });

  afterEach(async () => {
    await testBase.teardown();
  });

  describe('WebSocketServer and MessageHandler', () => {
    it('should handle client connection', async () => {
      const connectPromise = new Promise<void>((resolve) => {
        testBase.server.onConnect((clientId) => {
          expect(clientId).toBeTruthy();
          resolve();
        });
      });

      // Create client and test onopen event is fired
      const ws = new WebSocket(relayUrl);
      const openPromise = new Promise<void>((resolve) => {
        ws.onopen = () => {
          // Connection established from client side
          resolve();
        };
      });

      // Wait for both client and server to acknowledge connection
      await Promise.all([connectPromise, openPromise]);

      ws.close();
    });

    it('should process EVENT message and save to storage', async () => {
      let clientId: string | null = null;

      testBase.server.onConnect((id) => {
        clientId = id;
      });

      const ws = new WebSocket(relayUrl);

      await new Promise<void>((resolve) => {
        ws.onopen = () => resolve();
      });

      expect(clientId).toBeTruthy();

      const responsePromise = waitForMessage(ws, NostrMessageType.OK);

      const eventMessage: NostrWireMessage = ['EVENT', events.basic];
      ws.send(JSON.stringify(eventMessage));

      // Wait for OK response
      const response = await responsePromise;
      expect(response[0]).toBe(NostrMessageType.OK);
      expect(response[1]).toBe(events.basic.id);
      expect(response[2]).toBeTruthy(); // success = true

      // Verify event was saved to storage
      const savedEvents = await testBase.storage.getEvents([{ ids: [events.basic.id] }]);
      expect(savedEvents).toHaveLength(1);
      expect(savedEvents[0].id).toBe(events.basic.id);

      ws.close();
    });

    it('should handle REQ message and return matching events', async () => {
      await testBase.storage.saveEvent(events.basic);

      const ws = new WebSocket(relayUrl);

      await new Promise<void>((resolve) => {
        ws.onopen = () => resolve();
      });

      const eventPromise = new Promise<NostrEvent>((resolve) => {
        const messageHandler = (event: MessageEvent) => {
          const message = JSON.parse(event.data) as NostrWireMessage;
          if (message[0] === NostrMessageType.EVENT) {
            ws.removeEventListener('message', messageHandler);
            resolve(message[2] as NostrEvent);
          }
        };
        ws.addEventListener('message', messageHandler);
      });

      const eosePromise = new Promise<boolean>((resolve) => {
        const messageHandler = (event: MessageEvent) => {
          const message = JSON.parse(event.data) as NostrWireMessage;
          if (message[0] === NostrMessageType.EOSE) {
            ws.removeEventListener('message', messageHandler);
            resolve(true);
          }
        };
        ws.addEventListener('message', messageHandler);
      });

      // Send REQ message with filter matching the saved event
      const reqMessage: NostrWireMessage = [
        'REQ',
        'sub1',
        { kinds: [1], authors: [events.basic.pubkey] },
      ];
      ws.send(JSON.stringify(reqMessage));

      const receivedEvent = await eventPromise;
      expect(receivedEvent.id).toBe(events.basic.id);

      const eoseReceived = await eosePromise;
      expect(eoseReceived).toBeTruthy();

      ws.close();
    });

    it('should handle CLOSE message', async () => {
      const ws = new WebSocket(relayUrl);

      await new Promise<void>((resolve) => {
        ws.onopen = () => resolve();
      });

      const closedPromise = waitForMessage(ws, NostrMessageType.CLOSED);

      const reqMessage: NostrWireMessage = ['REQ', 'sub1', { kinds: [1] }];
      ws.send(JSON.stringify(reqMessage));

      const closeMessage: NostrWireMessage = ['CLOSE', 'sub1'];
      ws.send(JSON.stringify(closeMessage));

      const response = await closedPromise;
      expect(response[1]).toBe('sub1');

      ws.close();
    });

    it('should broadcast events to matching subscriptions', async () => {
      const subscriber = new WebSocket(relayUrl);

      // Wait for subscriber connection
      await new Promise<void>((resolve) => {
        subscriber.onopen = () => resolve();
      });

      const receivedEventPromise = new Promise<NostrWireMessage>((resolve) => {
        const messageHandler = (event: MessageEvent) => {
          const message = JSON.parse(event.data) as NostrWireMessage;
          if (message[0] === NostrMessageType.EVENT && message[1] === 'sub1') {
            subscriber.removeEventListener('message', messageHandler);
            resolve(message);
          }
        };
        subscriber.addEventListener('message', messageHandler);
      });

      const reqMessage: NostrWireMessage = [
        'REQ',
        'sub1',
        { kinds: [1], authors: [events.basic.pubkey] },
      ];
      subscriber.send(JSON.stringify(reqMessage));

      // Wait a bit for subscription to be created
      await new Promise((r) => setTimeout(r, 500));

      const publisher = new WebSocket(relayUrl);
      await new Promise<void>((resolve) => {
        publisher.onopen = () => resolve();
      });

      const publisherResponsePromise = waitForMessage(publisher, NostrMessageType.OK);

      const eventMessage: NostrWireMessage = ['EVENT', events.basic];
      publisher.send(JSON.stringify(eventMessage));

      // Verify publisher gets OK
      const publisherResponse = await publisherResponsePromise;
      expect(publisherResponse[0]).toBe(NostrMessageType.OK);
      expect(publisherResponse[1]).toBe(events.basic.id);
      expect(publisherResponse[2]).toBeTruthy();

      // Verify subscriber receives event
      const receivedEvent = await receivedEventPromise;
      expect(receivedEvent[0]).toBe(NostrMessageType.EVENT);
      expect(receivedEvent[1]).toBe('sub1');
      expect((receivedEvent[2] as NostrEvent).id).toBe(events.basic.id);

      subscriber.close();
      publisher.close();
    });
  });
});
