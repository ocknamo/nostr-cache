/**
 * The action bar under a card — the mechanism, without any actions.
 *
 * The widget deliberately ships none of its own. It is a read-only viewer: it
 * holds no key, signs nothing and never writes to a relay, so "reply",
 * "repost", "like" and "zap" belong to the embedding page — the side that has a
 * signer. What lives here is the plumbing that lets that page put its own
 * buttons under every card and hear about the presses:
 *
 * - a declarative list (`id` + `label`, plus an optional `icon`), so an iframe
 *   embed can describe its buttons in a query parameter — a URL cannot carry a
 *   function;
 * - an optional `onSelect`, for JS callers that can hand one over;
 * - a `nostr-timeline:action` DOM event on the custom element, for everyone
 *   else. The iframe host page forwards the same payload to the parent window.
 *
 * Everything is parsed defensively, the way the other attributes are: a broken
 * entry costs its own button rather than the whole bar.
 */

import type { NostrEvent } from '@nostr-cache/shared';
import type { ValidationStatus } from './validation-status.ts';

/** What a press hands back to whoever is listening. */
export interface EventActionContext {
  /** The event whose card the pressed button sits under. */
  event: NostrEvent;
  /**
   * The relay's signature verdict for that event, as of the press.
   *
   * The widget renders unverified events (faded, and without the ✓), so a
   * button that signs, reposts or pays on the reader's behalf must be able to
   * see that `validated` is not what it got. Anything other than `validated` —
   * including `undefined`, meaning the verdict has not arrived — is an event
   * the relay has not vouched for.
   */
  status?: ValidationStatus;
}

/** One button in a card's action bar. */
export interface EventAction {
  /**
   * Stable identifier, unique within the bar. This is what a listener switches
   * on — it travels in the DOM event and in the iframe's `postMessage`, where
   * the handler function cannot.
   */
  id: string;
  /**
   * The button's accessible name (and its `title`). Required even when an
   * `icon` is given: an icon-only button with no name is unusable by a screen
   * reader.
   */
  label: string;
  /**
   * What to render instead of the label.
   *
   * Plain text by default — an emoji or an arrow, one character or two. With
   * Material Symbols turned on it is a ligature name from
   * <https://fonts.google.com/icons> (`favorite`, `repeat`, `bolt`) instead;
   * see {@link EventAction.iconType} for mixing the two.
   */
  icon?: string;
  /**
   * How to read `icon`, overriding the widget's `material-icons` setting for
   * this one button — `text` keeps an emoji literal in an otherwise Material
   * bar, `material` asks for a ligature in a bar that is otherwise text.
   */
  iconType?: 'text' | 'material';
  /**
   * Show the label next to the icon rather than only to a screen reader.
   * Without an `icon` the label is the button, so this changes nothing there.
   */
  showLabel?: boolean;
  /** Renders the button greyed out and unpressable. */
  disabled?: boolean;
  /**
   * Called on a press, when the caller is able to pass a function (i.e. not
   * from an HTML attribute). The DOM event fires either way.
   */
  onSelect?: (context: EventActionContext) => void;
}

/**
 * Cap on buttons per card. Not a tuning knob — the bar is one row that has to
 * survive a narrow embed, and a list long enough to wrap is a mistake rather
 * than a design.
 */
export const MAX_ACTIONS = 8;

/** DOM event a press fires on the custom element (bubbling and composed). */
export const ACTION_EVENT = 'nostr-timeline:action';

/**
 * `detail` of {@link ACTION_EVENT}.
 *
 * Deliberately JSON-serializable: the iframe host page posts the very same
 * object to the embedding window, so the two paths carry identical payloads.
 */
