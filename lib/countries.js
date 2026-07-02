/**
 * Country list (English common names) and flag emoji from stored country name.
 * Data is bundled in data/countries.json (no npm dependency on the server).
 */
const fs = require("fs");
const path = require("path");

const raw = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "data", "countries.json"), "utf8")
);

const sortedCountryNames = raw.map((row) => row.n);

const nameToCode = new Map();
for (const row of raw) {
    nameToCode.set(row.n, row.c);
}

const manualAliases = {
    USA: "US",
    UK: "GB",
    "United States of America": "US",
    "United States": "US",
    "United Kingdom": "GB",
    "South Korea": "KR",
    "North Korea": "KP",
    Russia: "RU",
    Czechia: "CZ",
};

Object.entries(manualAliases).forEach(([name, code]) => {
    nameToCode.set(name, code);
});

function codeToFlagEmoji(code) {
    if (!code || typeof code !== "string" || code.length !== 2) return "";
    const u = code.toUpperCase();
    if (!/^[A-Z]{2}$/.test(u)) return "";
    const A = 0x1f1e6;
    return String.fromCodePoint(A + u.charCodeAt(0) - 65, A + u.charCodeAt(1) - 65);
}

function flagEmojiForCountryName(name) {
    if (!name || typeof name !== "string") return "";
    const trimmed = name.trim();
    if (!trimmed) return "";
    const code = nameToCode.get(trimmed);
    if (!code) return "";
    return codeToFlagEmoji(code);
}

function getSortedCountryNames() {
    return sortedCountryNames;
}

module.exports = {
    getSortedCountryNames,
    flagEmojiForCountryName,
};
