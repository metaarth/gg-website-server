import sha512 from 'js-sha512';
import pool, { query } from '../config/db.js';
import { validateCheckoutTotals, amountsMatch } from '../utils/checkoutPricing.js';
import { queueNewOrderNotification } from '../utils/adminNotification.js';

const EASEBUZZ_KEY = process.env.EASEBUZZ_KEY;
const EASEBUZZ_SALT = process.env.EASEBUZZ_SALT;
const EASEBUZZ_ENV = (process.env.EASEBUZZ_ENV || 'test').toLowerCase();
const FRONTEND_URL = (process.env.FRONTEND_URL || 'http://localhost:5174').replace(/\/$/, '');
const PAYMENT_CALLBACK_BASE_URL = (process.env.PAYMENT_CALLBACK_BASE_URL || '').replace(/\/$/, '');

const EASEBUZZ_BASE_URL =
    EASEBUZZ_ENV === 'prod' ? 'https://pay.easebuzz.in' : 'https://testpay.easebuzz.in';

function getPublicBaseUrl(req) {
    if (PAYMENT_CALLBACK_BASE_URL) return PAYMENT_CALLBACK_BASE_URL;
    const xfProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
    const proto = xfProto || req.protocol || 'http';
    const host = req.get('x-forwarded-host') || req.get('host');
    const safeProto = host && !/localhost|127\.0\.0\.1/i.test(host) ? 'https' : proto;
    return `${safeProto}://${host}`;
}

function generatePaymentHash(data, key, salt) {
    const udf = (i) => (data[`udf${i}`] != null ? String(data[`udf${i}`]).trim() : '');
    const hashstring = [
        key,
        data.txnid,
        data.amount,
        data.productinfo,
        data.firstname,
        data.email,
        udf(1), udf(2), udf(3), udf(4), udf(5),
        udf(6), udf(7), udf(8), udf(9), udf(10),
        salt,
    ].join('|');
    return sha512.sha512(hashstring);
}

function verifyCallbackHash(body, salt) {
    const udf = (i) => (body[`udf${i}`] != null ? String(body[`udf${i}`]).trim() : '');
    const hashstring = [
        salt,
        body.status || '',
        udf(10), udf(9), udf(8), udf(7), udf(6),
        udf(5), udf(4), udf(3), udf(2), udf(1),
        body.email || '',
        body.firstname || '',
        body.productinfo || '',
        body.amount || '',
        body.txnid || '',
        body.key || '',
    ].join('|');
    return sha512.sha512(hashstring);
}

async function findOrderByEasebuzzTxn(txnKey) {
    if (txnKey == null || String(txnKey).trim() === '') return null;
    try {
        const r = await query('SELECT id FROM orders WHERE easebuzz_txnid = $1 LIMIT 1', [String(txnKey)]);
        return r.rows[0] || null;
    } catch (e) {
        if (e.code === '42703') return null;
        throw e;
    }
}

async function markOrderDraftFailed(draftId) {
    if (!draftId) return;
    try {
        await query(
            "UPDATE order_drafts SET status = 'failed' WHERE id = $1",
            [draftId],
        );
    } catch (err) {
        // Older schema may not have `status` column; do not break callback flow for this.
        if (err?.code === '42703' && String(err?.message || '').includes('status')) {
            return;
        }
        throw err;
    }
}

