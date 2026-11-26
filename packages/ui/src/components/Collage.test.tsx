// A playlist's picture: up to four covers in one square, or its initial.

import { fireEvent, render } from '@testing-library/react';
import { expect, test } from 'vitest';
import { Collage, coversOf } from './primitives.tsx';

const square = (container: HTMLElement) => container.querySelector('.pl-collage')!;
const pictures = (container: HTMLElement) => [...container.querySelectorAll('.pl-collage img')] as HTMLImageElement[];

test('four albums make four quarters, from the art we host', () => {
  const { container } = render(<Collage name="Mine" covers={[
    { album_id: 'libalbum-a', image_url: null },
    { album_id: 'b2', image_url: 'https://cdn.example/b2.jpg' },
    { album_id: 'libalbum-c', image_url: null },
    { album_id: 'd4', image_url: null },
  ]} />);
  expect(square(container)).toHaveClass('n4');
  expect(pictures(container).map((img) => img.getAttribute('src'))).toEqual([
    '/img/local/libalbum-a.jpg', '/img/albums/b2.jpg', '/img/local/libalbum-c.jpg', '/img/albums/d4.jpg',
  ]);
});

test('fewer albums make fewer pieces, and none shows the initial', () => {
  const two = render(<Collage name="Mine" covers={[
    { album_id: 'a1', image_url: null }, { album_id: 'b2', image_url: null },
  ]} />);
  expect(square(two.container)).toHaveClass('n2');
  expect(pictures(two.container)).toHaveLength(2);

  const none = render(<Collage name="road trip" covers={[]} />);
  expect(square(none.container)).toHaveClass('empty-collage');
  expect(none.container).toHaveTextContent('R');
});

test('a cover we do not host falls back to the remote copy', () => {
  const { container } = render(<Collage name="Mine" covers={[
    { album_id: 'b2', image_url: 'https://cdn.example/b2.jpg' },
  ]} />);
  fireEvent.error(pictures(container)[0]!);
  expect(pictures(container)[0]).toHaveAttribute('src', 'https://cdn.example/b2.jpg');
});

test('a cover that cannot load at all drops out and the rest fill the square', () => {
  const { container } = render(<Collage name="Mine" covers={[
    { album_id: 'libalbum-a', image_url: null },
    { album_id: 'libalbum-b', image_url: null },
    { album_id: 'libalbum-c', image_url: null },
    { album_id: 'libalbum-d', image_url: null },
  ]} />);
  fireEvent.error(pictures(container)[1]!);
  expect(square(container)).toHaveClass('n3');
  expect(pictures(container).map((img) => img.getAttribute('src'))).not.toContain('/img/local/libalbum-b.jpg');
});

test('a Spotify playlist, which sends only image urls, still gets its covers', () => {
  expect(coversOf({ images: ['https://cdn.example/1.jpg'] })).toEqual([
    { album_id: null, image_url: 'https://cdn.example/1.jpg' },
  ]);
  expect(coversOf({ covers: [{ album_id: 'a', image_url: null }], images: ['/img/albums/a.jpg'] })).toEqual([
    { album_id: 'a', image_url: null },
  ]);
});
