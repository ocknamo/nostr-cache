/**
 * Tests for EventHandler
 */

import { EventHandler } from './EventHandler';
import { StorageAdapter } from '../storage/StorageAdapter';
import { NostrEvent } from '@nostr-cache/types';

describe('EventHandler', () => {
  // Mock storage adapter
  const mockStorage: StorageAdapter = {
    saveEvent: jest.fn().mockResolvedValue(true),
    getEvents: jest.fn().mockResolvedValue([]),
    deleteEvent: jest.fn().mockResolvedValue(true),
    clear: jest.fn().mockResolvedValue(undefined)
  };
  
  // Sample events
  const regularEvent: NostrEvent = {
    id: '123',
    pubkey: 'abc',
    created_at: Math.floor(Date.now() / 1000),
    kind: 1,
    tags: [],
    content: 'Hello, world!',
    sig: 'xyz'
  };
  
  const replaceableEvent: NostrEvent = {
    id: '456',
    pubkey: 'abc',
    created_at: Math.floor(Date.now() / 1000),
    kind: 0, // Replaceable
    tags: [],
    content: '{"name":"John"}',
    sig: 'xyz'
  };
  
  const ephemeralEvent: NostrEvent = {
    id: '789',
    pubkey: 'abc',
    created_at: Math.floor(Date.now() / 1000),
    kind: 20001, // Ephemeral
    tags: [],
    content: 'Ephemeral content',
    sig: 'xyz'
  };
  
  const addressableEvent: NostrEvent = {
    id: '012',
    pubkey: 'abc',
    created_at: Math.floor(Date.now() / 1000),
    kind: 30001, // Addressable
    tags: [['d', 'address-value']],
    content: 'Addressable content',
    sig: 'xyz'
  };
  
  let eventHandler: EventHandler;
  
  beforeEach(() => {
    jest.clearAllMocks();
    eventHandler = new EventHandler(mockStorage);
  });
  
  describe('handleEvent', () => {
    it('should validate and save the event', async () => {
      await eventHandler.handleEvent(regularEvent);
      
      expect(mockStorage.saveEvent).toHaveBeenCalledWith(regularEvent);
    });
    
    it('should return true if the event was saved', async () => {
      (mockStorage.saveEvent as jest.Mock).mockResolvedValueOnce(true);
      
      const result = await eventHandler.handleEvent(regularEvent);
      
      expect(result).toBe(true);
    });
    
    it('should return false if the event was not saved', async () => {
      (mockStorage.saveEvent as jest.Mock).mockResolvedValueOnce(false);
      
      const result = await eventHandler.handleEvent(regularEvent);
      
      expect(result).toBe(false);
    });
  });
  
  describe('isReplaceableEvent', () => {
    it('should identify replaceable events', () => {
      const result = eventHandler['isReplaceableEvent'](replaceableEvent);
      
      expect(result).toBe(true);
    });
    
    it('should identify non-replaceable events', () => {
      const result = eventHandler['isReplaceableEvent'](regularEvent);
      
      expect(result).toBe(false);
    });
  });
  
  describe('isEphemeralEvent', () => {
    it('should identify ephemeral events', () => {
      const result = eventHandler['isEphemeralEvent'](ephemeralEvent);
      
      expect(result).toBe(true);
    });
    
    it('should identify non-ephemeral events', () => {
      const result = eventHandler['isEphemeralEvent'](regularEvent);
      
      expect(result).toBe(false);
    });
  });
  
  describe('isAddressableEvent', () => {
    it('should identify addressable events', () => {
      const result = eventHandler['isAddressableEvent'](addressableEvent);
      
      expect(result).toBe(true);
    });
    
    it('should identify non-addressable events', () => {
      const result = eventHandler['isAddressableEvent'](regularEvent);
      
      expect(result).toBe(false);
    });
  });
  
  describe('getDTagValue', () => {
    it('should get the d tag value', () => {
      const result = eventHandler['getDTagValue'](addressableEvent);
      
      expect(result).toBe('address-value');
    });
    
    it('should return undefined if no d tag is present', () => {
      const result = eventHandler['getDTagValue'](regularEvent);
      
      expect(result).toBeUndefined();
    });
  });
});