async function createOrderFromDraft(draft, easebuzzTxnId = null) {
    const items = draft.items && Array.isArray(draft.items) ? draft.items : [];
    if (items.length === 0) return { order: null, error: 'No items in draft' };

    const today = new Date().toISOString().split('T')[0].replace(/-/g, '');
    const todayStart = new Date().toISOString().split('T')[0];

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const explicitUseWallet = String(draft.use_wallet).toLowerCase() === 'true' || draft.use_wallet === true;
        const explicitWalletAmount = Math.max(0, Number(draft.wallet_amount_to_use) || 0);
        const derivedWalletAmount = Math.max(
            0,
            (Number(draft.total_amount) || 0) +
            (Number(draft.shipping_charges) || 0) +
            (Number(draft.blessing_charge) || 0) -
            (Number(draft.final_amount) || 0),
        );
        const requestedWalletAmount = Math.max(explicitWalletAmount, derivedWalletAmount);
        const useWallet = explicitUseWallet || requestedWalletAmount > 0;
        let walletAmountUsed = 0;
        let walletBalanceBefore = 0;
        let walletBalanceAfter = 0;

        if (requestedWalletAmount > 0) {
            const walletRes = await client.query(
                'SELECT COALESCE(cashback_amount, 0) AS balance FROM users WHERE id = $1 FOR UPDATE',
                [draft.user_id],
            );
            walletBalanceBefore = Number(walletRes.rows[0]?.balance || 0);
            walletAmountUsed = Math.min(requestedWalletAmount, walletBalanceBefore);
            walletBalanceAfter = walletBalanceBefore - walletAmountUsed;

            if (walletAmountUsed > 0) {
                await client.query(
                    'UPDATE users SET cashback_amount = $1 WHERE id = $2',
                    [walletBalanceAfter, draft.user_id],
                );
            }
        }

        const countRes = await client.query(
            'SELECT COUNT(*) AS c FROM orders WHERE created_at >= $1::date',
            [todayStart],
        );
        const count = parseInt(countRes.rows[0]?.c || 0, 10);
        const orderNumber = `GG-${today}-${String(count + 1).padStart(5, '0')}`;

        const orderParams = [
            draft.user_id,
            orderNumber,
            draft.address_id,
            Number(draft.total_amount) || 0,
            Number(draft.discount_amount) || 0,
            Number(draft.shipping_charges) || 0,
            Number(draft.final_amount),
            'easebuzz',
            'paid',
            'pending',
            null,
        ];

        let orderRes;
        const txn = easebuzzTxnId != null && String(easebuzzTxnId).trim() !== '' ? String(easebuzzTxnId) : null;
        if (txn) {
            try {
                orderRes = await client.query(
                    `INSERT INTO orders (user_id, order_number, address_id, total_amount, discount_amount, shipping_charges, final_amount, payment_method, payment_status, order_status, notes, easebuzz_txnid)
                     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
                     RETURNING *`,
                    [...orderParams, txn],
                );
            } catch (insertErr) {
                if (insertErr.code === '42703' && String(insertErr.message || '').includes('easebuzz_txnid')) {
                    orderRes = await client.query(
                        `INSERT INTO orders (user_id, order_number, address_id, total_amount, discount_amount, shipping_charges, final_amount, payment_method, payment_status, order_status, notes)
                         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
                         RETURNING *`,
                        orderParams,
                    );
                } else if (insertErr.code === '23505') {
                    await client.query('ROLLBACK');
                    const existing = await query('SELECT * FROM orders WHERE easebuzz_txnid = $1 LIMIT 1', [txn]).catch(() => ({
                        rows: [],
                    }));
                    if (existing.rows?.[0]) {
                        return { order: existing.rows[0], error: null };
                    }
                    return { order: null, error: insertErr.message || 'Duplicate payment reference' };
                } else {
                    throw insertErr;
                }
            }
        } else {
            orderRes = await client.query(
                `INSERT INTO orders (user_id, order_number, address_id, total_amount, discount_amount, shipping_charges, final_amount, payment_method, payment_status, order_status, notes)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
                 RETURNING *`,
                orderParams,
            );
        }

        const order = orderRes.rows[0];
        if (!order) return { order: null, error: 'Insert order failed' };

        for (const item of items) {
            const subtotal = (item.product_price || 0) * (item.quantity || 0);
            await client.query(
                `INSERT INTO order_items (order_id, product_id, product_name, product_price, quantity, subtotal)
                 VALUES ($1, $2, $3, $4, $5, $6)`,
                [
                    order.id,
                    item.product_id,
                    item.product_name,
                    item.product_price,
                    item.quantity,
                    subtotal,
                ],
            );
        }

        if (walletAmountUsed > 0) {
            const numericSourceId = Number.isFinite(Number(order.id)) ? Number(order.id) : null;
            await client.query(
                `INSERT INTO wallet_transactions (user_id, txn_type, source_type, source_id, amount, balance_before, balance_after, remarks)
                 VALUES ($1, 'debit', 'order', $2, $3, $4, $5, $6)`,
                [
                    draft.user_id,
                    numericSourceId,
                    walletAmountUsed,
                    walletBalanceBefore,
                    walletBalanceAfter,
                    `Wallet used in online order ${order.order_number} (id: ${order.id})`,
                ],
            );
        }

        await client.query('COMMIT');
        queueNewOrderNotification(order);
        return { order, error: null };
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('createOrderFromDraft error:', err.message, err.code, err.detail);
        return { order: null, error: err.message || String(err) };
    } finally {
        client.release();
    }
}

