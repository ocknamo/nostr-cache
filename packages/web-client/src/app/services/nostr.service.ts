import { Injectable } from '@angular/core';
import { Observable, Subject } from 'rxjs';
import { NostrEvent } from '../models/nostr.model';

/**
 * Service for interacting with Nostr relays
 * Handles WebSocket connections and event subscriptions
 * Supports fetching follow lists and displaying follower timelines
 */
@Injectable({
  providedIn: 'root',
})
export class NostrService {
  private ws: WebSocket | null = null;
  private timelineSubscriptionId = 'timeline-sub';
  private followListSubscriptionId = 'follow-list-sub';
  private events$ = new Subject<NostrEvent>();
  private followedPubkeys: string[] = [];
  private targetPubkey = '26bb2ebed6c552d670c804b0d655267b3c662b21e026d6e48ac93a6070530958';

  // コンストラクタは依存性注入のために必要ですが、現在は特に初期化処理は不要です

  /**
   * Connects to a Nostr relay and fetches follow list, then subscribes to events
   * @returns Observable of NostrEvents
   */
  connect(): Observable<NostrEvent> {
    this.ws = new WebSocket('wss://nos.lol/');

    this.ws.onopen = () => {
      console.log('Connected to relay');
      this.fetchFollowList();
    };

    this.ws.onmessage = (event) => {
      const data = JSON.parse(event.data);

      if (data[0] === 'EVENT') {
        if (data[1] === this.followListSubscriptionId) {
          // Process follow list event
          if (data[2].kind === 3) {
            this.processFollowList(data[2]);
          }
        } else if (data[1] === this.timelineSubscriptionId) {
          // Process timeline event
          this.events$.next(data[2]);
        }
      } else if (data[0] === 'EOSE') {
        if (data[1] === this.followListSubscriptionId) {
          console.log('End of stored follow list events');
          // After receiving all follow list events, subscribe to timeline
          this.subscribeToTimeline();
        } else if (data[1] === this.timelineSubscriptionId) {
          console.log('End of stored timeline events');
        }
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
   * Fetches the follow list for the target user
   * @private
   */
  private fetchFollowList() {
    if (!this.ws) return;

    console.log(`Fetching follow list for ${this.targetPubkey}`);

    const req = [
      'REQ',
      this.followListSubscriptionId,
      {
        authors: [this.targetPubkey],
        kinds: [3], // Follow lists
        limit: 1, // Only need the most recent follow list
      },
    ];

    this.ws.send(JSON.stringify(req));
  }

  /**
   * Processes a follow list event and extracts followed pubkeys
   * @param event The follow list event
   * @private
   */
  private processFollowList(event: NostrEvent) {
    // Extract pubkeys from p tags
    this.followedPubkeys = event.tags.filter((tag) => tag[0] === 'p').map((tag) => tag[1]);

    console.log(`Extracted ${this.followedPubkeys.length} followed pubkeys`);

    // If no followed users found, use the target user as fallback
    if (this.followedPubkeys.length === 0) {
      console.log('No followed users found, using target user as fallback');
      this.followedPubkeys.push(this.targetPubkey);
    }
  }

  /**
   * Subscribes to timeline events from followed users
   * @private
   */
  private subscribeToTimeline() {
    if (!this.ws || this.followedPubkeys.length === 0) return;

    console.log(`Subscribing to timeline for ${this.followedPubkeys.length} users`);

    // Close the follow list subscription
    const closeMsg = ['CLOSE', this.followListSubscriptionId];
    this.ws.send(JSON.stringify(closeMsg));

    // Subscribe to timeline events
    const req = [
      'REQ',
      this.timelineSubscriptionId,
      {
        authors: this.followedPubkeys,
        kinds: [1], // Text notes
        limit: 50,
      },
    ];

    this.ws.send(JSON.stringify(req));
  }

  /**
   * Disconnects from the relay
   */
  disconnect() {
    if (this.ws) {
      // Send CLOSE messages to unsubscribe
      const closeFollowListMsg = ['CLOSE', this.followListSubscriptionId];
      this.ws.send(JSON.stringify(closeFollowListMsg));

      const closeTimelineMsg = ['CLOSE', this.timelineSubscriptionId];
      this.ws.send(JSON.stringify(closeTimelineMsg));

      // Close the WebSocket connection
      this.ws.close();
      this.ws = null;
    }
  }
}
