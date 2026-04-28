import { sendAdminNotification } from '../utils/adminNotification.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function cleanText(value, maxLength = 2000) {
  return String(value || '').trim().slice(0, maxLength);
}

export async function submitContactMessage(req, res) {
  try {
    const name = cleanText(req.body?.name, 120);
    const email = cleanText(req.body?.email, 160).toLowerCase();
    const subject = cleanText(req.body?.subject, 180) || 'Contact Form Inquiry';
    const message = cleanText(req.body?.message, 5000);

    if (!name || !email || !message) {
      return res.status(400).json({
        success: false,
        message: 'Name, email, and message are required.',
      });
    }

    if (!EMAIL_RE.test(email)) {
      return res.status(400).json({
        success: false,
        message: 'Please enter a valid email address.',
      });
    }

    const text = [
      'New contact form submission',
      `Name: ${name}`,
      `Email: ${email}`,
      `Subject: ${subject}`,
      '',
      'Message:',
      message,
    ].join('\n');

    const html = `
      <h2>New contact form submission</h2>
      <p><strong>Name:</strong> ${name}</p>
      <p><strong>Email:</strong> ${email}</p>
      <p><strong>Subject:</strong> ${subject}</p>
      <p><strong>Message:</strong></p>
      <p style="white-space: pre-wrap;">${message}</p>
    `;

    const mailResult = await sendAdminNotification({
      subject: `[Contact] ${subject}`,
      text,
      html,
    });

    if (!mailResult?.success) {
      return res.status(500).json({
        success: false,
        message: 'Unable to send your message right now. Please try again shortly.',
      });
    }

    return res.status(200).json({
      success: true,
      message: 'Your message has been sent successfully.',
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: 'Failed to submit contact form.',
    });
  }
}
