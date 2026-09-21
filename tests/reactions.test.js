// The reaction vocabulary: the six Unicode emoji and the community's own set (js/reactions.js,
// img/emoji/*.svg), as the chat and the solution comments use it.
//
// Until 2026-09 the six were kept by hand in four places (messages.js, brainstorm.js, twice in
// views/messages.ejs) and every reaction column was VARCHAR(8). The community set came out of
// reading the two community chats and the solution comments ("юный джедай", "Печеньки!!!",
// "подгон под ответ", the errors in the book...). What this file guards against:
//   - the lists drifting apart again, or a template growing its own copy;
//   - a :shortcode: longer than the column, which fails inside the INSERT (migration 052);
//   - an SVG in img/emoji that is live markup: it is served from our own origin with no CSP,
//     which is why chat uploads refuse SVG outright (messages.js);
//   - retiring or deleting an emoji and stranding the reactions people already left.
//
// Not covered, because there is no test database or browser here: the route SQL, the SSE
// broadcast, and the picker layout. Those were checked against a scratch copy of the schema in
// a real browser before release.
//
// The closing block holds the "must never block a real person" invariants: a reaction that is
// already stored can always be seen and always be taken back.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const EMOJI_DIR = path.join(ROOT, 'img', 'emoji');
const Reactions = require('../js/reactions');
const { resolveVar, toPx } = require('../scripts/lib/design-tokens');
const { ALLOWED_REACTIONS: BRAINSTORM_REACTIONS } = require('../brainstorm');

// The picker's Unicode row since 2026-09-13, most used first (👍 ❤️ 🙏 🔥 😂 🤔), and the two it
// retired: in four months 👎 was never used and 😢 three times. The retired brainstorm room
// keeps its old six.
const SIX = ['\u{1F44D}', '\u{2764}\u{FE0F}', '\u{1F64F}', '\u{1F525}', '\u{1F602}', '\u{1F914}'];
const RETIRED = ['\u{1F44E}', '\u{1F622}'];
const BRAINSTORM_SIX = ['\u{1F44D}', '\u{1F44E}', '\u{2764}\u{FE0F}', '\u{1F602}', '\u{1F622}', '\u{1F914}'];

// Append-only: every community id that has ever shipped. Removing one from the registry
// would strand the reactions that carry it.
const SHIPPED = [
    ':jedi:', ':etalon:', ':match:', ':cookies:', ':zachetka:', ':precious:',
    ':podgon:', ':trap:', ':ai:', ':grob:', ':cat:', ':horse:',
    // Premium, 2026-09-15 (lastProblem.js).
    ':kvant:', ':errata:', ':ammeter:', ':dino:', ':cyborgs:', ':libra:', ':laplace:',
    ':perpetuum:', ':n2000:', ':last:',
];

// The drawing rules, shared with the mini app's art (tests/last-problem.test.js).
const { assertSvgArt } = require('../scripts/lib/svg-art');

const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8');

function between(source, start, end) {
    const from = source.indexOf(start);
    assert.ok(from >= 0, `${start} not found`);
    const to = source.indexOf(end, from + start.length);
    assert.ok(to > from, `${end} not found after ${start}`);
    return source.slice(from, to);
}

// ── The vocabulary ───────────────────────────────────────────────────────────────────────

test('the Unicode row is the six people use, and the retired two are no longer offered', () => {
    assert.deepEqual([...Reactions.STANDARD], SIX);
    assert.deepEqual([...Reactions.RETIRED_STANDARD], RETIRED);
    assert.deepEqual(Reactions.pickerIds().slice(0, 6), SIX);
    for (const value of RETIRED) assert.ok(!Reactions.pickerIds().includes(value), value);
    // The brainstorm room keeps what it offered, and every one of those is still known here.
    assert.deepEqual([...BRAINSTORM_REACTIONS], BRAINSTORM_SIX);
    for (const value of BRAINSTORM_REACTIONS) assert.equal(Reactions.isKnownReaction(value), true, value);
});

