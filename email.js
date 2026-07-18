// Transactional email via Amazon SES (SESv2).
//
// Auth: on the production EC2 box, credentials are resolved automatically from the
// instance's attached IAM role (needs the ses:SendEmail permission) — no keys in .env.
// Off EC2 it falls back to the standard AWS credential chain (env vars / ~/.aws).
//
// Config (all via .env):
//   EMAIL_ENABLED=true                       # master switch; when unset/false, sends are no-ops
//   AWS_REGION=us-east-2                      # SES region (match the EC2/RDS region)
//   EMAIL_FROM=Savchenko Solutions <no-reply@savchenkosolutions.com>
//
// The SDK is lazy-loaded so the app runs fine locally without the dependency
// installed, as long as EMAIL_ENABLED is not "true".

const FROM =
    process.env.EMAIL_FROM ||
    "Savchenko Solutions <no-reply@savchenkosolutions.com>";

// no-reply@ has no inbox, so route replies to a real address (override via EMAIL_REPLY_TO).
const REPLY_TO = process.env.EMAIL_REPLY_TO || "togpe22@gmail.com";

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

/**
 * Send a transactional email. Resolves quietly (no throw) when EMAIL_ENABLED is
 * off so callers can wrap real sends in try/catch without special-casing dev.
 * @param {{to: string, subject: string, html: string, text?: string}} opts
 */
async function sendEmail({ to, subject, html, text }) {
    if (process.env.EMAIL_ENABLED !== "true") {
        console.log(`[email disabled] would send to ${to}: ${subject}`);
        return { skipped: true };
    }

    const { SendEmailCommand } = require("@aws-sdk/client-sesv2");
    const body = { Html: { Data: html, Charset: "UTF-8" } };
    if (text) body.Text = { Data: text, Charset: "UTF-8" };

    const input = {
        FromEmailAddress: FROM,
        Destination: { ToAddresses: [to] },
        Content: {
            Simple: {
                Subject: { Data: subject, Charset: "UTF-8" },
                Body: body,
            },
        },
    };
    if (REPLY_TO) input.ReplyToAddresses = [REPLY_TO];

    const result = await getClient().send(new SendEmailCommand(input));
    return { messageId: result.MessageId };
}

module.exports = { sendEmail };
