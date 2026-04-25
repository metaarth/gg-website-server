import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { query } from '../config/db.js';
import { queueNewAccountNotification } from '../utils/adminNotification.js';

const JWT_SECRET = process.env.JWT_SECRET;
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '24h';

if (!JWT_SECRET) {
  console.error('Missing JWT_SECRET in environment variables');
  throw new Error('JWT_SECRET is required for authentication');
}

function signToken(user) {
  const payload = {
    id: user.id,
    full_name: user.full_name || null,
    phone_number: user.phone_number || null,
    role: user.role || 'user',
  };

  return jwt.sign(payload, JWT_SECRET, {
    expiresIn: JWT_EXPIRES_IN,
  });
}

const OTP_EXPIRY_MINUTES = Number(process.env.OTP_EXPIRY_MINUTES || 5);
const OTP_LENGTH = Number(process.env.OTP_LENGTH || 6);
const FAST2SMS_URL = 'https://www.fast2sms.com/dev/bulkV2';
const FAST2SMS_ROUTE = String(process.env.FAST2SMS_ROUTE || 'otp').trim().toLowerCase();
const DEMO_PHONE_NUMBER = String(process.env.DEMO_PHONE_NUMBER || '9988776655').trim();
const DEMO_OTP = String(process.env.DEMO_OTP || '123456').trim();
/** First `{#}` in templates like `hi {#}, your OTP is {#}` — literal word (e.g. User), not the customer name */
const DLT_FIRST_HASH_GREETING = String(process.env.FAST2SMS_DLT_GREETING || 'User').trim() || 'User';

function normalizeIndianPhone(phoneNumber) {
  const digits = String(phoneNumber || '').replace(/\D/g, '');
  const normalized = digits.length === 12 && digits.startsWith('91') ? digits.slice(2) : digits;
  if (!/^[6-9]\d{9}$/.test(normalized)) {
    return null;
  }
  return normalized;
}

function generateNumericOtp(length = 6) {
  let otp = '';
  for (let i = 0; i < length; i += 1) {
    otp += Math.floor(Math.random() * 10);
  }
  return otp;
}

/** Strip internal-only DB fields from user rows returned to clients (auth is phone-only). */
function publicAuthUser(row) {
  if (!row) return row;
  const { email: _e, password_hash: _p, ...rest } = row;
  return rest;
}

/** Required when registering a new account (phone OTP). At least two name parts. */
function validateSignupFullName(raw) {
  const s = raw != null ? String(raw).trim() : '';
  if (!s) {
    return {
      ok: false,
      message: 'Please enter your first and last name.',
    };
  }
  if (s.length > 200) {
    return { ok: false, message: 'Name is too long.' };
  }
  const parts = s.split(/\s+/).filter(Boolean);
  if (parts.length < 2) {
    return { ok: false, message: 'Please enter your first and last name.' };
  }
  return { ok: true, value: s };
}

