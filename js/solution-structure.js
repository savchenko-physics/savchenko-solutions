/* solution-structure.js — the typeset shape of a solution, applied when it is displayed.
 *
 * Every post is written as markdown headings — "### Условие", "### Решение", "#### Ответ" —
 * but in nine spellings: with and without a colon (566 statements, 563 solutions, 193 answers
 * carry one), "Решение и Ответ:", "Альтернативное решение:", numbered answers, and 397 posts
 * that put the answer itself into the heading line ("#### Ответ: $v = 2$"). On the page they
 * all used to render as bare serif headings, so the answer — the thing a reader scrolls for —
 * looked like any other paragraph.
 *
 * This turns the sections into labelled, typeset blocks: the statement as a card, the answer
 * as a boxed result, a leading "$2.1.32.$" as the book's bold problem number with Savchenko's
 * ∗ when the problem is starred. It never edits posts/ (the contributors' copy): it runs on the
 * HTML marked produced, before the maths is rendered, in post.js and in the editor preview.
 *
 * UMD with no dependencies, like js/tex-normalize.js, so Node and the browser share one copy.
 * Contract: text is unchanged apart from the documented edits (label wording, the answer moved
 * out of its heading, the problem number), <section> tags always balance, running it twice is
 * a no-op, and anything it does not recognise is left exactly as it was.
 */
