# Brainstorm Room — Design Notes

> Status: **Phases 1–4 implemented** (data/backend + block + room + solved-case
> variant); the full conversation is now **embedded inline on the problem page**
> (§17). Phase 5 is hooks-only (already in the schema).
> Q1 resolved: the room is **unified per `problem_name`** (all languages together).
> See §13 for the locked decisions, the unified-scope no-break verification, and
> exactly what Phase 1 shipped + how to test it.
> Author: Claude (context exploration + proposed design). Reviewer: project owner.

This document is the deliverable for **Phase 0**. It records what the codebase
actually looks like today, then proposes the data model, API surface, component
breakdown, real-time approach, caching, and migration plan for the Brainstorm
Room. It ends with open questions that need your decision before Phase 1.

---

## 1. Context exploration — what I found

### 1.1 Stack (verified, not assumed)

| Concern | Reality in this repo |
| --- | --- |
| Runtime / framework | Node.js + **Express 4.21** (`index.js`, ~2200 lines, plus feature routers) |
| Templating | **EJS** + `express-ejs-layouts`; 39 templates in `views/` |
| DB | **PostgreSQL** via `pg` `Pool` (AWS RDS). No ORM — raw parameterized SQL. |
| Sessions | `express-session` + `connect-pg-simple` (`session` table) |
| Auth | Custom **bcrypt** + session. `passport` is in `package.json` but **not used** in routes. Current user = `req.session.userId` / `req.session.username`. |
| Markdown | `marked` + `sanitize-html` server-side (`utils.js`); a hand-rolled markdown-ish formatter client-side for comments (`formatCommentContent` in `solution_post.ejs`). |
| Math | **MathJax 3** (CDN) — note: CLAUDE.md says 2.7.7, but `solution_post.ejs` already loads `mathjax@3`. |
| CSS | Bootstrap 5.3.3 (CDN) + per-page `<style>` blocks + `css/design-system.css`. |
| i18n | `i18n` module (`locales/en.json`, `ru.json`) **plus** inline `lang === 'ru' ? … : …` ternaries. On the problem page, UI strings are almost all inline ternaries. |
| Rate limiting | `express-rate-limit` is installed and used (`loginLimiter`, `registerLimiter`, `apiLimiter`, `searchLimiter`, `editSaveLimiter`). `apiLimiter` is mounted on `/api/*` but its `max` is effectively unlimited. |
| Real-time | **No sockets anywhere.** The chat uses **AJAX long-poll-ish polling**. |
| Build step | None for JS. `npm run build:css` concatenates CSS, but JS is shipped as-is (mostly inline in EJS; only `js/analytics.js` is an external script on the problem page). |
| Migrations | Forward-only runner `scripts/run-migrations.js` applies `sql/migrations/*.sql` in filename order, tracked in `applied_migrations`, each in a transaction. **There is no down/rollback runner.** Latest applied file is `025_*`. |

### 1.2 The problem page (the page we modify most)

- Route: `app.get('/:lang/:name', …)` → `post.js` `renderPost()` → `views/solution_post.ejs`.
- `name` is the problem id string, e.g. `7.3.6` (`chapter.section.problem`); `lang` ∈ {`en`,`ru`}.
- Layout is a CSS grid:
  ```css
  .main-container { grid-template-columns: minmax(0, 1fr) 280px; gap: .75rem; }
  ```
  Left = the solution/statement (`.content-section`). Right = `<aside class="sidebar">`
  (sticky, `top:80px`) holding the **section problem grid**. The sidebar is
  `display:none` below 992px (it drops away on tablet/mobile).
- This **is** the YouTube layout the contributor described: statement = "video",
  right sidebar = where "live chat" goes. The Brainstorm block slots into this
  right column (above the section grid), and collapses below the statement when
  the sidebar stacks on mobile.
- Comments are **not** server-rendered: `#commentsList` is filled by client JS
  (`loadComments()`) hitting the comment API. `username` (from session) is passed
  to the template to gate the composer vs a login prompt.

### 1.3 The comment system (the closest analog, and the wiki-link precedent)

- Table `solution_comments`: `id, user_id (NOT NULL), problem_name, language,
  content, parent_id (self-FK, threaded), created_at, updated_at,
  is_deleted (BOOLEAN DEFAULT false)`. Indexed `(problem_name, language)`.
  **Scoped by `problem_name` + `language`.** ~89 rows.
- Likes are **on the problem, not the comment**: `solution_likes (user_id,
  problem_name, language, is_like BOOLEAN)`, unique per `(user_id, problem_name,
  language)`. **There is no per-comment like/reaction anywhere.**
- API (`index.js`):
  - `GET  /api/solutions/:problemName/:language/comments` (public read; builds a tree)
  - `POST /api/solutions/:problemName/:language/comments` (`checkAuthenticated`)
  - `PUT  /api/solutions/:problemName/:language/comments/:commentId` (owner, ≤24h)
  - `GET  /api/solutions/:problemName/:language/stats` (likes/dislikes/stars/comments)
  - `POST /api/solutions/:problemName/:language/like` / `…/star`
- **Wiki-linking already half-exists here.** `formatCommentContent()` in
  `solution_post.ejs` (≈line 1561) already turns:
  - `@username` → `<a href="/user/username">`
  - `#1.2.3` → `<a href="/{lang}/1.2.3">#1.2.3</a>`
  - `[text](https://…)` → external link (http/https only)
  The composer toolbar has dedicated `@` (mention) and `#` (problem) buttons with
  an autocomplete dropdown (`commentAutocomplete`). So the platform already has a
  bare-problem-number linkifier and a mention autocomplete — exactly the raw
  material for descriptive wiki links. What's missing is **descriptive** problem
  links (link *words*, not the number) and **storing** links as structured rows.

### 1.4 The chat / messages system (the real-time + reactions precedent)

- Tables: `conversations (is_group, title, …)`, `conversation_members
  (…, role, last_read_at)`, `messages (conversation_id, sender_id, content,
  created_at, edited_at, deleted_at, image_url)`, `message_reactions
  (message_id, user_id, emoji VARCHAR(8), UNIQUE(message_id,user_id,emoji))`.
- The "ALL chat" is a **group conversation** (`is_group = TRUE` with a `title`),
  not a special hardcoded room. Membership is explicit (`conversation_members`).
- **Real-time = polling.** `GET /messages/:id/poll?after=<lastId>&since=<ts>`
  returns `{ messages, updates, reactionUpdates }`: new messages with id > after,
  plus edits/deletes/reaction changes for messages the client already holds.
  Client calls this on a timer. No WebSocket, no SSE.
