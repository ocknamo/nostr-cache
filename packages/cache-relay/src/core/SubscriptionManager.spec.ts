/**
 * Tests for SubscriptionManager
 */

import { SubscriptionManager } from './SubscriptionManager';
import { StorageAdapter } from '../storage/StorageAdapter';
import { NostrEvent, Filter } from '@nostr-cache/types';

describe('SubscriptionManager', () => {
  // Mock storage adapter
  const mockStorage: StorageAdapter = {
    saveEvent: jest.fn().mockResolvedValue(true),
    getEvents: jest.fn().mockResolvedValue([]),
    deleteEvent: jest.fn().mockResolvedValue(true),
    clear: jest.fn().mockResolvedValue(undefined)
  };
  
  // Sample event
  const sampleEvent: NostrEvent = {
    id: '123',
    pubkey: 'abc',
    created_at: Math.floor(Date.now() / 1000),
    kind: 1,
    tags: [['e', '456'], ['p', 'def']],
    content: 'Hello, world!',
    sig: 'xyz'
  };
  
  // Sample filters
  const sampleFilter1: Filter = {
    kinds: [1],
    authors: ['abc'],
    limit: 10
  };
  
  const sampleFilter2: Filter = {
    kinds: [1, 2],
    '#e': ['456'],
    limit: 20
  };
  
  let subscriptionManager: SubscriptionManager;
  
  beforeEach(() => {
    jest.clearAllMocks();
    subscriptionManager = new SubscriptionManager(mockStorage);
  });
  
  describe('createSubscription', () => {
    it('should create a subscription', () => {
      const subscription = subscriptionManager.createSubscription('client1', 'sub1', [sampleFilter1]);
      
      expect(subscription).toBeDefined();
      expect(subscription.clientId).toBe('client1');
      expect(subscription.id).toBe('sub1');
      expect(subscription.filters).toEqual([sampleFilter1]);
    });
    
    it('should replace an existing subscription with the same ID', () => {
      subscriptionManager.createSubscription('client1', 'sub1', [sampleFilter1]);
      const subscription = subscriptionManager.createSubscription('client1', 'sub1', [sampleFilter2]);
      
      expect(subscription.filters).toEqual([sampleFilter2]);
    });
  });
  
  describe('removeSubscription', () => {
    it('should remove a subscription', () => {
      subscriptionManager.createSubscription('client1', 'sub1', [sampleFilter1]);
      
      const result = subscriptionManager.removeSubscription('client1', 'sub1');
      
      expect(result).toBe(true);
    });
    
    it('should return false if the subscription does not exist', () => {
      const result = subscriptionManager.removeSubscription('client1', 'non-existent');
      
      expect(result).toBe(false);
    });
  });
  
  describe('removeAllSubscriptions', () => {
    it('should remove all subscriptions for a client', () => {
      subscriptionManager.createSubscription('client1', 'sub1', [sampleFilter1]);
      subscriptionManager.createSubscription('client1', 'sub2', [sampleFilter2]);
      
      const count = subscriptionManager.removeAllSubscriptions('client1');
      
      expect(count).toBe(2);
    });
    
    it('should return 0 if the client has no subscriptions', () => {
      const count = subscriptionManager.removeAllSubscriptions('non-existent');
      
      expect(count).toBe(0);
    });
  });
  
  describe('removeSubscriptionByIdForAllClients', () => {
    it('should remove a subscription by ID for all clients', () => {
      subscriptionManager.createSubscription('client1', 'sub1', [sampleFilter1]);
      subscriptionManager.createSubscription('client2', 'sub1', [sampleFilter2]);
      
      const count = subscriptionManager.removeSubscriptionByIdForAllClients('sub1');
      
      expect(count).toBe(2);
    });
    
    it('should return 0 if no clients have the subscription', () => {
      const count = subscriptionManager.removeSubscriptionByIdForAllClients('non-existent');
      
      expect(count).toBe(0);
    });
  });
  
  describe('getSubscription', () => {
    it('should get a subscription', () => {
      subscriptionManager.createSubscription('client1', 'sub1', [sampleFilter1]);
      
      const subscription = subscriptionManager.getSubscription('client1', 'sub1');
      
      expect(subscription).toBeDefined();
      expect(subscription?.id).toBe('sub1');
    });
    
    it('should return undefined if the subscription does not exist', () => {
      const subscription = subscriptionManager.getSubscription('client1', 'non-existent');
      
      expect(subscription).toBeUndefined();
    });
  });
  
  describe('getClientSubscriptions', () => {
    it('should get all subscriptions for a client', () => {
      subscriptionManager.createSubscription('client1', 'sub1', [sampleFilter1]);
      subscriptionManager.createSubscription('client1', 'sub2', [sampleFilter2]);
      
      const subscriptions = subscriptionManager.getClientSubscriptions('client1');
      
      expect(subscriptions.length).toBe(2);
      expect(subscriptions[0].id).toBe('sub1');
      expect(subscriptions[1].id).toBe('sub2');
    });
    
    it('should return an empty array if the client has no subscriptions', () => {
      const subscriptions = subscriptionManager.getClientSubscriptions('non-existent');
      
      expect(subscriptions).toEqual([]);
    });
  });
  
  describe('getAllSubscriptions', () => {
    it('should get all subscriptions', () => {
      subscriptionManager.createSubscription('client1', 'sub1', [sampleFilter1]);
      subscriptionManager.createSubscription('client2', 'sub2', [sampleFilter2]);
      
      const subscriptions = subscriptionManager.getAllSubscriptions();
      
      expect(subscriptions.length).toBe(2);
    });
    
    it('should return an empty array if there are no subscriptions', () => {
      const subscriptions = subscriptionManager.getAllSubscriptions();
      
      expect(subscriptions).toEqual([]);
    });
  });
  
  describe('findMatchingSubscriptions', () => {
    it('should find subscriptions that match an event', () => {
      subscriptionManager.createSubscription('client1', 'sub1', [sampleFilter1]);
      subscriptionManager.createSubscription('client2', 'sub2', [sampleFilter2]);
      
      const matches = subscriptionManager.findMatchingSubscriptions(sampleEvent);
      
      expect(matches.size).toBe(2);
      expect(matches.get('client1')).toBeDefined();
      expect(matches.get('client2')).toBeDefined();
    });
    
    it('should return an empty map if no subscriptions match', () => {
      subscriptionManager.createSubscription('client1', 'sub1', [{
        kinds: [2], // Different kind
        authors: ['def'] // Different author
      }]);
      
      const matches = subscriptionManager.findMatchingSubscriptions({
        ...sampleEvent,
        kind: 3 // Different kind
      });
      
      expect(matches.size).toBe(0);
    });
  });
});
