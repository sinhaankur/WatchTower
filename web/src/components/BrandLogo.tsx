type BrandLogoProps = {
  size?: 'sm' | 'md' | 'lg';
  withLabel?: boolean;
};

const SIZE_CLASSES: Record<NonNullable<BrandLogoProps['size']>, string> = {
  sm: 'w-7 h-7 text-xs',
  md: 'w-8 h-8 text-sm',
  lg: 'w-10 h-10 text-base',
};

export default function BrandLogo({ size = 'md', withLabel = false }: BrandLogoProps) {
  return (
    <div className="flex items-center gap-2">
      <div className={`wt-logo ${SIZE_CLASSES[size]} rounded-md font-semibold flex items-center justify-center tracking-tight`}>
        Wt
      </div>
      {withLabel && <span className="text-sm font-semibold tracking-tight">WatchTower</span>}
    </div>
  );
}
