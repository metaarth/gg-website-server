/**
 * Nodemailer mailer configured for Brevo (brevo.com) SMTP.
 * Uses SMTP_HOST, SMTP_USER, SMTP_PASS from env. Optional MAIL_FROM for sender name/address
 * (should be a verified sender in your Brevo account for best deliverability).
 */
import nodemailer from 'nodemailer';
import dotenv from 'dotenv';

dotenv.config();

const {
    SMTP_HOST,
    SMTP_PORT,
    SMTP_SECURE,
    SMTP_USER,
    SMTP_PASS,
    MAIL_FROM
} = process.env;

const isConfigured = Boolean(SMTP_HOST && SMTP_USER && SMTP_PASS);

/** Brevo SMTP uses port 587 with STARTTLS; host is typically smtp-relay.brevo.com */
const isBrevo = Boolean(SMTP_HOST && String(SMTP_HOST).toLowerCase().includes('brevo'));

let transporter = null;

if (isConfigured) {
    const port = parseInt(SMTP_PORT, 10) || 587;
    transporter = nodemailer.createTransport({
        host: SMTP_HOST,
        port,
        secure: SMTP_SECURE === 'true',
        auth: {
            user: SMTP_USER,
            pass: SMTP_PASS
        },
        // Port 587 uses STARTTLS by default (no need to force requireTLS)
        connectionTimeout: 15000,
        greetingTimeout: 10000
    });
}

/**
 * Resolve the "From" address for sending. Brevo allows MAIL_FROM (verified sender);
 * fallback to SMTP_USER or a default.
 */
function getFromAddress() {
    if (MAIL_FROM && MAIL_FROM.trim()) {
        const from = MAIL_FROM.trim();
        return from.includes('<') ? from : `Gawri Ganga <${from}>`;
    }
    return `Gawri Ganga <${SMTP_USER || 'noreply@gawriganga.com'}>`;
}

/**
 * Send an email via Brevo SMTP.
 * @param {Object} options - { to, subject, text, html? }
 * @returns {Promise<{ success: boolean, messageId?: string, error?: string }>}
 */
export async function sendMail(options) {
    if (!transporter) {
        console.warn('[Mail] Not configured. Set SMTP_HOST, SMTP_USER, SMTP_PASS (Brevo SMTP credentials in .env or Render).');
        return { success: false, error: 'Mail not configured' };
    }

    try {
        const mailOptions = {
            from: getFromAddress(),
            to: options.to,
            subject: options.subject,
            text: options.text,
            html: options.html != null ? options.html : options.text
        };

        const result = await transporter.sendMail(mailOptions);

        const toMasked = options.to ? `${String(options.to).slice(0, 2)}***@${(String(options.to).split('@')[1] || '')}` : '?';
        console.log('[Mail] Sent via Brevo', result.messageId, 'to', toMasked);
        return { success: true, messageId: result.messageId };
    } catch (err) {
        console.error('[Mail] Send failed:', err?.message || err);
        return { success: false, error: err?.message || String(err) };
    }
}

export { isConfigured, isBrevo };
