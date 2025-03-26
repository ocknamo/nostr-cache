/**
 * WebSocket Integration Tests
 *
 * Tests the interaction between WebSocketServer and MessageHandler
 */

import { NostrEvent, NostrMessageType, NostrWireMessage } from '@nostr-cache/types';
import { WebSocketEmulator } from '../transport/WebSocketEmulator';
import { IntegrationTestBase, createTestEvent } from './utils/base.integration';

describe('WebSocket Integration', () => {
  let testBase: IntegrationTestBase;
  let clientEmulator: WebSocketEmulator;
  let events: { [key: string]: NostrEvent } = {};
  let relayUrl: string;

  // Setup before each test
  beforeEach(async () => {
    testBase = new IntegrationTestBase();
    const port = await testBase.setup();
    relayUrl = testBase.getServerUrl();

    // Create client emulator
    clientEmulator = new WebSocketEmulator();
    await clientEmulator.start(relayUrl);

    // Create test events
    events = {
      basic: createTestEvent(),
      replaceable: createTestEvent({
        id: 'replaceable-id',
        kind: 0, // Replaceable event
        pubkey: 'replaceable-pubkey',
      }),
      ephemeral: createTestEvent({
        id: 'ephemeral-id',
        kind: 20000, // Ephemeral event
        pubkey: 'ephemeral-pubkey',
      }),
    };
  });

  // Cleanup after each test
  afterEach(async () => {
    await testBase.teardown();
    await clientEmulator.stop();
  });

  describe('WebSocketServer and MessageHandler', () => {
    it('should handle client connection', async () => {
      // Create a WebSocket connection to test server
      const connectPromise = new Promise<void>((resolve) => {
        testBase.server.onConnect((clientId) => {
          expect(clientId).toBeTruthy();
          resolve();
        });
      });

      // Create client connection
      const ws = new WebSocket(relayUrl);
      ws.onopen = () => {
        // Connection established
      };

      // Wait for connection to be registered
      await connectPromise;

      // Cleanup
      ws.close();
    });

    it('should process EVENT message and save to storage', async () => {
      let clientId: string | null = null;

      // Save clientId when client connects
      testBase.server.onConnect((id) => {
        clientId = id;
      });

      // Track responses from server
      const responsePromise = new Promise<NostrWireMessage>((resolve) => {
        clientEmulator.onMessage((_, message) => {
          if (message[0] === NostrMessageType.OK) {
            resolve(message);
          }
        });
      });

      // Create client connection
      const ws = new WebSocket(relayUrl);

      // Wait for connection to be established
      await new Promise<void>((resolve) => {
        ws.onopen = () => resolve();
      });

      expect(clientId).toBeTruthy();

      // Send EVENT message
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

      // Cleanup
      ws.close();
    });

    it('should handle REQ message and return matching events', async () => {
      // First save an event
      await testBase.storage.saveEvent(events.basic);

      // Connect client and track responses
      const eosePromise = new Promise<boolean>((resolve) => {
        clientEmulator.onMessage((_, message) => {
          if (message[0] === NostrMessageType.EOSE) {
            resolve(true);
          }
        });
      });

      const eventPromise = new Promise<NostrEvent>((resolve) => {
        clientEmulator.onMessage((_, message) => {
          if (message[0] === NostrMessageType.EVENT) {
            resolve(message[2] as NostrEvent);
          }
        });
      });

      // Create client connection
      const ws = new WebSocket(relayUrl);

      // Wait for connection to be established
      await new Promise<void>((resolve) => {
        ws.onopen = () => resolve();
      });

      // Send REQ message with filter matching the saved event
      const reqMessage: NostrWireMessage = [
        'REQ',
        'sub1',
        { kinds: [1], authors: [events.basic.pubkey] },
      ];
      ws.send(JSON.stringify(reqMessage));

      // Check that we get the matching event back
      const receivedEvent = await eventPromise;
      expect(receivedEvent.id).toBe(events.basic.id);

      // Check that we get EOSE
      const eoseReceived = await eosePromise;
      expect(eoseReceived).toBeTruthy();

      // Cleanup
      ws.close();
    }, 10000); // Increase timeout to 10 seconds

    it('should handle CLOSE message', async () => {
      // Connect client and track responses
      const closedPromise = new Promise<string>((resolve) => {
        clientEmulator.onMessage((_, message) => {
          if (message[0] === NostrMessageType.CLOSED) {
            resolve(message[1] as string);
          }
        });
      });

      // Create client connection
      const ws = new WebSocket(relayUrl);

      // Wait for connection to be established
      await new Promise<void>((resolve) => {
        ws.onopen = () => resolve();
      });

      // First create a subscription
      const reqMessage: NostrWireMessage = ['REQ', 'sub1', { kinds: [1] }];
      ws.send(JSON.stringify(reqMessage));

      // Then close it
      const closeMessage: NostrWireMessage = ['CLOSE', 'sub1'];
      ws.send(JSON.stringify(closeMessage));

      // Check that we get CLOSED response
      const subscriptionId = await closedPromise;
      expect(subscriptionId).toBe('sub1');

      // Cleanup
      ws.close();
    }, 10000); // Increase timeout to 10 seconds

    it('should broadcast events to matching subscriptions', async () => {
      // Create an emulator for capturing subscriber events
      const subscriberEmulator = new WebSocketEmulator();
      await subscriberEmulator.start(relayUrl);

      // Create two WebSocket clients
      const subscriberPromise = new Promise<WebSocket>((resolve) => {
        const ws = new WebSocket(relayUrl);
        ws.onopen = () => resolve(ws);
        return ws;
      });

      const publisherPromise = new Promise<WebSocket>((resolve) => {
        const ws = new WebSocket(relayUrl);
        ws.onopen = () => resolve(ws);
        return ws;
      });

      let subscriberClientId: string | null = null;
      let publisherClientId: string | null = null;

      // Track the client IDs
      testBase.server.onConnect((clientId) => {
        if (!subscriberClientId) {
          subscriberClientId = clientId;
        } else {
          publisherClientId = clientId;
        }
      });

      // Track events received by subscriber
      const receivedEventPromise = new Promise<NostrEvent>((resolve) => {
        subscriberEmulator.onMessage((_, message) => {
          if (message[0] === NostrMessageType.EVENT && message[1] === 'sub1') {
            resolve(message[2] as NostrEvent);
          }
        });
      });

      // Track publisher's OK response
      const publisherResponsePromise = new Promise<boolean>((resolve) => {
        clientEmulator.onMessage((_, message) => {
          if (message[0] === NostrMessageType.OK && message[1] === events.basic.id) {
            resolve(message[2] as boolean);
          }
        });
      });

      // Connect subscriber and create subscription
      const subscriber = await subscriberPromise;
      const reqMessage: NostrWireMessage = [
        'REQ',
        'sub1',
        { kinds: [1], authors: [events.basic.pubkey] },
      ];
      subscriber.send(JSON.stringify(reqMessage));

      // Wait a bit for subscription to be created
      await new Promise((r) => setTimeout(r, 500)); // Increased wait time

      // Connect publisher
      const publisher = await publisherPromise;

      // Publish event
      const eventMessage: NostrWireMessage = ['EVENT', events.basic];
      publisher.send(JSON.stringify(eventMessage));

      // Verify publisher gets OK
      const publishSuccess = await publisherResponsePromise;
      expect(publishSuccess).toBeTruthy();

      // Verify subscriber receives event
      const receivedEvent = await receivedEventPromise;
      expect(receivedEvent.id).toBe(events.basic.id);

      // Cleanup
      subscriber.close();
      publisher.close();
      await subscriberEmulator.stop();
    }, 15000); // Increase timeout to 15 seconds
  });
});
