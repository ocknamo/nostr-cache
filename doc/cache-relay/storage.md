# ストレージレイヤー設計仕様書

## 1. 概要
本設計書では、cache-relayのストレージレイヤーの実装仕様について記載する。
主にDexie.jsを使用したIndexedDBの実装とテストについて詳述する。

## 2. システム構成

### 2.1. 依存関係
#### 2.1.1. 主要依存パッケージ
- dexie: ^4.0.11（IndexedDBラッパーライブラリ）
- @nostr-cache/shared: ^0.1.0（共有型定義、共有ユーティリティ）

#### 2.1.2. テスト用依存パッケージ
- fake-indexeddb: ^6.0.0（IndexedDBモック）

### 2.2. 基本構成
- 実装ファイル: packages/cache-relay/src/storage/dexie-storage.ts
- データベース: IndexedDB (Dexie.js)
- テーブル構成: events
  - 主要フィールド：id, pubkey, created_at, kind, tags, content, sig
  - インデックス用フィールド：indexed_tags
  - 検証状態フィールド：validated（0=未検証, 1=署名検証済み。boolean は
    IndexedDB でインデックス化できないため数値で保持）

### 2.3. インターフェース仕様
StorageAdapterインターフェースの実装
- saveEvent(event, options?): イベントの保存機能（`options.validated` で検証済みとして保存。省略時は未検証。既存行が検証済みの場合、再保存で未検証へ**ダウングレードしない**）
- getEvents(): フィルタに基づくイベント取得機能
- deleteEvent(): イベント削除機能
- clear(): ストレージクリア機能
- getUnvalidatedEvents(limit): 未検証イベントを保存時刻の古い順に取得（遅延検証の永続キュー。アクセス追跡しない）
- markValidated(ids): 検証済みフラグの一括付与（存在しない id は no-op）
- getValidationStatus(ids): id ごとの検証状態（`validated` / `pending` / `unknown`）を一括取得（主キー bulkGet。アクセス追跡しない）
- deleteEventsByIdsForPubkey(ids, pubkey): NIP-09 の `e` タグに対応する削除。`pubkey` が一致する行のみ削除し、kind 5 は削除しない（両方ともストレージ側で保証する）
- getCurrentVersion(address): 座標（kind / pubkey / `d` 値）に保存されている置換可能・アドレサブルイベントを取得。複数版があれば NIP-01 の順序（`created_at` の新しい方、同値は id の辞書順で小さい方）で 1 件を返す。リレーが「受信イベントを保存してよいか」の判定に使う書き込み経路の事前確認のため、アクセス追跡はしない。失敗は握り潰さず伝播させる（「未保存」と誤認すると古い版で新しい版を上書きしてしまうため）
- deleteEventsByAddress(address, until): NIP-09 の `a` タグに対応する削除。`created_at <= until` の版のみ削除。アドレサブル kind では `d` タグの一致を要求し、置換可能 kind では `identifier` を無視する（判定は cache-relay の共通純関数 `matchesAddressIdentifier`）

## 3. データベース設計

### 3.1. インデックス構成
#### 3.1.1. 単一フィールドインデックス
- id: プライマリキー
- pubkey: 著者検索用
- created_at: 時間範囲検索用
- kind: イベント種別検索用
- indexed_tags: タグ検索用（配列インデックス）

#### 3.1.2. 複合インデックス
- [pubkey+kind]: 著者とイベント種別の組み合わせ検索用
- [kind+created_at]: イベント種別と時間範囲の検索用
- [pubkey+created_at]: 著者と時間範囲の検索用
- [pubkey+kind+created_at]: 複合条件での検索用
- [validated+cached_at]: 遅延検証の永続キュー用。`validated=0` の等値プレフィックスで未検証イベントを `cached_at` 昇順（古い順）にスキャンできるため、FIFO バッチ処理に並び替えが不要

#### 3.1.3. 検証状態のインデックス戦略
- **id → 検証状態の参照**（クライアントのバッジ表示などで高頻度）は、`id` が主キーであるため **追加インデックス不要**。`bulkGet` による主キー直接参照が最速経路
- **未検証イベントのスキャン**（バックグラウンド検証）だけが `[validated+cached_at]` を使う
- 検証状態の読み取り（getValidationStatus / getUnvalidatedEvents）は LRU/LFU 用のアクセスメタデータを更新しない（ポーリングが退避順序を乱さないため）

### 3.2. タグインデックス仕様
- indexed_tagsフィールドの実装
- 優先タグの定義（e, p, a, t, d, h, m, q, r）
- タグインデックスの制限（最大100個）

## 4. 機能仕様

### 4.1. クエリ処理機能
- フィルタ条件に基づく最適なインデックス選択機能
- 複数フィルタの効率的な処理機能
- タグフィルタと時間範囲フィルタの組み合わせ処理

### 4.2. タグ処理機能
- シングルレタータグの優先処理
- タグ形式の正規化（`{tagName}:{value}`形式）
- 無効なタグ形式の検証と除外

### 4.3. フィルタ処理機能
- since/untilパラメータによる時間範囲フィルタ（**両端とも境界を含む**（NIP-01）。Dexie の
  `between()` は既定で上限排他のため、時間範囲の絞り込みは `betweenCreatedAt()` に集約し、
  全分岐で包含指定にそろえている。ここで境界のイベントを落とすと、最終判定の
  `eventMatchesFilter`（包含）では復活できない）
- 複合条件での時間範囲フィルタ処理
- limitパラメータによる件数制限（**一致するイベントのうち最新 N 件を、新しい順で**（NIP-01）。
  Dexie の `Collection.limit()` は選ばれたインデックス順の先頭 N 件になり最新順にならないため、
  取得後に `capEvents`（`created_at` 降順・id 昇順タイブレーク）で並べ替えつつ切り詰める。
  一致件数が limit 以下でも並び順の要件は変わらないため、常に整列する。
  limit はフィルタごとに適用し、複数フィルタの結果は id で重複排除する。
  limit は `normalizeLimit` で非負整数へ正規化してから使う）
- タグ値の検証と正規化処理

## 7. 制限事項
- インデックス化されるタグの数は最大100個
- シングルレターのタグのみがインデックス化される
- 複雑なタグフィルタリングはパフォーマンスに影響を与える可能性あり
