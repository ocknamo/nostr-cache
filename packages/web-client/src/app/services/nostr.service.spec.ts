import { TestBed } from '@angular/core/testing';
import { NostrEvent } from '../models/nostr.model';
import { NostrService } from './nostr.service';

describe('NostrService', () => {
  let service: NostrService;
  interface MockWebSocket {
    onopen: () => void;
    onmessage: (event: { data: string }) => void;
    onerror: (error: unknown) => void;
    onclose: () => void;
    send: jest.Mock;
    close: jest.Mock;
  }

  let mockWebSocket: MockWebSocket;

  beforeEach(() => {
    // Create a new mock WebSocket instance for each test
    mockWebSocket = {
      onopen: jest.fn(),
      onmessage: jest.fn(),
      onerror: jest.fn(),
      onclose: jest.fn(),
      send: jest.fn(),
      close: jest.fn(),
    };

    // Mock the WebSocket constructor
    global.WebSocket = jest.fn().mockImplementation(() => mockWebSocket) as unknown as typeof WebSocket;

    TestBed.configureTestingModule({
      providers: [NostrService],
    });
    service = TestBed.inject(NostrService);
  });

  it('should be created', () => {
    expect(service).toBeTruthy();
  });

  it('should connect to WebSocket and fetch follow list', () => {
    // Connect to relay
    service.connect();

    // Verify WebSocket was created with correct URL
    expect(global.WebSocket).toHaveBeenCalledWith('wss://nos.lol/');

    // Simulate WebSocket open event
    mockWebSocket.onopen();

    // Verify follow list request was sent
    expect(mockWebSocket.send).toHaveBeenCalledTimes(1);

    // Verify follow list request format
    const sentData = JSON.parse(mockWebSocket.send.mock.calls[0][0]);
    expect(sentData[0]).toBe('REQ');
    expect(sentData[1]).toBe('follow-list-sub');
    expect(sentData[2].authors).toContain(
      '26bb2ebed6c552d670c804b0d655267b3c662b21e026d6e48ac93a6070530958'
    );
    expect(sentData[2].kinds).toContain(3); // Follow list kind
  });

  it('should process follow list and subscribe to timeline', () => {
    // Sample follow list event
    const followListEvent: NostrEvent = {
      id: 'follow-list-id',
      pubkey: '26bb2ebed6c552d670c804b0d655267b3c662b21e026d6e48ac93a6070530958',
      created_at: 1615478857,
      kind: 3, // Follow list
      tags: [
        ['p', 'user1-pubkey'],
        ['p', 'user2-pubkey'],
        ['p', 'user3-pubkey'],
      ],
      content: '',
      sig: 'sample-sig',
    };

    // Connect to relay
    service.connect();

    // Simulate WebSocket open event
    mockWebSocket.onopen();

    // Reset mock to clear follow list request
    mockWebSocket.send.mockClear();

    // Simulate receiving follow list event
    mockWebSocket.onmessage({
      data: JSON.stringify(['EVENT', 'follow-list-sub', followListEvent]),
    });

    // Simulate end of stored events
    mockWebSocket.onmessage({
      data: JSON.stringify(['EOSE', 'follow-list-sub']),
    });

    // Verify CLOSE message for follow list subscription was sent
    expect(mockWebSocket.send).toHaveBeenCalledTimes(2);
    const closeMsg = JSON.parse(mockWebSocket.send.mock.calls[0][0]);
    expect(closeMsg[0]).toBe('CLOSE');
    expect(closeMsg[1]).toBe('follow-list-sub');

    // Verify timeline subscription was sent
    const timelineReq = JSON.parse(mockWebSocket.send.mock.calls[1][0]);
    expect(timelineReq[0]).toBe('REQ');
    expect(timelineReq[1]).toBe('timeline-sub');
    expect(timelineReq[2].authors).toContain('user1-pubkey');
    expect(timelineReq[2].authors).toContain('user2-pubkey');
    expect(timelineReq[2].authors).toContain('user3-pubkey');
    expect(timelineReq[2].kinds).toContain(1); // Text notes
  });

  it('should use target user as fallback if no followed users found', () => {
    // Sample empty follow list event
    const emptyFollowListEvent: NostrEvent = {
      id: 'empty-follow-list-id',
      pubkey: '26bb2ebed6c552d670c804b0d655267b3c662b21e026d6e48ac93a6070530958',
      created_at: 1615478857,
      kind: 3, // Follow list
      tags: [], // No p tags
      content: '',
      sig: 'sample-sig',
    };

    // Connect to relay
    service.connect();

    // Simulate WebSocket open event
    mockWebSocket.onopen();

    // Reset mock to clear follow list request
    mockWebSocket.send.mockClear();

    // Simulate receiving empty follow list event
    mockWebSocket.onmessage({
      data: JSON.stringify(['EVENT', 'follow-list-sub', emptyFollowListEvent]),
    });

    // Simulate end of stored events
    mockWebSocket.onmessage({
      data: JSON.stringify(['EOSE', 'follow-list-sub']),
    });

    // Verify timeline subscription was sent with target user as fallback
    const timelineReq = JSON.parse(mockWebSocket.send.mock.calls[1][0]);
    expect(timelineReq[2].authors).toContain(
      '26bb2ebed6c552d670c804b0d655267b3c662b21e026d6e48ac93a6070530958'
    );
  });

  it('should emit events when received from timeline subscription', (done) => {
    // Sample Nostr event
    const sampleEvent: NostrEvent = {
      id: 'sample-id',
      pubkey: 'user1-pubkey',
      created_at: 1615478857,
      kind: 1,
      tags: [],
      content: 'Hello, Nostr!',
      sig: 'sample-sig',
    };

    // Subscribe to events
    service.connect().subscribe((event) => {
      expect(event).toEqual(sampleEvent);
      done();
    });

    // Simulate WebSocket open event
    mockWebSocket.onopen();

    // Simulate receiving a timeline event
    mockWebSocket.onmessage({
      data: JSON.stringify(['EVENT', 'timeline-sub', sampleEvent]),
    });
  });

  it('should disconnect and close both subscriptions', () => {
    // Connect and then disconnect
    service.connect();

    // Reset mock to clear previous calls
    mockWebSocket.send.mockClear();

    service.disconnect();

    // Verify CLOSE messages were sent for both subscriptions
    expect(mockWebSocket.send).toHaveBeenCalledTimes(2);

    const closeFollowListMsg = JSON.parse(mockWebSocket.send.mock.calls[0][0]);
    expect(closeFollowListMsg[0]).toBe('CLOSE');
    expect(closeFollowListMsg[1]).toBe('follow-list-sub');

    const closeTimelineMsg = JSON.parse(mockWebSocket.send.mock.calls[1][0]);
    expect(closeTimelineMsg[0]).toBe('CLOSE');
    expect(closeTimelineMsg[1]).toBe('timeline-sub');

    // Verify WebSocket was closed
    expect(mockWebSocket.close).toHaveBeenCalledTimes(1);
  });
});
