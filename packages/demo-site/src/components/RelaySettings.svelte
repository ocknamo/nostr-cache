<script lang="ts">
  interface Props {
    /** Draft values, owned by the parent so applying is an explicit action. */
    relays: string;
    kinds: string;
    limit: string;
    /** True while the relay is restarting, so the form cannot be double-submitted. */
    busy?: boolean;
    onApply: () => void;
  }

  let {
    relays = $bindable(),
    kinds = $bindable(),
    limit = $bindable(),
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
  <button type="submit" disabled={busy}>{busy ? '再起動中…' : '適用してリレーを再起動'}</button>
</form>

<style>
  form {
    display: grid;
    /* minmax(0, …) rather than plain `1fr`: an <input> without an explicit
       width reports a ~20-character intrinsic minimum, which an auto-minimum
       track has to honour — that is what pushed the whole page wider than the
       viewport on phones. */
    grid-template-columns: minmax(0, 1fr) 120px 120px auto;
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

  @media (max-width: 720px) {
    form {
      grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
    }

    .wide {
      grid-column: 1 / -1;
    }

    /* Full width, so the long label does not wrap inside a half-width button. */
    button {
      grid-column: 1 / -1;
    }
  }
</style>
