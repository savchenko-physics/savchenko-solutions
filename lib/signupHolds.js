// Registrations from a listed network are not refused and not created either: they are held
// for a person to look at on /admin/signups (migration 062, `signup_ip_holds` is the list,
// `signup_holds` the queue). The list is for one troublemaker's mobile carrier pool, where
// the address changes by the hour, so a plain blocklist would miss him and a wide block would
// hit real students. A hold delays, it never turns anyone away.
//
// Entries are IPv4 addresses or CIDRs (a bare address is /32). Anything that is not IPv4
// (IPv6, garbage) never matches. Pure, for tests/signup-holds.test.js.
'use strict';

const net = require('net');

function ipToInt(ip) {
    const parts = String(ip).split('.');
    if (parts.length !== 4) return null;
    let n = 0;
    for (const p of parts) {
        if (!/^\d{1,3}$/.test(p)) return null;
        const o = Number(p);
        if (o > 255) return null;
        n = (n * 256) + o;
    }
    return n;
}

function normalizeIp(raw) {
    let ip = String(raw || '').trim();
    if (ip.startsWith('::ffff:')) ip = ip.slice(7);
    return net.isIPv4(ip) ? ip : null;
}

// '203.0.113.0/24' → [base, mask] or null when malformed.
function parseCidr(cidr) {
    const [base, bitsRaw] = String(cidr || '').trim().split('/');
    const baseInt = ipToInt(base);
    if (baseInt === null) return null;
    const bits = bitsRaw === undefined ? 32 : Number(bitsRaw);
    if (!Number.isInteger(bits) || bits < 0 || bits > 32) return null;
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return [(baseInt & mask) >>> 0, mask];
}

function isValidCidr(cidr) {
    return parseCidr(cidr) !== null;
}

// The first listed range holding `ip`, as written in the list, or null.
function holdFor(ip, cidrs) {
    const norm = normalizeIp(ip);
    const ipInt = norm === null ? null : ipToInt(norm);
    if (ipInt === null) return null;
    for (const cidr of cidrs || []) {
        const c = parseCidr(cidr);
        if (c && ((ipInt & c[1]) >>> 0) === c[0]) return cidr;
    }
    return null;
}

// What the person sees on the registration page instead of their new profile.
function holdNotice(lang) {
    return lang === 'ru'
        ? 'Регистрации из вашей сети проверяются вручную. Когда аккаунт будет создан, на указанный адрес придёт письмо. Обычно это занимает не больше суток.'
        : 'Registrations from your network are checked by hand. When the account is created, an email goes to the address you gave. This usually takes less than a day.';
}

module.exports = { holdFor, isValidCidr, holdNotice, normalizeIp };
