import { TestBed } from '@angular/core/testing';
import { NostrService } from './nostr.service';

describe('NostrService', () => {
  let service: NostrService;
  let mockWebSocket: any;
  
  beforeEach(() => {
    // Create a new mock WebSocket instance for each test
    mockWebSocket = {
      onopen: null,
      onmessage: null,
      onerror: null,
      onclose: null,
      send: jest.fn(),
      close: jest.fn()
    };
    
    // Mock the WebSocket constructor
    (global.WebSocket as any) = jest.fn().mockImplementation(() => mockWebSocket);
    
    TestBed.configureTestingModule({
      providers: [NostrService]
    });
    service = TestBed.inject(NostrService);
  });
  
  it('should be created', () => {
    expect(service).toBeTruthy();
  });
  
  it('should connect to WebSocket and subscribe', () => {
    // Connect to relay
    service.connect();
    
    // Verify WebSocket was created with correct URL
    expect(global.WebSocket).toHaveBeenCalledWith('wss://nos.lol/');
    
    // Simulate WebSocket open event
    mockWebSocket.onopen();
    
    // Verify subscription was sent
    expect(mockWebSocket.send).toHaveBeenCalledTimes(1);
    
    // Verify subscription format
    const sentData = JSON.parse(mockWebSocket.send.mock.calls[0][0]);
    expect(sentData[0]).toBe('REQ');
    expect(sentData[1]).toBe('timeline-sub');
    expect(sentData[2].authors).toContain('26bb2ebed6c552d670c804b0d655267b3c662b21e026d6e48ac93a6070530958');
    expect(sentData[2].kinds).toContain(1);
  });
  
  it('should emit events when received from WebSocket', (done) => {
    // Sample Nostr event
    const sampleEvent = {
      id: 'sample-id',
      pubkey: '26bb2ebed6c552d670c804b0d655267b3c662b21e026d6e48ac93a6070530958',
      created_at: 1615478857,
      kind: 1,
      tags: [],
      content: 'Hello, Nostr!',
      sig: 'sample-sig'
    };
    
    // Subscribe to events
    service.connect().subscribe(event => {
      expect(event).toEqual(sampleEvent);
      done();
    });
    
    // Simulate WebSocket open event
    mockWebSocket.onopen();
    
    // Simulate receiving an event
    mockWebSocket.onmessage({
      data: JSON.stringify(['EVENT', 'timeline-sub', sampleEvent])
    });
  });
  
  it('should disconnect and close WebSocket', () => {
    // Connect and then disconnect
    service.connect();
    service.disconnect();
    
    // Verify CLOSE message was sent
    expect(mockWebSocket.send).toHaveBeenCalledTimes(1);
    const sentData = JSON.parse(mockWebSocket.send.mock.calls[0][0]);
    expect(sentData[0]).toBe('CLOSE');
    
    // Verify WebSocket was closed
    expect(mockWebSocket.close).toHaveBeenCalledTimes(1);
  });
});
