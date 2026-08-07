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

    var state = {
        q: Q.q || '',
        min: Q.min != null ? Number(Q.min) : 0,
        max: Q.max != null ? Number(Q.max) : 100,
        minMin: 0,
        maxMin: 180,
        starred: !!Q.starred,
        bookmarked: false,
        lang: 'any',
        chapters: new Set(Q.chapter ? String(Q.chapter).split(',').map(Number) : []),
        tags: new Set(Q.tag ? String(Q.tag).split(',').filter(Boolean) : []),
        tagMode: Q.tagMode === 'and' ? 'and' : 'or',
        sort: Q.sort || '',
        dir: Q.dir === 'asc' ? 'asc' : 'desc',
        axisRanges: {},
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
                || r[COL.CANONICAL_TAGS].some(function (t) { return t.toLowerCase().indexOf(needle) !== -1; });
            if (!hit) return false;
        }
        if (r[COL.CALIBRATED] != null) {
            if (r[COL.CALIBRATED] < state.min || r[COL.CALIBRATED] > state.max) return false;
        } else if (state.min > 0) return false;

        if (r[COL.EST_MINUTES] != null) {
            var em = r[COL.EST_MINUTES];
            if (em < state.minMin) return false;
            if (state.maxMin < 180 && em > state.maxMin) return false;
        } else if (state.minMin > 0) return false;

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
            return rows.slice().sort(function (a, b) {
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
            ? esc(r[COL.VOTE_AVG]) + '/10 (' + r[COL.VOTE_COUNT] + (LANG === 'ru' ? ' оценок)' : ' ratings)')
            : '<span class="pf-none">' + (LANG === 'ru' ? 'Нет оценок читателей' : 'No reader ratings yet') + '</span>';

        var loadingText = LANG === 'ru' ? 'Загрузка условия…' : 'Loading statement…';
        return '<div class="pf-card ' + heatClass + '" data-name="' + esc(r[COL.NAME]) + '">'
            + tagsHtml
            + '<div class="pf-card-head">'
            + '<a class="pf-card-name" href="/' + LANG + '/' + esc(r[COL.NAME]) + '">' + esc(r[COL.NAME]) + '</a>'
            + (r[COL.STARRED] === 1 ? '<span class="pf-star" title="Asterisked by Savchenko">∗</span>' : '')
            + ratingHtml
            + '<span class="pf-card-status">' + statusHtml + '</span>'
            + '</div>'
            + '<div class="pf-card-statement is-loading" data-statement-for="' + esc(r[COL.NAME]) + '">' + loadingText + '</div>'
            + '<div class="pf-card-foot">'
            + '<span class="pf-card-vote">' + voteHtml + '</span>'
            + '<a class="pf-card-open" href="/' + LANG + '/' + esc(r[COL.NAME]) + '">' + (LANG === 'ru' ? 'Открыть решение' : 'Open solution') + ' →</a>'
            + '</div></div>';
    }

    // Event delegation, wired once on the stable container rather than per-button: Load
    // More appends new cards repeatedly, and re-attaching a listener to every button in the
    // container each time (including ones from earlier pages) would stack duplicate
    // listeners on old cards and fire toggleTag() multiple times per click.
    cardsEl.addEventListener('click', function (e) {
        var btn = e.target.closest('.pf-card-tag');
        if (btn) toggleTag(btn.getAttribute('data-tag'));
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
        countEl.textContent = (LANG === 'ru' ? 'Показано ' : 'Showing ') + shownCount + (LANG === 'ru' ? ' из ' : ' of ') + rows.length;
    }

    loadMoreBtn.addEventListener('click', function () { renderPage(currentRows, true); });

    function syncUrl() {
        var params = new URLSearchParams();
        if (state.q) params.set('q', state.q);
        if (state.min > 0) params.set('min', state.min);
        if (state.max < 100) params.set('max', state.max);
        if (state.starred) params.set('starred', '1');
        if (state.chapters.size) params.set('chapter', Array.from(state.chapters).join(','));
        if (state.tags.size) params.set('tag', Array.from(state.tags).join(','));
        if (state.tags.size && state.tagMode === 'and') params.set('tagMode', 'and');
        if (state.sort) { params.set('sort', state.sort); params.set('dir', state.dir); }
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
    wireRange(document.getElementById('pfCalibLo').closest('.pf-range-track'),
        document.getElementById('pfCalibLo'), document.getElementById('pfCalibHi'),
        function (lo, hi) {
            state.min = ratingToPercentileRange(lo)[0];
            state.max = ratingToPercentileRange(hi)[1];
        },
        document.getElementById('pfCalibVal'), function (lo, hi) { return lo + '–' + hi; });

    wireRange(document.getElementById('pfMinutesLo').closest('.pf-range-track'),
        document.getElementById('pfMinutesLo'), document.getElementById('pfMinutesHi'),
        function (lo, hi) { state.minMin = lo; state.maxMin = hi; },
        document.getElementById('pfMinutesVal'), function (lo, hi) { return lo + '–' + (hi >= 180 ? '180+' : hi); });

    Array.prototype.forEach.call(document.querySelectorAll('.pf-axis-lo'), function (loEl) {
        var key = loEl.getAttribute('data-axis');
        var hiEl = document.querySelector('.pf-axis-hi[data-axis="' + key + '"]');
        var labelEl = document.querySelector('[data-axis-val="' + key + '"]');
        wireRange(loEl.closest('.pf-range-track'), loEl, hiEl, function (lo, hi) {
            state.axisRanges[key] = (lo === 0 && hi === 100) ? null : [lo, hi];
        }, labelEl, function (lo, hi) { return lo + '–' + hi; });
    });

    // ── other controls ──────────────────────────────────────────────────────
    var searchEl = document.getElementById('pfSearch');
    searchEl.value = state.q;
    var searchTimer = null;
    searchEl.addEventListener('input', function () {
        state.q = searchEl.value.trim().toLowerCase();
        clearTimeout(searchTimer);
        searchTimer = setTimeout(applyState, 200);
    });

    var starredCb = document.getElementById('pfStarred');
    starredCb.checked = state.starred;
    starredCb.addEventListener('change', function () { state.starred = starredCb.checked; applyState(); });

    var bookmarkedCb = document.getElementById('pfBookmarked');
    if (bookmarkedCb) bookmarkedCb.addEventListener('change', function () { state.bookmarked = bookmarkedCb.checked; applyState(); });

    var langSeg = document.getElementById('pfLangSeg');
    langSeg.addEventListener('click', function (e) {
        var btn = e.target.closest('button');
        if (!btn) return;
        Array.prototype.forEach.call(langSeg.querySelectorAll('button'), function (b) { b.classList.remove('on'); });
        btn.classList.add('on');
        state.lang = btn.getAttribute('data-val');
        applyState();
    });

    Array.prototype.forEach.call(document.querySelectorAll('.pf-chapter-cb'), function (cb) {
        cb.addEventListener('change', function () {
            var v = parseInt(cb.value, 10);
            if (cb.checked) state.chapters.add(v); else state.chapters.delete(v);
            applyState();
        });
    });

    var tagModeEl = document.getElementById('pfTagMode');
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

    function resetAll(doApply) {
        state.q = ''; searchEl.value = '';
        state.min = 0; state.max = 100;
        state.minMin = 0; state.maxMin = 180;
        state.axisRanges = {};
        rangeRegistry.forEach(function (r) {
            r.loEl.value = r.loEl.min; r.hiEl.value = r.hiEl.max; r.render(false);
        });
        state.starred = false; starredCb.checked = false;
        if (bookmarkedCb) { state.bookmarked = false; bookmarkedCb.checked = false; }
        state.lang = 'any';
        Array.prototype.forEach.call(langSeg.querySelectorAll('button'), function (b) { b.classList.toggle('on', b.getAttribute('data-val') === 'any'); });
        state.chapters = new Set();
        Array.prototype.forEach.call(document.querySelectorAll('.pf-chapter-cb'), function (cb) { cb.checked = false; });
        state.tags = new Set();
        state.tagMode = 'or';
        Array.prototype.forEach.call(tagModeEl.querySelectorAll('button'), function (b) { b.classList.toggle('on', b.getAttribute('data-val') === 'or'); });
        renderTagList('');
        state.sort = ''; state.dir = 'desc';
        sortSelect.value = '';
        if (doApply !== false) applyState();
    }
    document.getElementById('pfClearBtn').addEventListener('click', function () { resetAll(); });

    // First client-side render replaces the SSR cards with the exact same
    // (already-filtered-server-side) view, then every control is instantly live.
    applyState();
    } // end init()
})();
