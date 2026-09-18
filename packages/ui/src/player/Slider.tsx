/**
 * The one range input in the player.
 *
 * Both sliders are linear controls: the handle sits where the value is, and
 * the distance you drag is the change you get. Volume only *sounds*
 * non-linear because the engine squares the position into a gain, and that
 * curve belongs there, next to the audio, rather than in a control that would
 * then be a different control from the one next to it.
 *
 * Keeping them one component is what stops the scrubber quietly inheriting a
 * curve meant for loudness.
 */
export function Slider({
  value,
  onValue,
  label,
  className,
  disabled = false,
  steps = 1000,
}: {
  /** 0 to 1, always. Callers scale to whatever they measure. */
  value: number;
  onValue: (value: number) => void;
  label: string;
  className?: string;
  disabled?: boolean;
  /** Resolution of the underlying input; the value stays a 0-1 fraction. */
  steps?: number;
}) {
  return (
    <input
      type="range"
      min={0}
      max={steps}
      step={1}
      className={className}
      disabled={disabled}
      value={Math.round(clamp01(value) * steps)}
      aria-label={label}
      onChange={(event) => onValue(Number(event.target.value) / steps)}
    />
  );
}

const clamp01 = (n: number) => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);
