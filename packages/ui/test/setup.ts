// Vitest + Testing Library setup. jsdom has no layout engine, so anything the
// UI does with geometry or media playback has to be stubbed per-test rather
// than globally -- see the player tests, which build their own fakes.
import '@testing-library/jest-dom/vitest';
