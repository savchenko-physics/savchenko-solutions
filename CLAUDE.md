# CLAUDE.md — Savchenko Solutions

## What This Is
SavchenkoSolutions.com is a collaborative platform for peer-reviewed solutions to Savchenko's Problems in Physics, one of the hardest physics problem collections in the post-Soviet world. 1,516 solutions, 72 contributors from 18 countries, 150,000+ users from 150+ countries. All content free under Creative Commons CC BY-SA 4.0.

## Front-End Assets
All render-critical third-party libraries are **self-hosted**, not loaded from a CDN
(see "What NOT to Do"). No page depends on an external origin to render.
- `css/vendor/` — Bootstrap 5.3.3, Bootstrap Icons, Font Awesome 6.4.0 + 4.7.0,
  CodeMirror 5.65.10 CSS, and `fonts/`. The site's own type lives in `fonts/h/`: content-hashed
  WOFF2 files served with a one-year immutable cache (mounted before `/css` in `index.js`), built
  by `scripts/build-fonts.py` from TeX Live (New Computer Modern, CM Unicode) and IBM's Plex
  release zips, which also writes `fonts/site-fonts.css` and `lib/siteFonts.json`. Re-run it only
  when a character set or a font changes; the build is reproducible. `fonts/stix-two-math.css` is
  for the two symbol palettes (editor, `/tools/latex`). The older Inter/Roboto/Noto/JetBrains/LMR
  files are unreferenced since 2026-09-14 and can be deleted in a later deploy.
- **Every page gets its stylesheets from `views/default/site_styles.ejs` and nowhere else**
  (fonts preloads, Bootstrap, vendor CSS, `bundle.css`, maths CSS), included once in `<head>`
  before the page's own `<style>`, with what the page needs passed as data:
  `include('default/site_styles', { ssStyles: { math: true, prose: true, icons: 'fa6' } })`.
  `tests/site-styles.test.js` finds every rendered page and enforces it.
- `js/vendor/` — Bootstrap JS, Popper, Chart.js, D3, marked, html2canvas, jQuery,
  CodeMirror JS + modes/addons. The solution page loads `icons: 'fa6-subset'`: the twenty
  Font Awesome glyphs it and the header use, 3 KB of font instead of 150 (`scripts/build-fa-subset.py`;
  `tests/site-styles.test.js` fails when a template uses an icon the subset lacks).
- **Problem links.** A problem number in a rendered statement or solution is a link to that problem
  (`lib/problemRefs.js`, on the HTML after the maths; the book's 2,023 numbers only, never inside a
  formula, a script or an existing link). While the cursor rests on any link to a problem (that, a
  grid dot, an unsolved chip) `js/problem-peek.js` shows its statement above the cursor, as a PDF
  reader previews a reference, from `/:lang/problems/statements`; the card sits strictly above
  the link (anchored by its bottom edge, capped to the room) and its figures carry width and
  height. An unsolved problem's address and every dot for one open `/:lang/problems?q=<number>`:
  the statement and the upload button. `lib/statementRender.js` shows a still-flattened row
  (`needs_review`) from the post's own statement section (`lib/postStatement.js`), repairs a
  stray opening `$` and opens a paragraph at "б." — the four rows that had the stray `$` were
  fixed in migration 059, and `scripts/build-statements.js` no longer produces it.
