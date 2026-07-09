// @vitest-environment jsdom
import { render, screen } from '@testing-library/svelte';
import { describe, expect, it } from 'vitest';
import EventCard from './EventCard.svelte';
import { makeEvent } from './test-fixtures.ts';

describe('EventCard', () => {
  it('renders the content, kind and a shortened pubkey', () => {
    const event = makeEvent({
      pubkey: 'abcdef0123456789aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa9876543210fedc',
      kind: 1,
      content: 'gm nostr',
    });
    render(EventCard, { event });

    expect(screen.getByText('gm nostr')).toBeInTheDocument();
    expect(screen.getByText('kind 1')).toBeInTheDocument();
    // 8 leading + ellipsis + 8 trailing hex chars
    expect(screen.getByText('abcdef01…3210fedc')).toBeInTheDocument();
  });

  it('does not shorten a pubkey of 16 chars or fewer', () => {
    render(EventCard, { event: makeEvent({ pubkey: 'short-pubkey' }) });
    expect(screen.getByText('short-pubkey')).toBeInTheDocument();
  });

  it('keeps a 16-char pubkey intact but shortens a 17-char one (boundary)', () => {
    const { unmount } = render(EventCard, {
      event: makeEvent({ pubkey: '0123456789abcdef' }), // exactly 16
    });
    expect(screen.getByText('0123456789abcdef')).toBeInTheDocument();
    unmount();

    render(EventCard, { event: makeEvent({ pubkey: '0123456789abcdefX' }) }); // 17
    expect(screen.getByText('01234567…9abcdefX')).toBeInTheDocument();
  });

  it('shows the verified badge only when status is "validated"', () => {
    const { unmount } = render(EventCard, {
      event: makeEvent(),
      status: 'validated',
    });
    expect(screen.getByLabelText('署名検証済み')).toBeInTheDocument();
    unmount();

    render(EventCard, { event: makeEvent(), status: 'pending' });
    expect(screen.queryByLabelText('署名検証済み')).not.toBeInTheDocument();
  });

  it('exposes the full pubkey as a title attribute', () => {
    const event = makeEvent({ pubkey: 'full-pubkey-value' });
    render(EventCard, { event });
    expect(screen.getByTitle('full-pubkey-value')).toBeInTheDocument();
  });
});
