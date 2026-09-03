import { describe, expect, test } from 'vitest';

import { pathFromLegacyHash, TABS } from './routes.ts';

describe('pathFromLegacyHash', () => {
  test('migrates every tab the old router served', () => {
    for (const tab of Object.keys(TABS)) {
      expect(pathFromLegacyHash(`#${tab}`)).toBe(`/${tab}`);
    }
  });

  test('migrates detail routes', () => {
    expect(pathFromLegacyHash('#album/4aawyAB9vmqN3uQ7FjRGTy')).toBe('/album/4aawyAB9vmqN3uQ7FjRGTy');
    expect(pathFromLegacyHash('#artist/1Xyo4u8uXC1ZmMpatF05PJ')).toBe('/artist/1Xyo4u8uXC1ZmMpatF05PJ');
    expect(pathFromLegacyHash('#playlist/37i9dQZF1DXcBWIGoYBM5M')).toBe('/playlist/37i9dQZF1DXcBWIGoYBM5M');
  });

  test('migrates stations, whose seed is free text rather than an id', () => {
    expect(pathFromLegacyHash('#radio/artist/Converge')).toBe('/radio/artist/Converge');
    expect(pathFromLegacyHash('#radio/tag/downtempo')).toBe('/radio/tag/downtempo');
    // Percent-encoding must survive untouched -- decoding here would produce a
    // path the router then re-encodes differently.
    expect(pathFromLegacyHash('#radio/artist/Bonobo%20%26%20Arooj')).toBe('/radio/artist/Bonobo%20%26%20Arooj');
  });

  test('leaves in-page anchors alone', () => {
    // The skip link is href="#main". Rewriting that to /main would send the
    // keyboard user to the overview instead of to the content.
    expect(pathFromLegacyHash('#main')).toBeNull();
    expect(pathFromLegacyHash('')).toBeNull();
    expect(pathFromLegacyHash('#')).toBeNull();
  });

  test('leaves unrecognised hashes alone rather than guessing', () => {
    // An unknown hash used to fall through to the overview silently. Inventing
    // a path for it would turn that quiet fallback into a hard 404.
    expect(pathFromLegacyHash('#nonsense')).toBeNull();
    expect(pathFromLegacyHash('#album')).toBeNull();
  });
});
