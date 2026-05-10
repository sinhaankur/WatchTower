import { cn } from '@/lib/utils';

type Mood = 'idle' | 'thinking' | 'sleepy' | 'curious';

type MascotProps = {
  /** Visual size in px (square box). Defaults to 96. */
  size?: number;
  /** Subtle expression variant — currently only affects which animation
   *  loops. Faces are the same to keep the asset simple. */
  mood?: Mood;
  className?: string;
};

const MOOD_CLASS: Record<Mood, string> = {
  idle:     'anim-pulse-soft',
  thinking: 'anim-fade-in',
  sleepy:   '',  // no animation — for "off" / paused contexts
  curious:  'anim-pulse-soft',
};

/**
 * The WatchTower owl keeper.
 *
 * Used for friendly empty states, the new RouteErrorBoundary fallback,
 * loading screens, and 404s — places where the alternative is a wall
 * of text or a dead-feeling page. Originally drawn for WatchTower; not
 * derived from any existing character.
 *
 * Usage:
 *   <Mascot size={120} mood="thinking" />
 *   <Mascot size={48} className="opacity-70" />
 */
export function Mascot({ size = 96, mood = 'idle', className }: MascotProps) {
  return (
    <img
      src="/wt-owl.svg"
      alt="WatchTower mascot"
      width={size}
      height={Math.round(size * (144 / 128))}
      className={cn('select-none', MOOD_CLASS[mood], className)}
      draggable={false}
    />
  );
}

export default Mascot;
