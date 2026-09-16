// Transactional email via Amazon SES (SESv2), with a ceiling on how much one address gets.
//
// Auth: on the production EC2 box, credentials are resolved automatically from the
// instance's attached IAM role (needs the ses:SendEmail permission) — no keys in .env.
// Off EC2 it falls back to the standard AWS credential chain (env vars / ~/.aws).
//
// Config (all via .env):
//   EMAIL_ENABLED=true                       # master switch; when unset/false, sends are no-ops
//   AWS_REGION=us-east-2                      # SES region (match the EC2/RDS region)
//   EMAIL_FROM=Savchenko Solutions <alex@savchenkosolutions.com>
//
// The SDK is lazy-loaded so the app runs fine locally without the dependency
// installed, as long as EMAIL_ENABLED is not "true".
//
// Every send is written to email_sends (migration 056) and counted before the next one: since
// 2026-09-16 no address receives more than the ceiling in lib/mailGuard.js, whatever asks for
// the mail — ten identical "started following you" emails in 27 seconds are what this is for.
// The kinds that get a person back into an account are exempt and carry their own limits.
// Every step of the bookkeeping fails open: a database that cannot be read must cost the site
// its limits, never its mail.

const { Pool } = require("pg");
const {
    LIMITS, normalizeAddress, normalizeKind, isCapped, overRecipientCap, maskAddress,
} = require("./lib/mailGuard");

const FROM =
    process.env.EMAIL_FROM ||
    "Savchenko Solutions <alex@savchenkosolutions.com>";

// alex@ is a real Zoho inbox (savchenkosolutions.com MX points at Zoho), so it is both
// the sender and the reply target — a recipient who hits Reply reaches a person. The
// domain is verified in SES, which is what lets any address on it send.
const REPLY_TO = process.env.EMAIL_REPLY_TO || "alex@savchenkosolutions.com";

let sesClient = null;
function getClient() {
    if (!sesClient) {
        const { SESv2Client } = require("@aws-sdk/client-sesv2");
        sesClient = new SESv2Client({
            region: process.env.AWS_REGION || "us-east-2",
        });
    }
    return sesClient;
}

// Its own pool, as every module here has one; no connection is opened until a send happens.
let pool = null;
function getPool() {
    if (!pool) {
        pool = new Pool({
            user: process.env.PG_USER,
            host: process.env.PG_HOST,
            database: process.env.PG_DATABASE,
            password: process.env.PG_PASSWORD,
            port: process.env.PG_PORT,
            ssl: { rejectUnauthorized: process.env.PG_SSL_REJECT_UNAUTHORIZED === "true" },
        });
    }
    return pool;
}

/** Sends to this address in the last hour and day, or null when the log cannot be read. */
async function recipientCounts(address) {
    try {
        const { rows } = await getPool().query(
            `SELECT count(*) FILTER (WHERE created_at > NOW() - INTERVAL '1 hour')::int AS "lastHour",
                    count(*)::int AS "lastDay"
               FROM email_sends
              WHERE to_address = $1 AND status IN ('sent', 'failed')
                AND created_at > NOW() - INTERVAL '24 hours'`,
            [address]
        );
        return rows[0];
    } catch (err) {
        console.error("email: recipient counts unavailable, sending without a limit:", err.message);
        return null;
    }
}

async function record({ address, kind, thread, subject, userId, status }) {
    try {
        await getPool().query(
            `INSERT INTO email_sends (to_address, kind, thread, subject, user_id, status)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [address, kind, thread ? String(thread).slice(0, 255) : null,
                subject ? String(subject).slice(0, 255) : null, userId || null, status]
        );
    } catch (err) {
        console.error("email: could not log the send:", err.message);
    }
}

/**
 * Send a transactional email. Resolves quietly (no throw) when EMAIL_ENABLED is
 * off so callers can wrap real sends in try/catch without special-casing dev.
 * `kind` (and `thread`, the link the mail is about) go into the email_sends log and decide
 * the ceiling; see lib/mailGuard.js. A send refused by the ceiling resolves with
 * { skipped: 'rate_limited' } rather than throwing: nothing that mails is worth failing for.
 * `headers` are SESv2 MessageHeader entries ({Name, Value}); the weekly digest uses them for
 * List-Unsubscribe, which is what puts Gmail's own one-click unsubscribe button on a message
 * and keeps a bulk-looking email out of the spam folder.
 * @param {{to: string, subject: string, html: string, text?: string, kind?: string,
 *          thread?: string, userId?: number, headers?: {Name: string, Value: string}[]}} opts
 */
async function sendEmail({ to, subject, html, text, kind, thread, userId, headers }) {
    const address = normalizeAddress(to);
    const sendKind = normalizeKind(kind);
    if (!address) return { skipped: "no_address" };

    if (process.env.EMAIL_ENABLED !== "true") {
        console.log(`[email disabled] would send ${sendKind} to ${to}: ${subject}`);
        return { skipped: true };
    }

    if (isCapped(sendKind)) {
        const counts = await recipientCounts(address);
        if (counts && overRecipientCap({ kind: sendKind, ...counts })) {
            console.error(
                `email: ${sendKind} to ${maskAddress(address)} not sent, ceiling reached ` +
                `(${counts.lastHour}/${LIMITS.perAddressPerHour} this hour, ${counts.lastDay}/${LIMITS.perAddressPerDay} today)`
            );
            await record({ address, kind: sendKind, thread, subject, userId, status: "suppressed" });
            return { skipped: "rate_limited" };
        }
    }

    const { SendEmailCommand } = require("@aws-sdk/client-sesv2");
    const body = { Html: { Data: html, Charset: "UTF-8" } };
    if (text) body.Text = { Data: text, Charset: "UTF-8" };

    const simple = {
        Subject: { Data: subject, Charset: "UTF-8" },
        Body: body,
    };
    if (Array.isArray(headers) && headers.length > 0) simple.Headers = headers;

    const input = {
        FromEmailAddress: FROM,
        Destination: { ToAddresses: [to] },
        Content: { Simple: simple },
    };
    if (REPLY_TO) input.ReplyToAddresses = [REPLY_TO];

    try {
        const result = await getClient().send(new SendEmailCommand(input));
        await record({ address, kind: sendKind, thread, subject, userId, status: "sent" });
        return { messageId: result.MessageId };
    } catch (err) {
        await record({ address, kind: sendKind, thread, subject, userId, status: "failed" });
        throw err;
    }
}

module.exports = { sendEmail };
