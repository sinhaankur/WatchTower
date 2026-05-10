import { useEffect, useRef, useState } from 'react';

/**
 * Animate a number from its previous value to `target` over `duration` ms.
 *
 * Uses requestAnimationFrame so it stays smooth and pauses with the tab.
 * `prefers-reduced-motion` short-circuits to the final value immediately.
 *
 * Designed for dashboard stat counters where the visual feedback ("the
 * number went up!") is the point. Don't use it for values that need to
 * stay readable mid-flight (e.g. monetary balances).
 */
export function useCountUp(target: number, duration = 600): number {
  const [displayed, setDisplayed] = useState(target);
  const startRef = useRef(target);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    const reduced =
      typeof window !== 'undefined'
      && window.matchMedia
      && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduced || !Number.isFinite(target) || duration <= 0) {
      setDisplayed(target);
      return;
    }

    const from = startRef.current;
    const to = target;
    if (from === to) return;

    const t0 = performance.now();
    const step = (t: number) => {
      const elapsed = Math.min(1, (t - t0) / duration);
      // ease-out-cubic — feels punchy at the start, settles smoothly
      const eased = 1 - Math.pow(1 - elapsed, 3);
      const current = Math.round(from + (to - from) * eased);
      setDisplayed(current);
      if (elapsed < 1) {
        rafRef.current = requestAnimationFrame(step);
      } else {
        startRef.current = to;
      }
    };

    rafRef.current = requestAnimationFrame(step);
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      startRef.current = displayed;
    };
    // We deliberately don't depend on `displayed` — that would restart the
    // animation on every frame.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target, duration]);

  return displayed;
}

export default useCountUp;
