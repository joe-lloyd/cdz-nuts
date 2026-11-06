import { describe, expect, test } from 'vitest';

import { describeQuality } from './primitives.tsx';

describe('a quality label in plain words', () => {
  test('names the format and bitrate of a lossy copy', () => {
    expect(describeQuality('high', 'MP3 320')).toBe('MP3 at 320 kbps, lossy');
    expect(describeQuality('standard', '128k')).toBe('128 kbps, lossy');
  });

  test('says a lossless copy is lossless', () => {
    expect(describeQuality('lossless', 'FLAC')).toBe('FLAC, lossless');
    expect(describeQuality('hires', '24/96')).toBe('24-bit 96 kHz, hi-res lossless');
  });
});
