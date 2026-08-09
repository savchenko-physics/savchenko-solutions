// Guards the country filter on /:lang/contributors.
//
// Why this exists: the leaderboard's place numbers ("место") are assigned over the
// whole sorted field and then paginated, and a filter is easy to bolt on in the wrong
// order — filter first and everyone from a small country suddenly ranks #1, #2, #3.
// The places shown under a filter must stay the real site-wide ones.
//
// The second reason is privacy. user_preferences.show_country_on_leaderboard has
// existed since migration 001 but nothing honoured it. Adding a *filter* raises the
// stakes: picking a country from a dropdown and finding someone there would leak
// exactly the fact that the setting exists to hide, and it would leak it more
// legibly than the flag column ever did.
//
// Not covered: the route handler, the SQL, and the dropdown itself. There is no test
// database, so what is tested here is the pure row-selection step the route calls —
// sorting, place assignment, faceting and filtering — with hand-built rows.

const test = require('node:test');
const assert = require('node:assert');

const { selectLeaderboardRows, countryOnLeaderboard } = require('../contributorsUserMetricsApi');

// Shaped like a row of the leaderboard query: user_id, country_location and the
// COALESCE'd show_country preference are all this step looks at.
function row(user_id, username, country_location, show_country = true) {
  return { user_id, username, country_location, show_country };
}

const FIELD = [
  row(28, 'astrosander', 'United States'),
  row(1, 'eugene', 'Russia'),
  row(2, 'anna', 'Kazakhstan'),
  row(3, 'boris', 'Russia'),
  row(4, 'chen', null),
  row(5, 'dmitri', '  Russia  '),
  row(6, 'elena', 'Kazakhstan', false),
];

test('places are assigned over the whole field, and the owner gets none', () => {
  const { placed } = selectLeaderboardRows(FIELD, '');
  assert.deepStrictEqual(
    placed.map((p) => [p.row.username, p.rank]),
    [
      ['astrosander', null],
      ['eugene', 1],
      ['anna', 2],
      ['boris', 3],
      ['chen', 4],
      ['dmitri', 5],
      ['elena', 6],
    ]
  );
});

test('a filtered view keeps the site-wide places, it does not renumber from 1', () => {
  const { matching } = selectLeaderboardRows(FIELD, 'Russia');
  assert.deepStrictEqual(
    matching.map((p) => [p.row.username, p.rank]),
    [['eugene', 1], ['boris', 3], ['dmitri', 5]]
  );
});

test('an empty filter returns everyone', () => {
  const { matching, placed } = selectLeaderboardRows(FIELD, '');
  assert.strictEqual(matching.length, placed.length);
  assert.strictEqual(matching.length, FIELD.length);
});

test('the filter is case-insensitive and ignores surrounding whitespace', () => {
  for (const query of ['russia', 'RUSSIA', '  Russia  ']) {
    const { matching } = selectLeaderboardRows(FIELD, query);
    assert.strictEqual(matching.length, 3, `query ${JSON.stringify(query)}`);
  }
});

test('a stored country with stray whitespace still matches', () => {
  const { matching } = selectLeaderboardRows(FIELD, 'Russia');
  assert.ok(matching.some((p) => p.row.username === 'dmitri'));
});

test('facets count every contributor, not just the current page', () => {
  const { countries } = selectLeaderboardRows(FIELD, '');
  assert.deepStrictEqual(
    countries.map((c) => [c.name, c.count]),
    [['Russia', 3], ['Kazakhstan', 1], ['United States', 1]]
  );
});

test('facets carry an ISO code and a flag so the UI can localise the name', () => {
  const { countries } = selectLeaderboardRows(FIELD, '');
  const russia = countries.find((c) => c.name === 'Russia');
  assert.strictEqual(russia.code, 'RU');
  assert.strictEqual(russia.flag, '\u{1F1F7}\u{1F1FA}');
});

test('facets do not change when a filter is applied', () => {
  const unfiltered = selectLeaderboardRows(FIELD, '').countries;
  const filtered = selectLeaderboardRows(FIELD, 'Kazakhstan').countries;
  assert.deepStrictEqual(filtered, unfiltered);
});

test('an unknown country matches nobody rather than everybody', () => {
  const { matching } = selectLeaderboardRows(FIELD, 'Atlantis');
  assert.deepStrictEqual(matching, []);
});

// ── Privacy: these must hold no matter what else changes ──────────────────────

test('a user who hid their country is absent from that country\'s filter', () => {
  const { matching } = selectLeaderboardRows(FIELD, 'Kazakhstan');
  assert.deepStrictEqual(matching.map((p) => p.row.username), ['anna']);
});

test('a hidden country is not counted in the facet list', () => {
  const { countries } = selectLeaderboardRows(FIELD, '');
  assert.strictEqual(countries.find((c) => c.name === 'Kazakhstan').count, 1);
});

test('a country hidden by its only holder disappears from the dropdown entirely', () => {
  const field = [row(1, 'solo', 'Iceland', false)];
  const { countries } = selectLeaderboardRows(field, '');
  assert.deepStrictEqual(countries, []);
});

test('hiding the country never removes the contributor from the leaderboard', () => {
  const { placed } = selectLeaderboardRows(FIELD, '');
  const elena = placed.find((p) => p.row.username === 'elena');
  assert.ok(elena, 'a hidden country must hide the country, not the person');
  assert.strictEqual(elena.rank, 6);
});

test('country resolution treats missing, blank and hidden alike', () => {
  assert.strictEqual(countryOnLeaderboard(row(1, 'a', null)), null);
  assert.strictEqual(countryOnLeaderboard(row(1, 'a', '')), null);
  assert.strictEqual(countryOnLeaderboard(row(1, 'a', '   ')), null);
  assert.strictEqual(countryOnLeaderboard(row(1, 'a', 'Russia', false)), null);
  assert.strictEqual(countryOnLeaderboard(row(1, 'a', ' Russia ')), 'Russia');
});

// The preference column defaults to TRUE and only 19 of 964 users have a
// user_preferences row at all, so the overwhelmingly common case is a NULL that
// COALESCE turns into true. Losing that default would blank the flag column for
// almost everyone.
test('a contributor with no preferences row still shows their country', () => {
  const noPrefs = { user_id: 7, username: 'fedor', country_location: 'Poland', show_country: true };
  assert.strictEqual(countryOnLeaderboard(noPrefs), 'Poland');
  const { countries } = selectLeaderboardRows([noPrefs], '');
  assert.deepStrictEqual(countries.map((c) => c.name), ['Poland']);
});
