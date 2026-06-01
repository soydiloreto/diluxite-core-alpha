import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CollabBanner } from './CollabBanner';

describe('CollabBanner', () => {
  it('renders nothing when collab is off (status=null)', () => {
    const { container } = render(<CollabBanner status={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing when happily connected (silent default)', () => {
    const { container } = render(<CollabBanner status="connected" />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows the amber "connecting" message while the WS handshakes', () => {
    render(<CollabBanner status="connecting" />);
    const banner = screen.getByTestId('collab-banner');
    expect(banner).toHaveAttribute('data-status', 'connecting');
    expect(banner.textContent ?? '').toMatch(/conectando/i);
    expect(banner.className).toContain('amber');
  });

  it('shows the red "disconnected" message on network drop', () => {
    render(<CollabBanner status="disconnected" />);
    const banner = screen.getByTestId('collab-banner');
    expect(banner).toHaveAttribute('data-status', 'disconnected');
    expect(banner.textContent ?? '').toMatch(/desconectado/i);
    expect(banner.textContent ?? '').toMatch(/edición está deshabilitada/i);
    expect(banner.className).toContain('red');
  });

  it('shows the "session expired" message with refresh instruction', () => {
    // Distinct from `disconnected` because reconnecting will never help —
    // the user has to refresh and log in again.
    render(<CollabBanner status="auth-expired" />);
    const banner = screen.getByTestId('collab-banner');
    expect(banner).toHaveAttribute('data-status', 'auth-expired');
    expect(banner.textContent ?? '').toMatch(/sesión expiró/i);
    expect(banner.textContent ?? '').toMatch(/refrescá la página/i);
    expect(banner.className).toContain('red');
  });
});
