/**
 * nostr-image-optimizer 形式の
 * `{proxy}/width=…,quality=…,format=webp/{原URL}` を組み立てる。原 URL を
 * エンコードしないのは、プロキシがパスの残り全体を URL として読むため。
 */

import { readUrl } from './content-parts.ts';

export interface ImageSizing {
  width: number;
  quality: number;
}

/** 幅はいずれも、対応する CSS 変数の既定値の 2 倍前後（高 DPI 用）。 */
export const ATTACHMENT_IMAGE: ImageSizing = { width: 800, quality: 60 };
export const AVATAR_IMAGE: ImageSizing = { width: 96, quality: 70 };
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
  // フラグメントはサーバに送られないので、パスに紛れ込ませない。資格情報は
  // `<img>` が送らないものなので、プロキシ運営者に渡すだけになる。
  target.hash = '';
  target.username = '';
  target.password = '';
  return `${proxy.replace(/\/+$/, '')}/width=${width},quality=${quality},format=webp/${target.href}`;
}
