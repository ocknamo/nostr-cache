import { CommonModule } from '@angular/common';
import { Component, Input } from '@angular/core';
import { NostrEvent } from '../../models/nostr.model';

/**
 * Component for displaying a single Nostr event (post)
 */
@Component({
  selector: 'app-post',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './post.component.html',
  styleUrls: ['./post.component.scss'],
})
export class PostComponent {
  @Input() event!: NostrEvent;

  /**
   * Returns a formatted date string from a Unix timestamp
   * @param timestamp Unix timestamp in seconds
   * @returns Formatted date string
   */
  formatDate(timestamp: number): string {
    const date = new Date(timestamp * 1000);
    return date.toLocaleString();
  }

  /**
   * Returns a shortened version of a pubkey for display
   * @param pubkey Nostr public key
   * @returns Shortened pubkey (first 8 chars + ... + last 8 chars)
   */
  shortenPubkey(pubkey: string): string {
    if (pubkey.length <= 16) return pubkey;
    return `${pubkey.substring(0, 8)}...${pubkey.substring(pubkey.length - 8)}`;
  }
}
