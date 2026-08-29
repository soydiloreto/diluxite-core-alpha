import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { FreshnessBadge } from './FreshnessBadge';
import type { Freshness } from '../../api';

const DAY = 86_400;

const freshness = (over: Partial<Freshness>): Freshness => ({
  level: 'aging',
  ageSeconds: 70 * DAY,
  expectedIntervalSeconds: 30 * DAY,
  usingPrior: false,
  intervalsElapsed: 2.3,
  ...over,
});

describe('FreshnessBadge', () => {
  // The two silences are the feature, not gaps in it.
  it('renders nothing for a note within its own rhythm', () => {
    const { container } = render(<FreshnessBadge freshness={freshness({ level: 'fresh' })} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing when no cadence was measured at all', () => {
    // Absent is NOT fresh. A reassuring badge here would be the UI claiming
    // something the system never checked.
    const { container } = render(<FreshnessBadge freshness={undefined} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows the measured rhythm when there is one', () => {
    render(<FreshnessBadge freshness={freshness({ level: 'aging' })} />);
    const badge = screen.getByTestId('freshness-badge');
    expect(badge.textContent).toContain('70');
    expect(badge.textContent).toContain('30');
  });

  it('does not quote a rhythm it never measured', () => {
    render(
      <FreshnessBadge
        freshness={freshness({ level: 'stale', usingPrior: true, ageSeconds: 400 * DAY })}
      />,
    );
    const badge = screen.getByTestId('freshness-badge');
    expect(badge.textContent).toContain('400');
    // The prior's number is an assumption about shape, not about this note,
    // so it is not presented as this note's habit.
    expect(badge.textContent).not.toContain('30');
    expect(badge.getAttribute('title')).toMatch(/not measured|sin medir|not enough|suficiente/i);
  });

  it('marks a stale note more loudly than an ageing one', () => {
    const { rerender } = render(<FreshnessBadge freshness={freshness({ level: 'aging' })} />);
    const aging = screen.getByTestId('freshness-badge').className;
    rerender(<FreshnessBadge freshness={freshness({ level: 'stale' })} />);
    const stale = screen.getByTestId('freshness-badge').className;
    expect(aging).not.toBe(stale);
  });
});
