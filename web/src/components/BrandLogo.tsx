type BrandLogoProps = {
  size?: 'sm' | 'md' | 'lg';
  withLabel?: boolean;
  subtitle?: string;
};

const SIZE_CLASSES: Record<NonNullable<BrandLogoProps['size']>, { box: string; dot: string }> = {
  sm: { box: 'w-7 h-7', dot: 'w-1.5 h-1.5' },
  md: { box: 'w-8 h-8', dot: 'w-2 h-2' },
  lg: { box: 'w-10 h-10', dot: 'w-2 h-2' },
};

export default function BrandLogo({ size = 'md', withLabel = false, subtitle = 'Control Plane' }: BrandLogoProps) {
  const classes = SIZE_CLASSES[size];

  return (
    <div className="flex items-center gap-2">
      <div
        className={`${classes.box} rounded-md border-2 border-slate-900 bg-amber-200 flex items-center justify-center shadow-[2px_2px_0_0_#0f172a]`}
        aria-hidden
      >
        <span className="text-xs font-extrabold tracking-tight text-destructive">Wt</span>
      </div>
      {withLabel && (
        <div className="leading-tight">
          <p className="text-sm font-semibold tracking-tight text-foreground">WatchTower</p>
          <p className="text-xs text-muted-foreground">{subtitle}</p>
        </div>
      )}
    </div>
  );
}