test('community ids are shortcodes that fit the column', () => {
    const ids = Reactions.CUSTOM.map((entry) => entry.id);
    assert.equal(new Set(ids).size, ids.length, 'ids are unique');
    for (const id of ids) {
        assert.match(id, /^:[a-z0-9_]{2,30}:$/);
        assert.ok(id.length <= 32, `${id} is longer than VARCHAR(32)`);
        assert.ok(![...SIX, ...RETIRED].includes(id));
    }
});

test('every community emoji has a Russian and an English name', () => {
    for (const entry of Reactions.CUSTOM) {
        for (const name of [entry.ru, entry.en]) {
            assert.equal(typeof name, 'string');
            assert.ok(name.length >= 1 && name.length <= 40, `${entry.id}: ${name}`);
            assert.doesNotMatch(name, /[<>&"$]/, `${entry.id}: ${name}`);
        }
        assert.doesNotMatch(entry.en, /[Ѐ-ӿ]/, `${entry.id} has Cyrillic in its English name`);
        assert.equal(Reactions.reactionTitle(entry.id, 'ru'), entry.ru);
        assert.equal(Reactions.reactionTitle(entry.id, 'en'), entry.en);
    }
    assert.equal(Reactions.reactionTitle('\u{1F44D}', 'ru'), '');
});

test('the picker is the six, the free community emoji, then the premium ones on offer', () => {
    const winter = new Date('2026-12-01T00:00:00Z');
    const picker = Reactions.pickerIds({ now: winter });
    // Most used first, left to right (measured 2026-09-13; see js/reactions.js), then the premium
    // row: what can be bought today (no Libra out of season, no trophies, no perpetual motion).
    assert.deepEqual(picker, [
        ...SIX,
        ':ai:', ':etalon:', ':match:', ':trap:', ':podgon:', ':cookies:',
        ':zachetka:', ':grob:', ':jedi:', ':horse:', ':precious:', ':cat:',
        ':kvant:', ':errata:', ':ammeter:', ':dino:', ':cyborgs:', ':laplace:',
    ]);
    assert.equal(new Set(picker).size, picker.length);
    // Four rows of six until premium reactions added one row of their own (checked on a 390px
    // phone in Firefox, 2026-09-15). A sixth row would no longer fit above a message on a phone.
    assert.ok(Reactions.pickerIds({ now: new Date('2026-10-01T00:00:00Z'), owned: [':n2000:', ':last:'] }).length <= 30,
        'a picker taller than five rows stops fitting a phone');
    assert.deepEqual(picker.slice(6, 18), Reactions.CUSTOM.filter((e) => !e.retired && !Reactions.isPremium(e.id)).map((e) => e.id));

    const registry = Reactions.create({
        standard: SIX,
        custom: [{ id: ':old:', ru: 'Старый', en: 'Old', retired: true }, { id: ':new:', ru: 'Новый', en: 'New' }],
    });
    assert.deepEqual(registry.pickerIds(), [...SIX, ':new:']);
});

// ── The files ────────────────────────────────────────────────────────────────────────────

test('every community emoji has its SVG, and every SVG belongs to one', () => {
    const files = fs.readdirSync(EMOJI_DIR);
    const expected = Reactions.CUSTOM.map((entry) => Reactions.emojiFile(entry.id));
    assert.deepEqual([...files].sort(), [...expected].sort());
    assert.equal(Reactions.emojiFile(':jedi:'), 'jedi.svg');
    assert.equal(Reactions.emojiFile('\u{1F44D}'), null);
    assert.equal(Reactions.emojiFile(':nope:'), null);
});

test('the emoji are inert, small, flat drawings in the palette', () => {
    for (const file of fs.readdirSync(EMOJI_DIR)) {
        assertSvgArt(fs.readFileSync(path.join(EMOJI_DIR, file), 'utf8'), `img/emoji/${file}`);
    }
});

test('emojiUrls versions every community emoji, retired ones included', () => {
    const urls = Reactions.emojiUrls((p) => `${p}?v=abc`);
    assert.deepEqual(Object.keys(urls).sort(), Reactions.CUSTOM.map((e) => e.id).sort());
    assert.equal(urls[':jedi:'], '/img/emoji/jedi.svg?v=abc');
    assert.equal(Reactions.emojiUrls()[':cat:'], '/img/emoji/cat.svg');
});

// ── The allow-list ───────────────────────────────────────────────────────────────────────

test('reactionAction: add, remove, or reject', () => {
    const registry = Reactions.create({
        standard: SIX,
        retiredStandard: RETIRED,
        custom: [{ id: ':live:', ru: 'Живой', en: 'Live' }, { id: ':gone:', ru: 'Ушёл', en: 'Gone', retired: true }],
    });
    assert.equal(registry.reactionAction('\u{1F44D}', false), 'add');
    assert.equal(registry.reactionAction('\u{1F44D}', true), 'remove');
    assert.equal(registry.reactionAction('\u{1F44E}', false), 'reject', 'a retired Unicode reaction cannot be newly left');
    assert.equal(registry.reactionAction('\u{1F44E}', true), 'remove', 'but it can always be taken back');
    assert.equal(Reactions.create({ standard: SIX, custom: [] }).reactionAction('\u{1F44E}', true), 'reject', 'unknown without the retired list');
    assert.equal(registry.reactionAction(':live:', false), 'add');
    assert.equal(registry.reactionAction(':live:', true), 'remove');
    assert.equal(registry.reactionAction(':gone:', false), 'reject', 'a retired emoji cannot be newly left');
    assert.equal(registry.reactionAction(':gone:', true), 'remove', 'but it can always be taken back');
    assert.equal(registry.reactionAction(':nope:', false), 'reject');
    assert.equal(registry.reactionAction(':nope:', true), 'reject');
});

test('near misses and hostile values are not reactions', () => {
    const values = [
        ':JEDI:', ' :jedi:', ':jedi: ', 'jedi', ':jedi', 'jedi:', '::jedi::', ':jedi:\n',
        '\u{2764}', '\u{1F44D}\u{1F3FB}', '\u{1F44D}\u{1F44D}',
        '', null, undefined, 42, true, [':jedi:'], { emoji: ':jedi:' }, ['\u{1F44D}'],
        '__proto__', 'constructor', 'toString', 'hasOwnProperty', ':__proto__:', ':constructor:',
        'x'.repeat(10000), '<img src=x onerror=alert(1)>', ':jedi:<script>',
    ];
    for (const value of values) {
        assert.equal(Reactions.isKnownReaction(value), false, JSON.stringify(value));
        assert.equal(Reactions.reactionAction(value, false), 'reject', JSON.stringify(value));
        assert.equal(Reactions.reactionAction(value, true), 'reject', JSON.stringify(value));
    }
});

// ── Rendering ────────────────────────────────────────────────────────────────────────────

test('glyphHTML draws a community emoji as an <img> and everything else as escaped text', () => {
    const urls = { ':jedi:': '/img/emoji/jedi.svg?v=1' };
    assert.equal(
        Reactions.glyphHTML(':jedi:', urls, 'ru'),
        '<img class="rx-img" src="/img/emoji/jedi.svg?v=1" alt="Юный джедай" title="Юный джедай" draggable="false">'
    );
    assert.match(Reactions.glyphHTML(':jedi:', urls, 'en'), /alt="Young Jedi"/);
    assert.equal(Reactions.glyphHTML('\u{1F44D}', urls, 'ru'), '\u{1F44D}');
    // No URL for it (a stale page, a missing file): the shortcode as text, still clickable.
    assert.equal(Reactions.glyphHTML(':cat:', urls, 'ru'), ':cat:');
    assert.equal(Reactions.glyphHTML('<b>"x"</b>', urls, 'ru'), '&lt;b&gt;&quot;x&quot;&lt;/b&gt;');
    assert.equal(Reactions.glyphHTML(':jedi:', { ':jedi:': '"><script>' }, 'ru').includes('<script>'), false);

    const tricky = Reactions.create({ standard: SIX, custom: [{ id: ':q:', ru: 'a"<b>&', en: "it's" }] });
    assert.match(tricky.glyphHTML(':q:', { ':q:': '/q.svg' }, 'ru'), /alt="a&quot;&lt;b&gt;&amp;"/);
    assert.match(tricky.glyphHTML(':q:', { ':q:': '/q.svg' }, 'en'), /title="it&#39;s"/);
});

test('the prototype chain is not a lookup table', () => {
    const inherited = Object.create({ ':jedi:': '/evil.svg' });
    assert.equal(Reactions.glyphHTML(':jedi:', inherited, 'en'), ':jedi:');
    assert.equal(Reactions.glyphHTML('__proto__', { __proto__: { x: 1 } }, 'en'), '__proto__');
});

// ── Wiring ───────────────────────────────────────────────────────────────────────────────

test('the chat and comment routes use the shared vocabulary, not their own list', () => {
    const messages = read('messages.js');
    const react = between(messages, "router.post('/:msgId(\\\\d+)/react'", "router.post('/:msgId(\\\\d+)/pin'");
    assert.match(react, /isKnownReaction\(/);
    assert.match(react, /reactionAction\(/);
    assert.match(react, /ON CONFLICT \(message_id, user_id, emoji\) DO NOTHING/);
    assert.doesNotMatch(react, /\\u\{1F44D\}|ALLOWED_REACTIONS/);

    const index = read('index.js');
    const comments = between(index, 'app.post("/api/solutions/comments/:commentId/reactions"', '// Add comment to solution');
    assert.match(comments, /Reactions\.isKnownReaction\(/);
    assert.match(comments, /Reactions\.reactionAction\(/);
    assert.doesNotMatch(index, /ALLOWED_REACTIONS/);
    assert.doesNotMatch(read('post.js'), /ALLOWED_REACTIONS|brainstormReactions/);
});

test('the templates load the registry and hold no copy of the list', () => {
    const chat = read('views', 'messages.ejs');
    assert.match(chat, /av\('\/js\/reactions\.js'\)/);
    assert.doesNotMatch(chat, /&#x1F44D;|REACTION_EMOJIS|\\u\{1F44D\}/);

    const post = read('views', 'solution_post.ejs');
    assert.match(post, /av\('\/js\/reactions\.js'\)/);
    assert.doesNotMatch(post, /brainstormReactions|REACTION_EMOJI\b/);
});

test('both pickers follow the design rules', () => {
    const rules = [
        [read('css', 'messages.css'), '    .msg-reaction-picker {'],
        [read('views', 'solution_post.ejs'), '        .comment-react-picker {'],
    ];
    for (const [source, selector] of rules) {
        const block = between(source, selector, '}');
        // Values are design tokens since the 2026-09 type unification; resolve them before judging.
        const radius = block.match(/border-radius:\s*([^;]+);/);
        assert.ok(radius && toPx(radius[1]) <= 8, `${selector.trim()} radius`);
        const shadow = block.match(/box-shadow:\s*([^;]+);/);
        assert.ok(shadow, `${selector.trim()} shadow`);
        assert.equal(resolveVar(shadow[1]).replace(/\s+/g, ''), '01px3pxrgba(0,0,0,0.08)', `${selector.trim()} shadow`);
        assert.doesNotMatch(block, /gradient/);
    }
});

test('migration 052 widens exactly the two reaction columns, and its rollback deletes by pattern', () => {
    const up = read('sql', 'migrations', '052_custom_reaction_emoji.sql');
    const altered = [...up.matchAll(/^ALTER TABLE (\w+) ALTER COLUMN emoji TYPE VARCHAR\((\d+)\);$/gm)].map((m) => [m[1], m[2]]);
    assert.deepEqual(altered, [['message_reactions', '32'], ['solution_comment_reactions', '32']]);
    assert.doesNotMatch(up.replace(/^--.*$/gm, ''), /brainstorm_reactions/);

    const down = read('sql', 'rollback', '052_custom_reaction_emoji_rollback.sql');
    const code = down.replace(/^--.*$/gm, '');
    const firstDelete = code.indexOf("DELETE FROM message_reactions WHERE emoji ~ '^:[a-z0-9_]+:$'");
    assert.ok(firstDelete >= 0);
    assert.ok(code.indexOf("DELETE FROM solution_comment_reactions WHERE emoji ~ '^:[a-z0-9_]+:$'") >= 0);
    assert.ok(firstDelete < code.indexOf('VARCHAR(8)'), 'rows go before the column narrows');

    // Every stored custom id matches the rollback's pattern, short ones included.
    for (const entry of Reactions.CUSTOM) assert.match(entry.id, /^:[a-z0-9_]+:$/);
});

// ── Must never block a real person ───────────────────────────────────────────────────────

test('every reaction stored in production can still be seen and taken back', () => {
    // message_reactions and solution_comment_reactions on 2026-09-13: thumbs-up 256, heart 178,
    // tears of joy 33, thinking 11, crying 3; thumbs-down was offered for four months and never
    // used. The brainstorm room's rows also hold thumbs-down and crying.
    const stored = ['\u{1F44D}', '\u{2764}\u{FE0F}', '\u{1F602}', '\u{1F914}', '\u{1F622}', '\u{1F44E}'];
    for (const value of stored) {
        assert.equal(Reactions.isKnownReaction(value), true, value);
        assert.equal(Reactions.reactionAction(value, true), 'remove', value);
        assert.equal(Reactions.glyphHTML(value, {}, 'ru'), value, 'a Unicode pill shows its emoji');
    }
    for (const value of SIX) assert.equal(Reactions.reactionAction(value, false), 'add', value);
    for (const value of RETIRED) assert.equal(Reactions.reactionAction(value, false), 'reject', value);
});

test('no shipped community emoji ever leaves the vocabulary', () => {
    for (const id of SHIPPED) {
        assert.equal(Reactions.isKnownReaction(id), true, `${id} was removed; set retired: true instead`);
        assert.ok(fs.existsSync(path.join(EMOJI_DIR, Reactions.emojiFile(id))), `${id} lost its SVG`);
    }
});

test('whatever is known can always be taken back', () => {
    for (const value of [...Reactions.STANDARD, ...Reactions.RETIRED_STANDARD, ...Reactions.CUSTOM.map((e) => e.id)]) {
        assert.equal(Reactions.reactionAction(value, true), 'remove', value);
    }
});

test('a stored value always renders as something to click, and rendering never throws', () => {
    const urls = Reactions.emojiUrls();
    const values = [...SIX, ...RETIRED, ...SHIPPED, ':retired_someday:', 'legacy', '\u{1F44D}\u{1F3FB}', 'x'.repeat(40)];
    for (const value of values) {
        for (const lang of ['ru', 'en', undefined]) {
            const html = Reactions.glyphHTML(value, urls, lang);
            assert.ok(typeof html === 'string' && html.length > 0, `${value} rendered as nothing`);
        }
    }
    for (const odd of [null, undefined, 42, {}, []]) {
        assert.doesNotThrow(() => Reactions.glyphHTML(odd, urls, 'ru'));
        assert.doesNotThrow(() => Reactions.glyphHTML(':jedi:', odd, 'ru'));
    }
});
