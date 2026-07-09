// @vitest-environment jsdom
import { render, screen } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import FilterForm from './FilterForm.svelte';

describe('FilterForm', () => {
  it('submits the default simple filter (kinds:[1], limit:100)', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(FilterForm, { onSubmit });

    await user.click(screen.getByRole('button', { name: 'フィルタを適用' }));

    expect(onSubmit).toHaveBeenCalledWith({ kinds: [1], limit: 100 });
  });

  it('parses edited simple fields into a filter', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(FilterForm, { onSubmit });

    const kinds = screen.getByPlaceholderText('1, 30023');
    await user.clear(kinds);
    await user.type(kinds, '1, 7');

    await user.click(screen.getByRole('button', { name: 'フィルタを適用' }));

    expect(onSubmit).toHaveBeenCalledWith({ kinds: [1, 7], limit: 100 });
  });

  it('shows a validation error and does not submit on an invalid kind', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(FilterForm, { onSubmit });

    const kinds = screen.getByPlaceholderText('1, 30023');
    await user.clear(kinds);
    await user.type(kinds, 'abc');
    await user.click(screen.getByRole('button', { name: 'フィルタを適用' }));

    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent('Invalid kind: "abc"');
  });

  it('submits a parsed JSON filter in JSON mode', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(FilterForm, { onSubmit });

    await user.click(screen.getByLabelText('JSON'));
    const textarea = screen.getByRole('textbox');
    await user.clear(textarea);
    // paste inserts the text literally (user.type treats `{` / `[` as special).
    await user.click(textarea);
    await user.paste('{"kinds":[7],"limit":5}');

    await user.click(screen.getByRole('button', { name: 'フィルタを適用' }));

    expect(onSubmit).toHaveBeenCalledWith({ kinds: [7], limit: 5 });
  });

  it('reports invalid JSON via an alert', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(FilterForm, { onSubmit });

    await user.click(screen.getByLabelText('JSON'));
    const textarea = screen.getByRole('textbox');
    await user.clear(textarea);
    await user.click(textarea);
    await user.paste('not json');
    await user.click(screen.getByRole('button', { name: 'フィルタを適用' }));

    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toBeInTheDocument();
  });
});
