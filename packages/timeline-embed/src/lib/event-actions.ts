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
   * Who was pressed, when the press was on a person rather than on a button:
   * the author's avatar or display name (see {@link AuthorAction}). Absent for
   * a button in the action bar.
   *
   * Redundant with `event.pubkey` on a card — and deliberately so. The same
   * affordance belongs on a reactor's row, on a quoted note's header and on a
   * `nostr:` mention in a body, where the person pressed is *not* the author of
   * the event that came with them. A listener that reads this field keeps
   * working when it lands there; one that reads `event.pubkey` would quietly
   * navigate to the wrong person.
   */
  pubkey?: string;
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
 * The author's avatar and display name as a press target.
 *
 * Same `id` + `label` contract as a button, and the same `nostr-timeline:action`
 * event, because it is the same mechanism: a card in a timeline still has
 * nowhere of its own to navigate to, and the page that knows where its profile
 * screen lives is the one holding the router.
 *
 * The id is the embedder's rather than one this module reserves. A fixed
 * `"author"` would be indistinguishable from a button an embedder had already
 * declared under that id — {@link normalizeActions} dedupes within the declared
 * list, and cannot see an id the widget injects afterwards.
 *
 * Its presence is also what makes the avatar and the name pressable at all:
 * without it they stay the plain image and text they have always been, so an
 * embed that wires no listener never shows a target that does nothing.
 */
export interface AuthorAction {
  /** Travels as `actionId`, exactly as a button's does. */
  id: string;
  /**
   * What pressing does, as the accessible name of the target — the widget
   * cannot know where the embedder's id leads, so it cannot write this itself.
   * The author's name is appended for a screen reader moving through a list of
   * cards.
   */
  label: string;
}

/**
 * Shown when `author-action-label` is not set. Names the overwhelmingly likely
 * destination; an embedder sending the press somewhere else has to say so, the
 * same way a button's `label` is required rather than guessed.
 */
export const DEFAULT_AUTHOR_LABEL = 'プロフィールを開く';

/**
 * A quoted note's card as a press target, so a reader can reach the post it
 * stands for.
 *
 * Same `id` + `label` contract as {@link AuthorAction}, and the same event. It
 * exists because a quote is the one post the widget draws that has no way out
 * of its own: a timeline card carries the embedder's action bar, and the card
 * a reader opened is already the post they are on, but a `nostr:` quote inside
 * a body is somebody else's post with nothing to press.
 */
export interface NoteAction {
  /** Travels as `actionId`, exactly as a button's does. */
  id: string;
  /**
   * What pressing does: the words on the target, and its accessible name. The
   * quoted author's name is appended to the latter, so a body holding several
   * quotes does not announce them all identically.
   */
  label: string;
}

/**
 * Shown when `note-action-label` is not set — see {@link DEFAULT_AUTHOR_LABEL}
 * for why there is a default at all.
 */
export const DEFAULT_NOTE_LABEL = '投稿を開く';

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
  /**
   * Who was pressed, on an author press — see {@link EventActionContext.pubkey}
   * for why this is here rather than left to `event.pubkey`. Absent for a
   * button in the action bar.
   */
  pubkey?: string;
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
 * Read a press target out of the two attributes that declare it.
 *
 * Only the id is required: it is what a listener switches on, and without it
 * there is nothing to report. The label has a default because a press target
 * cannot go unnamed — see {@link DEFAULT_AUTHOR_LABEL}.
 */
function normalizePressAction(
  attribute: string,
  fallback: string,
  id: unknown,
  label: unknown
): { id: string; label: string } | undefined {
  if (id === undefined || id === null || (typeof id === 'string' && id.trim() === '')) {
    // Silently: an absent attribute is the default, not a mistake — it is every
    // embed written before this existed.
    return undefined;
  }
  if (typeof id !== 'string') {
    // Anything else is a property set from JS with the wrong type, which would
    // otherwise take the press away without saying so.
    console.warn(`[nostr-timeline] Ignoring ${attribute}: expected a string id, got ${typeof id}.`);
    return undefined;
  }
  const name = typeof label === 'string' && label.trim() !== '' ? label.trim() : undefined;
  return { id: id.trim(), label: name ?? fallback };
}

/** The author press, from `author-action` / `author-action-label`. */
export function normalizeAuthorAction(id: unknown, label?: unknown): AuthorAction | undefined {
  return normalizePressAction('author-action', DEFAULT_AUTHOR_LABEL, id, label);
}

/** The quoted-note press, from `note-action` / `note-action-label`. */
export function normalizeNoteAction(id: unknown, label?: unknown): NoteAction | undefined {
  return normalizePressAction('note-action', DEFAULT_NOTE_LABEL, id, label);
}

/**
 * Announce a press on the custom element, so a page that could not pass an
 * `onSelect` (an HTML embed, or an iframe) still hears about it.
 *
 * Shared by both elements rather than written twice — they are meant to differ
 * only in how their filters are decided.
 *
 * Takes only the id of what was pressed, so an author press travels the same
 * path as a button one: to a listener the two differ by the `actionId` the
 * embedder chose for each, plus the `pubkey` an author press carries.
 */
export function dispatchActionEvent(
  host: EventTarget,
  action: Pick<EventAction, 'id'>,
  context: EventActionContext
): void {
  const detail: EventActionDetail = {
    actionId: action.id,
    event: context.event,
    status: context.status,
    // Spread rather than assigned, so a button press carries no `pubkey` key at
    // all: `'pubkey' in detail` is then the check for which kind of press this
    // was, on both sides of the iframe boundary (structured cloning keeps a key
    // whose value is undefined). `status` is assigned unconditionally because
    // it means something either way — an absent verdict is a verdict that has
    // not arrived.
    ...(context.pubkey ? { pubkey: context.pubkey } : {}),
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
