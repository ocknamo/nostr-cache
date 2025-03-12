import 'jest-preset-angular/setup-jest';

// Global mocks for testing
Object.defineProperty(global, 'window', { value: global });

// Mock WebSocket
class MockWebSocket {
  onopen: (() => void) | null = null;
  onmessage: ((event: any) => void) | null = null;
  onerror: ((error: any) => void) | null = null;
  onclose: (() => void) | null = null;
  
  constructor(public url: string) {}
  
  send(data: string): void {}
  
  close(): void {}
}

// Store original WebSocket if it exists
const originalWebSocket = global.WebSocket;

// Add WebSocket to global for tests
global.WebSocket = MockWebSocket as any;

// Cleanup after tests
afterAll(() => {
  global.WebSocket = originalWebSocket;
});
