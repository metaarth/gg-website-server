import { sendMail } from '../config/mailer.js';

function safe(value, fallback = '-') {
  if (value == null) return fallback;
  const text = String(value).trim();
  return text || fallback;
}

function getAdminNotificationEmail() {
  const primary = String(process.env.ADMIN_NOTIFICATION_EMAIL || '').trim();
  if (primary) return primary;

  // Backward compatibility with existing env naming.
  const legacy = String(process.env.ADMIN_NOTIFY_EMAILS || '').trim();
  if (legacy) return legacy;

  const fallback = String(process.env.ADMIN_EMAIL || '').trim();
  return fallback;
}

export async function sendAdminNotification({ subject, text, html }) {
  const adminNotificationEmail = getAdminNotificationEmail();

  if (!adminNotificationEmail) {
    console.warn('[AdminNotification] ADMIN_NOTIFICATION_EMAIL is not configured');
    return { success: false, error: 'ADMIN_NOTIFICATION_EMAIL not configured' };
  }

  return sendMail({
    to: adminNotificationEmail,
    subject,
    text,
    html,
  });
}

export function queueNewAccountNotification(user = {}) {
  const subject = 'New Account Created - Gawri Ganga';
  const text = [
    'A new user account was created.',
    `Name: ${safe(user.full_name)}`,
    `Phone: ${safe(user.phone_number)}`,
    `User ID: ${safe(user.id)}`,
    `Role: ${safe(user.role, 'user')}`,
  ].join('\n');

  sendAdminNotification({ subject, text }).catch((err) => {
    console.error('[AdminNotification] new account email failed:', err?.message || err);
  });
}

export function queueNewOrderNotification(order = {}) {
  const subject = `New Order Received - ${safe(order.order_number, 'No Number')}`;
  const text = [
    'A new order has been placed.',
    `Order No: ${safe(order.order_number)}`,
    `Order ID: ${safe(order.id)}`,
    `User ID: ${safe(order.user_id)}`,
    `Final Amount: ${safe(order.final_amount, '0')}`,
    `Payment Method: ${safe(order.payment_method)}`,
    `Payment Status: ${safe(order.payment_status)}`,
    `Order Status: ${safe(order.order_status)}`,
  ].join('\n');

  sendAdminNotification({ subject, text }).catch((err) => {
    console.error('[AdminNotification] new order email failed:', err?.message || err);
  });
}
