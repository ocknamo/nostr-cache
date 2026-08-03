<script lang="ts">
  interface Props {
    /** Draft values, owned by the parent so applying is an explicit action. */
    relays: string;
    kinds: string;
    limit: string;
    /** Seconds a cached kind 0 is served for; empty or invalid = widget default. */
    profileFreshness: string;
    /** Render the cache/upstream badges in the embed examples. Applies at once. */
    debug: boolean;
    /** True while the relay is restarting, so the form cannot be double-submitted. */
    busy?: boolean;
    onApply: () => void;
  }

  let {
    relays = $bindable(),
    kinds = $bindable(),
    limit = $bindable(),
    profileFreshness = $bindable(),
    debug = $bindable(),
    busy = false,
    onApply,
  }: Props = $props();

  function submit(event: SubmitEvent) {
    event.preventDefault();
    onApply();
  }
</script>

<form onsubmit={submit}>
  <label class="wide">
    <span>上流リレー（カンマ区切り・空ならキャッシュのみ）</span>
    <input
      bind:value={relays}
      placeholder="wss://yabu.me"
      spellcheck="false"
      autocapitalize="off"
    />
  </label>
  <label>
    <span>kinds</span>
    <input bind:value={kinds} placeholder="1" spellcheck="false" />
  </label>
  <label>
    <span>limit</span>
    <input bind:value={limit} placeholder="50" inputmode="numeric" />
  </label>
  <label>
    <span title="プロフィール（kind 0）のキャッシュを上流に問い合わせ直さずに使う秒数">
      profile-freshness（秒）
    </span>
    <input bind:value={profileFreshness} placeholder="86400" inputmode="numeric" />
  </label>
  <!-- No "apply" needed: this one only decides whether a badge is drawn. -->
  <label class="check">
    <input type="checkbox" bind:checked={debug} />
    <span>debug（埋め込み例のバッジ・即時反映）</span>
  </label>
  <button type="submit" disabled={busy}>{busy ? '再起動中…' : '適用してリレーを再起動'}</button>
</form>

<style>
  form {
    display: grid;
    /* minmax(0, …) rather than plain `1fr`: an <input> without an explicit
       width reports a ~20-character intrinsic minimum, which an auto-minimum
       track has to honour — that is what pushed the whole page wider than the
       viewport on phones. */
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 10px;
    align-items: end;
  }

  label {
    display: flex;
    flex-direction: column;
    gap: 4px;
    font-size: 0.78rem;
    color: var(--muted);
    min-width: 0;
  }

  input {
    width: 100%;
  }

  /* The checkbox sits beside its label rather than under it, and must not be
     stretched to the column width the text inputs use. */
  .check {
    flex-direction: row;
    align-items: center;
    gap: 6px;
    /* Line the box up with the inputs on the same row, not with their labels. */
    padding-bottom: 8px;
  }

  .check input {
    width: auto;
  }

  /* The relay list and the submit button each take a row of their own, leaving
     the four short controls to share the row between them. */
  .wide,
  button {
    grid-column: 1 / -1;
  }

  @media (max-width: 720px) {
    form {
      grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
    }
  }
</style>