export const initiatePayment = async (req, res) => {
    try {
        if (!EASEBUZZ_KEY || !EASEBUZZ_SALT) {
            return res.status(500).json({
                success: false,
                message: 'Payment gateway is not configured',
            });
        }

        const user_id = req.user?.id;
        if (!user_id) {
            return res.status(401).json({
                success: false,
                message: 'Not authenticated',
            });
        }
        const {
            address_id,
            items,
            total_amount,
            discount_amount = 0,
            coupon_code = null,
            shipping_charges = 0,
            blessing_charge = 0,
            final_amount,
            use_wallet = false,
            wallet_amount_to_use = 0,
            firstname,
            email,
            phone,
        } = req.body;

        if (!address_id || !items || !Array.isArray(items) || items.length === 0) {
            return res.status(400).json({
                success: false,
                message: 'Missing required fields: address_id, items (array)',
            });
        }
        // Ensure address belongs to the authenticated user
        const addrCheck = await query(
            'SELECT id FROM addresses WHERE id = $1 AND user_id = $2 AND is_active = true',
            [address_id, user_id],
        );
        if (!addrCheck.rows?.length) {
            return res.status(403).json({
                success: false,
                message: 'Address not found or does not belong to you',
            });
        }
        if (final_amount == null || !firstname || !email || !phone) {
            return res.status(400).json({
                success: false,
                message: 'Missing required fields: final_amount, firstname, email, phone',
            });
        }

        const pricing = await validateCheckoutTotals({
            items,
            userId: user_id,
            coupon_code,
            clientTotalAmount: total_amount,
            clientDiscountAmount: discount_amount,
            shipping_charges,
            blessing_charge,
        });
        if (!pricing.ok) {
            return res.status(pricing.status || 400).json({
                success: false,
                message: pricing.message || 'Invalid cart or pricing',
            });
        }

        let walletDeduction = 0;
        const requestedWallet = use_wallet ? Math.max(0, Number(wallet_amount_to_use) || 0) : 0;
        if (requestedWallet > 0) {
            const wRes = await query(
                'SELECT COALESCE(cashback_amount, 0) AS balance FROM users WHERE id = $1',
                [user_id],
            );
            const bal = Number(wRes.rows[0]?.balance || 0);
            walletDeduction = Math.min(requestedWallet, bal, pricing.computedPreWallet);
        }

        const serverFinalAmount = Math.max(0, pricing.computedPreWallet - walletDeduction);
        if (!amountsMatch(serverFinalAmount, final_amount)) {
            return res.status(400).json({
                success: false,
                message: 'Order total does not match. Please refresh and try again.',
            });
        }

        const amountNum = serverFinalAmount;
        const amountStr = amountNum.toFixed(2);

        const draftData = {
            user_id: String(user_id),
            address_id: address_id != null ? String(address_id) : null,
            items,
            total_amount: pricing.serverSubtotal,
            discount_amount: pricing.effectiveDiscount,
            shipping_charges: pricing.serverShipping,
            blessing_charge: Number(blessing_charge) || 0,
            final_amount: amountNum,
            use_wallet: walletDeduction > 0,
            wallet_amount_to_use: walletDeduction,
            firstname: String(firstname).trim(),
            email: String(email).trim(),
            phone: String(phone).replace(/\D/g, '').slice(0, 10) || '0000000000',
        };

        let draftRes;
        try {
            draftRes = await query(
                `INSERT INTO order_drafts (
                    user_id, address_id, items, total_amount, discount_amount, shipping_charges,
                    blessing_charge, final_amount, use_wallet, wallet_amount_to_use, firstname, email, phone
                 )
                 VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
                 RETURNING *`,
                [
                    draftData.user_id,
                    draftData.address_id,
                    JSON.stringify(draftData.items),
                    draftData.total_amount,
                    draftData.discount_amount,
                    draftData.shipping_charges,
                    draftData.blessing_charge,
                    draftData.final_amount,
                    draftData.use_wallet,
                    draftData.wallet_amount_to_use,
                    draftData.firstname,
                    draftData.email,
                    draftData.phone,
                ],
            );
        } catch (dbErr) {
            console.error('order_drafts insert error:', dbErr.message, dbErr.code, dbErr.detail);
            const msg = dbErr.message || 'Database error';
            const hint =
                dbErr.code === '42P01'
                    ? 'Table order_drafts does not exist. Run Server/schema/order_drafts_table.sql in pgAdmin.'
                    : msg.toLowerCase().includes('uuid') || dbErr.code === '22P02'
                        ? 'order_drafts may use UUID for user_id/address_id. Run Server/schema/fix_order_drafts_user_id.sql to align with app (bigint user_id).'
                        : undefined;
            return res.status(500).json({
                success: false,
                message: hint ? `Failed to create payment session. ${hint}` : 'Failed to create payment session',
                error: msg,
                ...(hint && { hint }),
            });
        }

        const draft = draftRes.rows[0];
        if (!draft) {
            return res.status(500).json({
                success: false,
                message: 'Failed to create payment session',
            });
        }

        const txnid = String(draft.id);
        const udf1 = txnid;

        const callbackBase = getPublicBaseUrl(req);
        const surl = `${callbackBase}/api/payment/callback`;
        const furl = surl;

        const data = {
            key: EASEBUZZ_KEY,
            txnid,
            amount: amountStr,
            productinfo: `Order ${txnid.slice(0, 8)}`,
            firstname: draftData.firstname,
            email: draftData.email,
            phone: draftData.phone,
            surl,
            furl,
            udf1,
            // Carry wallet data through gateway callback, independent of order_drafts schema.
            udf2: draftData.use_wallet ? '1' : '0',
            udf3: String(draftData.wallet_amount_to_use || 0),
            udf4: '', udf5: '', udf6: '', udf7: '', udf8: '', udf9: '', udf10: '',
        };
        data.hash = generatePaymentHash(data, EASEBUZZ_KEY, EASEBUZZ_SALT);

        const formBody = new URLSearchParams();
        Object.keys(data).forEach((k) => formBody.append(k, data[k]));

        const response = await fetch(`${EASEBUZZ_BASE_URL}/payment/initiateLink`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: formBody.toString(),
        });

        const result = await response.json().catch(() => ({}));
        const accessKey =
            typeof result.data === 'string'
                ? result.data
                : result.data?.access_key || result.access_key || result.accessKey;

        if (!accessKey) {
            return res.status(502).json({
                success: false,
                message: 'Could not get payment link',
                detail: result.message || result.error || 'Invalid response from payment gateway',
            });
        }

        const payment_url = `${EASEBUZZ_BASE_URL}/pay/${accessKey}`;

        return res.status(200).json({
            success: true,
            payment_url,
            access_key: accessKey,
        });
    } catch (error) {
        console.error('initiatePayment error:', error?.message, error);
        return res.status(500).json({
            success: false,
            message: 'Payment initiation failed',
            error: error?.message || String(error),
        });
    }
};

