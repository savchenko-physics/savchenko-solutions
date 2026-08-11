const { Index } = require('flexsearch');
const fs = require('fs');
const path = require('path');
const { readCSV } = require('./parents');

let problemIndex;
let problemData = {};
let chapterLookup = {};
let sectionLookup = {};

// `${lang}:${problemName}` -> the flexsearch document id, so one changed file can be
// re-indexed on its own. Without it the only way to reflect an edit was to rebuild the
// whole index, and that is a ~2 s synchronous stall (see updateDocument below).
let docIdByKey = new Map();
let nextId = 0;

const docKey = (lang, problemName) => `${lang}:${problemName}`;

function loadChapterSectionData() {
  chapterLookup = {};
  sectionLookup = {};

  for (const lang of ['en', 'ru']) {
    const chaptersCSV = lang === 'ru'
      ? path.join(__dirname, 'src/ru/database/chapters.csv')
      : path.join(__dirname, 'src/database/chapters.csv');
    const sectionsCSV = lang === 'ru'
      ? path.join(__dirname, 'src/ru/database/sections.csv')
      : path.join(__dirname, 'src/database/sections.csv');

    if (!fs.existsSync(chaptersCSV) || !fs.existsSync(sectionsCSV)) continue;

    const chapterNums = readCSV(chaptersCSV, 0);
    const chapterTitles = readCSV(chaptersCSV, 1);
    const sectionNumbers = readCSV(sectionsCSV, 0);
    const sectionTitles = readCSV(sectionsCSV, 1);

    chapterLookup[lang] = {};
    for (let i = 0; i < chapterNums.length; i++) {
      chapterLookup[lang][chapterNums[i]] = chapterTitles[i];
    }

    sectionLookup[lang] = {};
    for (let i = 0; i < sectionNumbers.length; i++) {
      sectionLookup[lang][sectionNumbers[i]] = sectionTitles[i];
    }
  }
}

// The single place a document's searchable text and metadata are derived, so a
// full rebuild and a one-file update can never drift apart.
function indexDocument(id, lang, problemName, content, isNew) {
  const plainText = stripLatexAndMarkdown(content);
  const searchText = `${problemName} ${plainText}`;

  if (isNew) problemIndex.add(id, searchText);
  else problemIndex.update(id, searchText);

  const parts = problemName.split('.');
  const chapterNum = parts[0] || '';
  const sectionRef = parts.length >= 2 ? `${parts[0]}.${parts[1]}` : '';

  problemData[id] = {
    problemName,
    lang,
    plainText,
    chapterNum,
    sectionRef,
    chapter: (chapterLookup[lang] && chapterLookup[lang][chapterNum]) || '',
    section: (sectionLookup[lang] && sectionLookup[lang][sectionRef]) || '',
  };
}

function buildIndex() {
  problemIndex = new Index({
    tokenize: 'forward',
    resolution: 9,
  });

  problemData = {};
  docIdByKey = new Map();
  loadChapterSectionData();

  const languages = ['en', 'ru'];
  let id = 0;

  for (const lang of languages) {
    const dir = path.join(__dirname, 'posts', lang);
    if (!fs.existsSync(dir)) continue;

    const files = fs.readdirSync(dir).filter(f => f.endsWith('.md'));

    for (const file of files) {
      const problemName = file.replace('.md', '');
      const content = fs.readFileSync(path.join(dir, file), 'utf-8');

      indexDocument(id, lang, problemName, content, true);
      docIdByKey.set(docKey(lang, problemName), id);
      id++;
    }
  }

  nextId = id;
  console.log(`Search index built: ${id} documents`);
}

// Re-index exactly one solution after it is saved.
//
// This used to be rebuildIndex(), which re-reads and re-tokenizes all ~2,500 markdown
// files. That is fully synchronous: measured at 1.8-2.0 s on the production box, and it
// blocks the event loop, so it stalled every other in-flight request as well. It was the
// reason the Save button appeared frozen for several seconds and people clicked it again
// and again — one contributor produced 67 identical rows in 2 min 20 s that way.
//
// Measured here: full rebuild 620 ms locally / 1,845 ms on the box, one document 9 ms
// locally (~35 ms on the box). flexsearch's `fastupdate: true` would take that to 0.08 ms
// but costs ~42 MB of heap for the removal registry, and the box has 915 MB total with
// swap already in use — not worth it for a save that now feels instant either way.
//
// Silently does nothing before the first build; search() builds lazily and would read the
// new file from disk anyway.
function updateDocument(lang, problemName, content) {
  if (!problemIndex) return;

  const key = docKey(lang, problemName);
  const existingId = docIdByKey.get(key);
  const isNew = existingId === undefined;
  const id = isNew ? nextId++ : existingId;

  indexDocument(id, lang, problemName, content, isNew);
  if (isNew) docIdByKey.set(key, id);
}