- **Grids** (homepage chapters, a solution page's section, `/unsolved`) are coloured by difficulty
  only, `body.grid-heat` on those pages (2026-09-19: the language colouring and its switch are
  gone); dashed = unsolved, heavy border = Savchenko's ∗, bold numerals; the heat rules outrank
  `a:link` by specificity, not `!important`.
- **Formulas copy as TeX.** Every server-typeset formula carries its source beside the SVG
  (`$…$`, `$$…$$`, or the environment) in a `font-size: 0` span — the one hiding Chrome keeps in
  a copy — and `js/math-select.js` paints a selected formula in the site's selection colour.
  Already typeset containers are protected from a second pass, so rendering stays idempotent.
  A bare `\begin{equation}…\end{equation}` is typeset as display maths. **A formula never
  crosses a block-level tag** (2026-09-20): the maths pass runs over the whole solution page, and
  `$\alpha$$l$` in /ru/1.4.18's answer paired its `$$` with one further down and ate the rest of
  the page. Block tags get their own placeholder in `protect()` and every pass stops at it, so
  what a post file holds can drop no tag outside its own paragraph. `tests/math-blocks.test.js`.
- MathJax 3 is served from the installed `mathjax-full` package at `/vendor/mathjax/`
  (mounted in `index.js` and `sandbox/sandbox-app.js`); keep that dependency installed.
- Server-rendered maths (`mathRender.js`) sets the glyphs MathJax's TeX font lacks — the
  Cyrillic units and subscripts inside `$…$` in nearly every Russian solution — in a
  self-hosted Computer Modern Unicode (`css/vendor/fonts/files/cmun*-math.woff2`, OFL) and
  lays them out from that font's advance widths (`lib/mathFallbackFont.json`, built by
  `scripts/build-math-fallback-font.py` from TeX Live's cm-unicode). Before that the server
  guessed 0.6 em per letter in whatever serif the visitor had, and "10 кОм" lost half its "м"
  on `/ru/upload` (2026-09-02). **Every page that shows server-rendered maths must pass
  `ssStyles: { math: true }`** — `/css/mathjax.css` carries MathJax's `overflow: visible` and
  the `@font-face` rules. Its `?v=` is the md5 of `getMathCss()` computed at boot
  (`app.locals.mathCssVersion`), so there is nothing to bump. Server formulas are sized in `em`
  at SS Text's x-height (0.431), not in `ex`, so they do not change size while the text font
  loads. `tests/math-fallback.test.js`. **Memory:** from 2026-09-03 to 2026-09-19 this renderer
  killed the app every 10–20 hours ("Ineffective mark-compacts near heap limit", 596 restarts, a
  1.3 GB core dump each): mathjax-full 3.2.2's textmacros package never releases the parser it
  creates for each `\text{…}` (cleared after every conversion now), each cache key was a slice
  pinning the whole page it came from (copied flat now), and 20,000 two-byte SVG strings were
  ~370 MB by themselves (UTF-8 buffers under `MATH_CACHE_MB`, 32 by default, least recently
  used out first). `memoryStats()` reports the cache and what MathJax still holds;
  `tests/math-memory.test.js` renders a thousand `\text{}` formulas three times in a child
  process with the garbage collector exposed and fails if pass three costs heap.
- **Chat attachments** are stated once in `lib/messageAttachments.js`: images play inline, videos
  play inline in a `<video>` since 2026-09-19 (asked in the Russian chat), audio files are a player
  card (mp3, m4a, wav as they are; ogg, opus, flac converted to m4a), documents are download cards;
  25 MB for a file, 100 MB for video or audio, all read by `messages.js`, the page's composer and
  its tooltip from that module. A picture or a video sent "as a document" (the send dialog's
  checkbox, `as_document=1`) is a card with `attachment_status = 'document'` and is never converted.
  Browsers send file names in UTF-8 and busboy read them as Latin-1, so "Савченко.pdf" was stored
  as mojibake until 2026-09-19: `fixFileName` in `messages.js` reads the bytes back
  (`tests/message-file-names.test.js`); the rows from before were repaired in place. **Every video plays in every browser** because a video that is not
  already H.264 4:2:0 + AAC in an mp4 (the one thing browsers agree on) is converted to it after
  upload by `lib/videoTranscode.js` with the ffmpeg on the box (installed 2026-09-19; the first
  video ever sent was OpenCV's MPEG-4 part 2, which nothing plays): re-encoded at up to 1280 px,
  one thread, nice 19, choom 900, one job at a time, or only re-wrapped when just the container is
  wrong (mov, mkv). Meanwhile the row has `attachment_status = 'converting'` (migration 057) and
  shows a card saying so; on completion every message with that upload (forwards share it) gets
  the `-web.mp4` URL, size, box and a blurred first-frame placeholder, members are told over SSE
  `msg:update`, and the original is deleted; a failure leaves `'failed'` and the download card. A
  restart resumes whatever was converting (`resumeConversions`); `VIDEO_CONVERT=off` disables it.
  A video's pixel size comes from the container (`lib/videoMeta.js`: ISO BMFF `tkhd` with its
  rotation matrix, or Matroska `PixelWidth`/`PixelHeight`) into `image_width`/`image_height`, so
  the bubble reserves its box like an image does. **The chat's look is Telegram Desktop's, with
  the site's own left/right sides kept** (the owner, 2026-09-19): media fills the bubble edge to
  edge up to a 430 × 430 box (`mediaBox`, the same in the template and the script), the caption
  sits under it, the time and ticks sit inside the bubble after the last line (`float: right`, the
  bubble is `flow-root`) or in a pill on a caption-less picture, a video shows its first frame, its
  length and a play button and hands over to the browser's controls on the first click. The
  right-click / long-press menu carries the reactions strip on top, plus Copy Image and Save As.
  A click on a picture or a video opens the viewer (`#mediaViewer`): the chat's media in order,
  arrows, ← → and swipe between them, the caption over the lower part, "Photo N of M" with the
  sender and time, a thumbnail strip, download, Esc or the backdrop to close; a video plays there
  with the browser's controls. The sidebar search filters the chats under "Chats" and lists people
  from `/messages/search-users` under "Global search results", each a chat away; the sidebar
  shows and orders chats by their newest message that is not deleted, and deleting one moves
  `conversations.last_message_at` back to the previous message. The chat's name in the header
  opens its info panel (`#chatInfo`, Telegram's "profile" of a chat): avatar, name, members or
  handle, quick actions (mute, search, profile, manage or leave), then what the chat holds
  (photos, videos, files, audio, links: `GET /messages/:id/info` counts them, `GET
  /messages/:id/media?kind=` lists them 60 at a time, both members-only, kinds by the same
  extension lists as the uploads) as lists inside the panel; a picture there opens the viewer,
  a link entry jumps to its message.
  A file from the picker, a drop anywhere on the chat column or a paste opens the send dialog
  (preview — a video plays from the file itself, one the browser cannot decode says it will be
  converted — a caption, the "send as a document" choice). **Several at once** (2026-09-21, up to
  10 by any of the three routes): the dialog shows them as tiles, each with a cross, and every one
  becomes its own message, uploaded one after another so they arrive in the order chosen, the
  caption and the reply on the last (under the pictures, as under a Telegram album); a picture
  or video tile opens in the media viewer on click. Uploads go by XMLHttpRequest so the
  pending card shows progress; no attachment is accepted with under 1 GB free on the disk (507); deleting a
  video message removes its file unless a forward still shows it (other kinds keep their files,
  as before). `tests/message-attachments.test.js`, `tests/video-meta.test.js`,
  `tests/video-transcode.test.js` (the last two run ffmpeg when installed).
- The sandbox app serves `/css`, `/js`, `/img` from the main app's directories — it is a
  separate Express app on its own subdomain and would otherwise 404 on shared assets.
- **Reactions** (chat and solution comments) have one vocabulary, `js/reactions.js`: six
  Unicode emoji (👍 ❤️ 🙏 🔥 😂 🤔) plus the community's own emoji, hand-drawn SVGs in
  `img/emoji/` (the in-jokes of the two community chats and the comments: "юный джедай",
  "Печеньки!!!", "подгон под ответ"…), both ordered most used first. 👎 (never used in four
  months) and 😢 (three uses) were retired for 🙏 and 🔥 on 2026-09-13. A custom one is stored
  as its `:shortcode:` in the same `emoji` column (VARCHAR(32) since migration 052;
  `brainstorm_reactions` stays 8 and keeps its old six). **Never delete a registry entry** —
  retire it (`retired: true`, or `RETIRED_STANDARD` for Unicode), or the reactions people left
  can no longer be taken back. `/img` is gitignored, so new emoji need `git add -f img/emoji/<name>.svg`. The art
  rules (64-unit viewBox, palette, no text/gradients/scripts, ≤ 4 KB) live in `scripts/lib/svg-art.js` and are
  enforced by `tests/reactions.test.js`. Since 2026-09-15 ten entries are **premium** (`price` in quanta,
  `price: Infinity` never for sale, `trophy` awarded, `sale` window): owning one is a row in
  `reaction_unlocks`, both reaction endpoints answer 403 `locked` otherwise (`lib/reactionUnlocks.js`), taking
  one back always works, and the pickers grey them out until `js/apps/launcher.js` learns what the member owns.
- **«Последняя задача»** (`lastProblem.js`), a one-time prediction mini app opened from a card under a message in
  the community chats, as a Telegram mini app opens from a bot. The market asks which of the problems unsolved on
  2026-09-15 will be solved last; every account gets 1000 quanta (ħ, `img/apps/last-problem/coin.svg`), prices
  come from an LMSR market maker (`js/lmsr.js`, b = 1000), quanta buy the premium reactions. Play money, no cash
  value. A problem drops out when a real post appears (checked every 2 minutes, `syncSolved`; the untouched
  `/create-problem` template does not count, nor a post with nothing written in it, `hasWrittenSolution`, since
  "asd" in the /upload template knocked 5.8.9 out on the first evening). **Conservation of interest** (the owner's rule since the first
  evening, migration 055): a solve burns the solved problem's shares and pays every holding still in play interest
  at p / (1 − p) of the solved problem's price p, on what those shares fetch right after (`js/lmsr.js` `solve`,
  `lib/lastProblem.js` `settleSolve`, one ledger row per position `solved:<tick>:<problem>`); `lp_market.scale`
  shrinks by (1 − p) so no price per share jumps and a complete set of shares is worth the same before and after.
  So a problem solved near the end pays off even if it is not the last; one left → decided → its shares pay
  their full value (shares × scale) after 72 h. A chat bet is refundable only until the first solve after it.
  `--revert` takes back a solve's interest as far as balances allow and restores the scale. Page
  `views/apps/last_problem.ejs` + `js/apps/last-problem.js` (in an iframe sheet when `?embed=1`), card and sheet
  `js/apps/launcher.js` (loaded by `messages.ejs` and `solution_post.ejs`), copy `lastProblemCopy.js`, pure rules
  `lib/lastProblem.js`, tables from migration 054. It opened with a seed (`scripts/seed-last-problem.js
  --dry-run|--apply|--revert <problem>`): Laplace's demon, a house trader with no account, spread 800 ħ over a
  survival model's top ten, and the two bets Valter and emixter named in the chat. `LAST_PROBLEM=off` plus a
  restart takes it off the site. `tests/last-problem.test.js`. Since 2026-09-18, from three days of play (14 of
  32 solved by five people, five traders, nobody able to afford a reaction): whoever first posts a real
  solution of a market problem gets `SOLVER_BOUNTY` (150 ħ; `payBounties` in the sync, ledger `bounty`
  `solved:<tick>`, back-paid for the first 14); the market is held at `MARKET_DEPTH` 1000 ħ of liquidity after
  every solve (`deepen`: b and every q times one factor, so no price moves); reactions cost 1100 to 1800. The
  demon's forecast is `data/lp-forecast.json`, from `scripts/last-problem-research.js` (on the server,
  read-only) and `scripts/last-problem-forecast.py` (the weekly hazard model; the buy form shows each
  problem's chance of being solved within 7 days), and `scripts/last-problem-demon.js --dry-run|--apply`
  trades the demon towards its fair weights (`rebalancePlan`). The Рейтинг tab ranks people by quanta earned,
  trading plus bounties (`earnedOf`, `rankBoard`); the demon is shown apart as the benchmark, never ranked.
- **Birth-year turns, 2,007 and 2,008** (`lib/founderYear.js` `TURNS`, 2026-09-18). emixter's birth-year
  challenge in the chats says whoever was born in the year the solved count reaches solves the next problem.
  While the count (the homepage's) is exactly 2,007, a problem's **first post in either language** (`/api/upload`,
  `/create-problem`) answers 423 to everyone but astrosander (user 28); at exactly 2,008 to everyone but Valter
  (user 2543); 2,009 is open. Edits (the save route), translations and drafts are never held: holding edits on
  the first day stopped Daniyar from correcting a solution (2026-09-19). `/upload` says why. Inert past 2,008;
  delete it then. `tests/founder-year.test.js`.

## Tech Stack
- **Runtime:** Node.js
- **Framework:** Express.js 4.21.1
- **Templates:** EJS with express-ejs-layouts
- **Database:** PostgreSQL (AWS RDS) via `pg` module
- **Sessions:** PostgreSQL via connect-pg-simple
- **Auth:** Custom bcrypt + express-session (no Passport in practice)
- **CSS:** Bootstrap 5.3.3 (self-hosted, `css/vendor/`) + custom CSS files
- **Math:** MathJax 3 (self-hosted at `/vendor/mathjax/`); solution pages render LaTeX to SVG server-side (`mathRender.js`)
- **Editor:** CodeMirror 5.65.10 (edit page only)
- **No SPA framework. No TypeScript. No bundler.** One build step only: `npm run build:css`.

## Architecture
Monolithic server-side rendered Express app. All pages are EJS templates. Client-side JS handles search, form validation, CodeMirror, and Chart.js. Entry point is `index.js` (~2200 lines). A separate sandbox app runs on port 4000 (`sandbox/sandbox-app.js`).

**The problem database's readers' mode.** `/:lang/problems?rated=1` keeps only the problems readers
have rated (the votes under the AI panel of a solution page) and shows that rating in place of the
model's, ordered by it; the methodology page's "оценка читателей" leads there.

**Languages in addresses.** Every page router is mounted at its bare address and under `/en`
and `/ru` (`/blog` and `/ru/blog`, `/discuss` and `/en/discuss`, …). The bare address speaks the
session's language; a prefixed one sets `req.urlLang` for that request, which the routers read
before the session, so `/ru/blog` is Russian even for a visitor botgate does not count (the
session is only written for counted visitors, to keep crawlers out of the session table). The
header's RU / EN link is **this page in the other language**: `lib/langSwitch.js` computes it
for every request from `req.originalUrl` (prefix swapped or added, query kept, `error` /
`success` flashes dropped) and `index.js` puts it in `res.locals`; only the 404 page, the
Russian-only `/summit` and the recovery pages (which say their language in `?lang=`) pass their
own. Until 2026-09-19 the link went to the homepage from nearly every page, the solution page
included. `tests/lang-switch.test.js` checks the rule, the mounts and the reads.

**Server speed (2026-09-19).** Every page renders in tens of milliseconds on the box; what made
them slow was never the work. (1) **One connection pool**, `lib/db.js`, for every module and the
session store (scripts keep their own): 53 module pools each dropped their connection after 10 s
idle and a new one costs ~95 ms of TCP + TLS to RDS against 1–2 ms per query, so a solution page
paid several handshakes; the pool keeps two connections for good, the rest for 30 min, runs
without parallel query (RDS spent 20 ms launching workers for 0.4 ms of work) and logs a dropped
idle connection instead of crashing on it. (2) **Stale-while-revalidate caches**, `lib/swr.js`:
a held value is served at once and refreshed behind the reader once older than its ttl — the
homepage widgets, the profile and contributors payloads, the finder datasets, the unsolved page's
view totals; the homepage, the datasets and the twelve top profiles are filled at boot. (3) The
**view cache is on** regardless of NODE_ENV (`VIEW_CACHE=off` for local work): a template change
needs a restart. (4) The solution page gathers its lookups in one `Promise.all` and records the
view after answering; the contributors page ships its five API answers in the HTML
(`lib/inProcess.js`, as the profile does). `parents.js` holds the CSVs and the posts listing (5 s).
Measure with `curl -w %{time_starttransfer}` on the box and a CPU profile through the inspector
(`kill -USR1`), never guess: the "slow query" was worker start-up, the "slow render" was EJS
compiling.

## File Structure
```
index.js                          # Main Express app (all routes)
utils.js                          # Markdown parsing, XSS validation
post.js                           # Solution rendering + view tracking
upload.js                         # Upload router
accountRecovery.js                # Forgot password, reset link, recovery appeal (rules: lib/passwordReset.js)
digest.js                         # The weekly summary email (the email itself: lib/digestRender.js)
contributions.js                  # Contribution display
contributorsUserMetricsApi.js     # Leaderboard and user stats API
userProfile.js                    # User profile rendering
unsolved.js                       # Unsolved problems display
sitemap.js                        # Sitemap XML generation
parents.js                        # Chapter/section data

views/                            # EJS templates (39 files)
posts/en/                         # English solution markdown files
posts/ru/                         # Russian solution markdown files
css/                              # Stylesheets
js/                               # Client-side JavaScript
img/                              # Images (per-problem subdirectories)
locales/en.json, ru.json          # i18n translations
src/database/                     # CSV data (chapters.csv, sections.csv)
pdf/                              # Textbook PDFs
```

## Database Tables (key ones)
Counts measured 2026-07-31. 61 tables in total; `sql/migrations/` only creates the ones
added after the GitHub-Pages migration, so `users`, `contributions`, `solution_comments`,
`solution_reports` and friends have no `CREATE TABLE` anywhere in the repo.
- `users` — 964 accounts, but only 118 ever seen online and **94 have ever contributed**
- `contributions` — 8,137 edits; 2,157 of them (27%) have `user_id = NULL`, from the era
  when anyone could edit anonymously
- `github_contributions` — 11,493 edits (pre-migration, from GitHub Pages era)
- `solution_comments` — 318 comments, **61% of them written by two people**
- `solution_likes` — 742 likes/dislikes
- `solution_reports` — 63 reports, **62 still pending**, mean age 245 days. Admin UI at
  `/admin/reports`; also surfaced on `/admin/feedback`
- `feedback_items` / `feedback_votes` / `poll_answers` — the suggestion box, the public
  board and the one-question poll (migration 042). All three accept anonymous writes
- `messages` / `conversations` — user-to-user DMs, groups, and the two **community chats**
  (`conversations.community_lang` = `'ru'` / `'en'`, migration 051; the Russian one is the
  old site-wide conversation 5). Every account is in both; registration joins both and mutes
  the one not in the signup page's language (`lib/communityChats.js`). **Muted conversations
  don't count toward the header's unread badge.** The messenger's pages live at
  `/ru/messages[/:id|/saved]` and `/en/messages…` (`lib/messagesUrls.js`); a bare `/messages/…` page
  address redirects there with its query, while the JSON and SSE endpoints stay unprefixed. Every
  page of a signed-in member polls `GET /messages/pulse` (`js/pulse.js`, loaded by the header) and
  shows a card for a new DM, small-group message, reply or @mention (`lib/pulse.js`), updating the
  header badges in place. Leaving a community chat is refused (mute
  instead). The split itself was a one-off, `scripts/split-community-chat.js` (`--undo` with
  the backup in `deploy-backups/`). Above 25 members a conversation does not fan out one
  notification per member, only to members who have posted there (`notifications.js:84`)
- `page_views` / `recent_views` — view tracking
- `user_preferences` — privacy and notification settings (**only 19 rows for 964 users**)
- `user_activities` — activity log (follows, likes, stars, comments)
- `starred_solutions` — bookmarked problems
- `special_contributions` — flagged edits (blocked IPs, emoji content)
- `problem_statements` (4,046) / `problem_difficulty` (2,023) — see Content Structure
- `session` — Express session store
- `quanta_wallets` / `quanta_ledger` / `lp_market` / `lp_outcomes` / `lp_ticks` / `lp_positions` /
  `reaction_unlocks` — «Последняя задача» (migrations 054, 055): balances with every change logged, the one market
  row (the demon's money and interest are counted there, and the `scale`), one row per problem with its LMSR `q`,
  every trade and elimination with a price snapshot (the chart) and a solve's interest `rate`, holdings with the
  interest each earned, and owned premium reactions (a trophy belongs to one person)
- `password_reset_requests` — every "Forgot password?" and recovery appeal, with `outcome`
  (migration 053). Its email rows are what the recovery limits count, per account and
  site-wide (`LIMITS` in `lib/passwordReset.js`), under an advisory lock in
  `accountRecovery.js`, and mail only ever goes to an address already on an account. **Never
  send recovery mail from anywhere else**; before 2026-09-15 `/recover-account` emailed any
  address typed into it, with no rate limit
- `email_sends` — one row per email the site attempts (migration 056), with its kind (a
  notification type, `digest`, `password_reset`, `email_verify`, `email_change`), the
  thread it was about, and `sent` / `failed` / `suppressed`. It answers "how many emails did we
  send, and to whom" in one query, and it is what the limits count: an address gets at most
  `LIMITS.perAddressPerHour` / `perAddressPerDay` (`lib/mailGuard.js`), a notification about one
  thread is not repeated within the hour, and a follower is announced once a month. Recovery
  and signup mail are exempt from the ceiling on purpose. On 2026-09-16 a follow/unfollow
  toggle put ten identical emails in one inbox in 27 seconds; replayed against the two months
  before the fix, 233 notification emails become 142

## Security — open issues
1. **No CSRF protection anywhere.** Zero occurrences of `csrf` outside `node_modules`. The
   only mitigation is the session cookie's `sameSite: 'lax'` (`index.js:121`). The
   exceptions: the account-recovery forms and every money-moving POST of «Последняя задача»
   (`guardWrite` in `lastProblem.js`) refuse cross-site posts by `Sec-Fetch-Site` / `Origin`
   (`isCrossSite` in `lib/passwordReset.js`).
2. **`apiLimiter` is a no-op.** `index.js:146` sets `max: Number.MAX_SAFE_INTEGER`, so
   mounting it on `/api/` at `:191` protects nothing. Any new public endpoint must bring its
   own limiter (see `feedback.js`).
3. **`editSaveLimiter` collapses every signed-out visitor into one bucket** —
   `keyGenerator: (req) => String(req.session?.userId ?? 'anonymous')` (`index.js:182`). Same
   pattern in `brainstorm.js:168`. Key on `ipKeyGenerator(req.ip)` instead; a bare `req.ip`
   is also wrong, because one IPv6 client owns a whole /64.
4. **`express.static(path.join(__dirname, "src"))`** still exposes the Python source
   directory publicly.

### Fixed since this list was first written — do not "re-fix" these
Anonymous edit / upload / create-problem are all `checkAuthenticated` now (`index.js:2852`,
`upload.js:29`, `index.js:1652`). `SESSION_SECRET` throws on startup if unset
(`index.js:84`). Rate limiting exists (`express-rate-limit`, six limiters at
`index.js:130-186`). Password reset and email verification both ship (migrations 003, 015,
035); account recovery was rewritten on 2026-09-15 (username or address, case-insensitive,
flood limits in the database, token moved out of the URL; migration 053). The report queue
has an admin UI (`admin.js:140-215`) — the real problem is that
**62 of 63 reports are still pending at a mean age of 245 days**, which is a closure
problem, not a UI one; the `/admin/feedback` tab surfaces the backlog. The IP blocklist
moved to the `blocked_ips` table (migration 002).

## Known Technical Debt
- jQuery 1.10.1 still loaded on every page (nothing requires it)
- **`npm run build:css` is a required step, not an optional one.** Every page loads
  `/css/bundle.css`, which `scripts/build-css.js` builds from `fonts/site-fonts.css`, the data
  palettes in `js/palettes.js`, `design-system.css` and `main_page.css`. Editing either stylesheet
  without rebuilding ships invisible CSS; `tests/site-styles.test.js` fails on a stale bundle.
- Search scans filesystem on every query (no search index)
- **`views/default/modern_footer.ejs` is not on every page** (the editor, the chat and admin
  have none by design; solution pages have it since 2026-09-14). Only
  `views/default/main_site_header.ejs` is genuinely on every page, so anything that must
  appear site-wide belongs there.
- Dead templates, zero includes: `modern_header.ejs`, `header_mobile.ejs`, `footer_en.ejs`,
  `footer_ru.ejs`, `eng_page_old.ejs`, `profile.ejs`, `post.ejs` (only the standalone
  `markdownParser.js` and `profile.js`, which nothing requires, render the last two).
  `header.ejs` is a one-line alias for `main_site_header.ejs`.
- **Dead `en.json` / `ru.json` at the repo root**, unrelated to `locales/*.json` and loaded by
  nothing. Edit only the files in `locales/` — they are tab-indented, and `updateFiles: false`
  (`index.js:2522`) means hand edits are safe.
- `express.static(path.join(__dirname, "src"))` exposes Python source directory publicly
- Instagram field deprecated but column still in database
- Windows path separators in image paths (`\\` instead of `/`)
- Features shipped with essentially zero usage, worth knowing before building another one:
  `bank_*` tables (0 rows across the whole problem bank), `bank_difficulty_votes` (0),
  `votes` (4), `user_interests` (4, three from one person), `user_preferences` (19 rows for
  964 users). Anything gated behind sign-in on this site collects nothing.

## Design System
All new UI must follow these rules. The system is the tokens in `css/design-system.css` §1
(type, colour, space, radius, shadow, widths), the Bootstrap bridge in §2, base elements §3,
reading type §4 and components §5; it was introduced by the September 2026 typography
unification (plan and research: 39 font stacks, 110 sizes and 291 colours before). Use the
tokens and components; `tests/design-rules.test.js` and `tests/design-tokens.test.js` check
every declaration on every live page, and `scripts/codemod-design-tokens.js` maps literal
values onto tokens (`--check` in CI-style runs, `/* ss-codemod: off */` to exempt a region).

### Colors
- Primary navy: #1a1a2e
- Text: #2d2d2d (never pure black)
- Secondary text: #6c757d
- Links: #1a5276 (hover: #0d3b54)
- Borders: #dee2e6
- Card backgrounds: #f8f9fa
- Page background: #ffffff
- Success: #27ae60
- Error: #c0392b

In CSS always the tokens (`--ss-navy`, `--ss-text`, `--ss-text-secondary`, `--ss-link`,
`--ss-rule`, `--ss-surface-alt`, …). #27ae60 is for fills only (2.9:1 as text): success *text*
and white-on-green fills use `--ss-success-strong` (#1b7a43). Greys lighter than
`--ss-text-secondary` (`--ss-text-tertiary`) are for placeholders, separators and icons, never
content. Data colours (difficulty heat ramp, language states, activity, rank tiers) exist once,
in `js/palettes.js`, and reach CSS as generated `--ss-heat-*` / `--ss-lang-*` variables.

### Typography
Four families, self-hosted, never a system font stack:
- **SS Text** — New Computer Modern Book, the Computer Modern of Savchenko's 3rd edition and of
  the server-rendered TeX: statements, solutions, prose, knowledge-page titles, problem numbers.
- **SS Sans** — IBM Plex Sans (400, 600, italic): the whole interface.
- **SS Mono** — IBM Plex Mono: code and the editor.
- **SS Display** — CMU Sans Serif Demi Condensed (the book's title page): the wordmark and big
  titles only. **SS Symbols** (NewCM Math) supplies the few glyphs Plex lacks, above all
  Savchenko's ∗ — write it as `<sup class="ss-star">∗</sup>`.

Exactly ten sizes: 12 13 14 16 18 20 24 28 32 40 (`--ss-fs-*`), used through role tokens
(`--ss-text-label` 12, `-meta` 13, `-ui` 14, `-body`/`-input` 16, `-lead`/`-h3` 18, `-h2`,
`-h1`, `-display`, `-title`, `-prose` 18→20 at 768px). Weights: interface 400/600, serif
400/700. Line heights 1.2 / 1.35 / 1.5 / 1.6. Prose (`.ss-prose`) is ragged right with
hyphenation and a 1em paragraph indent, as journals set text.

### Rules
- No gradients anywhere (hard-stop half fills that mark a language are data, not decoration)
- No shadows other than `var(--ss-shadow)` (`0 1px 3px rgba(0,0,0,0.08)`)
- No border-radius larger than 8px (`--ss-radius-sm` 4, `--ss-radius` 6, `--ss-radius-lg` 8);
  50% only for avatars and dots; no `rounded-pill` / `rounded-4` classes
- No emojis in the UI. The one exception is reactions: the pickers and chips under chat
  messages and solution comments show the vocabulary in `js/reactions.js` (six Unicode emoji
  and the community set in `img/emoji/`), and nothing else may borrow it except the shop of
  «Последняя задача», which sells the premium ones. Its own art (the ħ coin, Laplace's demon)
  follows the same drawing rules (`scripts/lib/svg-art.js`)
- No "Built with love" or similar filler copy
- **No em dash, colon or semicolon in the site's own prose either** (the owner, 2026-09-20): the
  methodology page, the 22 axis explanations (`lib/difficultyAxes.js`) and every blog post by
  astrosander were rewritten that way (the posts live in `blog_posts`; the rows before the rewrite are
  in `~/deploy-backups/blog-posts-before-*.json` on the box). Times (23:59), URLs, TeX and table
  syntax keep theirs. Write new copy the same way.
- **Page titles** (`<title>`, og:title, twitter:title) contain no em dash, en dash, colon or
  semicolon; parts are joined with ` | `. Build them with `docTitle(...parts)` and pass any
  database or user text through `titleText()` (`lib/pageTitle.js`, both `app.locals`).
  `tests/page-titles.test.js` checks every template's source
- Inputs: 40px height, border 1px solid #dee2e6, border-radius 6px, **16px text** (below that iOS
  zooms on focus; `design-system.css` enforces it as a floor)
- Buttons primary: background #1a1a2e, text #ffffff, border-radius 6px (Bootstrap `.btn-primary`
  and `.btn-dark` are mapped onto this; `.btn-outline-dark` is the secondary button)
- One focus style: `:focus-visible` 2px `--ss-link` outline; `outline: none` only as
  `:focus:not(:focus-visible)`
- Images in solutions carry width and height so nothing moves while they load; fallback font
  faces are size-matched for the same reason
- The site should feel like arXiv meets GitHub. Academic, clean, no-nonsense.

## Coding Standards

### JavaScript
- Vanilla JS only. No jQuery for new code.
- Use `const` and `let`, never `var`.
- Use template literals for string interpolation.
- Use async/await, not callbacks or raw promises.
- All database queries must use parameterized queries (`$1`, `$2`). Never concatenate user input into SQL.

### Express Routes
- All POST routes that modify data MUST check `req.session.userId`. If not authenticated, return 401 or redirect to login.
- Use `try/catch` around all database operations.
- Return proper HTTP status codes (200, 201, 400, 401, 404, 500).
- Flash messages for user-facing errors, JSON for API errors.

### EJS Templates
- Use `<%- include() %>` for shared partials.
- Escape all user-generated content with `<%= %>` (not `<%- %>`).
- Keep logic minimal in templates. Compute values in the route handler.
- `js/local-time.js` keeps the reader's zone in the `ss_tz` cookie (a year, `SameSite=Lax`); the
  messenger reads it (`readerTimeZone` in `messages.js`) and writes its times and day separators
  in that zone and the page's language from the start, and the page rewrites them only when its own
  zone differs (`TIMES_ARE_LOCAL`). Until then they used to flip from UTC to local on every chat
  switch. A first page without the cookie keeps them out of sight (`.msg-times-utc`) until rewritten.
- **Every date or time of an event goes through `<%- localTime(value, kind, lang) %>`** (`lib/localTime.js`,
  kinds `date longdate day daytime datetime time month relative recent`): it writes a `<time data-local>` in UTC
  that `js/local-time.js` (loaded by the header, and by the few pages without it) rewrites in the reader's time
  zone and the page's language. Never `toLocaleDateString()` on the server: it runs in UTC. A calendar date stored
  as UTC midnight (DATE columns, seeded rows) passes `{ calendar: true }` so it is not shifted into the day
  before. SQL day buckets (heatmaps, view charts) are still UTC days. `tests/local-time.test.js` fails on a new
  server-formatted time in a template.

### CSS
- New styles go in `css/design-system.css` using CSS custom properties.
- Use Bootstrap 5 utility classes where possible.
- No inline styles in EJS templates.
- Mobile-first: write base styles for mobile, use `@media (min-width: 768px)` for desktop.

### Database
- All queries use the `pool` object from `pg`.
- Use `RETURNING *` on INSERT/UPDATE when you need the result.
- Use transactions (`BEGIN`/`COMMIT`/`ROLLBACK`) for multi-step operations.
- Index any column used in WHERE clauses on large tables.

## Content Structure
- 14 chapters, 77 sections, 2,023 total problems (the third column of
  `src/database/sections.csv` is authoritative and sums to exactly 2,023)
- Problem statements live in the `problem_statements` table, 4,046 rows — one per problem
  per language, built by `scripts/build-statements.js`. Savchenko's own `∗` harder-problem
  marker is the `starred` column, 565 of 2,023, and is the only independent difficulty
  ground truth the project has: never feed it to a scoring model.
- **The 3rd edition is the reference for Russian statements and for every figure.**
  `pdf/savchenko.pdf` is a pdfTeX file (exact text layer, figures as 300 dpi bitmaps
  with "К задаче N" drawn inside them), not a scan — the scan is the 4th edition,
  `pdf/savchenko-4th-ed.pdf`, served at `/savchenko-4th-ed.pdf` and used for nothing else.
  `scripts/book3/` turns the 3rd edition into
  `src/database/book3/`: `extract.py` (text, ∗, ♦ = has-figure, from fonts and positions),
  `figures.py` (attributes every bitmap by OCR-reading its caption, writes
  `img/<problem>/statement.png` and `figures.json`), `vectorize.py` (traces those bitmaps
  with potrace into `statement.svg` — transparent, a few KB, crisp at any zoom; the SVG's
  own width/height attributes carry the display size; `figures.json` points at the SVGs,
  the PNGs stay as the trace source and as what `posts/` still embeds), `compare.py` /
  `assemble.py` (the site's
  markdown is kept only where its Cyrillic words and digits equal the book's; otherwise the
  book text, model-typeset by `typeset.py` under invariants that reject any changed word,
  digit, Latin or Greek symbol), `render-check.js` (MathJax must render every statement).
  `build-statements.js` prefers these files when present. A problem the book does not mark
  ♦ gets no figure even if a `statement.png` exists — that fallback is how 8.3.3 showed
  8.3.4's circuit. Do not hand-edit `figures.json`; fix `OVERRIDES` in `figures.py`.
  **Posts show the SVG** since 2026-09-20: the owner switched section 1.1 by hand and
  `scripts/svg-statement-figures.js` did the other 848 posts on the server the same way
  (`--apply`; a dry run by default; backup `~/deploy-backups/posts-before-svg-figures-20260920T072843Z.tgz`
  on the box), with no `contributions` rows: `statement.png`, or a contributor's own crop of the
  book figure captioned "К задаче N" / "For problem N" or with no alt, becomes
  `![alt|<viewBox>, <pct>%](../../img/N/statement.svg)`, the share of the 800 px basis being half
  the SVG's 300-dpi width (1.2 × the printed size) with a lift for small and flat figures, so every
  figure shows the book at one magnification. It leaves a section with several images, a
  contributor's own captioned drawing, and the twenty problems whose book bitmap was never split
  from a neighbour's (`SHARED_BITMAP`; 5.4.6's SVG shows 5.4.7 too, `figures.py` OVERRIDES needed);
  296 posts with an SVG show no figure at all. `tests/svg-statement-figures.test.js`.
- Problem naming: `chapter.section.problem` (e.g., 1.1.1, 14.5.24). `lib/bookProblems.js` `isBookProblem` says
  whether a number is one of the 2,023. A real problem's address with no post in that language redirects (302) to
  the other language's solution, or to `/:lang/problems?q=<number>` (its statement and the upload button) when there is none; only a non-problem is a 404
  (`post.js` renderPost, since 2026-09-15).
- Solutions stored as markdown files in `posts/en/` and `posts/ru/`. **`posts/` on the
  server is the contributors' work and the only authoritative copy**: the site's editor
  writes it directly (a pre-edit copy goes to `posts-old/`, the saved text to
  `contributions.new_content`), and the repo's copy lags behind. Never rsync local posts to
  the server and never let a script rewrite them — the statements table is the place for
  generated text.
- Custom markdown image syntax: `![alt|WxH,scale%](../../img/folder/file)`
- **Solutions are structured when displayed, never in the files.** `js/solution-structure.js`
  (shared by `post.js` and the editor preview) turns the headings, in all nine spellings the
  posts use, into typeset sections: the statement as a card, answers in a box (including the
  397 posts that put the answer into the heading), the leading `$2.1.32.$` as the book's number
  with ∗ from `problem_difficulty.starred`. `SS_STRUCTURE=off` in the environment turns it off
  without a deploy. `transformImageMarkdown` drops the "К задаче N" caption on `statement.*`
  figures, because the book's bitmap already carries it.
- LaTeX inline: `$...$`, display: `$$...$$`

## What NOT to Do
- Do NOT introduce TypeScript, React, Vue, Next.js, or any SPA framework.
- Do NOT add new npm dependencies unless absolutely necessary. Check if vanilla JS or an existing dependency can do the job.
- Do NOT modify the database schema without documenting the migration in `sql/migrations/`.
- Do NOT expose internal IPs, emails, or database credentials in client-side code.
- Do NOT send email except through `email.js`. It is the only place that counts what an
  address has already received (`lib/mailGuard.js`) and logs the send (`email_sends`); a sender
  that goes straight to SES is uncounted, uncapped and invisible.
- Do NOT mail people per event. Notifications send nothing; `digest.js` collects the week and
  sends one summary on **Saturday at 06:48 UTC**, to people who had news that week, and only
  that. The slot is measured, not chosen: `scripts/digest-best-time.js` scores every minute of
  the week by how much of the audience is on the site after a send, weighted by how fast this
  audience opens mail, and `--apply` writes the winner to `data/digest-schedule.json`, which
  `digest.js` reads at startup. The app's timer fires at the minute and an hourly cron runs
  `scripts/send-digest.js --send --if-due` behind it; neither can double-send, because a person
  who had a digest in the last six days is not a candidate.
  Immediate mail is what an account needs to work (reset, verify, email change). A digest
  carries no images either: mail clients block them, and Gmail fetches through a proxy that
  sends no `Accept-Language`, which botgate answered with 403 until rule 8 (2026-09-16).
  `scripts/send-digest.js` builds and writes the week without sending it.
- Do NOT use `res.send()` for HTML pages. Use `res.render()` with EJS templates.
- Do NOT add social media features (stories, reels, feeds). This is an academic tool.
- Do NOT add AI features (chatbots, auto-generated solutions). Every solution must be
  human-written. Two narrow exceptions exist, both about *metadata*, never content:
  `scripts/score-difficulty.js` rates human-written problems on the axes in
  `difficultyRubric.js`, and `scripts/repair-ru-latex.js` re-typesets the mathematics in
  the Russian statements recovered from the scanned book (notation only — the prose is
  checked word-for-word against the original and a changed statement is rejected).
  Neither writes physics. Anything that would author or complete a solution is still out.
- Do NOT load stylesheets, fonts, or scripts from any third-party origin (jsdelivr, cdnjs, unpkg, Google Fonts, code.jquery.com, …). Every such origin is a single point of failure: a corporate or ISP web filter that blocks that one hostname leaves the site unstyled or broken for everyone behind it. This actually happened — `cdn.jsdelivr.net` is blocked by filters that classify it as a malware-distribution host, and Bootstrap was loaded from it on every page. Vendor new libraries into `css/vendor/` or `js/vendor/` and reference them with an absolute local path. `npm test` enforces this (`tests/external-assets.test.js`).
- Analytics (`googletagmanager`, `mc.yandex.ru`) is the one allowed exception: it is injected asynchronously and the page is fully usable without it.
- Do NOT register a service worker. Firefox bypasses its image cache on any page a worker controls, so every avatar and figure reloaded on each navigation (measured 2026-09-12: 33–166 ms of blank avatars per chat switch). `public/sw.js` is now a self-unregistering kill switch and must stay (a 404 would strand old workers); pages call `unregister()`. `tests/service-worker.test.js`.

## Testing
- `npm test` runs `node --test tests/` — Node's built-in runner. **No Jest, no test
  dependency**, and adding one is not wanted; the rationale is written down at
  `tests/brainstorm.test.js:1-10`.
- Suites include `botgate.test.js`, `external-assets.test.js`, `statements.test.js`,
  `brainstorm.test.js`, `feedback.test.js`, `community-chats.test.js`, `password-reset.test.js`,
  `page-titles.test.js`, `service-worker.test.js`, `reactions.test.js`, `last-problem.test.js`, `local-time.test.js`,
  `book-problems.test.js`, and the design system's
  `site-styles.test.js`, `site-fonts.test.js`, `design-tokens.test.js`, `design-rules.test.js`
  and `solution-structure.test.js`.
- Rendering is checked outside `npm test`: `scripts/qa/type_audit.py` renders every page type in
  headless Chrome (families, sizes, overflow, layout shift, formula counts) and compares two runs
  as contact sheets; `scripts/check-solution-structure.js` runs the solution transform over a
  copy of the server's `posts/` with MathJax. Both write outside the repo.
- There is **no test database**, so route handlers are not integration-tested. The house
  pattern is to export the pure decision logic from a module and test that
  (`parseProblemLinks`, `validateFeedback`), then say plainly in the file header what is left
  uncovered.
- Two conventions worth keeping: a prose header explaining which real incident the file
  guards against, and — for anything that can reject a user — a closing block of
  "must never block a real person" invariants built from real traffic
  (`botgate.test.js`, `feedback.test.js`).
- `external-assets.test.js` walks the whole tree and fails on any third-party asset origin,
  so it will catch a CDN reference in a new template automatically.
- Run the app locally with `node index.js` on port 3000.

## Deployment
- Manual: `node index.js` (port 3000) + `node sandbox/sandbox-app.js` (port 4000)
- Production is a pm2 process on a 915 MiB box where V8 gets a 470 MB heap. pm2 recycles it at
  `max_memory_restart` 420M (set 2026-09-19, `pm2 save`d) with `kill_timeout` 8000: `index.js`
  handles SIGINT by closing the port, ending the chat streams and exiting once what is in flight
  is done (5 s deadline). The pm2 unit has `LimitCORE=0` and the on-box disk guard deletes
  `/var/lib/apport/coredump/core.*`, so a crash can no longer fill the disk. Memory is sampled
  every five minutes into `~/mem-samples.csv` on the box, and `/usr/local/bin/app-crash-alert.sh`
  (root cron, every 5 min) mails the owner when pm2 logs an exit that is not its own SIGINT, or
  when the memory recycle has fired three times in a day: a restart must never again go unseen.
- Database: AWS RDS PostgreSQL
- No Docker, no CI/CD pipeline currently
- Static assets served directly by Express (no CDN)

## When Compacting Context
Always preserve:
- The security issues list above
- The design system colors and rules
- The file structure
- Which files are currently being edited
- Any test failure messages from the current session
- Architecture decisions made in this session
