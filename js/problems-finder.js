// Problem finder — vanilla JS, no dependency. The dataset (metadata-only, 2,023 rows —
// small enough to filter/sort entirely client-side with no round-trip per filter change)
// loads once via fetch() from GET /problems/data (see loadData below for why this isn't
// embedded inline in the page). Results render as cards (statement preview, not a dense
// table) with Load More pagination rather than all matches at once. Statement HTML itself
// is fetched per card, on demand, from GET /api/problem/:name/statement (see
// fetchStatementsFor below) — see problems.js's COL comment for why that's split out too.
//
// Row layout (must stay in sync with problems.js's COL map):
//   [name, chapter, section, idx, starred, calibrated, estMinutes,
//    prerequisites[], canonicalTags[], voteAvg, voteCount, solvedEn, solvedRu, scores[]]
(function () {
    var loadErrorEl = document.getElementById('pfLoadError');
    var retryBtn = document.getElementById('pfRetryBtn');
    if (!loadErrorEl || !retryBtn || !window.__PF_DATA_URL__) return; // page has no finder on it

    // Needed before init() runs, because the statement batch for the server-rendered cards
    // starts immediately rather than waiting for the dataset (see primeSsrStatements).
    var LANG = window.__PF_LANG__ || 'en';
    var cardsEl = document.getElementById('pfCards');

    // Never let a bad payload throw at top level. That is precisely what broke this page in
    // production: an empty/corrupted response reached JSON.parse, it threw before a single
    // listener was attached, and every button and slider went dead with no visible reason.
    // Anything that can fail here is wrapped, and any failure shows the retry UI instead.
    function safeParse(text, fallback) {
        try { return JSON.parse(text); } catch (e) { return fallback; }
    }

    // The dataset arrives via a real fetch() rather than being embedded in the page's HTML,
    // so a failure is an ordinary, retryable HTTP failure rather than a corrupted script
    // that takes the page down with it.
    function loadData() {
        loadErrorEl.hidden = true;
        fetch(window.__PF_DATA_URL__, { credentials: 'same-origin' })
            .then(function (r) { if (!r.ok) throw new Error('http ' + r.status); return r.text(); })
            .then(function (text) {
                var data = safeParse(text, null);
                if (!data || !data.rows || !data.rows.length) throw new Error('bad payload');
                var bmEl = document.getElementById('pfBookmarked');
                init(data, safeParse(bmEl ? bmEl.textContent : '[]', []));
            })
            .catch(function () { loadErrorEl.hidden = false; });
    }
    // Statement HTML is deliberately NOT in the main dataset (see problems.js's COL comment),
    // and it is fetched for a whole page of cards in ONE batched request rather than one per
    // card. Rendering is not the slow part — a warm cache hit and a cold miss both measure
    // about the same from outside the datacentre, so it is nearly all round-trip latency —
    // and browsers only run ~6 requests per host at a time, so 20 separate fetches queued
    // into several waves and left the cards showing "Loading statement…" for seconds.
    // A batch failing degrades to those cards showing a message; it cannot take the page down.
    var statementRequested = Object.create(null);
    var statementCache = Object.create(null);

    function paintStatement(name, html) {
        var el = cardsEl.querySelector('.pf-card-statement[data-statement-for="' + CSS.escape(name) + '"]');
        if (!el) return;
        if (html) {
            el.innerHTML = html;
            el.classList.remove('is-loading');
        } else {
            el.textContent = LANG === 'ru' ? 'Не удалось загрузить условие.' : 'Could not load the statement.';
            el.classList.remove('is-loading');
        }
    }

    // Chunked to the server's page size. Asking for more than the server is willing to
    // return in one batch is exactly how cards ended up permanently showing "Could not load
    // the statement": the extra names simply were not in the response, and a name missing
    // from the response used to be treated as a hard failure.
    var BATCH_SIZE = window.__PF_PAGE_SIZE__ || 20;

    function requestBatch(names, attempt) {
        fetch('/' + LANG + '/problems/statements?names=' + encodeURIComponent(names.join(',')),
              { credentials: 'same-origin' })
            .then(function (r) { if (!r.ok) throw new Error('http ' + r.status); return r.json(); })
            .then(function (map) {
                var stillMissing = [];
                names.forEach(function (name) {
                    var html = map && map[name] ? map[name] : null;
                    if (html) {
                        statementCache[name] = html;
                        paintStatement(name, html);
                    } else {
                        stillMissing.push(name);
                    }
                });
                // A name absent from an otherwise-successful response is usually transient
                // (or genuinely has no statement on record). Retry once before giving up,
                // rather than immediately writing an error into the card.
                if (stillMissing.length && attempt < 1) {
                    setTimeout(function () { requestBatch(stillMissing, attempt + 1); }, 600);
                } else {
                    stillMissing.forEach(function (name) {
                        statementCache[name] = null;
                        paintStatement(name, null);
                    });
                }
            })
            .catch(function () {
                if (attempt < 1) {
                    setTimeout(function () { requestBatch(names, attempt + 1); }, 800);
                    return;
                }
                // Give up, but forget the request so these cards can try again if they
                // render a second time (e.g. after a filter change).
                names.forEach(function (name) {
                    delete statementRequested[name];
                    paintStatement(name, null);
                });
            });
    }

    function fetchStatementsFor(names) {
        var needed = [];
        names.forEach(function (name) {
            // Already fetched earlier this session (e.g. the card reappears after a filter
            // change) — repaint from memory, no request at all.
            if (Object.prototype.hasOwnProperty.call(statementCache, name)) {
                paintStatement(name, statementCache[name]);
                return;
            }
            if (statementRequested[name]) return;
            statementRequested[name] = true;
            needed.push(name);
        });
        if (!needed.length) return;

        for (var i = 0; i < needed.length; i += BATCH_SIZE) {
            requestBatch(needed.slice(i, i + BATCH_SIZE), 0);
        }
    }

    // Fire the statement batch for the server-rendered first page IMMEDIATELY, in parallel
    // with the dataset fetch above, instead of waiting for it. The server already rendered
    // those 20 cards into the HTML, so their names are known before any JS data arrives —
    // waiting would make the chain page -> dataset -> statements strictly sequential and add
    // a whole round-trip to the time the first statement appears.
    (function primeSsrStatements() {
        var names = [];
        Array.prototype.forEach.call(
            document.querySelectorAll('#pfCards .pf-card-statement[data-statement-for]'),
            function (el) { names.push(el.getAttribute('data-statement-for')); }
        );
        if (names.length) fetchStatementsFor(names);
    })();

    retryBtn.addEventListener('click', loadData);
    loadData();

    function init(DATA, bookmarkedList) {
    var BOOKMARKED = new Set(bookmarkedList);
    var Q = window.__PF_QUERY__ || {};
    var AXIS_IDX = {};
    DATA.axisKeys.forEach(function (k, i) { AXIS_IDX[k] = i; });

    var COL = { NAME: 0, CHAPTER: 1, SECTION: 2, IDX: 3, STARRED: 4, CALIBRATED: 5, EST_MINUTES: 6,
        PREREQUISITES: 7, CANONICAL_TAGS: 8, VOTE_AVG: 9, VOTE_COUNT: 10, SOLVED_EN: 11, SOLVED_RU: 12,
        SCORES: 13 };

    // Same quantile-mapped Codeforces-style rescale as lib/difficultyRating.js (duplicated,
    // not shared: this file ships to the browser with no bundler, that module runs server-side
    // only). See that file's header for why this isn't a straight linear map.
    var CF_HISTOGRAM = [
        [800, 1087], [900, 350], [1000, 402], [1100, 444], [1200, 455], [1300, 471],
        [1400, 460], [1500, 475], [1600, 522], [1700, 516], [1800, 491], [1900, 537],
        [2000, 494], [2100, 451], [2200, 472], [2300, 412], [2400, 462], [2500, 415],
        [2600, 340], [2700, 308], [2800, 254], [2900, 240], [3000, 198], [3100, 170],
        [3200, 159], [3300, 136], [3400, 90], [3500, 240]
    ];
    var CF_TOTAL = CF_HISTOGRAM.reduce(function (s, b) { return s + b[1]; }, 0);
    var CF_CUMULATIVE = (function () {
        var running = 0;
        return CF_HISTOGRAM.map(function (b) {
            var from = (running / CF_TOTAL) * 100;
            running += b[1];
            return { rating: b[0], from: from };
        });
    })();
    function toRating(calibrated) {
        if (calibrated == null) return null;
        var p = Math.max(0, Math.min(100, calibrated));
        var rating = CF_CUMULATIVE[0].rating;
        for (var i = 0; i < CF_CUMULATIVE.length; i++) {
            if (p >= CF_CUMULATIVE[i].from) rating = CF_CUMULATIVE[i].rating; else break;
        }
        return rating;
    }
    function ratingToPercentileRange(rating) {
        var idx = -1;
        for (var i = 0; i < CF_CUMULATIVE.length; i++) if (CF_CUMULATIVE[i].rating === rating) { idx = i; break; }
        if (idx === -1) return [0, 100];
        var from = CF_CUMULATIVE[idx].from;
        var to = idx + 1 < CF_CUMULATIVE.length ? CF_CUMULATIVE[idx + 1].from : 100;
        return [from, to];
    }
    function heatOf(c) { return c == null ? null : Math.min(9, Math.max(1, Math.ceil((c / 100) * 9) || 1)); }

    // Text search (lib/problemSearch.js via GET /<lang>/problems/search): the problems whose
    // statement or solution contains the query, best first, and a snippet for those found only
    // in the solution. A number ("2.1.32") is matched by the name filter alone.
    var SEARCH = { q: '', rank: new Map(), snippets: {}, terms: [] };
    function isNumberQuery(q) { return /^\d{1,2}([.,]\d{0,2}([.,]\d{0,3})?)?$/.test(String(q || '').replace(/\s+/g, '')); }
    var searchSeq = 0;
    function runSearch(q, then) {
        var seq = ++searchSeq;
        if (!q || q.length < 2 || isNumberQuery(q)) {
            SEARCH = { q: q, rank: new Map(), snippets: {}, terms: [] };
            then();
            return;
        }
        fetch('/' + LANG + '/problems/search?q=' + encodeURIComponent(q), { credentials: 'same-origin' })
            .then(function (r) { if (!r.ok) throw new Error('http ' + r.status); return r.json(); })
            .then(function (data) {
                if (seq !== searchSeq) return;   // a newer query has been typed since
                var rank = new Map();
                (data.names || []).forEach(function (n, i) { rank.set(n, i); });
                SEARCH = { q: q, rank: rank, snippets: data.snippets || {}, terms: data.terms || [] };
                then();
            })
            .catch(function () {
                if (seq !== searchSeq) return;
                SEARCH = { q: q, rank: new Map(), snippets: {}, terms: [] };
                then();
            });
    }
    function searchActive() { return state.q && SEARCH.q === state.q && SEARCH.rank.size > 0; }

    // Every filter lives in the URL (syncUrl below), so a copied link, a reload or the back
    // button brings back exactly these results. Until 2026-09-14 the difficulty slider, the
    // chapter boxes, the solution language, bookmarks and the skill axes were lost on reload.
    function clampPct(v, fallback) { v = Number(v); return isFinite(v) ? Math.max(0, Math.min(100, v)) : fallback; }
    function parseRange(v) {
        var m = /^(\d{1,3})-(\d{1,3})$/.exec(String(v || ''));
        if (!m) return null;
        var lo = Math.min(100, Number(m[1])), hi = Math.min(100, Number(m[2]));
        if (lo > hi) { var t = lo; lo = hi; hi = t; }
        return (lo === 0 && hi === 100) ? null : [lo, hi];
    }
    var state = {
        q: (typeof Q.q === 'string' ? Q.q : '').trim(),
        min: Q.min != null ? clampPct(Q.min, 0) : 0,
        max: Q.max != null ? clampPct(Q.max, 100) : 100,
        starred: !!Q.starred,
        bookmarked: Q.bookmarked === '1',
        lang: ['en', 'ru', 'none'].indexOf(Q.solved) !== -1 ? Q.solved : 'any',
        chapters: new Set(Q.chapter ? String(Q.chapter).split(',').map(Number).filter(function (n) { return n >= 1 && n <= 14; }) : []),
        tags: new Set(Q.tag ? String(Q.tag).split(',').filter(Boolean) : []),
        tagMode: Q.tagMode === 'and' ? 'and' : 'or',
        sort: Q.sort || '',
        dir: Q.dir === 'asc' ? 'asc' : 'desc',
        axisRanges: (function () {
            var out = {};
            DATA.axisKeys.forEach(function (k) { var r = parseRange(Q['ax_' + k]); if (r) out[k] = r; });
            return out;
        })(),
    };

    // ── build the tag list (Codeforces/LeetCode-style checkbox sidebar) ────────
    var tagListEl = document.getElementById('pfTagList');
    var tagCounts = {};
    DATA.rows.forEach(function (r) { r[COL.CANONICAL_TAGS].forEach(function (t) { tagCounts[t] = (tagCounts[t] || 0) + 1; }); });
    var tagLabelOf = {};
    DATA.tags.forEach(function (t) { tagLabelOf[t[0]] = LANG === 'ru' ? t[2] : t[1]; });
    function tagLabel(key) { return tagLabelOf[key] || key; }

    function renderTagList(filterText) {
        var needle = (filterText || '').toLowerCase();
        var html = '';
        DATA.tags.forEach(function (t) {
            var key = t[0], label = LANG === 'ru' ? t[2] : t[1];
            if (needle && label.toLowerCase().indexOf(needle) === -1 && key.indexOf(needle) === -1) return;
            var n = tagCounts[key] || 0;
            if (!n) return;
            var checked = state.tags.has(key) ? ' checked' : '';
            html += '<label class="pf-tag-row"><input type="checkbox" class="pf-tag-cb" value="' + key + '"' + checked + '> '
                + label + '<span class="n">' + n + '</span></label>';
        });
        tagListEl.innerHTML = html;
        Array.prototype.forEach.call(tagListEl.querySelectorAll('.pf-tag-cb'), function (cb) {
            cb.addEventListener('change', function () { toggleTag(cb.value); });
        });
    }
    renderTagList('');

    // Toggling a tag happens from two places (the sidebar checkbox list and the clickable
    // tag chips at the top of each card) — one function keeps both in sync plus re-renders
    // the active/inactive (green) state on whichever tags are currently visible in cards.
    function toggleTag(key) {
        if (state.tags.has(key)) state.tags.delete(key); else state.tags.add(key);
        var cb = tagListEl.querySelector('.pf-tag-cb[value="' + key + '"]');
        if (cb) cb.checked = state.tags.has(key);
        applyState();
    }

    // ── filter + sort ───────────────────────────────────────────────────────
    function passesFilters(r) {
        if (state.q) {
            var needle = state.q.toLowerCase();
            var hit = r[COL.NAME].indexOf(needle) !== -1
                || r[COL.PREREQUISITES].some(function (t) { return t.toLowerCase().indexOf(needle) !== -1; })
                || r[COL.CANONICAL_TAGS].some(function (t) { return t.toLowerCase().indexOf(needle) !== -1; })
                || (SEARCH.q === state.q && SEARCH.rank.has(r[COL.NAME]));
            if (!hit) return false;
        }
        if (r[COL.CALIBRATED] != null) {
            if (r[COL.CALIBRATED] < state.min || r[COL.CALIBRATED] > state.max) return false;
        } else if (state.min > 0) return false;

        if (state.starred && r[COL.STARRED] !== 1) return false;
        if (state.bookmarked && !BOOKMARKED.has(r[COL.NAME])) return false;

        if (state.lang === 'en' && !r[COL.SOLVED_EN]) return false;
        if (state.lang === 'ru' && !r[COL.SOLVED_RU]) return false;
        if (state.lang === 'none' && (r[COL.SOLVED_EN] || r[COL.SOLVED_RU])) return false;

        if (state.chapters.size && !state.chapters.has(r[COL.CHAPTER])) return false;

        if (state.tags.size) {
            var have = r[COL.CANONICAL_TAGS];
            var ok = state.tagMode === 'and'
                ? Array.from(state.tags).every(function (t) { return have.indexOf(t) !== -1; })
                : Array.from(state.tags).some(function (t) { return have.indexOf(t) !== -1; });
            if (!ok) return false;
        }

        for (var key in state.axisRanges) {
            var range = state.axisRanges[key];
            if (!range) continue;
            var idx = AXIS_IDX[key];
            var v = r[COL.SCORES] ? r[COL.SCORES][idx] : null;
            if (v == null) { if (range[0] > 0) return false; continue; }
            if (v < range[0] || v > range[1]) return false;
        }
        return true;
    }

    function sortRows(rows) {
        if (!state.sort) {
            var rank = searchActive() ? SEARCH.rank : null;
            var last = rank ? rank.size : 0;
            return rows.slice().sort(function (a, b) {
                if (rank) {
                    var ra = rank.has(a[COL.NAME]) ? rank.get(a[COL.NAME]) : last;
                    var rb = rank.has(b[COL.NAME]) ? rank.get(b[COL.NAME]) : last;
                    if (ra !== rb) return ra - rb;
                }
                return (a[COL.CHAPTER] - b[COL.CHAPTER]) || (a[COL.SECTION] - b[COL.SECTION]) || (a[COL.IDX] - b[COL.IDX]);
            });
        }
        var mul = state.dir === 'asc' ? 1 : -1;
        var axisIdx = AXIS_IDX[state.sort];
        return rows.slice().sort(function (a, b) {
            var av, bv;
            if (state.sort === 'calibrated') { av = a[COL.CALIBRATED]; bv = b[COL.CALIBRATED]; }
            else if (state.sort === 'est_minutes') { av = a[COL.EST_MINUTES]; bv = b[COL.EST_MINUTES]; }
            else if (state.sort === 'vote_avg') { av = a[COL.VOTE_AVG]; bv = b[COL.VOTE_AVG]; }
            else if (axisIdx !== undefined) { av = a[COL.SCORES] ? a[COL.SCORES][axisIdx] : null; bv = b[COL.SCORES] ? b[COL.SCORES][axisIdx] : null; }
            else return 0;
            if (av == null && bv == null) return 0;
            if (av == null) return 1;
            if (bv == null) return -1;
            return (av - bv) * mul;
        });
    }

    // ── render (cards + Load More pagination) ──────────────────────────────────
    var countEl = document.getElementById('pfResultCount');
    var emptyEl = document.getElementById('pfEmpty');
    var loadMoreBtn = document.getElementById('pfLoadMore');
    var esc = function (s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); };
    // The query's words marked in an escaped snippet, as the header's live suggestions mark them.
    function highlight(text, query) {
        var escaped = esc(text);
        var terms = String(query || '').trim().split(/\s+/).filter(function (t) { return t.length > 1; });
        if (!terms.length) return escaped;
        var pattern = terms.map(function (t) { return esc(t).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }).join('|');
        return escaped.replace(new RegExp('(' + pattern + ')', 'gi'), '<mark class="ss-search-mark">$1</mark>');
    }
    var PAGE_SIZE = BATCH_SIZE;   // same server-authoritative value

    var currentRows = [];   // full filtered+sorted set for the active query
    var shownCount = 0;     // how many of currentRows are in the DOM right now

    function cardHtml(r) {
        var heat = heatOf(r[COL.CALIBRATED]);
        var rating = toRating(r[COL.CALIBRATED]);
        var heatClass = heat ? 'pf-heat-' + heat : '';
        var tagSource = r[COL.CANONICAL_TAGS].length ? r[COL.CANONICAL_TAGS] : r[COL.PREREQUISITES];
        var isCanonical = r[COL.CANONICAL_TAGS].length > 0;

        var tagsHtml = '';
        if (tagSource.length) {
            tagsHtml = '<div class="pf-card-tags">' + tagSource.map(function (t) {
                var active = isCanonical && state.tags.has(t) ? ' active' : '';
                var label = isCanonical ? esc(tagLabel(t)) : esc(t);
                return '<button type="button" class="pf-card-tag' + active + '" data-tag="' + esc(t) + '">' + label + '</button>';
            }).join('') + '</div>';
        }

        var ratingHtml = rating != null
            ? '<span class="pf-card-rating ' + (heat ? 'pf-heat-bg-' + heat : 'pf-heat-none') + '">' + rating + '</span>' : '';
        var statusHtml = (r[COL.SOLVED_EN] ? '<span class="en" title="English solution">EN</span>' : '')
            + (r[COL.SOLVED_RU] ? '<span class="ru" title="Russian solution">RU</span>' : '');
        var voteHtml = r[COL.VOTE_COUNT]
            ? '<span class="pf-card-vote">' + esc(r[COL.VOTE_AVG]) + '/10 (' + r[COL.VOTE_COUNT] + ')</span>' : '';

        var loadingText = LANG === 'ru' ? 'Загрузка условия…' : 'Loading statement…';
        var href = '/' + LANG + '/' + esc(r[COL.NAME]);
        var snippet = SEARCH.q === state.q ? SEARCH.snippets[r[COL.NAME]] : null;
        // Marked by the search's own stems ("трен" in "трения"), not the words as typed.
        var snippetHtml = snippet ? '<p class="pf-card-snippet">' + highlight(snippet, SEARCH.terms.length ? SEARCH.terms.join(' ') : state.q) + '</p>' : '';
        return '<div class="pf-card ' + heatClass + '" data-name="' + esc(r[COL.NAME]) + '" data-href="' + href + '" role="link" tabindex="0">'
            + tagsHtml
            + '<div class="pf-card-head">'
            + '<a class="pf-card-name" href="' + href + '">' + esc(r[COL.NAME]) + '</a>'
            + (r[COL.STARRED] === 1 ? '<sup class="ss-star" title="Asterisked by Savchenko">∗</sup>' : '')
            + ratingHtml
            + '<span class="pf-card-status">' + statusHtml + '</span>'
            + voteHtml
            + '<span class="pf-card-go" aria-hidden="true">→</span>'
            + '</div>'
            + snippetHtml
            + '<div class="pf-card-statement ss-prose ss-prose--compact is-loading" data-statement-for="' + esc(r[COL.NAME]) + '">' + loadingText + '</div>'
            + '</div>';
    }

    // Event delegation, wired once on the stable container rather than per-button: Load
    // More appends new cards repeatedly, and re-attaching a listener to every button in the
    // container each time (including ones from earlier pages) would stack duplicate
    // listeners on old cards and fire toggleTag() multiple times per click.
    cardsEl.addEventListener('click', function (e) {
        var btn = e.target.closest('.pf-card-tag');
        if (btn) { toggleTag(btn.getAttribute('data-tag')); return; }
        // The card itself is the link to the problem. Real controls inside it (the number
        // link, tag buttons, anything in the statement) keep their own behaviour, and a
        // click that merely ends a text selection is not a navigation.
        if (e.target.closest('a, button, input, select, textarea, label')) return;
        var card = e.target.closest('.pf-card[data-href]');
        if (!card) return;
        var sel = window.getSelection ? String(window.getSelection()) : '';
        if (sel) return;
        var href = card.getAttribute('data-href');
        if (e.ctrlKey || e.metaKey || e.shiftKey) window.open(href, '_blank'); else window.location.href = href;
    });
    cardsEl.addEventListener('auxclick', function (e) {
        if (e.button !== 1 || e.target.closest('a, button')) return;
        var card = e.target.closest('.pf-card[data-href]');
        if (card) { e.preventDefault(); window.open(card.getAttribute('data-href'), '_blank'); }
    });
    cardsEl.addEventListener('keydown', function (e) {
        if (e.key !== 'Enter' || !e.target.classList || !e.target.classList.contains('pf-card')) return;
        window.location.href = e.target.getAttribute('data-href');
    });

    function renderPage(rows, append) {
        if (!append) {
            cardsEl.innerHTML = '';
            shownCount = 0;
        }
        var slice = rows.slice(shownCount, shownCount + PAGE_SIZE);
        if (slice.length) {
            var frag = document.createElement('div');
            frag.innerHTML = slice.map(cardHtml).join('');
            while (frag.firstChild) cardsEl.appendChild(frag.firstChild);
            fetchStatementsFor(slice.map(function (r) { return r[COL.NAME]; }));
        }
        shownCount += slice.length;
        loadMoreBtn.hidden = shownCount >= rows.length;
        emptyEl.hidden = rows.length !== 0;
        countEl.textContent = (LANG === 'ru' ? 'Показано ' : 'Showing ') + shownCount + (LANG === 'ru' ? ' из ' : ' of ') + rows.length
            + (state.q ? (LANG === 'ru' ? ' по запросу «' : ' for «') + state.q + '»' : '');
        if (sortDefaultOpt) sortDefaultOpt.textContent = sortDefaultOpt.getAttribute(state.q && !isNumberQuery(state.q) ? 'data-label-search' : 'data-label');
    }
    var sortDefaultOpt = document.getElementById('pfSortDefault');

    loadMoreBtn.addEventListener('click', function () { renderPage(currentRows, true); });

    function syncUrl() {
        var params = new URLSearchParams();
        if (state.q) params.set('q', state.q);
        // Difficulty as the ratings on the slider ("rating=1200-2400"), not the percentiles
        // underneath: a link should read as what the reader chose. Old min/max links still load.
        if (state.min > 0 || state.max < 100) params.set('rating', calibLoEl.value + '-' + calibHiEl.value);
        if (state.starred) params.set('starred', '1');
        if (state.chapters.size) params.set('chapter', Array.from(state.chapters).join(','));
        if (state.tags.size) params.set('tag', Array.from(state.tags).join(','));
        if (state.tags.size && state.tagMode === 'and') params.set('tagMode', 'and');
        if (state.sort) { params.set('sort', state.sort); params.set('dir', state.dir); }
        if (state.lang !== 'any') params.set('solved', state.lang);
        if (state.bookmarked) params.set('bookmarked', '1');
        Object.keys(state.axisRanges).forEach(function (k) {
            var r = state.axisRanges[k];
            if (r) params.set('ax_' + k, r[0] + '-' + r[1]);
        });
        var qs = params.toString();
        var url = window.location.pathname + (qs ? '?' + qs : '');
        window.history.replaceState(null, '', url);
    }

    var applyTimer = null;
    function scheduleApply() {
        clearTimeout(applyTimer);
        applyTimer = setTimeout(applyState, 120);
    }
    function applyState() {
        var filtered = DATA.rows.filter(passesFilters);
        currentRows = sortRows(filtered);
        renderPage(currentRows, false);
        syncUrl();
        renderChips();
    }

    // ── dual-range slider wiring ─────────────────────────────────────────────
    // A plain input[type=range]'s native hit-testing only responds to the exact thumb
    // pixel, which is too small/fragile to drag reliably once two handles overlap on one
    // track (confirmed: real click-and-drag missed the thumb and did nothing). Instead the
    // whole .pf-range-track is the drag surface: pointerdown picks whichever handle is
    // nearer the click, pointer capture keeps the drag going even if the cursor leaves the
    // track, and the <input>s underneath (pointer-events: none) are purely visual — their
    // .value is set programmatically so the native thumb still renders in the right place.
    var rangeRegistry = []; // so resetAll() can put every slider back to its default visually
    function wireRange(track, loEl, hiEl, onChange, labelEl, fmt) {
        var fillEl = track.querySelector('.pf-range-fill');
        var min = parseFloat(loEl.min), max = parseFloat(loEl.max);
        var step = parseFloat(loEl.step) || 1;

        function clampStep(v) {
            v = Math.round(v / step) * step;
            return Math.max(min, Math.min(max, v));
        }
        function valueFromClientX(clientX) {
            var rect = track.getBoundingClientRect();
            var pct = (clientX - rect.left) / rect.width;
            pct = Math.max(0, Math.min(1, pct));
            return clampStep(min + pct * (max - min));
        }
        function render(fireApply) {
            var lo = parseFloat(loEl.value), hi = parseFloat(hiEl.value);
            if (lo > hi) { var t = lo; lo = hi; hi = t; loEl.value = lo; hiEl.value = hi; }
            if (fillEl) {
                fillEl.style.left = ((lo - min) / (max - min) * 100) + '%';
                fillEl.style.right = (100 - (hi - min) / (max - min) * 100) + '%';
            }
            if (labelEl) labelEl.textContent = fmt(lo, hi);
            onChange(lo, hi);
            if (fireApply) scheduleApply();
        }

        var dragEl = null;
        track.addEventListener('pointerdown', function (e) {
            var v = valueFromClientX(e.clientX);
            var lo = parseFloat(loEl.value), hi = parseFloat(hiEl.value);
            dragEl = Math.abs(v - lo) <= Math.abs(v - hi) ? loEl : hiEl;
            dragEl.value = v;
            track.setPointerCapture(e.pointerId);
            render(true);
            e.preventDefault();
        });
        track.addEventListener('pointermove', function (e) {
            if (!dragEl) return;
            dragEl.value = valueFromClientX(e.clientX);
            render(true);
        });
        function endDrag() { dragEl = null; }
        track.addEventListener('pointerup', endDrag);
        track.addEventListener('pointercancel', endDrag);

        render(false);
        rangeRegistry.push({ loEl: loEl, hiEl: hiEl, render: render });
    }

    // Difficulty slider operates natively in rating-space (800-3500, step 100 — see
    // views/problems/index.ejs). Converting a rating back to the calibrated (0-100)
    // space filtering runs on isn't a single value (many percentiles share one rating
    // bucket under the quantile-mapped scale), so the low handle uses its bucket's
    // floor and the high handle uses its bucket's ceiling — "at least this rating" and
    // "at most this rating" both capture the whole bucket they land on.
    var calibLoEl = document.getElementById('pfCalibLo');
    var calibHiEl = document.getElementById('pfCalibHi');
    // The handles start where the link puts them: "rating=1200-2400", or an older link's
    // percentiles (the high handle's bucket is the one that ends at max, hence the step below it).
    var ratingParam = /^(\d{3,4})-(\d{3,4})$/.exec(String(Q.rating || ''));
    if (ratingParam) {
        calibLoEl.value = Math.min(Number(ratingParam[1]), Number(ratingParam[2]));
        calibHiEl.value = Math.max(Number(ratingParam[1]), Number(ratingParam[2]));
    } else {
        if (state.min > 0) calibLoEl.value = toRating(state.min);
        if (state.max < 100) calibHiEl.value = toRating(Math.max(0, state.max - 1e-9));
    }
    wireRange(calibLoEl.closest('.pf-range-track'),
        calibLoEl, calibHiEl,
        function (lo, hi) {
            state.min = ratingToPercentileRange(lo)[0];
            state.max = ratingToPercentileRange(hi)[1];
        },
        document.getElementById('pfCalibVal'), function (lo, hi) { return lo + '–' + hi; });

    Array.prototype.forEach.call(document.querySelectorAll('.pf-axis-lo'), function (loEl) {
        var key = loEl.getAttribute('data-axis');
        var hiEl = document.querySelector('.pf-axis-hi[data-axis="' + key + '"]');
        var labelEl = document.querySelector('[data-axis-val="' + key + '"]');
        if (state.axisRanges[key]) { loEl.value = state.axisRanges[key][0]; hiEl.value = state.axisRanges[key][1]; }
        wireRange(loEl.closest('.pf-range-track'), loEl, hiEl, function (lo, hi) {
            state.axisRanges[key] = (lo === 0 && hi === 100) ? null : [lo, hi];
        }, labelEl, function (lo, hi) { return lo + '–' + hi; });
    });

    // ── other controls ──────────────────────────────────────────────────────
    // Two boxes, one query: the header's (from 768px, views/default/main_site_header.ejs marks
    // it data-finder) and the panel's (phones, where the header has no search). Typing in either
    // updates the other.
    var searchEl = document.getElementById('pfSearch');
    var headerSearchEl = document.querySelector('#searchInput[data-finder]');
    var searchEls = [searchEl, headerSearchEl].filter(Boolean);
    searchEls.forEach(function (el) { el.value = state.q; });
    var searchTimer = null;
    function searchNow(source) {
        clearTimeout(searchTimer);
        var q = source.value.trim();
        searchEls.forEach(function (el) { if (el !== source) el.value = source.value; });
        if (q === state.q && SEARCH.q === q) return;
        state.q = q;
        runSearch(q, applyState);
    }
    searchEls.forEach(function (el) {
        el.addEventListener('input', function () {
            clearTimeout(searchTimer);
            searchTimer = setTimeout(function () { searchNow(el); }, 250);
        });
        el.addEventListener('keydown', function (e) {
            if (e.key === 'Enter') { e.preventDefault(); searchNow(el); }
        });
    });
    // Enter searches in place; the form's GET is for a page whose script has not loaded.
    document.getElementById('pfSearchForm').addEventListener('submit', function (e) {
        e.preventDefault();
        searchNow(searchEl);
    });

    var starredCb = document.getElementById('pfStarred');
    starredCb.checked = state.starred;
    starredCb.addEventListener('change', function () { state.starred = starredCb.checked; applyState(); });

    var bookmarkedCb = document.getElementById('pfBookmarked');
    if (bookmarkedCb) bookmarkedCb.checked = state.bookmarked; else state.bookmarked = false;
    if (bookmarkedCb) bookmarkedCb.addEventListener('change', function () { state.bookmarked = bookmarkedCb.checked; applyState(); });

    var langSeg = document.getElementById('pfLangSeg');
    function syncLangSeg() {
        Array.prototype.forEach.call(langSeg.querySelectorAll('button'), function (b) { b.classList.toggle('on', b.getAttribute('data-val') === state.lang); });
    }
    syncLangSeg();
    langSeg.addEventListener('click', function (e) {
        var btn = e.target.closest('button');
        if (!btn) return;
        Array.prototype.forEach.call(langSeg.querySelectorAll('button'), function (b) { b.classList.remove('on'); });
        btn.classList.add('on');
        state.lang = btn.getAttribute('data-val');
        applyState();
    });

    Array.prototype.forEach.call(document.querySelectorAll('.pf-chapter-cb'), function (cb) {
        cb.checked = state.chapters.has(parseInt(cb.value, 10));
        cb.addEventListener('change', function () {
            var v = parseInt(cb.value, 10);
            if (cb.checked) state.chapters.add(v); else state.chapters.delete(v);
            applyState();
        });
    });

    var tagModeEl = document.getElementById('pfTagMode');
    function syncTagMode() {
        Array.prototype.forEach.call(tagModeEl.querySelectorAll('button'), function (b) { b.classList.toggle('on', b.getAttribute('data-val') === state.tagMode); });
    }
    syncTagMode();
    tagModeEl.addEventListener('click', function (e) {
        var btn = e.target.closest('button');
        if (!btn) return;
        Array.prototype.forEach.call(tagModeEl.querySelectorAll('button'), function (b) { b.classList.remove('on'); });
        btn.classList.add('on');
        state.tagMode = btn.getAttribute('data-val');
        applyState();
    });

    document.getElementById('pfTagSearch').addEventListener('input', function (e) { renderTagList(e.target.value); });

    // Sort dropdown replaces the old sortable-table-header UI now that results are cards.
    var sortSelect = document.getElementById('pfSortSelect');
    if (Q.sort) {
        var match = Q.sort + ':' + (Q.dir === 'asc' ? 'asc' : 'desc');
        if (Array.prototype.some.call(sortSelect.options, function (o) { return o.value === match; })) sortSelect.value = match;
    }
    sortSelect.addEventListener('change', function () {
        var v = sortSelect.value;
        if (!v) { state.sort = ''; state.dir = 'desc'; }
        else { var parts = v.split(':'); state.sort = parts[0]; state.dir = parts[1]; }
        applyState();
    });

    // Records: one click sets a full filter+sort preset, mirroring the exact
    // questions asked in the site's own chat ("is there ever a 100/100?").
    document.querySelectorAll('.pf-record-chip').forEach(function (btn) {
        btn.addEventListener('click', function () {
            var preset = btn.getAttribute('data-preset');
            if (preset === 'clear') { resetAll(); return; }
            resetAll(false);
            if (preset === 'hardest') { state.sort = 'calibrated'; state.dir = 'desc'; sortSelect.value = 'calibrated:desc'; }
            else if (preset === 'easiest') { state.sort = 'calibrated'; state.dir = 'asc'; sortSelect.value = 'calibrated:asc'; }
            else if (preset === 'quickest') { state.sort = 'est_minutes'; state.dir = 'asc'; }
            else if (preset === 'elegant') { state.sort = 'elegance'; state.dir = 'desc'; sortSelect.value = 'elegance:desc'; }
            else if (preset === 'starred') { state.starred = true; starredCb.checked = true; }
            applyState();
        });
    });

    // ── active filters as chips ─────────────────────────────────────────────
    // Everything that narrows or orders the list, shown above the results and removable one by
    // one, with the link that reproduces it. Built from state, so it cannot disagree with the URL.
    var chipsEl = document.getElementById('pfChips');
    var RU = LANG === 'ru';
    function axisLabel(key) {
        var val = document.querySelector('[data-axis-val="' + key + '"]');
        var name = val && val.previousElementSibling;
        return name ? name.textContent.trim() : key;
    }
    function activeFilters() {
        var list = [];
        if (state.q) list.push({ kind: 'q', label: (RU ? 'Поиск «' : 'Search «') + state.q + '»' });
        Array.from(state.chapters).sort(function (a, b) { return a - b; }).forEach(function (n) {
            list.push({ kind: 'chapter', value: n, label: n + '. ' + (DATA.chapters[n] || '') });
        });
        Array.from(state.tags).forEach(function (t) { list.push({ kind: 'tag', value: t, label: tagLabel(t) }); });
        if (state.tags.size > 1 && state.tagMode === 'and') list.push({ kind: 'tagMode', label: RU ? 'Все выбранные темы сразу' : 'All selected topics at once' });
        if (state.min > 0 || state.max < 100) {
            list.push({ kind: 'difficulty', label: (RU ? 'Сложность ' : 'Difficulty ') + calibLoEl.value + '–' + calibHiEl.value });
        }
        if (state.starred) list.push({ kind: 'starred', label: RU ? 'Со звёздочкой ∗' : 'Asterisked ∗' });
        if (state.bookmarked) list.push({ kind: 'bookmarked', label: RU ? 'Мои закладки' : 'My bookmarks' });
        if (state.lang !== 'any') {
            var solved = { en: RU ? 'Решение на английском' : 'Solved in English', ru: RU ? 'Решение на русском' : 'Solved in Russian', none: RU ? 'Без решения' : 'Unsolved' };
            list.push({ kind: 'solved', label: solved[state.lang] });
        }
        Object.keys(state.axisRanges).forEach(function (k) {
            var r = state.axisRanges[k];
            if (r) list.push({ kind: 'axis', value: k, label: axisLabel(k) + ' ' + r[0] + '–' + r[1] });
        });
        if (state.sort) {
            // The "quickest" preset sorts by a key the dropdown does not offer.
            var extraSorts = { est_minutes: RU ? 'Быстрее сначала' : 'Quickest first' };
            var opt = sortSelect.options[sortSelect.selectedIndex];
            var sortName = opt && opt.value ? opt.textContent.trim() : (extraSorts[state.sort] || state.sort);
            list.push({ kind: 'sort', label: (RU ? 'Сортировка: ' : 'Sort: ') + sortName });
        }
        return list;
    }
    function renderChips() {
        if (!chipsEl) return;
        var list = activeFilters();
        chipsEl.hidden = list.length === 0;
        if (!list.length) { chipsEl.innerHTML = ''; return; }
        var removeLabel = RU ? 'Убрать фильтр' : 'Remove filter';
        chipsEl.innerHTML = list.map(function (f) {
            return '<button type="button" class="pf-chip" data-kind="' + f.kind + '"' + (f.value != null ? ' data-value="' + esc(f.value) + '"' : '')
                + ' title="' + removeLabel + '">' + esc(f.label) + '<span class="pf-chip-x" aria-hidden="true">×</span></button>';
        }).join('')
            + '<button type="button" class="pf-chip-action" data-action="clear">' + (RU ? 'Сбросить всё' : 'Clear all') + '</button>'
            + '<button type="button" class="pf-chip-action" data-action="copy">' + (RU ? 'Скопировать ссылку' : 'Copy link') + '</button>';
    }
    function removeFilter(kind, value) {
        if (kind === 'q') {
            state.q = ''; searchEls.forEach(function (el) { el.value = ''; });
            searchSeq++; SEARCH = { q: '', rank: new Map(), snippets: {}, terms: [] };
        } else if (kind === 'chapter') {
            state.chapters.delete(Number(value));
            var cb = document.querySelector('.pf-chapter-cb[value="' + Number(value) + '"]');
            if (cb) cb.checked = false;
        } else if (kind === 'tag') {
            toggleTag(value); return;
        } else if (kind === 'tagMode') {
            state.tagMode = 'or'; syncTagMode();
        } else if (kind === 'difficulty') {
            calibLoEl.value = calibLoEl.min; calibHiEl.value = calibHiEl.max;
            rangeRegistry[0].render(false);
            state.min = 0; state.max = 100;
        } else if (kind === 'starred') {
            state.starred = false; starredCb.checked = false;
        } else if (kind === 'bookmarked') {
            state.bookmarked = false; if (bookmarkedCb) bookmarkedCb.checked = false;
        } else if (kind === 'solved') {
            state.lang = 'any'; syncLangSeg();
        } else if (kind === 'axis') {
            var lo = document.querySelector('.pf-axis-lo[data-axis="' + value + '"]');
            var entry = rangeRegistry.filter(function (r) { return r.loEl === lo; })[0];
            if (entry) { entry.loEl.value = entry.loEl.min; entry.hiEl.value = entry.hiEl.max; entry.render(false); }
            state.axisRanges[value] = null;
        } else if (kind === 'sort') {
            state.sort = ''; state.dir = 'desc'; sortSelect.value = '';
        }
        applyState();
    }
    function copyLink(btn) {
        var done = function () {
            btn.textContent = RU ? 'Ссылка скопирована' : 'Link copied';
            setTimeout(function () { btn.textContent = RU ? 'Скопировать ссылку' : 'Copy link'; }, 2000);
        };
        var url = window.location.href;
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(url).then(done, function () { window.prompt(RU ? 'Ссылка на эту выборку' : 'Link to these results', url); });
        } else {
            window.prompt(RU ? 'Ссылка на эту выборку' : 'Link to these results', url);
        }
    }
    if (chipsEl) chipsEl.addEventListener('click', function (e) {
        var action = e.target.closest('.pf-chip-action');
        if (action) {
            if (action.getAttribute('data-action') === 'clear') resetAll();
            else copyLink(action);
            return;
        }
        var chip = e.target.closest('.pf-chip');
        if (chip) removeFilter(chip.getAttribute('data-kind'), chip.getAttribute('data-value'));
    });

    function resetAll(doApply) {
        state.q = ''; searchEls.forEach(function (el) { el.value = ''; });
        searchSeq++; SEARCH = { q: '', rank: new Map(), snippets: {}, terms: [] };
        state.min = 0; state.max = 100;
        state.axisRanges = {};
        rangeRegistry.forEach(function (r) {
            r.loEl.value = r.loEl.min; r.hiEl.value = r.hiEl.max; r.render(false);
        });
        state.starred = false; starredCb.checked = false;
        if (bookmarkedCb) { state.bookmarked = false; bookmarkedCb.checked = false; }
        state.lang = 'any';
        syncLangSeg();
        state.chapters = new Set();
        Array.prototype.forEach.call(document.querySelectorAll('.pf-chapter-cb'), function (cb) { cb.checked = false; });
        state.tags = new Set();
        state.tagMode = 'or';
        syncTagMode();
        renderTagList('');
        state.sort = ''; state.dir = 'desc';
        sortSelect.value = '';
        if (doApply !== false) applyState();
    }
    document.getElementById('pfClearBtn').addEventListener('click', function () { resetAll(); });

    // First client-side render replaces the SSR cards with the exact same
    // (already-filtered-server-side) view, then every control is instantly live. With a query
    // in the URL it waits for the search, or it would briefly drop the text matches.
    if (state.q) runSearch(state.q, applyState); else applyState();
    } // end init()
})();