- **Reactions = toggle.** `POST /messages/:msgId/react` with one of a fixed
  `ALLOWED_REACTIONS` set (👍 👎 ❤️ 😂 😢 🤔), unique per (message,user,emoji),
  returns aggregated `{ emoji, count, me }`. **This is the per-message popularity
  mechanism the Brainstorm Room should reuse — by pattern, not by table, because
  `message_reactions.message_id` is FK'd to `messages(id)`.**

### 1.5 Auth, users, countries, permissions

- Current user: `req.session.userId`, `req.session.username`, `req.session.lang`.
- Middleware `checkAuthenticated` **redirects** unauthenticated users to
  `/{lang}/login` — fine for pages, wrong for pure-AJAX APIs (they want a 401
  JSON). CLAUDE.md explicitly allows "return 401 **or** redirect". For the
  brainstorm AJAX endpoints I propose a small JSON-aware guard that returns
  `401 {error}` (the room is JS-driven; a redirect body would be useless to it).
- `users`: `username, full_name, country_location` (mostly NULL — ~96% — so
  country display must degrade gracefully), `profile_picture`, `is_verified_user`
  (14 verified of 710). There is an admin layer in `admin.js`.
- Rate limiting pattern to copy: `editSaveLimiter` keys by `req.session.userId`
  (20/hour). I'll add a `brainstormPostLimiter` in the same shape.

### 1.6 Solved-vs-unsolved + the green/blue/purple coloring

- "Solved" = **the markdown file exists**: `parents.js` checks
  `fs.existsSync(posts/<lang>/<name>.md)`. `getSectionProblemsGrid(name, lang)`
  returns per-problem `{ solved (current lang), solvedOther (other lang) }`.
- Colors (in `solution_post.ejs` grid CSS, the "recent work" referenced):
  - **RU only** → green `#27ae60` (`--solved-ru`)
  - **EN only** → blue `#2471a3` (`--solved-en`)
  - **Both** → purple `#7d3c98` (`--solved-both`)
  - **Unsolved** → grey outline
