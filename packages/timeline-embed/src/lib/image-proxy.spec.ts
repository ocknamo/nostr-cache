import { describe, expect, it } from 'vitest';
import { ATTACHMENT_IMAGE, AVATAR_IMAGE, proxiedImageUrl } from './image-proxy.ts';

const PROXY = 'https://nostr-image-optimizer.example/image';
const IMAGE = 'https://media.example/cat.webp';

describe('proxiedImageUrl', () => {
  it('asks the proxy for the size the widget renders', () => {
    expect(proxiedImageUrl(PROXY, IMAGE, ATTACHMENT_IMAGE)).toBe(
      `${PROXY}/width=800,quality=60,format=webp/${IMAGE}`
    );
    expect(proxiedImageUrl(PROXY, IMAGE, AVATAR_IMAGE)).toBe(
      `${PROXY}/width=96,quality=70,format=webp/${IMAGE}`
    );
  });

  it('leaves the URL alone when no proxy was named', () => {
    expect(proxiedImageUrl(undefined, IMAGE, ATTACHMENT_IMAGE)).toBe(IMAGE);
    expect(proxiedImageUrl('', IMAGE, ATTACHMENT_IMAGE)).toBe(IMAGE);
  });

  it('joins on one slash however the proxy was spelled', () => {
    expect(proxiedImageUrl(`${PROXY}//`, IMAGE, ATTACHMENT_IMAGE)).toBe(
      `${PROXY}/width=800,quality=60,format=webp/${IMAGE}`
    );
  });

  it('keeps the query the original URL needs to be served', () => {
    const signed = 'https://media.example/cat.webp?sig=abc&exp=1';

    expect(proxiedImageUrl(PROXY, signed, ATTACHMENT_IMAGE)).toBe(
      `${PROXY}/width=800,quality=60,format=webp/${signed}`
    );
  });

  it('drops the fragment, which no server would have seen anyway', () => {
    expect(proxiedImageUrl(PROXY, `${IMAGE}#frag`, ATTACHMENT_IMAGE)).toBe(
      `${PROXY}/width=800,quality=60,format=webp/${IMAGE}`
    );
  });

  it('passes anything it cannot read through untouched, rather than to the proxy', () => {
    // Left for the `<img>` to fail on, as it would without a proxy.
    expect(proxiedImageUrl(PROXY, 'data:image/png;base64,AAAA', ATTACHMENT_IMAGE)).toBe(
      'data:image/png;base64,AAAA'
    );
    expect(proxiedImageUrl(PROXY, 'not a url', ATTACHMENT_IMAGE)).toBe('not a url');
  });
});
