<script lang="ts">
  interface Props {
    onPost: (content: string) => Promise<void>;
    disabled?: boolean;
  }

  const { onPost, disabled = false }: Props = $props();

  let content = $state('');
  let posting = $state(false);

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    const trimmed = content.trim();
    if (trimmed.length === 0 || posting) {
      return;
    }
    posting = true;
    try {
      await onPost(trimmed);
      content = '';
    } finally {
      posting = false;
    }
  }
</script>

<form class="panel post-form" onsubmit={submit}>
  <h2>投稿 (kind 1)</h2>
  <textarea
    rows="3"
    bind:value={content}
    placeholder="いまどうしてる？ (ローカルリレーに保存されます)"
  ></textarea>
  <div class="actions">
    <button type="submit" disabled={disabled || posting || content.trim().length === 0}>
      {posting ? '投稿中…' : '投稿'}
    </button>
  </div>
</form>

<style>
  textarea {
    margin-bottom: 10px;
  }

  .actions {
    display: flex;
    justify-content: flex-end;
  }
</style>
