import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { PresenceAvatars } from './PresenceAvatars';

describe('PresenceAvatars', () => {
  it('renders nothing when there are no users', () => {
    const { container } = render(<PresenceAvatars users={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders one avatar per user with their initials', () => {
    render(
      <PresenceAvatars
        users={[
          { identity: 'p', name: 'Pablo' },
          { identity: 'm', name: 'Maria Garcia' },
        ]}
      />,
    );
    expect(screen.getByTitle('Pablo')).toBeInTheDocument();
    expect(screen.getByTitle('Pablo').textContent).toBe('PA');
    expect(screen.getByTitle('Maria Garcia')).toBeInTheDocument();
    expect(screen.getByTitle('Maria Garcia').textContent).toBe('MG');
  });

  it('marks the local user with "(vos)" in the title and dims them', () => {
    render(
      <PresenceAvatars
        users={[{ identity: 'me', name: 'Pablo', isSelf: true }]}
      />,
    );
    const self = screen.getByTitle('Pablo (vos)');
    expect(self).toBeInTheDocument();
    expect(self.getAttribute('data-self')).toBe('true');
  });

  it('collapses past `max` and shows a +N overflow chip', () => {
    const users = Array.from({ length: 8 }, (_, i) => ({
      identity: `u${i}`,
      name: `User ${i}`,
    }));
    render(<PresenceAvatars users={users} max={3} />);
    expect(screen.getByTitle('User 0')).toBeInTheDocument();
    expect(screen.getByTitle('User 1')).toBeInTheDocument();
    expect(screen.getByTitle('User 2')).toBeInTheDocument();
    expect(screen.queryByTitle('User 3')).not.toBeInTheDocument();
    expect(screen.getByTitle('+5 más')).toBeInTheDocument();
  });

  it('assigns the deterministic caret color as background', () => {
    render(<PresenceAvatars users={[{ identity: 'pablo', name: 'P' }]} />);
    const el = screen.getByTitle('P');
    const bg = (el as HTMLElement).style.backgroundColor;
    // jsdom may serialize `hsl(...)` either verbatim or as `rgb(...)` depending
    // on the version — either form proves we set a parsed color, which is the
    // contract we care about (a color was applied, not a literal CSS string).
    expect(bg.length).toBeGreaterThan(0);
    expect(/^(hsl|rgb)\(/.test(bg)).toBe(true);
  });
});
