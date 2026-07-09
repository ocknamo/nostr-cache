// @vitest-environment jsdom
import { render, screen } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import PostForm from './PostForm.svelte';

describe('PostForm', () => {
  it('keeps the submit button disabled until non-whitespace content is entered', async () => {
    const user = userEvent.setup();
    render(PostForm, { onPost: vi.fn() });

    const button = screen.getByRole('button', { name: '投稿' });
    expect(button).toBeDisabled();

    const textarea = screen.getByRole('textbox');
    await user.type(textarea, '   ');
    expect(button).toBeDisabled();

    await user.type(textarea, 'hello');
    expect(button).toBeEnabled();
  });

  it('calls onPost with trimmed content and clears the field on success', async () => {
    const user = userEvent.setup();
    const onPost = vi.fn().mockResolvedValue(true);
    render(PostForm, { onPost });

    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
    await user.type(textarea, '  gm nostr  ');
    await user.click(screen.getByRole('button', { name: '投稿' }));

    expect(onPost).toHaveBeenCalledWith('gm nostr');
    expect(textarea.value).toBe('');
  });

  it('preserves the content when onPost reports failure', async () => {
    const user = userEvent.setup();
    const onPost = vi.fn().mockResolvedValue(false);
    render(PostForm, { onPost });

    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
    await user.type(textarea, 'keep me');
    await user.click(screen.getByRole('button', { name: '投稿' }));

    expect(onPost).toHaveBeenCalledWith('keep me');
    expect(textarea.value).toBe('keep me');
  });

  it('disables the button when the disabled prop is set', () => {
    render(PostForm, { onPost: vi.fn(), disabled: true });
    expect(screen.getByRole('button')).toBeDisabled();
  });
});
