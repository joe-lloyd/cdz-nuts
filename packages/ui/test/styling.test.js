// Does the CSS still find the markup it was written for?
//
// This exists because of a real regression: the sidebar nav is styled through
// `#nav button`, and the React port rendered `<a>` inside a `<nav>` with no id.
// Every rule missed, so the icons rendered at their intrinsic size and the
// sidebar was several screens tall. Nothing failed -- the build was green, the
// types were sound, every view rendered, and the app was simply broken to look
// at.
//
// Styling is not fully testable without a browser, but the specific failure
// here is: the stylesheet names hooks the markup no longer provides. That is
// checkable, so it is checked.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import path from 'node:path';

import { indexHtml, staticFiles } from '../index.js';

// The SOURCE stylesheet, not the built one. Minified CSS packs selectors up
// against the previous rule's closing brace, so `}#tip{` gives a parser no
// boundary to anchor on -- the first version of this test read the build and
// silently skipped every selector that followed a `}`.
const css = readFileSync(path.resolve(process.cwd(), 'src/styles/app.css'), 'utf8');
// The shipped bundle: React writes these ids, so they appear as string
// literals there rather than in the document.
const shipped = readFileSync(staticFiles['/app.js'].file, 'utf8') + readFileSync(indexHtml, 'utf8');

/** Id selectors in the CSS, minus hex colours, which share the `#` prefix. */
function idSelectors(source) {
  const ids = new Set();
  // Comments first: a note explaining why a rule was deleted should not read
  // as a selector. This caught itself -- the comment left behind when #tip was
  // removed said "#tip", and the test then demanded markup for it.
  source = source.replace(/\/\*[\s\S]*?\*\//g, '');
  // Only where `#` starts a selector token — after whitespace, a comma, or a
  // combinator — so `color: #ff57d9` is never mistaken for `#ff57d9 {}`.
  for (const [, id] of source.matchAll(/(?:^|[\s,>+~}{])#([a-zA-Z][\w-]*)/gm)) {
    if (!/^[0-9a-fA-F]{3,8}$/.test(id)) ids.add(id);
  }
  return [...ids];
}

test('every id the stylesheet targets is rendered by the app', () => {
  const missing = idSelectors(css).filter((id) => !shipped.includes(`"${id}"`) && !shipped.includes(`'${id}'`));
  assert.deepEqual(missing, [],
    `the stylesheet styles #${missing.join(', #')}, which nothing renders — those rules are dead and whatever they styled is unstyled`);
});

test('the nav is styled for the element it actually uses', () => {
  // Links, not buttons: cmd-click, middle-click and "open in new tab" all work,
  // and a screen reader announces navigation rather than an action. The CSS has
  // to know that.
  assert.match(css, /#nav a\s*\{/, '#nav renders anchors, so the CSS must target them');
  assert.match(css, /#nav a svg\s*\{/, 'without this the icons render at their intrinsic size');
  assert.match(css, /#nav a\.on\s*\{/, 'the active tab needs its own state');
});
