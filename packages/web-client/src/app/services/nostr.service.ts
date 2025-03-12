import { Injectable } from '@angular/core';
import { Observable, Subject } from 'rxjs';
import { NostrEvent, Filter } from '../models/nostr.model';

/**
 * Service for interacting with Nostr relays
 * Handles WebSocket connections and event subscriptions
 */
@Injectable({
  providedIn: 'root'
})
export class NostrService {
  private ws: WebSocket | null = null;
  private subscriptionId = 'timeline-sub';
  private events$ = new Subject<NostrEvent>();
  
  /**
   * Creates an instance of NostrService
   */
  constructor() {}
  
  /**
   * Connects to a Nostr relay and subscribes to events
   * @returns Observable of NostrEvents
   */
  connect(): Observable<NostrEvent> {
    this.ws = new WebSocket('wss://nos.lol/');
    
    this.ws.onopen = () => {
      console.log('Connected to relay');
      this.subscribe();
    };
    
    this.ws.onmessage = (event) => {
      const data = JSON.parse(event.data);
      if (data[0] === 'EVENT' && data[1] === this.subscriptionId) {
        this.events$.next(data[2]);
      } else if (data[0] === 'EOSE' && data[1] === this.subscriptionId) {
        console.log('End of stored events');
      }
    };
    
    this.ws.onerror = (error) => {
      console.error('WebSocket error:', error);
    };
    
    this.ws.onclose = () => {
      console.log('Disconnected from relay');
    };
    
    return this.events$.asObservable();
  }
  
  /**
   * Subscribes to events from a specific user
   * @private
   */
  private subscribe() {
    if (!this.ws) return;
    
    const req = [
      'REQ',
      this.subscriptionId,
      {
        authors: ['26bb2ebed6c552d670c804b0d655267b3c662b21e026d6e48ac93a6070530958'],
        kinds: [1], // Text notes
        limit: 20
      }
    ];
    
    this.ws.send(JSON.stringify(req));
  }
  
  /**
   * Disconnects from the relay
   */
  disconnect() {
    if (this.ws) {
      // Send CLOSE message to unsubscribe
      const closeMsg = ['CLOSE', this.subscriptionId];
      this.ws.send(JSON.stringify(closeMsg));
      
      // Close the WebSocket connection
      this.ws.close();
      this.ws = null;
    }
  }
}
