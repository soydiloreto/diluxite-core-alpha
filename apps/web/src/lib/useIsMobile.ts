import { useEffect, useState } from 'react';

/** Tailwind `md` breakpoint = 768px. Stay in sync if Tailwind config moves. */
const MOBILE_QUERY = '(max-width: 767px)';

/**
 * Reactive mobile detector. Returns true while the viewport matches the
 * Tailwind `< md` breakpoint and updates on resize / device rotation.
 *
 * Use it for behavioural decisions that CSS alone can't express
 * (auto-closing the sidebar when opening a note, choosing a default
 * preview layout, etc.). For purely visual changes prefer Tailwind's
 * `md:` utilities — they're cheaper and don't bounce the React tree.
 */
export function useIsMobile(): boolean {
  const [matches, setMatches] = useState(
    () => typeof window !== 'undefined' && window.matchMedia(MOBILE_QUERY).matches,
  );

  useEffect(() => {
    const mq = window.matchMedia(MOBILE_QUERY);
    const onChange = (e: MediaQueryListEvent) => setMatches(e.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  return matches;
}
