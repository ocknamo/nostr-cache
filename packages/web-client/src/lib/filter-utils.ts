import type { Filter } from '@nostr-cache/shared';

/**
 * Raw text values from the filter form. Empty strings mean "not specified".
 */
export interface FilterFormValues {
  kinds?: string;
  authors?: string;
  ids?: string;
  limit?: string;
  since?: string;
  until?: string;
}

export type FilterParseResult = { ok: true; filter: Filter } | { ok: false; error: string };

/**
 * Split a comma/whitespace separated list into trimmed non-empty tokens.
 */
function splitList(value: string): string[] {
  return value
    .split(/[\s,]+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
}

function parseIntegerField(value: string, field: string): number | { error: string } {
  const parsed = Number(value.trim());
  if (!Number.isInteger(parsed) || parsed < 0) {
    return { error: `${field} must be a non-negative integer` };
  }
  return parsed;
}

/**
 * Build a NIP-01 Filter from form values.
 *
 * Empty fields are omitted entirely (an explicit empty array would match
 * nothing on strict relays).
 */
export function buildFilter(values: FilterFormValues): FilterParseResult {
  const filter: Filter = {};

  if (values.kinds && values.kinds.trim().length > 0) {
    const kinds: number[] = [];
    for (const token of splitList(values.kinds)) {
      const kind = Number(token);
      if (!Number.isInteger(kind) || kind < 0) {
        return { ok: false, error: `Invalid kind: "${token}"` };
      }
      kinds.push(kind);
    }
    filter.kinds = kinds;
  }

  if (values.authors && values.authors.trim().length > 0) {
    filter.authors = splitList(values.authors);
  }

  if (values.ids && values.ids.trim().length > 0) {
    filter.ids = splitList(values.ids);
  }

  for (const field of ['limit', 'since', 'until'] as const) {
    const raw = values[field];
    if (raw && raw.trim().length > 0) {
      const parsed = parseIntegerField(raw, field);
      if (typeof parsed !== 'number') {
        return { ok: false, error: parsed.error };
      }
      filter[field] = parsed;
    }
  }

  return { ok: true, filter };
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isNumberArray(value: unknown): value is number[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'number');
}

/**
 * Parse and validate a raw JSON filter (advanced form input).
 *
 * Known NIP-01 fields are type-checked; unknown non-tag fields are allowed
 * (e.g. relay-specific extensions) as long as the value is a JSON object.
 */
export function parseFilterJson(raw: string): FilterParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return { ok: false, error: `Invalid JSON: ${(error as Error).message}` };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: 'Filter must be a JSON object' };
  }

  const candidate = parsed as Record<string, unknown>;
  for (const field of ['ids', 'authors'] as const) {
    if (candidate[field] !== undefined && !isStringArray(candidate[field])) {
      return { ok: false, error: `"${field}" must be an array of strings` };
    }
  }
  if (candidate.kinds !== undefined && !isNumberArray(candidate.kinds)) {
    return { ok: false, error: '"kinds" must be an array of numbers' };
  }
  for (const field of ['since', 'until', 'limit'] as const) {
    if (candidate[field] !== undefined && typeof candidate[field] !== 'number') {
      return { ok: false, error: `"${field}" must be a number` };
    }
  }
  for (const key of Object.keys(candidate)) {
    if (key.startsWith('#') && !isStringArray(candidate[key])) {
      return { ok: false, error: `"${key}" must be an array of strings` };
    }
  }

  return { ok: true, filter: candidate as Filter };
}
