import { useSyncExternalStore } from 'react';

import { player, type PlayerSnapshot } from './engine.ts';

/**
 * Read the engine's state.
 *
 * useSyncExternalStore rather than context-with-state on purpose: the engine
 * is the source of truth and outlives every component, so React subscribes to
 * it rather than owning it. That is also what keeps the two audio elements
 * safe from Strict Mode.
 */
export const usePlayer = (): PlayerSnapshot =>
  useSyncExternalStore(player.subscribe, player.getSnapshot, player.getSnapshot);

export { player };
