import { clamp } from '../lib/format.ts';

export interface AudioOutput { id: string; name: string; builtInSpeakers: boolean }
interface OutputWindow extends Window { __homearpaOutputVolumeEnabled?: boolean }
const KEY = 'music-output-volumes-v1';
export const QUIET_GAIN = 0.25 ** 2;

/** Mac output profiles use native device identities, never microphone access or guessed names. */
export class OutputVolume {
  private output: AudioOutput | null = null;
  private profiles: Record<string, number> = Object.create(null);
  private revision = 0;

  constructor(
    private readonly apply: (gain: number) => void,
    private readonly changed: (name: string) => void,
    readonly legacyGain: number,
    private readonly activeGain: () => number | null = () => null,
  ) {
    try {
      const saved: unknown = JSON.parse(localStorage.getItem(KEY) ?? '{}');
      if (saved && typeof saved === 'object' && !Array.isArray(saved)) {
        for (const [id, gain] of Object.entries(saved)) {
          if (typeof gain === 'number' && Number.isFinite(gain) && gain >= 0 && gain <= 1) this.profiles[id] = gain;
        }
      }
    } catch { /* Missing or corrupt storage starts quietly. */ }
    this.apply(Math.min(legacyGain, QUIET_GAIN));
  }

  /** Called for both the initial native snapshot and subsequent Core Audio route events. */
  select(value: unknown, routeNotification = false) {
    ++this.revision;
    if (value === null) {
      if (this.output) this.changed('an unavailable output');
      this.output = null;
      this.apply(Math.min(this.legacyGain, QUIET_GAIN));
      return;
    }
    if (!value || typeof value !== 'object') return;
    const next = value as AudioOutput;
    if (typeof next.id !== 'string' || !next.id || typeof next.name !== 'string') return;
    if (next.id === this.output?.id) return;
    const previous = this.output;
    this.output = next;
    const saved = this.profiles[next.id];
    // Only migrate the old global level to positively identified built-in speakers.
    const gain = saved ?? (next.builtInSpeakers === true ? this.legacyGain : Math.min(this.legacyGain, QUIET_GAIN));
    // A delayed initial snapshot must not turn up audio already playing at
    // the quiet fallback. Loading playback counts too, before play() resolves.
    const activeGain = this.activeGain();
    if (previous || routeNotification || (activeGain !== null && gain > activeGain)) this.changed(next.name);
    this.apply(gain);
    this.remember(gain);
  }

  remember(gain: number) {
    if (!this.output) return;
    this.profiles[this.output.id] = clamp(gain, 0, 1);
    try { localStorage.setItem(KEY, JSON.stringify(this.profiles)); } catch { /* Storage can be denied. */ }
  }

  /** Native events win over an initial request that finishes after a route change. */
  async load() {
    const revision = this.revision;
    try {
      const response = await fetch('/api/desktop/audio-output', { cache: 'no-store' });
      if (!response.ok) return;
      const output: unknown = await response.json();
      if (revision === this.revision) this.select(output);
    } catch { /* Keep the quiet fallback if Core Audio cannot identify the output. */ }
  }
}

export function usesOutputVolume(): boolean {
  return (window as OutputWindow).__homearpaOutputVolumeEnabled === true;
}
