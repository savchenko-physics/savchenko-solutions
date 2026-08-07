/**
 * ruPlural.js — Russian plural selection by the standard mod10/mod100 rule
 * (same algorithm as practicum.js's local ruDays, promoted here so a second
 * feature doesn't grow its own copy — or its own copy of the bug already
 * living in views/bank/problem.ejs, which hardcodes "голосов" regardless of
 * count and is wrong for n=1 ("1 голос") and n=2-4 ("2 голоса")).
 */

function ruPlural(n, one, few, many) {
    const mod100 = n % 100;
    const mod10 = n % 10;
    if (mod100 >= 11 && mod100 <= 14) return many;
    if (mod10 === 1) return one;
    if (mod10 >= 2 && mod10 <= 4) return few;
    return many;
}

/** "1 голос" / "3 голоса" / "11 голосов" / "25 голосов", with the count prefixed. */
function ruVotes(n) {
    return `${n} ${ruPlural(n, 'голос', 'голоса', 'голосов')}`;
}

module.exports = { ruPlural, ruVotes };
