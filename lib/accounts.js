// Creating an account: the row, the two community chats, the verification email. Used by
// the registration route (index.js) and by an admin approving a held registration
// (admin.js, lib/signupHolds.js), so that the two can never drift apart.
'use strict';

const crypto = require('crypto');
const pool = require('./db');
const { sendEmail } = require('../email');
const { COMMUNITY_LANGS, mutedByDefault } = require('./communityChats');

// Returns the new user's id. Throws pg errors (23505 on a taken username or email) to the caller.
async function createAccount({ username, email, fullName, passwordHash, lang, baseUrl }) {
    const newUser = await pool.query(
        // created_at is set explicitly rather than left to the column DEFAULT so the
        // provenance is recorded too: 'exact' distinguishes real signup times from the
        // dates scripts/backfill-user-created-at.js inferred for pre-existing accounts,
        // which are only upper bounds.
        "INSERT INTO users (username, email, full_name, password, created_at, created_at_source) VALUES ($1, $2, $3, $4, now(), 'exact') RETURNING id",
        [username, email, fullName, passwordHash]
    );
    const userId = newUser.rows[0].id;

    // Join both community chats (conversations.community_lang). The one in the language
    // of the page they signed up on is live; the other starts muted, so it doesn't add
    // to their unread count until they unmute it. See lib/communityChats.js.
    try {
        const communityChats = await pool.query(
            `SELECT id, community_lang FROM conversations WHERE community_lang = ANY($1)`,
            [COMMUNITY_LANGS]
        );
        for (const chat of communityChats.rows) {
            await pool.query(
                `INSERT INTO conversation_members (conversation_id, user_id, muted) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
                [chat.id, userId, !!mutedByDefault({ chatLang: chat.community_lang, userLang: lang })]
            );
        }
    } catch (e) {
        console.error('Failed to add user to the community chats:', e);
    }

    // Send a verification email (soft: the account works right away; the user
    // shows as unverified until they click the link). Failures are swallowed.
    try {
        const verifyToken = crypto.randomBytes(32).toString("hex");
        const verifyExpires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days
        await pool.query(
            "UPDATE users SET email_verification_token = $1, email_verification_expires = $2 WHERE id = $3",
            [verifyToken, verifyExpires, userId]
        );
        const verifyUrl = `${baseUrl}/verify-email?token=${verifyToken}&lang=${lang}`;
        await sendEmail({
            to: email,
            kind: 'email_verify',
            userId,
            subject: lang === 'ru'
                ? 'Подтвердите ваш email — Savchenko Solutions'
                : 'Confirm your email — Savchenko Solutions',
            html: `<p>${lang === 'ru'
                ? 'Добро пожаловать в Savchenko Solutions! Подтвердите свой адрес электронной почты (ссылка действительна 7 дней):'
                : 'Welcome to Savchenko Solutions! Please confirm your email address (this link is valid for 7 days):'}</p>
                   <p><a href="${verifyUrl}">${verifyUrl}</a></p>`,
            text: verifyUrl,
        });
    } catch (mailErr) {
        console.error('Verification email failed:', mailErr);
    }

    return userId;
}

module.exports = { createAccount };
