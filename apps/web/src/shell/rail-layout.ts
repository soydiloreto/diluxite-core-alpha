/**
 * How wide the activity rail is, and when.
 *
 * The bar was icons-only, which is fine once you know the icons and opaque
 * until then. It can now show its labels — the same rail behaviour the Dilux
 * AI Studio shell uses, minus the hamburger: the brand mark at the top is the
 * control, because that is the one button that was only decorative.
 *
 * Pure on purpose (no DOM, no storage) so the rule is testable on its own.
 */

export type RailMode = 'auto' | 'expanded' | 'collapsed';

/** Rail widths. Expanded fits a label; collapsed is the old icon strip. */
export const RAIL_EXPANDED_PX = 176;
export const RAIL_COLLAPSED_PX = 48;

const CYCLE: RailMode[] = ['auto', 'expanded', 'collapsed'];

/** auto → expanded → collapsed → auto. */
export function nextRailMode(m: RailMode): RailMode {
  return CYCLE[(CYCLE.indexOf(m) + 1) % CYCLE.length];
}

/**
 * Is the rail showing icons only?
 *
 * In `auto` — the default — it shows labels while you are at the top level and
 * shrinks to icons the moment a panel opens beside it, because at that point
 * the panel says where you are and two columns of words is one too many. The
 * other two modes are the user overriding that in either direction.
 */
export function railCollapsed(mode: RailMode, panelOpen: boolean): boolean {
  if (mode === 'collapsed') return true;
  if (mode === 'expanded') return false;
  return panelOpen;
}

export function railWidthPx(mode: RailMode, panelOpen: boolean): number {
  return railCollapsed(mode, panelOpen) ? RAIL_COLLAPSED_PX : RAIL_EXPANDED_PX;
}

/** What the toggle's tooltip says, so the three-state cycle is not a guess. */
export function railModeTitle(m: RailMode): string {
  switch (m) {
    case 'auto':
      return 'Menu: labels at the top level, icons while a panel is open';
    case 'expanded':
      return 'Menu: always show labels';
    case 'collapsed':
      return 'Menu: always icons only';
  }
}