function stripLatexAndMarkdown(text) {
  return text
    .replace(/\$\$[\s\S]*?\$\$/g, '')
    .replace(/\$[^$]+\$/g, '')
    .replace(/\\[a-zA-Z]+\{[^}]*\}/g, '')
    .replace(/[#*_~`>]/g, '')
    .replace(/!\[.*?\]\(.*?\)/g, '')
    .replace(/\[([^\]]+)\]\(.*?\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

function generateContextSnippet(text, query, maxLen = 140) {
  if (!text) return '';
  if (!query) return text.substring(0, maxLen) + (text.length > maxLen ? '...' : '');

  const lowerText = text.toLowerCase();
  const lowerQuery = query.toLowerCase().trim();
  const terms = lowerQuery.split(/\s+/).filter(t => t.length > 1);

  let matchPos = -1;
  let matchLen = 0;

  const fullIdx = lowerText.indexOf(lowerQuery);
  if (fullIdx !== -1) {
    matchPos = fullIdx;
    matchLen = lowerQuery.length;
  } else {
    for (const term of terms.sort((a, b) => b.length - a.length)) {
      const idx = lowerText.indexOf(term);
      if (idx !== -1) {
        matchPos = idx;
        matchLen = term.length;
        break;
      }
    }
  }

  if (matchPos === -1) {
    return text.substring(0, maxLen) + (text.length > maxLen ? '...' : '');
  }

  const halfWindow = Math.floor((maxLen - matchLen) / 2);
  let start = Math.max(0, matchPos - halfWindow);
  let end = Math.min(text.length, matchPos + matchLen + halfWindow);

  if (start > 0) {
    const sp = text.indexOf(' ', start);
    if (sp !== -1 && sp < matchPos) start = sp + 1;
  }
  if (end < text.length) {
    const sp = text.lastIndexOf(' ', end);
    if (sp > matchPos + matchLen) end = sp;
  }

  const snippet = text.substring(start, end);
  const prefix = start > 0 ? '...' : '';
  const suffix = end < text.length ? '...' : '';

  return prefix + snippet + suffix;
}

function search(query, lang, limit = 15) {
  if (!problemIndex) buildIndex();

  const results = problemIndex.search(query, { limit: limit * 3 });

  const mapped = results
    .map(id => problemData[id])
    .filter(Boolean);

  // Prioritize current language and exact matches
  const sorted = mapped.sort((a, b) => {
    if (a.lang === lang && b.lang !== lang) return -1;
    if (a.lang !== lang && b.lang === lang) return 1;
    if (a.problemName === query) return -1;
    if (b.problemName === query) return 1;
    return 0;
  });

  // Deduplicate by problemName (keep the current language version)
  const seen = new Set();
  const deduped = sorted.filter(r => {
    if (seen.has(r.problemName)) return false;
    seen.add(r.problemName);
    return true;
  });

  return deduped.slice(0, limit).map(r => ({
    problemName: r.problemName,
    lang: r.lang,
    name: r.problemName,
    url: `/${r.lang}/${r.problemName}`,
    relativePath: `/${r.lang}/${r.problemName}`,
    chapter: r.chapter,
    chapterNum: r.chapterNum,
    section: r.section,
    snippet: generateContextSnippet(r.plainText, query),
    isExactMatch: r.problemName === query,
    confidence: r.problemName === query && r.lang === lang ? 'high' : 'medium',
  }));
}

function rebuildIndex() {
  buildIndex();
}

function getChapterList(lang) {
  const l = lang === 'ru' ? 'ru' : 'en';
  if (!chapterLookup[l]) return [];
  return Object.entries(chapterLookup[l]).map(([num, title]) => ({
    num,
    title,
  }));
}

module.exports = { buildIndex, search, rebuildIndex, updateDocument, getChapterList, stripLatexAndMarkdown };
