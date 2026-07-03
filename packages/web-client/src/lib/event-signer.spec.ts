import { verifier } from 'rx-nostr-crypto';
import { describe, expect, it } from 'vitest';
import { EventSigner } from './event-signer.ts';

describe('EventSigner', () => {
  it('signs a kind-1 text note with all NIP-01 fields', async () => {
    const signer = new EventSigner();
    const event = await signer.signTextNote('hello nostr');

    expect(event.kind).toBe(1);
    expect(event.content).toBe('hello nostr');
    expect(event.tags).toEqual([]);
    expect(event.id).toMatch(/^[0-9a-f]{64}$/);
    expect(event.pubkey).toMatch(/^[0-9a-f]{64}$/);
    expect(event.sig).toMatch(/^[0-9a-f]{128}$/);
    expect(event.created_at).toBeGreaterThan(0);
  });

  it('produces a verifiable signature', async () => {
    const signer = new EventSigner();
    const event = await signer.signTextNote('verify me');
    expect(await verifier(event)).toBe(true);
  });

  it('uses the same pubkey for repeated notes', async () => {
    const signer = new EventSigner();
    const first = await signer.signTextNote('one');
    const second = await signer.signTextNote('two');
    expect(first.pubkey).toBe(second.pubkey);
    expect(await signer.getPublicKey()).toBe(first.pubkey);
  });
});
