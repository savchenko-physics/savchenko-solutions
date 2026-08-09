// Guards the click-to-play video embed (js/video-embed.js + views/default/video_embed.ejs).
//
// Why this exists: the partial renders two different things through one class. A normal
// video becomes a <button data-video-id> that swaps itself for a YouTube iframe. A video
// whose owner has switched embedding off — the LEX News segment on the homepage does
// exactly this — becomes a plain <a> to youtube.com carrying no id, because an iframe
// there renders "Playback on other websites has been disabled by the video owner" and
// nothing on our side can override it.
//
// The first version of the handler matched .video-embed-trigger alone and called
// preventDefault() before checking for an id, so clicking the homepage card did
// absolutely nothing: no navigation, no player, no error. That is the regression these
// tests exist to catch.
//
// Not covered: real browser layout, autoplay policy, and whether YouTube accepts the
// embed. There is no headless browser in the test setup, so the module is driven against
// a hand-written DOM stub — enough to assert which element it acts on and what it builds.

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const MODULE = path.join(__dirname, '..', 'js', 'video-embed.js');

// Minimal stand-ins for the two DOM APIs the module touches: a delegated click
// listener on document, and document.createElement for the iframe it builds.
function loadModule() {
  const created = [];
  let handler = null;
  global.document = {
    addEventListener(type, fn) { if (type === 'click') handler = fn; },
    createElement(tag) {
      const el = { tag, style: {}, setAttribute(k, v) { this[k] = v; } };
      created.push(el);
      return el;
    },
  };
  delete require.cache[require.resolve(MODULE)];
  require(MODULE);
  assert.ok(handler, 'module must register a click listener');
  return { created, click: (target) => {
    let prevented = false;
    handler({ target, preventDefault() { prevented = true; } });
    return prevented;
  } };
}

// `attrs` omitting data-video-id models the link-out card.
function makeTrigger(attrs, className = 'video-embed-trigger') {
  const el = {
    attrs,
    className,
    getAttribute(n) { return Object.prototype.hasOwnProperty.call(this.attrs, n) ? this.attrs[n] : null; },
    closest(selector) {
      if (!selector.includes('.' + this.className)) return null;
      if (selector.includes('[data-video-id]') && !this.attrs['data-video-id']) return null;
      return this;
    },
    parentNode: {
      classList: { added: [], add(c) { this.added.push(c); } },
      replaceChild(next, old) { this.replaced = [next, old]; },
    },
  };
  return el;
}

test('a playable video is replaced in place by a nocookie iframe', () => {
  const { created, click } = loadModule();
  const trigger = makeTrigger({ 'data-video-id': 'd-x7Lk-mfTs', 'aria-label': 'How to use the site' });

  assert.strictEqual(click(trigger), true, 'the click must be intercepted');
  const iframe = created[0];
  assert.strictEqual(iframe.tag, 'iframe');
  assert.strictEqual(
    iframe.src,
    'https://www.youtube-nocookie.com/embed/d-x7Lk-mfTs?autoplay=1&rel=0&modestbranding=1'
  );
  assert.strictEqual(iframe.allowFullscreen, true);
  assert.strictEqual(iframe.title, 'How to use the site');
  assert.deepStrictEqual(trigger.parentNode.classList.added, ['is-playing']);
  assert.strictEqual(trigger.parentNode.replaced[1], trigger, 'the poster must be the element replaced');
});

test('a start offset reaches the player', () => {
  const { created, click } = loadModule();
  click(makeTrigger({ 'data-video-id': 'abc123', 'data-video-start': '42' }));
  assert.ok(created[0].src.endsWith('&start=42'), created[0].src);
});

test('a nonsense start offset is dropped rather than passed through', () => {
  const { created, click } = loadModule();
  click(makeTrigger({ 'data-video-id': 'abc123', 'data-video-start': 'soon' }));
  assert.ok(!created[0].src.includes('start='), created[0].src);
});

test('the video id is escaped into the URL', () => {
  const { created, click } = loadModule();
  click(makeTrigger({ 'data-video-id': 'a b&c' }));
  assert.ok(created[0].src.includes('/embed/a%20b%26c'), created[0].src);
});

test('a click elsewhere on the page is left alone', () => {
  const { created, click } = loadModule();
  const elsewhere = { closest: () => null };
  assert.strictEqual(click(elsewhere), false);
  assert.strictEqual(created.length, 0);
});

// ── The regression: a card that cannot be embedded must still be clickable ────

test('the link-out card is not intercepted, so the browser still follows it', () => {
  const { created, click } = loadModule();
  // The <a> the partial renders for videoEmbeddable: false. It carries neither the
  // trigger class nor a video id — belt and braces, because an older cached copy of
  // this script matched the class alone and swallowed the click for a week.
  const card = makeTrigger({ 'aria-label': 'Real impact — Watch on YouTube' }, 'video-embed-link');

  assert.strictEqual(click(card), false,
    'preventDefault() on a link-out card leaves it doing nothing at all');
  assert.strictEqual(created.length, 0, 'no iframe may be built for a non-embeddable video');
  assert.strictEqual(card.parentNode.replaced, undefined, 'the card must stay on the page');
});

test('an empty data-video-id counts as no id, not as a video called ""', () => {
  const { created, click } = loadModule();
  assert.strictEqual(click(makeTrigger({ 'data-video-id': '' })), false);
  assert.strictEqual(created.length, 0);
});
