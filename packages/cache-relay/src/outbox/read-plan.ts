/**
 * 読み込みの宛先（NIP-65）。既定の上流には元のフィルタがそのまま行くので、ここで決めるのは
 * 既定の上流では届かない分だけを足す先。
 */

import type { Filter } from '@nostr-cache/shared';
import { isReplaceableKind } from '../event/event-kind.js';
import type { ReadPart } from '../upstream/upstream-coordinator.js';
import type { RelayList } from './relay-list.js';

/** NIP-65 はリストを 2〜4 本に保つよう勧めている。全部を引くと接続が膨らむので 2 本で足りる。 */
export const RELAYS_PER_AUTHOR = 2;
/** REQ 1 本で足す宛先の上限。 */
export const MAX_READ_RELAYS = 8;

type RoutedField = 'authors' | '#p' | '#e' | '#q';

export interface ReadPlanContext {
  lists: ReadonlyMap<string, RelayList>;
  /** `#e` / `#q` が指すイベントの著者（キャッシュにあるものだけ）。 */
  referencedAuthors: ReadonlyMap<string, string>;
  /** 既定の上流。ここに載っている人は既定の上流への REQ で拾える。 */
  isDefault: (relay: string) => boolean;
  canReach: (relay: string) => boolean;
}

interface Need {
  filterIndex: number;
  field: RoutedField;
  value: string;
  candidates: string[];
}

/**
 * 宛先を決めるのに要るもの。replaceable だけを引くフィルタは対象外（インデックスリレーにも
 * 広く載っていて鮮度ウィンドウも効くので、著者ごとに接続を開くほどの得が無い）。
 */
export function readLookups(filters: Filter[]): { pubkeys: string[]; eventIds: string[] } {
  const pubkeys = new Set<string>();
  const eventIds = new Set<string>();
  for (const filter of filters) {
    const routed = routedField(filter);
    if (routed === 'authors' || routed === '#p') {
      for (const value of filterValues(filter, routed)) {
        pubkeys.add(value);
      }
    } else if (routed) {
      for (const value of filterValues(filter, routed)) {
        eventIds.add(value);
      }
    }
  }
  return { pubkeys: [...pubkeys], eventIds: [...eventIds] };
}

/**
 * 既定の上流に 1 本でも書いている人のための宛先は足さない。残りの人に 2 本ずつ届くまで、
 * 多くの人をまとめて拾えるリレーから順に選ぶ（貪欲な集合被覆）。上限が先に来たとき
 * 宛先ゼロの人が残らないよう、1 本目を要る人の数を 2 本目より優先して数える。
 */
export function planReads(filters: Filter[], context: ReadPlanContext): ReadPart[] {
  const needs = collectNeeds(filters, context);
  const assigned = new Map<Need, Set<string>>();
  const quota = (need: Need) => Math.min(RELAYS_PER_AUTHOR, need.candidates.length);
  const chosen: string[] = [];

  while (chosen.length < MAX_READ_RELAYS) {
    const score = new Map<string, { first: number; total: number }>();
    for (const need of needs) {
      const got = assigned.get(need);
      if ((got?.size ?? 0) >= quota(need)) {
        continue;
      }
      for (const relay of need.candidates) {
        if (!got?.has(relay)) {
          const entry = score.get(relay) ?? { first: 0, total: 0 };
          entry.total += 1;
          if (!got?.size) {
            entry.first += 1;
          }
          score.set(relay, entry);
        }
      }
    }
    const best = [...score.entries()].sort(
      ([ra, a], [rb, b]) => b.first - a.first || b.total - a.total || ra.localeCompare(rb)
    )[0];
    if (!best) {
      break;
    }
    const [relay] = best;
    chosen.push(relay);
    for (const need of needs) {
      const got = assigned.get(need) ?? new Set<string>();
      if (got.size < quota(need) && need.candidates.includes(relay)) {
        got.add(relay);
        assigned.set(need, got);
      }
    }
  }

  return chosen.map((relay) => ({ relay, filters: filtersFor(relay, filters, assigned) }));
}

function routedField(filter: Filter): RoutedField | undefined {
  if (filter.ids !== undefined) {
    return undefined;
  }
  if (filter.kinds?.length && filter.kinds.every(isReplaceableKind)) {
    return undefined;
  }
  for (const field of ['authors', '#p', '#e', '#q'] as const) {
    if (filterValues(filter, field).length > 0) {
      return field;
    }
  }
  return undefined;
}

function filterValues(filter: Filter, field: RoutedField): string[] {
  const values = (filter as Record<string, unknown>)[field];
  return Array.isArray(values) ? values.filter((v): v is string => typeof v === 'string') : [];
}

function collectNeeds(filters: Filter[], context: ReadPlanContext): Need[] {
  const needs: Need[] = [];
  filters.forEach((filter, filterIndex) => {
    const field = routedField(filter);
    if (!field) {
      return;
    }
    for (const value of filterValues(filter, field)) {
      const relays = relaysFor(field, value, context);
      if (relays.some(context.isDefault)) {
        continue;
      }
      const candidates = relays.filter(context.canReach);
      if (candidates.length > 0) {
        needs.push({ filterIndex, field, value, candidates });
      }
    }
  });
  return needs;
}

/** 著者の投稿は write、その人宛て（言及・返信・リアクション）は read に載る。 */
function relaysFor(field: RoutedField, value: string, context: ReadPlanContext): string[] {
  if (field === 'authors') {
    return context.lists.get(value)?.write ?? [];
  }
  if (field === '#p') {
    return context.lists.get(value)?.read ?? [];
  }
  const author = context.referencedAuthors.get(value);
  return author ? (context.lists.get(author)?.read ?? []) : [];
}

function filtersFor(
  relay: string,
  filters: Filter[],
  assigned: ReadonlyMap<Need, ReadonlySet<string>>
): Filter[] {
  const valuesByFilter = new Map<number, { field: RoutedField; values: string[] }>();
  for (const [need, relays] of assigned) {
    if (!relays.has(relay)) {
      continue;
    }
    const entry = valuesByFilter.get(need.filterIndex) ?? { field: need.field, values: [] };
    entry.values.push(need.value);
    valuesByFilter.set(need.filterIndex, entry);
  }
  return [...valuesByFilter.entries()]
    .sort(([a], [b]) => a - b)
    .map(([index, { field, values }]) => ({ ...filters[index], [field]: values }) as Filter);
}
