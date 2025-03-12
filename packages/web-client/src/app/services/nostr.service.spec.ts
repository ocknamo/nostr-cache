import { TestBed } from '@angular/core/testing';
import { NostrService } from './nostr.service';

/**
 * Mock WebSocket class for testing
 */
class MockWebSocket {
  onopen: (() => void) | null = null;
  onmessage: ((event: any) => void) | null = null;
  onerror: ((error: any) => void) | null = null;
  onclose: (() => void) | null = null;
  
  constructor(public url: string) {}
  
  send(data: string): void {}
  
  close(): void {}
}

describe('NostrService', () => {
  let service: NostrService;
  let mockWebSocket: MockWebSocket;
  
  // Store the original WebSocket
  const originalWebSocket = global.WebSocket;
  
  beforeEach(() => {
    // Replace global WebSocket with mock
    mockWebSocket = new MockWebSocket('wss://nos.lol/');
    (global as any).WebSocket = jest.fn(() => mockWebSocket);
    
    TestBed.configureTestingModule({
      providers: [NostrService]
    });
    service = TestBed.inject(NostrService);
  });
  
  afterEach(() => {
    // Restore original WebSocket
    (global as any).WebSocket = originalWebSocket;
  });
  
  it('should be created', () => {
    expect(service).toBeTruthy();
  });
  
  it('should connect to WebSocket and subscribe', () => {
    // Spy on WebSocket methods
    const sendSpy = jest.spyOn(mockWebSocket, 'send');
    
    // Connect to relay
    service.connect();
    
    // Simulate WebSocket open event
    if (mockWebSocket.onopen) {
      mockWebSocket.onopen();
    }
    
    // Verify subscription was sent
    expect(sendSpy).toHaveBeenCalledTimes(1);
    
    // Verify subscription format
    const sentData = JSON.parse(sendSpy.mock.calls[0][0]);
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
    if (mockWebSocket.onopen) {
      mockWebSocket.onopen();
    }
    
    // Simulate receiving an event
    if (mockWebSocket.onmessage) {
      mockWebSocket.onmessage({
        data: JSON.stringify(['EVENT', 'timeline-sub', sampleEvent])
      });
    }
  });
  
  it('should disconnect and close WebSocket', () => {
    // Spy on WebSocket methods
    const closeSpy = jest.spyOn(mockWebSocket, 'close');
    const sendSpy = jest.spyOn(mockWebSocket, 'send');
    
    // Connect and then disconnect
    service.connect();
    service.disconnect();
    
    // Verify CLOSE message was sent
    expect(sendSpy).toHaveBeenCalledTimes(1);
    const sentData = JSON.parse(sendSpy.mock.calls[0][0]);
    expect(sentData[0]).toBe('CLOSE');
    
    // Verify WebSocket was closed
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });
});