export const paymentCallback = async (req, res) => {
    try {
        const body = req.body || {};
        const receivedHash = body.hash;

        if (!receivedHash || !EASEBUZZ_SALT) {
            console.error('paymentCallback: missing hash or EASEBUZZ_SALT');
            return res.redirect(302, `${FRONTEND_URL}/order-failed?reason=invalid_callback`);
        }

        const computedHash = verifyCallbackHash(body, EASEBUZZ_SALT);
        if (computedHash !== receivedHash) {
            console.error('paymentCallback: hash mismatch', { status: body.status, txnid: body.txnid });
            return res.redirect(302, `${FRONTEND_URL}/order-failed?reason=hash_mismatch`);
        }

        const status = (body.status || '').toLowerCase();
        const draftId = body.udf1 || body.txnid;

        if (status === 'success' || status === 'captured') {
            if (!draftId) {
                console.error('paymentCallback: success but no draft id in body');
                return res.redirect(302, `${FRONTEND_URL}/order-failed?reason=no_draft`);
            }

            const txnKey = String(draftId);
            const alreadyPaid = await findOrderByEasebuzzTxn(txnKey);
            if (alreadyPaid?.id) {
                return res.redirect(302, `${FRONTEND_URL}/order-success?order_id=${alreadyPaid.id}`);
            }

            const draftRes = await query(
                'SELECT * FROM order_drafts WHERE id = $1',
                [draftId],
            );
            const draft = draftRes.rows[0];

            if (!draft) {
                const retryOrder = await findOrderByEasebuzzTxn(txnKey);
                if (retryOrder?.id) {
                    return res.redirect(302, `${FRONTEND_URL}/order-success?order_id=${retryOrder.id}`);
                }
                console.error('paymentCallback: draft not found', { draftId });
                return res.redirect(302, `${FRONTEND_URL}/order-failed?reason=draft_not_found`);
            }

            const items = typeof draft.items === 'object' && Array.isArray(draft.items)
                ? draft.items
                : (typeof draft.items === 'string' ? JSON.parse(draft.items || '[]') : []);
            const draftWithItems = {
                ...draft,
                items,
                // Merge both persisted and callback wallet data robustly.
                use_wallet:
                    (String(draft.use_wallet).toLowerCase() === 'true' || draft.use_wallet === true) ||
                    (String(body.udf2 || '') === '1'),
                wallet_amount_to_use: Math.max(
                    Number(draft.wallet_amount_to_use) || 0,
                    Number(body.udf3) || 0,
                ),
            };

            const { order, error: createError } = await createOrderFromDraft(draftWithItems, txnKey);
            if (createError || !order) {
                console.error('paymentCallback: createOrderFromDraft failed', createError || 'no order');
                await markOrderDraftFailed(draftId);
                return res.redirect(302, `${FRONTEND_URL}/order-failed?reason=order_create_failed`);
            }

            // Confirmed order is in orders; remove draft so order_drafts only keeps failed/pending
            await query('DELETE FROM order_drafts WHERE id = $1', [draftId]);

            return res.redirect(302, `${FRONTEND_URL}/order-success?order_id=${order.id}`);
        }

        // Payment failed: keep draft in order_drafts and mark as failed (only failed/pending stay in order_drafts)
        if (draftId) {
            await markOrderDraftFailed(draftId).catch(() => {});
        }
        return res.redirect(
            302,
            `${FRONTEND_URL}/order-failed?draft_id=${draftId || ''}&reason=payment_failed`,
        );
    } catch (error) {
        console.error('paymentCallback error:', error?.message, error);
        return res.redirect(302, `${FRONTEND_URL}/order-failed?reason=error`);
    }
};