export interface EventActionDetail {
  /** `id` of the pressed action. */
  actionId: string;
  /** The event whose card it sits under. */
  event: NostrEvent;
  /** The relay's verdict for it — see {@link EventActionContext.status}. */
  status?: ValidationStatus;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Read the raw list out of whatever the caller had to offer. */
function toEntries(value: unknown): unknown[] {
  if (value === null || value === undefined) {
    return [];
  }
  if (Array.isArray(value)) {
    return value;
  }
  // An HTML attribute or a query parameter: JSON, like `filters`.
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === '') {
      return [];
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      console.warn(`[nostr-timeline] Ignoring malformed actions JSON: ${value}`);
      return [];
    }
    if (!Array.isArray(parsed)) {
      console.warn('[nostr-timeline] Ignoring actions: expected a JSON array.');
      return [];
    }
    return parsed;
  }
  console.warn('[nostr-timeline] Ignoring actions: expected an array or a JSON array string.');
  return [];
}

function toAction(entry: unknown): EventAction | undefined {
  if (!isRecord(entry)) {
    return undefined;
  }
  const { id, label, icon, iconType, showLabel, disabled, onSelect } = entry;
  // Both are load-bearing: `id` is the only thing a listener can identify the
  // press by, and `label` is the button's accessible name.
  if (typeof id !== 'string' || id.trim() === '') {
    return undefined;
  }
  if (typeof label !== 'string' || label.trim() === '') {
    return undefined;
  }
  const action: EventAction = { id: id.trim(), label: label.trim() };
  if (typeof icon === 'string' && icon.trim() !== '') {
    action.icon = icon.trim();
  }
  if (iconType === 'text' || iconType === 'material') {
    action.iconType = iconType;
  }
  if (showLabel === true) {
    action.showLabel = true;
  }
  if (disabled === true) {
    action.disabled = true;
  }
  if (typeof onSelect === 'function') {
    action.onSelect = onSelect as (context: EventActionContext) => void;
  }
  return action;
}

/**
 * Turn the `actions` input — an array from JS, or a JSON array string from an
 * attribute or query parameter — into the list a card renders.
 *
 * Unusable entries are dropped with a warning rather than taking the bar down
 * with them, and duplicate ids keep the first: a second button answering to the
 * same id would be indistinguishable to the listener that receives the press.
 *
 * @param value Raw `actions` input
 * @returns The buttons to render; at most {@link MAX_ACTIONS}
 */
export function normalizeActions(value: unknown): EventAction[] {
  const actions: EventAction[] = [];
  const seen = new Set<string>();

  for (const entry of toEntries(value)) {
    const action = toAction(entry);
    if (!action) {
      console.warn('[nostr-timeline] Ignoring action without a usable id and label.');
      continue;
    }
    if (seen.has(action.id)) {
      console.warn(`[nostr-timeline] Ignoring duplicate action id: ${action.id}`);
      continue;
    }
    if (actions.length >= MAX_ACTIONS) {
      // Stop rather than skip: everything after this is dropped too, and one
      // line says that better than a warning per remaining entry.
      console.warn(
        `[nostr-timeline] Ignoring actions after "${action.id}": at most ${MAX_ACTIONS} fit in a row.`
      );
      break;
    }
    seen.add(action.id);
    actions.push(action);
  }

  return actions;
}

/**
 * Announce a press on the custom element, so a page that could not pass an
 * `onSelect` (an HTML embed, or an iframe) still hears about it.
 *
 * Shared by both elements rather than written twice — they are meant to differ
 * only in how their filters are decided.
 *
 * @param host The custom element itself (`$host()`)
 * @param action The pressed action
 * @param context The card the press came from
 */
export function dispatchActionEvent(
  host: EventTarget,
  action: EventAction,
  context: EventActionContext
): void {
  const detail: EventActionDetail = {
    actionId: action.id,
    event: context.event,
    status: context.status,
  };
  host.dispatchEvent(
    new CustomEvent<EventActionDetail>(ACTION_EVENT, {
      detail,
      // Out of the shadow root and up the embedding page's tree: a listener
      // will usually sit on the element, but delegating from an ancestor has to
      // work too.
      bubbles: true,
      composed: true,
    })
  );
}