function sanitizeDltDisplayName(raw) {
  const s = String(raw || '')
    .trim()
    .replace(/[\r\n|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .slice(0, 40);
  return s || 'Customer';
}

/** Two `{#var#}` → first name, second OTP; one `{#var#}` → OTP only. `{#name#}` → name. */
function buildDltManualMessage(configuredMessage, otp, rawFullName) {
  const name = sanitizeDltDisplayName(rawFullName);
  let message = String(configuredMessage || '').trim();

  message = message
    .replace(/\{#name#\}/gi, name)
    .replace(/\{\{name\}\}/gi, name)
    .replace(/\$NAME\$/g, name);

  const varRegex = /\{#var#\}/gi;
  const varMatches = message.match(varRegex);
  const varCount = varMatches ? varMatches.length : 0;

  if (varCount >= 2) {
    let i = 0;
    message = message.replace(varRegex, () => {
      i += 1;
      if (i === 1) return name;
      return otp;
    });
  } else if (varCount === 1) {
    message = message.replace(varRegex, otp);
  }

  // `{#}` — DLT often uses two: first = fixed greeting ("User"), second = OTP (not both OTP).
  const hashMatches = message.match(/\{#\}/g);
  const hashCount = hashMatches ? hashMatches.length : 0;
  if (hashCount >= 2) {
    let h = 0;
    message = message.replace(/\{#\}/g, () => {
      h += 1;
      if (h === 1) return DLT_FIRST_HASH_GREETING;
      return otp;
    });
  } else if (hashCount === 1) {
    message = message.replace(/\{#\}/, otp);
  }

  message = message
    .replace(/\{\{otp\}\}/gi, otp)
    .replace(/\{otp\}/gi, otp)
    .replace(/\$OTP\$/g, otp);

  if (!message.includes(otp)) {
    message = `${configuredMessage} ${otp}`.trim();
  }
  return message;
}

function formatFast2SmsMessage(data) {
  if (!data || data.message == null) return '';
  const m = data.message;
  return Array.isArray(m) ? m.join('; ') : String(m);
}

async function sendOtpViaFast2Sms(phoneNumber, otp, rawFullName = '') {
  const apiKey = String(process.env.FAST2SMS_API_KEY || '').trim();
  if (!apiKey) {
    throw new Error(
      'FAST2SMS_API_KEY is not set in server .env — SMS cannot be sent. Add your Fast2SMS API key.',
    );
  }

  const otpDigits = String(otp || '').replace(/\D/g, '');
  if (!otpDigits) {
    throw new Error('Invalid OTP for SMS');
  }

  let payload;
  if (FAST2SMS_ROUTE === 'dlt_manual') {
    const senderId = String(process.env.FAST2SMS_SENDER_ID || '').trim();
    const templateId = String(process.env.FAST2SMS_TEMPLATE_ID || '').trim();
    const entityId = String(process.env.FAST2SMS_ENTITY_ID || '').trim();
    const configuredMessage = String(process.env.FAST2SMS_DLT_MESSAGE || 'Your OTP is {#}').trim();
    if (!senderId) {
      throw new Error('FAST2SMS_SENDER_ID is required for dlt_manual route');
    }
    const message = buildDltManualMessage(configuredMessage, otpDigits, rawFullName);
    payload = {
      route: 'dlt_manual',
      sender_id: senderId,
      message,
      numbers: phoneNumber,
      ...(templateId ? { template_id: templateId } : {}),
      ...(entityId ? { entity_id: entityId } : {}),
    };
  } else {
    payload = {
      route: 'otp',
      variables_values: otpDigits,
      numbers: phoneNumber,
    };
  }

  const response = await fetch(FAST2SMS_URL, {
    method: 'POST',
    headers: {
      authorization: apiKey,
      'content-type': 'application/json',
      accept: '*/*',
    },
    body: JSON.stringify(payload),
  });

  let data = null;
  try {
    data = await response.json();
  } catch (_error) {
    data = null;
  }

  const providerText = formatFast2SmsMessage(data);

  if (!response.ok) {
    console.error('[Fast2SMS] HTTP', response.status, data);
    throw new Error(providerText || `Fast2SMS request failed (HTTP ${response.status})`);
  }

  // Fast2SMS often returns HTTP 200 with return: false (wallet, DLT, KYC, spam, etc.)
  const accepted = data?.return === true || data?.return === 'true';
  if (!accepted) {
    console.error('[Fast2SMS] Not accepted', JSON.stringify(data));
    throw new Error(
      providerText ||
        'SMS was not accepted by Fast2SMS. Check API wallet balance, DLT template, and KYC in the Fast2SMS dashboard.',
    );
  }
}

function placeholderPhoneEmail(phoneNumber) {
  return `${phoneNumber}@phone.gawriganga.local`;
}

/**
 * Phone OTP: identify users by phone only. New rows use a placeholder email (DB constraint).
 */
async function createOrFetchPhoneUser(phoneNumber, fullName) {
  const fullNameTrim =
    fullName != null && String(fullName).trim() !== '' ? String(fullName).trim() : null;

  const existingByPhone = await query(
    'SELECT id, full_name, role, is_verified, phone_number FROM users WHERE phone_number = $1',
    [phoneNumber],
  );

  if (existingByPhone.rows.length > 0) {
    const userByPhone = existingByPhone.rows[0];
    if (fullNameTrim) {
      const updated = await query(
        `UPDATE users
         SET full_name = COALESCE(NULLIF($1, ''), full_name)
         WHERE id = $2
         RETURNING id, full_name, role, is_verified, phone_number`,
        [fullNameTrim, userByPhone.id],
      );
      return updated.rows[0];
    }
    return userByPhone;
  }

  const emailForNew = placeholderPhoneEmail(phoneNumber);
  const passwordHash = await bcrypt.hash(`otp-only-${Date.now()}-${Math.random()}`, 10);
  const inserted = await query(
    `INSERT INTO users (email, password_hash, full_name, phone_number)
     VALUES ($1, $2, $3, $4)
     RETURNING id, full_name, role, is_verified, phone_number`,
    [emailForNew, passwordHash, fullNameTrim, phoneNumber],
  );
  return inserted.rows[0];
}

export const me = async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({
        success: false,
        message: 'Not authenticated',
      });
    }

    const result = await query(
      'SELECT id, full_name, role, is_verified, phone_number, created_at, updated_at FROM users WHERE id = $1',
      [userId],
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'User not found',
      });
    }

    res.json({
      success: true,
      user: publicAuthUser(result.rows[0]),
    });
  } catch (err) {
    console.error('Me error:', err);
    res.status(500).json({
      success: false,
      message: 'Internal server error',
    });
  }
};

export const logout = async (req, res) => {
  res.json({
    success: true,
    message: 'Logged out successfully (client should delete token)',
  });
};

export const sendPhoneOtp = async (req, res) => {
  try {
    const {
      phone_number: phoneNumberBody,
      full_name: fullNameBody,
      name: nameBody,
      is_signup: isSignupBody,
    } = req.body;
    let nameForSms = fullNameBody != null ? fullNameBody : nameBody;
    const phoneNumber = normalizeIndianPhone(phoneNumberBody);
    if (!phoneNumber) {
      return res.status(400).json({
        success: false,
        message: 'Please provide a valid Indian mobile number',
      });
    }

    const isSignupFlow = isSignupBody === true;

    if (isSignupFlow) {
      const v = validateSignupFullName(nameForSms);
      if (!v.ok) {
        return res.status(400).json({
          success: false,
          message: v.message,
        });
      }
      nameForSms = v.value;
    } else {
      const skipLoginDbCheck =
        phoneNumber === DEMO_PHONE_NUMBER && process.env.NODE_ENV !== 'production';
      if (!skipLoginDbCheck) {
        const registered = await query(
          'SELECT id FROM users WHERE phone_number = $1 LIMIT 1',
          [phoneNumber],
        );
        if (registered.rows.length === 0) {
          return res.status(404).json({
            success: false,
            code: 'NO_ACCOUNT',
            message:
              'No account found for this mobile number. Please create an account first.',
          });
        }
      }
    }

    if (
      process.env.NODE_ENV === 'production' &&
      phoneNumber === DEMO_PHONE_NUMBER &&
      process.env.ALLOW_DEMO_PHONE_IN_PROD !== 'true'
    ) {
      return res.status(400).json({
        success: false,
        message: 'Demo phone is disabled in production',
      });
    }

    const otp = phoneNumber === DEMO_PHONE_NUMBER ? DEMO_OTP : generateNumericOtp(OTP_LENGTH);

    // Send SMS before storing OTP so we never report success if the provider rejects the send.
    if (phoneNumber !== DEMO_PHONE_NUMBER) {
      await sendOtpViaFast2Sms(phoneNumber, otp, nameForSms);
    }

    const otpHash = await bcrypt.hash(otp, 10);
    const expiresAt = new Date(Date.now() + OTP_EXPIRY_MINUTES * 60 * 1000);

    await query(
      `INSERT INTO otp_login_requests (phone_number, otp_hash, expires_at)
       VALUES ($1, $2, $3)`,
      [phoneNumber, otpHash, expiresAt],
    );

    const isDevelopment = process.env.NODE_ENV !== 'production';
    return res.json({
      success: true,
      message: 'OTP sent successfully',
      otp_length: OTP_LENGTH,
      ...(isDevelopment ? { dev_otp: otp } : {}),
      is_demo_number: phoneNumber === DEMO_PHONE_NUMBER,
    });
  } catch (err) {
    console.error('Send phone OTP error:', err);
    return res.status(500).json({
      success: false,
      message: err?.message || 'Failed to send OTP',
    });
  }
};

export const verifyPhoneOtp = async (req, res) => {
  try {
    const {
      phone_number: phoneNumberBody,
      otp,
      full_name: fullNameBody,
      name,
      is_signup: isSignupBody,
    } = req.body;
    const phoneNumber = normalizeIndianPhone(phoneNumberBody);
    const otpText = String(otp || '').trim();

    if (
      process.env.NODE_ENV === 'production' &&
      phoneNumber === DEMO_PHONE_NUMBER &&
      process.env.ALLOW_DEMO_PHONE_IN_PROD !== 'true'
    ) {
      return res.status(400).json({
        success: false,
        message: 'Demo phone is disabled in production',
      });
    }

    if (!phoneNumber || !otpText) {
      return res.status(400).json({
        success: false,
        message: 'Phone number and OTP are required',
      });
    }

    const requestResult = await query(
      `SELECT id, otp_hash, expires_at, attempts, is_used
       FROM otp_login_requests
       WHERE phone_number = $1
       ORDER BY created_at DESC
       LIMIT 1`,
      [phoneNumber],
    );

    if (requestResult.rows.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'OTP not found. Please request a new OTP',
      });
    }

    const otpRequest = requestResult.rows[0];
    if (otpRequest.is_used) {
      return res.status(400).json({
        success: false,
        message: 'OTP already used. Please request a new OTP',
      });
    }
    if (new Date(otpRequest.expires_at).getTime() < Date.now()) {
      return res.status(400).json({
        success: false,
        message: 'OTP expired. Please request a new OTP',
      });
    }
    if (otpRequest.attempts >= 5) {
      return res.status(429).json({
        success: false,
        message: 'Too many invalid attempts. Please request a new OTP',
      });
    }

    const isMatch = await bcrypt.compare(otpText, otpRequest.otp_hash);
    if (!isMatch) {
      await query(
        'UPDATE otp_login_requests SET attempts = attempts + 1 WHERE id = $1',
        [otpRequest.id],
      );
      return res.status(401).json({
        success: false,
        message: 'Invalid OTP',
      });
    }

    await query(
      'UPDATE otp_login_requests SET is_used = TRUE WHERE id = $1',
      [otpRequest.id],
    );

    const existingByPhone = await query('SELECT id FROM users WHERE phone_number = $1', [
      phoneNumber,
    ]);
    const isNewPhoneUser = existingByPhone.rows.length === 0;
    const isSignupFlow = isSignupBody === true;

    const allowLoginWithoutExistingUser =
      !isSignupFlow &&
      isNewPhoneUser &&
      phoneNumber === DEMO_PHONE_NUMBER &&
      process.env.NODE_ENV !== 'production';

    if (!isSignupFlow && isNewPhoneUser && !allowLoginWithoutExistingUser) {
      return res.status(400).json({
        success: false,
        code: 'NO_ACCOUNT',
        message:
          'No account for this number. Use Create account to register, then sign in.',
      });
    }

    let fullNameForUser = fullNameBody != null ? fullNameBody : name;
    if (isNewPhoneUser && isSignupFlow) {
      const v = validateSignupFullName(fullNameForUser);
      if (!v.ok) {
        return res.status(400).json({
          success: false,
          message: v.message,
        });
      }
      fullNameForUser = v.value;
    } else if (fullNameForUser != null && String(fullNameForUser).trim() !== '') {
      fullNameForUser = String(fullNameForUser).trim();
    } else {
      fullNameForUser = null;
    }

    const user = await createOrFetchPhoneUser(phoneNumber, fullNameForUser);
    const token = signToken(user);

    if (isNewPhoneUser && isSignupFlow) {
      queueNewAccountNotification(user);
    }

    return res.json({
      success: true,
      message: 'Phone verified successfully',
      token,
      user: publicAuthUser(user),
    });
  } catch (err) {
    console.error('Verify phone OTP error:', err);
    const msg = err?.message || 'Failed to verify OTP';
    const conflict = /linked|already/i.test(msg);
    return res.status(conflict ? 409 : 500).json({
      success: false,
      message: msg,
    });
  }
};

