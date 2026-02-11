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

let transporter = null;

if (isConfigured) {
    transporter = nodemailer.createTransport({
        host: SMTP_HOST,
        port: parseInt(SMTP_PORT, 10) || 587,
        secure: SMTP_SECURE === 'true',
        auth: {
            user: SMTP_USER,
            pass: SMTP_PASS
        }
    });
}

/**
 * Send an email.
 * @param {Object} options - { to, subject, text, html? }
 * @returns {Promise<{ success: boolean, error?: string }>}
 */
export async function sendMail(options) {
    if (!transporter) {
        console.warn('[Mail] Not configured. Set SMTP_HOST, SMTP_USER, SMTP_PASS in environment (e.g. Render dashboard).');
        return { success: false, error: 'Mail not configured' };
    }

    try {
        const from = MAIL_FROM || SMTP_USER || 'noreply@gawriganga.com';
        const result = await transporter.sendMail({
            from: typeof from === 'string' && from.includes('<') ? from : `Gawri Ganga <${from}>`,
            to: options.to,
            subject: options.subject,
            text: options.text,
            html: options.html || options.text
        });
        return { success: true, messageId: result.messageId };
    } catch (err) {
        console.error('[Mail] Send failed:', err?.message || err);
        return { success: false, error: err?.message || String(err) };
    }
}

export { isConfigured };