- `renderPost` already computes `alternateFileExists` (the other language's file).
  So for a given page we cheaply know: this-lang solved (we're rendering it, so
  yes) + other-lang solved. A tiny helper can return `unsolved | solved-ru |
  solved-en | solved-both` for any problem without new DB work.

### 1.7 Storage conventions (for the "quiet mode" preference)

- `user_preferences` is a **fixed-column** table (one row per user): booleans like
  `email_notifications`, `show_country_on_leaderboard`, plus
  `theme_preference VARCHAR(20)`. It only covers **logged-in** users.
- `localStorage` is used in **exactly one** place: `views/blog/editor.ejs`
  (draft autosave). So localStorage is a *thin existing precedent*, acceptable for
  anonymous users, but **not** the primary mechanism — logged-in preferences live
  in `user_preferences`.

---

## 2. Key design decisions (and why)

### 2.1 Dedicated tables, not an extension of `solution_comments` — confirmed

Your instinct (dedicated table) is right, and here's the argument **from the
schema**:

1. **Different unit of engagement.** `solution_comments` has *no* per-row
   reaction mechanism; popularity there is impossible without inventing one. The
   Brainstorm Room's entire premise (rotate the *most-reacted* messages) requires
   per-message reactions. Reactions in this codebase live on `messages`, a
   different table. Bolting reactions onto `solution_comments` would change the
   meaning of an existing, in-use table (89 live rows, shown on every page).
2. **Different lifecycle & curation.** Brainstorm needs `is_pinned` (curator
   highlight), structured cross-links, and (Phase 5) a narrative role. Adding all
   that to `solution_comments` repurposes a table the rest of the site renders.
   CLAUDE.md + your constraints forbid repurposing existing columns/tables.
3. **Different read pattern.** Comments are read once (full tree per page).
   Brainstorm is read three ways: top-N (hot, cached), paginated room, and poll.
   That wants its own indexes (`reaction_count DESC`) without bloating the
   comments path.
4. **Clean separation = safe rollback.** New tables can be dropped wholesale to
   reverse the feature; touching `solution_comments` cannot.

We **reuse patterns** aggressively (reaction toggle, poll endpoint shape,
`formatCommentContent`, `is_deleted` soft-delete, `(problem_name, language)`
scoping, the rate-limiter shape), just not the *tables*.

### 2.2 Why per-problem table, not a `conversations` row per problem

The chat's `conversation_members` model is membership-gated (you must be added).
A brainstorm room is **public-read, open to every visitor of a problem page**, of
which there are ~2,023 problems × 2 languages. Creating a conversation + managing
membership for thousands of always-on public rooms is the wrong shape. A row
scoped by `(problem_name, language)` with no membership table is simpler, matches
`solution_comments`, and needs no per-room bootstrapping.

---

## 3. Data model (proposed)

### 3.1 `brainstorm_messages`

```text
id              SERIAL PRIMARY KEY
problem_name    VARCHAR(50)  NOT NULL          -- e.g. '7.3.6' (matches solution_comments)
language        VARCHAR(5)   NOT NULL          -- 'en' | 'ru'  (see open question Q1)
user_id         INTEGER      NOT NULL REFERENCES users(id) ON DELETE CASCADE
content         TEXT         NOT NULL
parent_id       INTEGER      REFERENCES brainstorm_messages(id) ON DELETE SET NULL  -- optional thread
is_pinned       BOOLEAN      NOT NULL DEFAULT FALSE     -- curator highlight
is_deleted      BOOLEAN      NOT NULL DEFAULT FALSE     -- soft delete (matches solution_comments)
reaction_count  INTEGER      NOT NULL DEFAULT 0         -- denormalized popularity (kept in sync on toggle)
narrative_role  VARCHAR(20)                              -- PHASE-5 HOOK: NULL | 'question'|'clue'|'breakthrough'|'recap'
created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()

INDEX (problem_name, language, created_at DESC)                 -- room pagination & poll
INDEX (problem_name, language, reaction_count DESC, created_at DESC)  -- hot top-N block
```

- `reaction_count` is denormalized so the rotating top-N query is an index scan
  (no GROUP BY on the hot path). It is recomputed atomically inside the reaction
  toggle (`UPDATE … SET reaction_count = (SELECT count …)`).
- `parent_id` is included now (cheap) even if the first UI is flat — it lets a
  great brainstorm spawn a thread and supports the detective "thread as story"
  framing later (Phase 5) without a migration.
- `narrative_role` is the **Phase-5 detective hook**: present, nullable, unused
  in Phases 1–4.

### 3.2 `brainstorm_reactions` (mirror of `message_reactions`)

```text
id           SERIAL PRIMARY KEY
message_id   INTEGER NOT NULL REFERENCES brainstorm_messages(id) ON DELETE CASCADE
user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE
emoji        VARCHAR(8) NOT NULL          -- reuse the chat ALLOWED_REACTIONS set
created_at   TIMESTAMPTZ DEFAULT NOW()
UNIQUE (message_id, user_id, emoji)
INDEX (message_id)
```

Popularity for the rotating block = `reaction_count` (sum of reactions). Pinned
messages float to the top regardless. Identical toggle semantics to chat.

### 3.3 `brainstorm_message_links` (structured wiki cross-links + cross-ref graph)

```text
id                   SERIAL PRIMARY KEY
message_id           INTEGER NOT NULL REFERENCES brainstorm_messages(id) ON DELETE CASCADE
target_problem_name  VARCHAR(50) NOT NULL    -- the referenced problem, e.g. '2.4.44'
target_language      VARCHAR(5)              -- nullable: link may be language-agnostic
link_text            VARCHAR(255) NOT NULL   -- the descriptive words shown (wiki-style)
created_at           TIMESTAMPTZ DEFAULT NOW()
INDEX (message_id)                            -- render links for a message
INDEX (target_problem_name)                   -- PHASE-5 HOOK: reverse cross-reference graph
```

This is the **Phase-5 cross-reference-graph hook** and the **wiki-link store**:
descriptive text + machine-readable target, queryable in both directions
("which problems link here?"). When a message is posted, the server parses both
bare `#x.y.z` mentions and descriptive links and writes the rows. Rendering can
then produce real `<a>` words instead of bare numbers.

### 3.4 `user_preferences` — additive column (logged-in quiet mode)

```sql
ALTER TABLE user_preferences
  ADD COLUMN IF NOT EXISTS brainstorm_display_mode VARCHAR(10) NOT NULL DEFAULT 'rotate';
  -- values: 'rotate' (animated, default) | 'static' (single top comment, no motion) | 'hidden'
```

One enum column covers the task's two quiet-mode sub-choices ("static top
comment" vs "hide entirely") plus the default. Non-destructive `ADD COLUMN`.
Anonymous users fall back to `localStorage` (precedent: blog editor) + the
`prefers-reduced-motion` default (see §6).

---

## 4. API surface (proposed)

New router module `brainstorm.js` (mirrors `messages.js`/`forum.js`/`blog.js`),
mounted in `index.js`. All reads are public; all writes are auth-gated +
rate-limited. JSON-aware auth guard returns `401` for these AJAX routes.

| Method & path | Auth | Purpose |
| --- | --- | --- |
| `GET /api/brainstorm/:problem/:lang/top?limit=5` | public | Top-N popular (pinned first, then `reaction_count DESC`) for the rotating block. **Cached** (§5). |
| `GET /api/brainstorm/:problem/:lang/messages?before=<id>&limit=30` | public | Paginated chronological room (newest→older). |
| `GET /api/brainstorm/:problem/:lang/poll?after=<id>&since=<ts>` | public | New messages + reaction/edit/delete updates. **Same response shape as the chat poll.** No membership gate. |
| `POST /api/brainstorm/:problem/:lang/messages` | user + `brainstormPostLimiter` | Post a message. Body: `content`, `parentId?`, parsed `links[]`. Writes `brainstorm_message_links`. |
| `POST /api/brainstorm/messages/:id/react` | user | Toggle reaction; updates `reaction_count`; returns aggregated reactions (chat shape). |
| `PUT  /api/brainstorm/messages/:id` | owner, ≤24h | Edit (mirrors comment edit window). |
| `DELETE /api/brainstorm/messages/:id` | owner ≤24h **or** admin | Soft delete (`is_deleted = true`). |
| `POST /api/brainstorm/messages/:id/pin` | curator/admin (Q2) | Toggle `is_pinned`. |
| `GET /:lang/:name/brainstorm` | public page | Full Brainstorm Room view (`brainstorm_room.ejs`). |
| `POST /api/brainstorm/:problem/:lang/quiet-mode` | user | Persist `brainstorm_display_mode` to `user_preferences`. |

All SQL parameterized. Writes wrapped in `try/catch`; multi-step writes (message
+ links) in a `BEGIN/COMMIT/ROLLBACK` transaction.

---

## 5. Real-time + caching

**Real-time: AJAX polling, copied from the chat — no new technology.**
- Full room: poll `…/poll?after&since` on a ~5s timer, paused via the Page
  Visibility API when the tab is hidden (don't hammer the hot page in background
  tabs). Identical to how the chat client consumes `/messages/:id/poll`.
- Rotating block: **does not poll.** It rotates client-side among an
  already-fetched top-N, and optionally refetches top-N every ~60s. The rotation
  is pure CSS/JS over data already in the DOM.

**Caching the hot top-N query (the problem page is the most-visited page):**
1. The block is **server-rendered on first paint** inside `solution_post.ejs`
   (the partial receives the top-N from `renderPost`), so a fresh page view costs
   **zero** extra client round-trips for the block.
2. The top-N is produced by a tiny in-process **TTL cache** (a `Map` keyed by
   `problem_name|language`, ~60s TTL), invalidated for that key on any
   post/react/pin to that problem. Cache miss is a single index scan thanks to the
   denormalized `reaction_count` index — no GROUP BY.
3. No Redis/memcached — staying inside the current stack (single Node process).
   If the app later runs multi-process, the TTL cache degrades gracefully (each
   process holds its own; worst case is 60s staleness), and can be swapped for a
   shared cache without API changes.

This keeps the added cost of the feature on a hot page to **≈0 on cache hit** and
**one index-only query on miss**.

---

## 6. Accessibility & motion (the rotating block)

- **Default off when the OS asks:** `@media (prefers-reduced-motion: reduce)` →
  no animation; show a single static top message. This is the *default*, not an
  afterthought.
- **Pausable + disableable:** visible "тихий режим / Quiet mode" control →
  `rotate | static | hidden`. Persisted to `user_preferences` (logged-in) or
  `localStorage` (anonymous).
- **Pause on hover and on focus**, resume on leave/blur. Rotation must **not trap
  focus**; links inside remain tab-reachable; the live region uses
  `aria-live="polite"` so a screen reader is not spammed by every rotation.
- Subtle fade / vertical ticker only — "refined news ticker, not a casino",
  reusing existing easing/colors (the vibrant `#27ae60 / #2471a3 / #7d3c98`
  accent palette is already the platform's language for this feature area).

---

## 7. Component breakdown

| File | New/!modified | Role |
| --- | --- | --- |
| `sql/migrations/026_brainstorm.sql` | new | Tables + indexes + `user_preferences` column (all `IF NOT EXISTS`/additive). |
| `sql/migrations/026_brainstorm_rollback.sql` | new | Companion reverse script (runner is forward-only) — documents/enables rollback. |
| `scripts/seed-brainstorm.js` | new | Idempotent realistic seed (a few messages + reactions on, e.g., `1.1.1` and `6.4.8`). |
| `brainstorm.js` | new | Express router: all APIs above + the room page. Owns the TTL cache + link parser. |
| `index.js` | modified | `require('./brainstorm')` and mount it (one block, mirrors how `messages`/`forum` are mounted). |
| `views/partials/brainstorm_block.ejs` | new | The right-column rotating block (server-rendered initial top-N). Included from `solution_post.ejs` sidebar. |
| `views/brainstorm_room.ejs` | new | Full room page (uses `main_site_header` partial). |
| `js/brainstorm-room.js` | new | Room client: poll loop, composer (with `#`/descriptive-link + `@` autocomplete reused), reactions, pin. Served from `/js` static. |
| `views/solution_post.ejs` | modified | Include the block in the sidebar; small inline rotation/quiet-mode JS (matches the page's inline-JS convention). Reuse existing `formatCommentContent` for rendering. |
| `css/design-system.css` | modified | Brainstorm block/room styles as CSS custom properties (per CLAUDE.md "new styles go here"). |
| `locales/en.json`, `ru.json` | modified | Brainstorm UI strings (title, quiet mode, CTA). Plus inline ternaries on the problem page to match local convention. |

---

## 8. Migration plan (reversible, non-destructive)

- **Forward** (`026_brainstorm.sql`): only `CREATE TABLE IF NOT EXISTS`,
  `CREATE INDEX IF NOT EXISTS`, and `ALTER TABLE … ADD COLUMN IF NOT EXISTS`.
  Nothing existing is dropped, renamed, or repurposed. Runs in the existing
  transactional runner (`npm run migrate`).
- **Reverse** (`026_brainstorm_rollback.sql`): `DROP TABLE IF EXISTS
  brainstorm_message_links, brainstorm_reactions, brainstorm_messages;` +
  `ALTER TABLE user_preferences DROP COLUMN IF EXISTS brainstorm_display_mode;`.
  Because the runner is forward-only, this is a documented manual script (run with
  `psql`), not auto-applied — but it makes the change fully reversible.
- **Seed** is separate (`scripts/seed-brainstorm.js`), idempotent, and never part
  of the schema migration, so production schema and dev data stay decoupled.

---

## 9. Solved-problem treatment (Phase 4 options — pick one)

Per the contributor: solved problems lose the open-question energy, so they need a
**different content selection and framing**, reusing the same data/components.
Three concrete options:

- **Option A — "Discussion & Insights".** Same rotating component, but selection =
  pinned + most-reacted *insight* messages and alternative-approach threads,
  titled "Обсуждение и идеи / Discussion & Insights" instead of an open call.
  Lowest build cost; reuses everything.
- **Option B — "Deepen your understanding".** The block surfaces **related harder
  problems** (via `brainstorm_message_links` reverse graph + same-section grid)
  plus a couple of Socratic prompts. Drives exploration; leans on the Phase-5 hook.
- **Option C — "Solution backstory" (detective).** The block shows a short,
  narrative-ordered set of `narrative_role`-tagged messages telling how the key
  idea was found — the detective framing the community responds to.

**Recommendation:** ship **A** as the solved-state default (cheapest, reuses the
rotating component wholesale), with a static **"related problems" strip (B)**
underneath, and treat **C** as a later content layer once `narrative_role` is
populated. Implement whichever you approve; the component differs only in *content
selection + label*, not in a separate system.

---

## 10. Phase-5 hooks (documented now, not built)

- **Cross-reference graph:** `brainstorm_message_links.target_problem_name` is
  indexed for reverse lookups. A future `/graph` can answer "which problems link
  to X" and "what does X link to" with no migration.
- **Detective / narrative framing:** `brainstorm_messages.narrative_role` +
  `parent_id` let a future UI render a thread as an ordered story (question →
  clue → breakthrough → recap) without schema changes.
- **Descriptive wiki links:** storing `link_text` separately from
  `target_problem_name` means rendering "the relativistic Doppler trick" as a link
  is a render-time choice, and the link is still queryable as structured data.

---

## 11. Open questions — need your call before Phase 1

1. **Scope key — `(problem_name, language)` or `problem_name` only?** Every
   per-problem feature here keys on *both* (comments, likes, stars). The
   contributor framed the room as "one problem, one implicit topic," which argues
   *language-agnostic*. **Recommendation: key on `(problem_name, language)` for
   consistency now;** a merged cross-language view is a later additive change.
   (Affects the schema, so I need this answer first.)
2. **Who can pin?** Admins only, or also `is_verified_user`, or the original
   solution author? **Recommendation: admins (+ verified users) for Phase 3.**
3. **Reaction set:** reuse the 6 chat emojis (👍 👎 ❤️ 😂 😢 🤔), or a
   brainstorm-specific set (e.g. 💡 idea, ❓ question, ✅ this-works)?
   **Recommendation: reuse the chat set in Phase 1; revisit for theming.**
4. **Anonymous quiet-mode persistence:** `localStorage` acceptable (precedent:
   blog editor) given there's no server pref for logged-out users?
   **Recommendation: yes — localStorage for anon, `user_preferences` for users.**
5. **Threading in the first UI:** keep `parent_id` in the schema now (cheap) but
   render a **flat** room first, threads later? **Recommendation: yes.**
6. **Solved-case option (§9):** A, B, C, or the recommended A+B hybrid?

---

## 12. Surprises / contradictions vs the brief (flagged per instructions)

- **MathJax is already v3**, not 2.7.7 as CLAUDE.md states (at least on the
  problem page). No action needed, just noting the doc is stale.
- **There is no per-comment reaction system at all** — `solution_likes` is
  per-*problem*. The only per-item reaction primitive is `message_reactions` on
  chat. This is *why* a dedicated brainstorm reactions table is necessary (we
  cannot "reuse the existing comment reactions" because none exist).
- **The migration runner is forward-only** (no down migrations). "Reversible"
  therefore means a companion rollback `.sql`, run manually — not an automated
  `migrate:down`.
- **`checkAuthenticated` redirects** rather than returning 401; for AJAX
  brainstorm endpoints I'll use a JSON 401 guard, which CLAUDE.md permits.

---

---

## 13. Phase 1 — locked decisions, unified-scope verification & what shipped

### 13.1 Decisions locked (your answers)

| # | Decision | Outcome |
| --- | --- | --- |
| Q1 | **Room scope** | **Unified by `problem_name` only.** One room per problem, all languages together. Solutions & `solution_comments` stay `(problem_name, language)` and are untouched. |
| Q2 | Pin permission | Admins (`username = 'astrosander'`) **+ verified users** (`is_verified_user`). |
| Q3 | Reaction set | Reuse the chat's six emoji (👍 👎 ❤️ 😂 😢 🤔). |
| Q4 | Anon quiet-mode | `localStorage` for anonymous, `user_preferences.brainstorm_display_mode` for logged-in. |
| Q5 | Threading | `parent_id` kept in schema; UI renders flat first. |
| Q6 | Solved case (§9) | Option **A** ("Discussion & Insights") **+ a related-problems strip that uses descriptive wiki links, not bare numbers**, framed so the `narrative_role` detective layer can drop in later without rework. |

### 13.2 Unified scope — concrete no-break verification (as requested)

I checked every place the language could have been load-bearing. Nothing breaks:

- **Comments / likes / stars** stay `(problem_name, language)` — brainstorm is in
  *separate tables*, so unifying cannot leak into them.
- **No FK, UNIQUE, or join** in the new schema depends on language.
  `brainstorm_reactions` is unique on `(message_id, user_id, emoji)`;
  `message_id` is global. Cross-links key on `target_problem_name` only.
- **Notifications need a language for the URL** (`/{lang}/{problem}/brainstorm`).
  Resolved without a scope: the notification uses the *posting* message's
  `language` tag. Not a break, just a choice.
- **`user_activities.target_language`** is already nullable — fine if we log
  brainstorm activity later.
- **The block renders identically on the EN and RU problem pages** for the same
  problem (same unified top-N). That is the *intended* effect of unification, not
  a regression.

**Conclusion: unified is safe; no downstream schema/join breaks.** Implemented as
specified.

### 13.3 The one schema nuance unification introduced

Each message still records the **language it was written in** as a *display tag*
(`brainstorm_messages.language`, nullable) — **never** as a scope/partition key.
This satisfies your "note that messages may appear in RU or EN" requirement and
seeds the future translation tooling, while keeping the room a single pool. The
seed data deliberately mixes RU and EN on the same problem to exercise this.

### 13.4 Deltas from the Phase-0 proposal (because of Q1)

- `brainstorm_messages` scope key is `problem_name` (the `language` column became a
  per-message display tag, as above).
- Indexes dropped `language` from the scope: `(problem_name, created_at DESC)` and
  `(problem_name, reaction_count DESC, created_at DESC)`.
- API paths dropped the `:lang` segment: `/api/brainstorm/:problem/...`. The
  posting language travels in the POST body (`lang`) / session, not the path.
- Cross-link rows store `target_problem_name` (+ nullable `target_language`),
  language-agnostic by default.

### 13.5 What Phase 1 shipped

| File | What |
| --- | --- |
| `sql/migrations/026_brainstorm.sql` | Additive: 3 tables + indexes + `user_preferences.brainstorm_display_mode`. All `IF NOT EXISTS`. |
| `sql/rollback/026_brainstorm_rollback.sql` | Reverse script. **Deliberately outside `sql/migrations/`** — the runner applies *every* `.sql` there, so a rollback placed alongside would auto-drop the feature. |
| `brainstorm.js` | Express router + the full JSON API (top / messages / poll / post / react / pin / edit / delete), the per-problem TTL cache, the `parseProblemLinks` wiki-link parser, JSON-401 auth guard, curator check, and a per-user post rate limiter. Exports `getTopBrainstormMessages` for the Phase-2 server render. |
| `index.js` | Requires + mounts the router at `/api/brainstorm` (picks up the global `apiLimiter`). |
| `scripts/seed-brainstorm.js` | Idempotent seed: 6 realistic RU/EN messages across `6.4.8` and `1.1.1`, with reactions, a pinned message, and descriptive + bare cross-links. |
| `tests/brainstorm.test.js` | 11 `node:test` unit tests for the link parser + reaction set (no new dependency). |
| `package.json` | `test` now runs the suite; added `seed:brainstorm`. |

### 13.6 Reversibility & non-destructiveness (restated, verified)

- Forward migration only `CREATE`s / `ADD COLUMN`s — nothing existing is dropped,
  renamed, or repurposed.
- Reverse script drops only the new tables + the new column, and clears the
  `applied_migrations` row so the forward migration can re-run.
- Because the runner is forward-only, the reverse script is **not** in
  `sql/migrations/` (that was a real foot-gun — caught and avoided).

### 13.7 How to test Phase 1 locally

```bash
npm install                 # (express-rate-limit etc. already in package.json)
npm test                    # 11/11 unit tests for the wiki-link parser — pass offline, no DB

npm run migrate             # applies 026_brainstorm.sql to your configured PG
npm run seed:brainstorm     # inserts demo messages/reactions/links (idempotent)
node index.js               # boot the app on :3000
```

Then exercise the API (reads are public; writes need a logged-in session cookie):

```bash
# rotating-block source (top-N popular, pinned first)
curl localhost:3000/api/brainstorm/6.4.8/top

# full room, newest-first, paginated
curl "localhost:3000/api/brainstorm/6.4.8/messages?limit=30"

# near-real-time poll (new since id 0)
curl "localhost:3000/api/brainstorm/6.4.8/poll?after=0"
```

A `parseProblemLinks` sanity check without a DB:

```bash
node -e "console.log(require('./brainstorm').parseProblemLinks('CoM idea [like here](#6.4.7), cf #2.4.44'))"
# => [ { targetProblemName: '6.4.7', linkText: 'like here' },
#      { targetProblemName: '2.4.44', linkText: '#2.4.44' } ]
```

> Migrations and seeding were **not** run against the live AWS RDS database — that
> is yours to run in your environment, per the stop-for-review process. The SQL is
> standard and the JS is syntax-checked + unit-tested.

### 13.8 Still open for Phase 2+

- Quiet-mode persistence endpoint (`POST …/quiet-mode`) lands in **Phase 2** with
  the block UI (the column already exists from this migration).
- The Brainstorm Room **page route** (`GET /:lang/:name/brainstorm`) + views land
  in **Phase 3**; only the JSON API exists today.
- Mention notifications were intentionally left out of Phase 1 to match the
  comment system (only reply notifications are wired).

---

## 14. Phase 2 — the rotating right-side block

### 14.1 What shipped

| File | What |
| --- | --- |
| `views/partials/brainstorm_block.ejs` | The server-rendered block: title (RU "Комната мозгового штурма" / EN "Brainstorm Room"), the quiet-mode controls, all top-N messages pre-rendered into a crossfade ticker, dots, a CTA into the room, an empty-state, and a collapsed/restore affordance. |
| `css/design-system.css` | `.bs-*` component styles using the design tokens (subtle crossfade + vertical-ticker motion, no gradients, ≤8px radius, the vibrant `#7d3c98` accent), plus the `prefers-reduced-motion` override. |
| `js/brainstorm-block.js` | Vanilla progressive enhancement: rotation, pause-on-hover/focus, quiet/hidden modes, preference persistence, reduced-motion handling, `inert` on hidden messages. |
| `brainstorm.js` | Added `formatBrainstormHtml` (server render of message bodies → safe HTML with wiki links), `getUserDisplayMode`, and `POST /api/brainstorm/quiet-mode`. |
| `post.js` | `renderPost` now fetches the cached top-N + the user's display mode and passes them (with the formatter) to the template. |
| `views/solution_post.ejs` | Restructured the right column into a `.right-rail` (Brainstorm block on top, section grid below); included the block; loaded the script. Layout/responsive CSS updated. |

### 14.2 How the requirements were met

- **YouTube layout.** The statement stays the main column; the block sits in the
  right rail (where "live chat" lives), above the section grid. The 2-column grid
  was kept; only the right column was wrapped in `.right-rail`.
- **Mobile.** At ≤991px the grid collapses to one column and the block flows
  **below** the statement. The section grid stays hidden (as before); the block
  does not (it's outside the hidden `.sidebar`, inside `.right-rail`).
- **Rotation.** All top-N messages are server-rendered (good first paint, no
  flicker, SEO-visible); the script only crossfades which is active every 6s.
- **Pausable + disableable.** A pause/play control toggles **rotate ↔ static**
  (quiet); a hide control collapses to a one-line restore bar. Three modes:
  `rotate | static | hidden`.
- **Persistence.** Logged-in → `POST /api/brainstorm/quiet-mode` → `user_preferences.brainstorm_display_mode`. Anonymous → `localStorage` (the
  one storage mechanism already used in the repo — `blog/editor.ejs`). No new
  storage tech.
- **Accessibility.** Rotation pauses on hover **and** focus; `prefers-reduced-motion`
  defaults to no motion (CSS + JS); hidden messages are `inert` + `aria-hidden`
  so focus is never trapped on an invisible item; the region is marked
  `aria-roledescription="carousel"` and does **not** use a noisy `aria-live`.
- **Wiki links in the ticker.** `formatBrainstormHtml` renders `[text](#x.y.z)`
  and bare `#x.y.z` as real descriptive `<a>` words, `@user` as profile links,
  protects `$…$`/`$$…$$` so MathJax typesets normally, and is XSS-safe
  (escape-then-linkify, same order as the existing comment renderer).
- **Performance.** The block is server-rendered from the 60s TTL cache, so a hot
  problem-page view adds **no** client round-trip and at most one index-only query
  per minute per problem.

### 14.3 Known/intentional for now

- The CTA points at `GET /:lang/:name/brainstorm`, which **404s until Phase 3**
  builds the room page. Wiring the destination is Phase 3's job.
- Solved vs unsolved is **not yet differentiated** — the same block shows on both.
  Phase 4 changes the *content selection + framing* for solved problems (Option A
  + a descriptive-wiki-link related-problems strip), reusing this same component.

### 14.4 How to test Phase 2 locally

```bash
npm run migrate && npm run seed:brainstorm   # ensure demo data exists
node index.js
# open http://localhost:3000/ru/6.4.8  (a seeded problem)
```

Check: the block appears top-right and rotates; hovering/focusing pauses it; the
pause button freezes it (quiet) and the eye button collapses it; reloading keeps
your choice (logged-in via DB, guest via localStorage); set the OS "reduce motion"
flag and confirm it loads static; narrow the window past 991px and confirm the
block drops below the statement while the section grid disappears; click a `#x.y.z`
link in a message and confirm it goes to that problem.

> Templates, the partial (all branches), the client script, and `formatBrainstormHtml`
> were compile-/render-/syntax-checked and the unit suite stays green (11/11). The
> app was not booted against the live RDS — running it is yours.

---

## 15. Phase 3 — the full Brainstorm Room

### 15.1 What shipped

| File | What |
| --- | --- |
| `views/brainstorm_room.ejs` | The room page: breadcrumb + back-to-problem link, title scoped to the problem, a "messages may be RU or EN" note, the messages container, the composer (with a wiki-link toolbar) or a login prompt, and a safe JSON config blob (`window.BSR`) carrying the initial messages + i18n strings. |
| `js/brainstorm-room.js` | The room client: renders messages, **polls** `…/poll` every 5s (paused when the tab is hidden), posts, toggles reactions, pins (curators), edits/deletes own messages, loads older pages, and renders wiki links + math (MathJax). Mirrors the server formatter for consistency. |
| `css/design-system.css` | `.bsr-*` room styles (messages, reaction chips + picker, composer, inline edit, responsive). |
| `brainstorm.js` | Added `renderRoom` (page handler; validates the problem via `getProblemBreadcrumbParts`, works for **unsolved** problems too), extracted `fetchRoomMessages` (shared by the messages API + the page), made `formatBrainstormHtml` multiline-capable, and simplified `serializeMessage` (pin is a page-level `isCurator` capability, not per-message). |
| `index.js` | Registered `GET /:lang(en|ru)/:name/brainstorm` **before** the `/:lang/:name` catch-all. |

### 15.2 How the requirements were met

- **Dedicated view + direct URL.** `/:lang/:name/brainstorm`, reachable from the
  block CTA and directly. `lang` only controls chrome; the room itself is unified.
- **Message display.** Author, country, RU/EN language chip, relative timestamp,
  body, reactions, pinned state, and **descriptive wiki links** rendered as
  clickable words.
- **Post / react / pin.** All wired to the Phase-1 API. Pinning shows only for
  curators (admins + verified users); delete shows for the owner (≤24h) or admin;
  edit for the owner (≤24h) — matching the backend's authorization exactly.
- **Real-time = polling**, reusing the chat's mechanism (`…/poll?after&since`
  returning `{messages, updates, reactionUpdates}`). No new real-time tech. Paused
  on tab-hidden via the Page Visibility API; new messages de-duplicated by id.
- **Scoped + linked back.** The room is labelled with the problem and links back
  to the statement (breadcrumb + a "Back to problem" button).
- **Wiki-style composer.** A "Problem" toolbar button collects a number + optional
  descriptive text and inserts `[text](#x.y.z)`; bare `#x.y.z` typed in prose is
  **auto-detected** server-side and rendered as a link. Descriptive links are the
  priority and fully supported; the structured link rows are written on post/edit.

### 15.3 Design choices worth noting

- **Messages render client-side** from a server-embedded JSON blob (consistent
  output for initial + polled + posted messages, one renderer to maintain). The
  page is `noindex` (interactive app view; the solution page remains the SEO
  surface). Trade-off: no-JS users can read the block on the problem page but not
  the live room — acceptable for a chat that requires JS to participate anyway.
- **`isCurator` is computed once per page load**, not per message, so the 5s poll
  never costs an extra `is_verified_user` query.
- **`renderRoom` does not gate on a solution file existing** — unsolved problems
  get a room (the whole point of the feature). It validates the problem id via the
  chapter/section data instead.

### 15.4 How to test Phase 3 locally

```powershell
npm run migrate:brainstorm   # if not already applied
npm run seed:brainstorm
node index.js
```

Open `http://localhost:3000/ru/6.4.8/brainstorm` (a seeded problem):

- The seeded RU/EN messages appear oldest→newest; the block CTA on the problem
  page now lands here.
- Post a message (Ctrl/⌘+Enter or Send); it appears immediately and persists.
- Click the "Problem" toolbar button → enter `6.4.7` + "the CoM trick" → it
  inserts `[the CoM trick](#6.4.7)`; after posting it renders as a clickable word
  linking to that problem. A bare `#2.4.44` typed in prose also auto-links.
- Hover a message → react (toggle an emoji), and as a curator pin/unpin, edit, or
  delete. Open a second browser/incognito and watch changes appear within ~5s via
  polling.
- An unsolved problem (e.g. one with no solution file) still opens a working room.

> Backend reload, EJS render of the room (with header/search includes resolved and
> a safe messages blob), and both client scripts were syntax/render-checked; the
> unit suite stays green (11/11). Not booted against live RDS.

### 15.5 Deferred to Phase 4+

- Solved-problem differentiation (Phase 4): Option A "Discussion & Insights" + a
  descriptive-wiki-link related-problems strip, reusing the block component.
- Threaded replies remain schema-only (`parent_id`); the room renders flat (Q5).

---

## 16. Phase 4 — the solved-problem case ("Discussion & Insights")

### 16.1 A platform reality that shaped this phase

`renderPost` only renders `solution_post.ejs` when the solution markdown file
exists; unsolved cells link to `/upload`. **So every problem page on the live site
is a solved problem** — there is no unsolved problem-statement page today. That
means the Phase-4 "solved" variant is the one that actually appears on the site,
and the Phase-2 "open brainstorm" framing is reserved for a future unsolved-page
context (the component still supports it). The open-question energy meanwhile
lives in the full **Brainstorm Room**, which every problem links to.

### 16.2 What shipped (Option A, as approved)

| File | What |
| --- | --- |
| `brainstorm.js` | `getRelatedBrainstormLinks(problem, lang)` — builds the related strip from the **cross-reference graph** (outgoing + incoming `brainstorm_message_links`), preferring stored descriptive `link_text` and falling back to the target's **section title** for bare mentions, so links are always meaningful phrases — never bare numbers. 5-min cached. A `narrative_role` Phase-5 hook comment marks exactly where a detective/story ordering slots into the top-N query. |
| `post.js` | Computes `brainstormVariant = 'insights'` (the page is always a solved problem) and fetches the related links; passes both to the template. |
| `views/partials/brainstorm_block.ejs` | Variant-aware: title "Обсуждение и идеи / Discussion & Insights", `fa-comments` icon, an insight-framed empty state, a "Open the discussion" CTA, and the **related-problems strip** of descriptive wiki links. Same rotating ticker + quiet-mode + a11y as Phase 2. |
| `css/design-system.css` | `.bs-related` strip styles; hidden along with the rest in collapsed mode. |

### 16.3 How it satisfies the brief

- **Not the same block.** Solved problems get a distinctly framed variant
  (Discussion & Insights) — different title, icon, empty state, CTA, and the added
  related strip — *reusing the same component, data, and rotation*, differing only
  in content selection/framing (exactly the constraint).
- **Insight-biased selection.** The ticker reuses the top-N (pinned-first, then
  most-reacted), which already surfaces the most-valued contributions — the
  elegant/alternative approaches — rather than open questions.
- **Descriptive related links.** The strip renders linked *phrases* (the stored
  wiki text, or the section title as a fallback), never bare problem numbers —
  the contributor's explicit requirement.
- **Detective framing drop-in.** `narrative_role` is selected and surfaced through
  the data layer, and the top-N query carries a comment marking where a narrative
  ordering attaches — so the story treatment can be added later with **no rework**.

### 16.4 How to test Phase 4 locally

```powershell
npm run migrate:brainstorm   # if needed
npm run seed:brainstorm
node index.js
```

Open `http://localhost:3000/ru/6.4.8` (seeded): the right-rail block is now titled
**"Обсуждение и идеи"**, rotates through the best contributions, and shows a
**"Связанные задачи"** strip linking *"the energy-balance argument"* (descriptive)
and *"Законы Кеплера"* (section-title fallback for the bare `#2.4.44`). The CTA
reads "Открыть обсуждение" and still opens the Brainstorm Room.

> Both block variants were render-checked, the module graph loads, `solution_post`
> compiles, and the unit suite stays green (11/11). Not booted against live RDS.

### 16.5 Note for the reviewer (a judgment call I made)

Because every problem page is solved, the Phase-2 "Brainstorm Room"-titled block no
longer appears on problem pages — it's replaced by the "Discussion & Insights"
variant there, which is the approved solved-case treatment. The brainstorm
branding still lives on the full room page (`/:lang/:name/brainstorm`). If you'd
rather keep the "Brainstorm Room" framing on problem pages and treat Insights as an
addition, that's a one-line flip of `brainstormVariant` in `post.js` — tell me and
I'll change it. (Update: with §17 the full "Brainstorm Room" conversation is now
embedded inline on the problem page anyway, so its branding is back on the page —
the rail block is the "Discussion & Insights" teaser that scrolls down to it.)

---

## 17. Inline conversation on the problem page (no separate-page click)

Feedback: clicking through to `/:lang/:name/brainstorm` to converse added friction.
The full Brainstorm Room is now **embedded directly on the problem page**, so
reading and posting happen in place — fewer clicks, more effortless.

### 17.1 What changed

- **Reusable panel.** Extracted `views/partials/brainstorm_room_panel.ejs` (message
  list + composer + reactions + the `window.BSR` config + the room script). The
  problem page and the standalone `/brainstorm` page both include this one partial
  — a single source of truth for the conversation UI.
- **Embedded inline.** `solution_post.ejs` renders the panel in a labelled
  "Brainstorm Room" section (`#brainstormRoom`) just above the solution comments.
- **The rail block became a teaser.** The rotating "Discussion & Insights" block's
  CTA now points at `#brainstormRoom` — it just **scrolls down** to the live
  conversation instead of navigating away.
- **Standalone page kept.** `/:lang/:name/brainstorm` still works (shareable direct
  link, and ready for future unsolved-problem pages); it reuses the same panel.

### 17.2 Performance — lazy, so the hottest page pays nothing

The problem page is the most-visited page, so the conversation is NOT fetched on
every view:

- Messages **lazy-load on first visibility** (IntersectionObserver on the room) —
  or when the reader focuses the composer, or follows a `#brainstormRoom` link.
  Readers who never scroll to it trigger zero message queries and no polling.
- **Anonymous page views add no brainstorm queries at all** (top-N block is cached;
  `canCurate` returns false without a DB hit when there is no session user).
  Logged-in views add one cheap indexed `is_verified_user` lookup.
- Polling only starts after the conversation is opened, and pauses when the tab is
  hidden (Page Visibility API).

### 17.3 Client changes (`js/brainstorm-room.js`)

- Lazy first-load via IntersectionObserver; `BSR.messages` is `null` and fetched
  client-side (the server no longer embeds the first page).
- The messages list is now its **own bounded scroll container** (an inline chat
  box, `max-height` + `overflow`), so the conversation never makes the problem page
  huge; "load earlier" preserves scroll position.
- Same posting / reactions / pin / edit / delete / polling / wiki-link behaviour.

### 17.4 How to test

```powershell
npm run migrate:brainstorm   # if needed
npm run seed:brainstorm
node index.js
```

Open `http://localhost:3000/ru/8.1.4` and scroll down (or click the rail block's
"Открыть обсуждение", which scrolls): the full conversation is right there on the
page — post, react, pin, edit, link a problem, all without leaving. Messages only
fetch once you reach the section (nothing brainstorm-message-related fires on
initial load until the room scrolls into view). The direct URL `…/8.1.4/brainstorm`
still opens the same conversation as a page.

> All four templates compile; the standalone room, the inline panel, the block CTA,
> and a full `solution_post.ejs` render (exactly one `window.BSR`, both scripts
> loaded once) were verified; unit suite green (11/11). Not booted against live RDS.

---

## 18. Live chat in the right rail (the YouTube layout, finally literal)

Feedback: replace the rotating "Discussion & Insights" teaser ("Открыть
обсуждение") with **the live conversation itself, on the right of the solution** —
like a YouTube live stream's chat next to the video. Solution = the video (main
column); the live Brainstorm Room = the chat (right rail).

### 18.1 What changed

- **The right rail IS the live chat now.** `solution_post.ejs` renders the room
  panel (`roomRail: true`) directly in `.right-rail`, above the section grid. No
  rotation, no teaser, no click-through — the actual streaming conversation.
- **One panel per page.** Removed the rotating block (`brainstorm_block.ejs` +
  `js/brainstorm-block.js` are now unused) **and** the below-content embed, so the
  page has exactly one `window.BSR` / one room instance.
- **Quiet mode kept (important for focus).** The rail header has two controls:
  *pause* (тихий режим — freezes the live feed: stops polling, no new messages pop
  in) and *collapse* (свернa thin restore strip). Three states `rotate` (live) /
  `static` (paused) / `hidden` (collapsed), **persisted** in
  `user_preferences.brainstorm_display_mode` (logged-in) or `localStorage`
  (guest) — the same mechanism the old block used; `prefers-reduced-motion`
  disables the message fade.
- **Responsive.** On desktop the chat is the sticky right column (stays beside the
  solution as you scroll); below 992px `.right-rail` flows under the solution, so
  the chat sits below the statement on phones — the section grid stays hidden.
- **Standalone `/brainstorm` page** still works (panel with `roomRail: false`,
  full-width, no rail chrome).

### 18.2 Behaviour & performance

- Messages **lazy-load on first visibility** (IntersectionObserver), gated by mode:
  collapsed never loads until expanded; paused loads once but does not stream; live
  loads + polls. Polling pauses on tab-hidden and whenever the reader pauses/​
  collapses. Newest at the bottom; "load earlier" preserves scroll position.
- **Anonymous problem-page views add no per-user brainstorm queries** (no top-N,
  no `canCurate`/`getUserDisplayMode` for guests); the only always-on query is the
  cached related-problems strip. The conversation itself isn't fetched until the
  reader's viewport reaches the rail.
- A subtle fade-in on new messages gives the "live" feel; disabled under
  reduced-motion.

### 18.3 Files

- `views/partials/brainstorm_room_panel.ejs` — gained `roomRail` mode (header +
  pause/collapse controls + restore bar + related strip) and `displayMode` config.
- `js/brainstorm-room.js` — quiet-mode state machine (pause/collapse/expand +
  persistence) and mode-gated lazy-load/polling.
- `views/solution_post.ejs` — rail renders the live chat panel; rotating block +
  below-content embed + `brainstorm-block.js` removed.
- `post.js` — drops the top-N/teaser data; passes `brainstormMode` (initial quiet
  state), `brainstormIsCurator`, `brainstormReactions`, `brainstormRelated`.
- `css/design-system.css` — `.bsr-room--rail` styles (compact messages, header,
  pause/collapse/restore, live fade).

### 18.4 How to test

```powershell
npm run migrate:brainstorm   # if needed
npm run seed:brainstorm
node index.js
```

Open `http://localhost:3000/ru/6.4.8`: the live Brainstorm Room is the right-hand
column next to the solution (YouTube live-chat layout). Post a message — it streams
in; open a second window and watch it arrive within ~5s. Hit **pause** (тихий
режим) to freeze the feed, or **collapse** to tuck it into a one-line strip;
reload and the choice persists. Narrow the window past 992px and the chat moves
below the solution. The direct `…/6.4.8/brainstorm` URL still opens the same room.

### 18.5 Deprecated (left in place, not deleted)

`views/partials/brainstorm_block.ejs`, `js/brainstorm-block.js`, and the rotating
`.bs-block*/.bs-ticker/.bs-dot` styles are no longer referenced (superseded by the
rail live chat). Kept in the tree in case the rotating teaser is wanted for a
future *unsolved* problem-statement page; say the word and I'll delete them.

> Syntax/compile/render verified: rail + standalone panels, a full `solution_post`
> render (one `window.BSR`, `brainstorm-room.js` once, no rotating block / no
> `brainstorm-block.js` / no stray inline embed), and the chat sits inside
> `.right-rail`. Unit suite green (11/11). Not booted against live RDS.
