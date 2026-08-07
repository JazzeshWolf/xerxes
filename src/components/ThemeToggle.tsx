import { useTheme, cycleMode, MODE_ICON, MODE_LABEL } from "../lib/theme";

/** Cycles System → Light → Dark. Sized to sit beside the Refresh button. */
export function ThemeToggle({ className = "" }: { className?: string }) {
  const { mode } = useTheme();
  return (
    <button
      onClick={cycleMode}
      className={`shrink-0 w-7 h-7 grid place-items-center text-xs rounded-full border border-white/15 text-white/70 active:bg-white/[0.08] ${className}`}
      title={`Theme: ${MODE_LABEL[mode]} — tap to change`}
      aria-label={`Theme: ${MODE_LABEL[mode]}. Tap to change.`}
    >
      {MODE_ICON[mode]}
    </button>
  );
}
