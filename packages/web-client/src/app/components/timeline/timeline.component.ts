import { Component, OnDestroy, OnInit } from '@angular/core';
import { Subscription } from 'rxjs';
import { PostComponent } from '../../components/post/post.component';
import { NostrEvent } from '../../models/nostr.model';
import { NostrService } from '../../services/nostr.service';

/**
 * Timeline component that displays a list of Nostr events
 */
@Component({
  selector: 'app-timeline',
  standalone: true,
  imports: [PostComponent],
  providers: [NostrService],
  templateUrl: './timeline.component.html',
  styleUrls: ['./timeline.component.scss'],
})
export class TimelineComponent implements OnInit, OnDestroy {
  events: NostrEvent[] = [];
  private subscription: Subscription | null = null;
  isLoading = true;
  error: string | null = null;

  /**
   * Creates an instance of TimelineComponent
   * @param nostrService Service for interacting with Nostr relays
   */
  constructor(private nostrService: NostrService) {}

  /**
   * Initializes the component and subscribes to Nostr events
   */
  ngOnInit(): void {
    this.isLoading = true;
    this.error = null;

    try {
      this.subscription = this.nostrService.connect().subscribe({
        next: (event) => {
          this.events.push(event);
          // Sort events by created_at in descending order (newest first)
          this.events.sort((a, b) => b.created_at - a.created_at);
          this.isLoading = false;
        },
        error: (err) => {
          this.error = `Error connecting to relay: ${err.message}`;
          this.isLoading = false;
        },
      });
    } catch (err: any) {
      this.error = `Error initializing timeline: ${err.message}`;
      this.isLoading = false;
    }
  }

  /**
   * Cleans up subscriptions when the component is destroyed
   */
  ngOnDestroy(): void {
    if (this.subscription) {
      this.subscription.unsubscribe();
    }
    this.nostrService.disconnect();
  }
}
