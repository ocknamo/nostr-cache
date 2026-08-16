// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeEvent } from '../test-fixtures.ts';
import {
  ACTION_EVENT,
  DEFAULT_AUTHOR_LABEL,
  type EventAction,
  type EventActionDetail,
  MAX_ACTIONS,
  dispatchActionEvent,
  normalizeActions,
  normalizeAuthorAction,
} from './event-actions.ts';

describe('normalizeActions', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** Silences the warnings the defensive paths emit, and lets a test read them. */
  function quiet(): ReturnType<typeof vi.spyOn> {
    return vi.spyOn(console, 'warn').mockImplementation(() => {});
  }

  it('reads a JSON array, the way an attribute or query parameter carries one', () => {
    expect(normalizeActions('[{"id":"reply","label":"返信","icon":"💬"}]')).toEqual([
      { id: 'reply', label: '返信', icon: '💬' },
    ]);
  });

  it('takes the array itself, keeping the handler a JS caller can pass', () => {
    const onSelect = vi.fn();

    const [action] = normalizeActions([{ id: 'zap', label: 'Zap', onSelect }]);

    expect(action.id).toBe('zap');
    expect(action.onSelect).toBe(onSelect);
  });

  it('treats nothing as no buttons', () => {
    expect(normalizeActions(undefined)).toEqual([]);
    expect(normalizeActions(null)).toEqual([]);
    expect(normalizeActions('')).toEqual([]);
    expect(normalizeActions('   ')).toEqual([]);
    expect(normalizeActions([])).toEqual([]);
  });

  it('drops an entry with no usable id or label rather than the whole bar', () => {
    quiet();

    expect(
      normalizeActions([
        { id: 'like', label: 'いいね' },
        // No id: nothing a listener could tell this press apart by.
        { label: 'なにか' },
        // No label: an icon-only button with no accessible name.
        { id: 'mystery', icon: '⚡' },
        { id: '  ', label: 'blank' },
        'not an object',
      ])
    ).toEqual([{ id: 'like', label: 'いいね' }]);
  });

  it('keeps the first of two buttons answering to the same id', () => {
    const warn = quiet();

    expect(
      normalizeActions([
        { id: 'like', label: 'いいね' },
        { id: 'like', label: 'べつのいいね' },
      ])
    ).toEqual([{ id: 'like', label: 'いいね' }]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('duplicate action id'));
  });

  it('caps the bar so it never has to wrap, warning once', () => {
    const warn = quiet();
    const many = Array.from({ length: MAX_ACTIONS + 3 }, (_, index) => ({
      id: `a${index}`,
      label: `action ${index}`,
    }));

    const kept = normalizeActions(many);

    expect(kept).toHaveLength(MAX_ACTIONS);
    expect(kept.at(-1)?.id).toBe(`a${MAX_ACTIONS - 1}`);
    // One line for the whole tail, not one per dropped entry.
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('survives broken JSON and JSON that is not an array', () => {
    const warn = quiet();

    expect(normalizeActions('[{"id":')).toEqual([]);
    expect(normalizeActions('{"id":"reply","label":"返信"}')).toEqual([]);
    expect(normalizeActions(42)).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(3);
  });

  it('keeps the per-button icon and label switches', () => {
    expect(
      normalizeActions(
        '[{"id":"like","label":"いいね","icon":"favorite","iconType":"material","showLabel":true}]'
      )
    ).toEqual([
      { id: 'like', label: 'いいね', icon: 'favorite', iconType: 'material', showLabel: true },
    ]);
  });

  it('ignores an iconType it does not know', () => {
    expect(
      normalizeActions('[{"id":"like","label":"いいね","icon":"♡","iconType":"svg"}]')
    ).toEqual([{ id: 'like', label: 'いいね', icon: '♡' }]);
  });

  it('carries only the fields a card renders from', () => {
    // Whatever else an embedder puts in the JSON stays out of the card: the
    // list is a rendering instruction, not a bag the widget passes through.
    expect(
      normalizeActions('[{"id":"reply","label":"返信","disabled":true,"href":"javascript:0"}]')
    ).toEqual([{ id: 'reply', label: '返信', disabled: true }]);
  });
});

describe('normalizeAuthorAction', () => {
  it('takes the id the embedder chose', () => {
    expect(normalizeAuthorAction('open-profile', 'プロフィール')).toEqual({
      id: 'open-profile',
      label: 'プロフィール',
    });
  });

  it('names the press when the embedder did not', () => {
    // A target with no accessible name is unusable by a screen reader, and the
    // widget cannot leave it out the way it leaves out a button nobody declared.
    expect(normalizeAuthorAction('open-profile')).toEqual({
      id: 'open-profile',
      label: DEFAULT_AUTHOR_LABEL,
    });
    expect(normalizeAuthorAction('open-profile', '   ')).toEqual({
      id: 'open-profile',
      label: DEFAULT_AUTHOR_LABEL,
    });
  });

  it('trims what an attribute picked up', () => {
    expect(normalizeAuthorAction(' open-profile ', ' 開く ')).toEqual({
      id: 'open-profile',
      label: '開く',
    });
  });

  it('asks for nothing without an id, which is the default', () => {
    // Silently: an absent attribute is not a mistake, it is every embed that
    // existed before this feature.
    for (const id of [undefined, '', '  ', 42, {}]) {
      expect(normalizeAuthorAction(id, 'プロフィール')).toBeUndefined();
    }
  });
});

describe('dispatchActionEvent', () => {
  it('announces the press on the element, escaping the shadow root', () => {
    const host = document.createElement('div');
    const parent = document.createElement('div');
    parent.appendChild(host);
    const event = makeEvent({ id: 'note-1' });
    const action: EventAction = { id: 'like', label: 'いいね' };
    const heard: EventActionDetail[] = [];

    // Listening on an ancestor rather than on the element itself: delegation
    // has to work, which is what `bubbles` and `composed` are for.
    parent.addEventListener(ACTION_EVENT, (received) => {
      heard.push((received as CustomEvent<EventActionDetail>).detail);
    });

    dispatchActionEvent(host, action, { event, status: 'pending' });

    // The verdict travels with the event: a button that signs or pays on the
    // reader's behalf has no other way to learn the card was never validated.
    expect(heard).toEqual([{ actionId: 'like', event, status: 'pending' }]);
    // The iframe host page posts this detail to the embedding window verbatim,
    // so it has to survive being serialized.
    expect(JSON.parse(JSON.stringify(heard[0]))).toEqual({
      actionId: 'like',
      event,
      status: 'pending',
    });
    // No key at all rather than one holding undefined: structured cloning keeps
    // the key, and the iframe path clones this object.
    expect('pubkey' in heard[0]).toBe(false);
  });

  it('carries the person an author press was on', () => {
    const host = document.createElement('div');
    const event = makeEvent({ id: 'note-1', pubkey: 'pk' });
    const heard: EventActionDetail[] = [];

    host.addEventListener(ACTION_EVENT, (received) => {
      heard.push((received as CustomEvent<EventActionDetail>).detail);
    });

    dispatchActionEvent(
      host,
      { id: 'open-profile' },
      { event, status: 'validated', pubkey: event.pubkey }
    );

    expect(heard).toEqual([{ actionId: 'open-profile', event, status: 'validated', pubkey: 'pk' }]);
  });
});
