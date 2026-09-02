import { describe, it, expect } from 'vitest';
import { isCollision, COLLISION_DISTANCE } from './collisions';

describe('isCollision', () => {
  it('far apart AND saying different things is a collision', () => {
    expect(isCollision(0.8, '3%', '15%')).toBe(true);
  });

  it('far apart but AGREEING is corroboration, not a collision', () => {
    // Two areas that reached the same number from different places is the
    // best thing that can happen to a memory, not a warning.
    expect(isCollision(0.9, '3%', '3%')).toBe(false);
    expect(isCollision(0.9, ' OK ', 'ok')).toBe(false);
  });

  it('close together is the same subject disagreeing — not this check', () => {
    // A disagreement everybody can see is a normal editorial problem. The
    // expensive one is the word doing two jobs without anybody noticing.
    expect(isCollision(0.1, '3%', '15%')).toBe(false);
  });

  it('an incomparable pair is not a collision', () => {
    // No vectors means "we cannot compare these", which is not the same as
    // "they are close" and definitely not the same as "they collide".
    expect(isCollision(null, '3%', '15%')).toBe(false);
  });

  it('the threshold is the boundary, and it is generous on purpose', () => {
    expect(isCollision(COLLISION_DISTANCE, 'a', 'b')).toBe(true);
    expect(isCollision(COLLISION_DISTANCE - 0.01, 'a', 'b')).toBe(false);
  });
});