(function (root, factory) {
    const api = factory();
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    else root.SolutionStructure = api;
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    // JS \b does not know Cyrillic, so every pattern anchors on the whole heading text.
    const KINDS = [
        ['statement', /^(?:у?сл?л?овие|условия|statement|problem(?:\s+statement)?|condition)$/i],
        ['solution', /^(?:решение(?:\s+и\s+ответ)?(?:\s*\d+)?|доказательство|solution(?:\s+and\s+answer)?(?:\s*\d+)?|proof)$/i],
        ['alternative', /^(?:(?:альтерна\S*|аналогичное|другое|второе|иное)\s+решение(?:\s*\d+)?|alternative\s+solution(?:\s*\d+)?|another\s+solution)$/i],
        ['answer', /^(?:ответ|ответы|answer|answers)(?:\s*\d+)?$/i],
        ['literature', /^(?:литература|источники|references|literature)$/i],
    ];
    const ANSWER_WITH_CONTENT = /^((?:ответ|answer)(?:\s*\d+)?)\s*:\s*([\s\S]+)$/i;
    const LABELS = {
        ru: { statement: 'Условие', solution: 'Решение', alternative: 'Альтернативное решение', answer: 'Ответ', literature: 'Литература' },
        en: { statement: 'Statement', solution: 'Solution', alternative: 'Alternative solution', answer: 'Answer', literature: 'References' },
    };
    const CONTAINERS = /^(?:blockquote|ul|ol|li|table|thead|tbody|tr|td|th|details|figure|div|center|pre|section|aside|dl)$/i;

    function plainText(inner) {
        return String(inner)
            .replace(/<[^>]*>/g, '')
            .replace(/&nbsp;|&#160;/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
    }

    function classify(inner) {
        const text = plainText(inner);
        const bare = text.replace(/[:.]\s*$/, '').trim();
        const withContent = text.match(ANSWER_WITH_CONTENT);
        if (withContent && withContent[2].replace(/[\s.]/g, '')) {
            const num = (withContent[1].match(/\d+/) || [''])[0];
            // Keep the original inner HTML after the colon (it may hold maths or tags).
            const colon = inner.indexOf(':');
            let content = colon >= 0 ? inner.slice(colon + 1) : withContent[2];
            // "<strong>Ответ:</strong> $x$" — drop the closing tags the split left dangling.
            content = content.replace(/^\s*(?:<\/[a-zA-Z][a-zA-Z0-9]*>\s*)+/, '').trim();
            return { kind: 'answer', num, content };
        }
        for (const [kind, re] of KINDS) {
            if (re.test(bare)) {
                const num = kind === 'answer' || kind === 'solution' || kind === 'alternative' ? ((bare.match(/(\d+)\s*$/) || [])[1] || '') : '';
                return { kind, num, combined: /(?:и\s+ответ|and\s+answer)/i.test(bare) };
            }
        }
        return null;
    }

    /** Split top-level HTML into [{ type: 'heading', level, inner, raw } | { type: 'chunk', raw }]. */
    function tokenize(html) {
        const out = [];
        const re = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)\b[^>]*>/g;
        let depth = 0;
        let last = 0;
        let m;
        while ((m = re.exec(html))) {
            const closing = m[1] === '/';
            const tag = m[2];
            if (depth === 0 && !closing && /^h[1-6]$/i.test(tag)) {
                const end = html.indexOf(`</${tag}>`, re.lastIndex);
                if (end < 0) continue;
                if (m.index > last) out.push({ type: 'chunk', raw: html.slice(last, m.index) });
                out.push({ type: 'heading', level: Number(tag[1]), inner: html.slice(re.lastIndex, end), raw: html.slice(m.index, end + tag.length + 3) });
                last = end + tag.length + 3;
                re.lastIndex = last;
                continue;
            }
            if (CONTAINERS.test(tag) && !/\/>$/.test(m[0])) depth += closing ? -1 : 1;
            if (depth < 0) depth = 0;
        }
        if (last < html.length) out.push({ type: 'chunk', raw: html.slice(last) });
        return out;
    }

    const NUMBER_AT_START = /^(\s*<p>\s*)\$\s*(\d{1,2}\.\d{1,2}\.\d{1,3})\s*(\^\s*\{?\s*(?:\*|∗|\\ast)\s*\}?)?\s*\.?\s*\$(?:\s*\.)?/;

    function bookNumber(chunk, name, starred) {
        return chunk.replace(NUMBER_AT_START, (all, open, num, star) => {
            if (name && num !== name) return all;
            const isStarred = typeof starred === 'boolean' ? starred : Boolean(star);
            return `${open}<span class="ss-num">${num}${isStarred ? '<sup class="ss-star" aria-label="∗">∗</sup>' : ''}.</span>`;
        });
    }

    const DISPLAY_ONLY = /<p>((?:\s*(?:\$\$[\s\S]*?\$\$|\\\[[\s\S]*?\\\])\s*(?:<br\s*\/?>\s*)*)+)<\/p>/g;
    function markDisplayParagraphs(html) {
        return html.replace(DISPLAY_ONLY, (all, inner) => `<p class="ss-eq">${inner}</p>`);
    }

    function structureSolution(html, opts) {
        if (typeof html !== 'string' || !html) return html;
        if (html.indexOf('class="ss-sec') !== -1) return html;       // already structured
        const o = opts || {};
        const lang = o.lang === 'ru' ? 'ru' : 'en';
        const labels = LABELS[lang];
        const tokens = tokenize(html);
        let out = '';
        let open = null;          // { kind }
        let statementSeen = false;
        let pendingBox = false;   // an answer box has been opened and needs closing
        let hasContent = false;   // the open section has something besides its label
        let sectionStart = 0;
        const close = () => {
            if (!open) return;
            if (!hasContent) {
                // A heading with nothing under it ("### решение:" at the end of a post):
                // an empty labelled block would read as missing content, so drop it.
                out = out.slice(0, sectionStart);
                open = null; pendingBox = false;
                return;
            }
            if (pendingBox) {
                out += '</div>';
                pendingBox = false;
            }
            out += '</section>';
            open = null;
        };
        for (const t of tokens) {
            if (t.type === 'chunk') {
                if (open && open.kind === 'statement' && !open.numbered) {
                    t.raw = bookNumber(t.raw, o.name, o.starred);
                    open.numbered = true;
                }
                if (open && t.raw.replace(/<br\s*\/?>/g, '').trim()) hasContent = true;
                out += t.raw;
                continue;
            }
            const c = classify(t.inner);
            if (c && c.kind === 'statement' && statementSeen) {
                // a second "Условие" is text, not a new card
                out += t.raw.replace(/:\s*(<\/h[1-6]>)$/, '$1');
                continue;
            }
            if (!c) {
                // Unrecognised heading: a statement/answer/literature block ends here.
                if (open && (open.kind === 'statement' || open.kind === 'answer' || open.kind === 'literature')) close();
                out += t.raw.replace(/\s*:\s*(<\/h[1-6]>)$/, '$1');
                continue;
            }
            close();
            sectionStart = out.length;
            const label = labels[c.kind] + (c.num ? ` ${c.num}` : '');
            const extra = c.kind === 'statement' ? ' ss-problem' : '';
            out += `<section class="ss-sec ss-sec--${c.kind}${extra}">`;
            out += `<h2 class="ss-label">${c.combined ? (lang === 'ru' ? 'Решение и ответ' : 'Solution and answer') : label}</h2>`;
            open = { kind: c.kind, numbered: false };
            hasContent = false;
            if (c.kind === 'statement') statementSeen = true;
            if (c.kind === 'answer') {
                out += '<div class="ss-answer">';
                pendingBox = true;
                if (c.content) {
                    out += `<p>${c.content}</p>`;
                    hasContent = true;
                }
            }
        }
        close();
        return markDisplayParagraphs(out);
    }

    /** True when an image's alt text is the book's own caption for that problem's statement figure. */
    function isBookCaption(alt, folder, filename) {
        if (!/^statement\.(png|svg|webp|jpe?g)$/i.test(String(filename || ''))) return false;
        const text = String(alt || '')
            .replace(/\$|\^\{?\s*(?:∗|\*|\\\*)\s*\}?|\\\*|∗/g, '')
            .replace(/\s+/g, ' ')
            .replace(/[.\s]+$/, '')
            .trim();
        const m = text.match(/^(?:к задаче|for problem|for the|figure for problem|to problem)\s+(\d{1,2}\.\d{1,2}\.\d{1,3})(?:\s+problem)?$/i);
        return Boolean(m && m[1] === String(folder || '').trim());
    }

    return { structureSolution, isBookCaption, classify, tokenize };
});
