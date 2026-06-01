/**
 * Deterministic per-user color for collaborative awareness.
 *
 * Why deterministic: when two users are editing the same note, their cursors
 * need stable colors across reloads — "you" always blue, "Maria" always
 * green. A random palette per session means a remote cursor can change
 * color when it reconnects, which is jarring and breaks pattern recognition.
 *
 * Hash the user id (or email if id is missing) to a hue in [0, 360) and pick
 * a fixed saturation + lightness range that is readable on both light and
 * dark themes.
 */

function fnv1a32(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h >>> 0;
}

export interface UserColorTokens {
  /** Solid HSL used for the caret line + name label background. */
  caret: string;
  /** Translucent HSL used to highlight the selected range. */
  selection: string;
  /** Hex-friendly contrast color for text drawn on top of `caret`. */
  label: string;
}

/**
 * Returns a stable color set for the given user identity. Pass anything
 * unique-per-user — id, email, username — and you'll get the same colors back.
 */
export function userColorTokens(identity: string): UserColorTokens {
  const hue = fnv1a32(identity) % 360;
  // 65% sat + 50% light renders cleanly on both vs and vs-dark themes
  // without smashing AA contrast for the label text.
  const caret = `hsl(${hue}, 65%, 50%)`;
  const selection = `hsla(${hue}, 65%, 50%, 0.25)`;
  // Label text: white over saturated mids works for the full hue wheel.
  const label = '#ffffff';
  return { caret, selection, label };
}
