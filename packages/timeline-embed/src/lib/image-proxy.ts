/**
 * `image-proxy` 指定時に、表示先の大きさへ縮めた画像を配信する URL を組み立てる。
 *
 * 形式は nostr-image-optimizer に合わせた
 * `{proxy}/width=…,quality=…,format=webp/{原URL}`。原 URL は**エンコードせずに**
 * 連結する（プロキシがパスの残り全体を URL として読むため）。
 */

import { readUrl } from './content-parts.ts';

export interface ImageSizing {
  /** 要求する横幅（px）。CSS 側の上限に対しておよそ 2 倍を見込んだ値。 */
  width: number;
  quality: number;
}

/** `--nt-media-max-height` の既定 300px と、カード幅 400px 程度の 2 倍。 */
export const ATTACHMENT_IMAGE: ImageSizing = { width: 800, quality: 60 };

/** `--nt-avatar-size` の既定 40px の 2 倍強。 */
export const AVATAR_IMAGE: ImageSizing = { width: 96, quality: 70 };

/** `--nt-ogp-image-height` の既定 160px でカード幅いっぱいに敷く分。 */
export const OGP_IMAGE: ImageSizing = { width: 600, quality: 60 };

/**
 * @param proxy 未指定なら `url` をそのまま返すので、呼び出し側に分岐を作らない
 * @returns 読めない URL も素通し。プロキシに渡さず、これまでどおり `<img>` に失敗させる
 */
export function proxiedImageUrl(
  proxy: string | undefined,
  url: string,
  { width, quality }: ImageSizing
): string {
  if (!proxy) {
    return url;
  }
  const target = readUrl(url);
  if (!target) {
    return url;
  }
  // フラグメントはサーバに送られないので、パスに紛れ込ませない。
  target.hash = '';
  return `${proxy.replace(/\/+$/, '')}/width=${width},quality=${quality},format=webp/${target.href}`;
}
