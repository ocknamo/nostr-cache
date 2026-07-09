// @vitest-environment jsdom
import { render, screen } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import ConnectionBar from './ConnectionBar.svelte';

describe('ConnectionBar', () => {
  it('shows the localized label for the current status', () => {
    render(ConnectionBar, {
      url: 'ws://x',
      status: 'connected',
      onConnect: vi.fn(),
      onDisconnect: vi.fn(),
    });
    expect(screen.getByText('接続済み')).toBeInTheDocument();
  });

  it('seeds the input with the url prop', () => {
    render(ConnectionBar, {
      url: 'wss://relay.example.com',
      status: 'disconnected',
      onConnect: vi.fn(),
      onDisconnect: vi.fn(),
    });
    expect(screen.getByLabelText('リレーURL')).toHaveValue('wss://relay.example.com');
  });

  it('submits the trimmed input url via onConnect', async () => {
    const user = userEvent.setup();
    const onConnect = vi.fn();
    render(ConnectionBar, {
      url: '',
      status: 'disconnected',
      onConnect,
      onDisconnect: vi.fn(),
    });

    await user.type(screen.getByLabelText('リレーURL'), '  ws://local  ');
    await user.click(screen.getByRole('button', { name: '接続' }));

    expect(onConnect).toHaveBeenCalledWith('ws://local');
  });

  it('does not call onConnect when the url is blank', async () => {
    const user = userEvent.setup();
    const onConnect = vi.fn();
    render(ConnectionBar, {
      url: '   ',
      status: 'disconnected',
      onConnect,
      onDisconnect: vi.fn(),
    });

    await user.click(screen.getByRole('button', { name: '接続' }));
    expect(onConnect).not.toHaveBeenCalled();
  });

  it('shows a disconnect button that fires onDisconnect when connected', async () => {
    const user = userEvent.setup();
    const onDisconnect = vi.fn();
    render(ConnectionBar, {
      url: 'ws://x',
      status: 'connected',
      onConnect: vi.fn(),
      onDisconnect,
    });

    await user.click(screen.getByRole('button', { name: '切断' }));
    expect(onDisconnect).toHaveBeenCalledOnce();
  });

  it('disables the connect button while connecting', () => {
    render(ConnectionBar, {
      url: 'ws://x',
      status: 'connecting',
      onConnect: vi.fn(),
      onDisconnect: vi.fn(),
    });
    expect(screen.getByRole('button', { name: '接続' })).toBeDisabled();
  });
});
