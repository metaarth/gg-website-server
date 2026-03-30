import sha512 from 'js-sha512';
import { query } from '../config/db.js';

const EASEBUZZ_KEY = process.env.EASEBUZZ_KEY;
const EASEBUZZ_SALT = process.env.EASEBUZZ_SALT;
const EASEBUZZ_ENV = (process.env.EASEBUZZ_ENV || 'test').toLowerCase();
const FRONTEND_URL = (process.env.FRONTEND_URL || 'http://localhost:5174').replace(/\/$/, '');

const EASEBUZZ_BASE_URL =
    EASEBUZZ_ENV === 'prod' ? 'https://pay.easebuzz.in' : 'https://testpay.easebuzz.in';

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

async function createOrderFromDraft(draft) {
    const items = draft.items && Array.isArray(draft.items) ? draft.items : [];
    if (items.length === 0) return { order: null, error: 'No items in draft' };

    const today = new Date().toISOString().split('T')[0].replace(/-/g, '');
    const todayStart = new Date().toISOString().split('T')[0];

    try {
        const countRes = await query(
            'SELECT COUNT(*) AS c FROM orders WHERE created_at >= $1::date',
            [todayStart],
        );
        const count = parseInt(countRes.rows[0]?.c || 0, 10);
        const orderNumber = `GG-${today}-${String(count + 1).padStart(5, '0')}`;

        const orderRes = await query(
            `INSERT INTO orders (user_id, order_number, address_id, total_amount, discount_amount, shipping_charges, final_amount, payment_method, payment_status, order_status, notes)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
             RETURNING *`,
            [
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
            ],
        );
        const order = orderRes.rows[0];
        if (!order) return { order: null, error: 'Insert order failed' };

        for (const item of items) {
            const subtotal = (item.product_price || 0) * (item.quantity || 0);
            await query(
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

        return { order, error: null };
    } catch (err) {
        console.error('createOrderFromDraft error:', err.message, err.code, err.detail);
        return { order: null, error: err.message || String(err) };
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
            shipping_charges = 0,
            blessing_charge = 0,
            final_amount,
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

        const amountNum = Number(final_amount);
        const amountStr = amountNum.toFixed(2);

        const draftData = {
            user_id: String(user_id),
            address_id: address_id != null ? String(address_id) : null,
            items,
            total_amount: Number(total_amount) || 0,
            discount_amount: Number(discount_amount) || 0,
            shipping_charges: Number(shipping_charges) || 0,
            blessing_charge: Number(blessing_charge) || 0,
            final_amount: amountNum,
            firstname: String(firstname).trim(),
            email: String(email).trim(),
            phone: String(phone).replace(/\D/g, '').slice(0, 10) || '0000000000',
        };

        let draftRes;
        try {
            draftRes = await query(
                `INSERT INTO order_drafts (user_id, address_id, items, total_amount, discount_amount, shipping_charges, final_amount, firstname, email, phone)
                 VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7, $8, $9, $10)
                 RETURNING *`,
                [
                    draftData.user_id,
                    draftData.address_id,
                    JSON.stringify(draftData.items),
                    draftData.total_amount,
                    draftData.discount_amount,
                    draftData.shipping_charges,
                    draftData.final_amount,
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

        const callbackBase = `${req.protocol}://${req.get('host')}`;
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
            udf2: '', udf3: '', udf4: '', udf5: '', udf6: '', udf7: '', udf8: '', udf9: '', udf10: '',
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

            const draftRes = await query(
                'SELECT * FROM order_drafts WHERE id = $1',
                [draftId],
            );
            const draft = draftRes.rows[0];

            if (!draft) {
                console.error('paymentCallback: draft not found', { draftId });
                return res.redirect(302, `${FRONTEND_URL}/order-failed?reason=draft_not_found`);
            }

            const items = typeof draft.items === 'object' && Array.isArray(draft.items)
                ? draft.items
                : (typeof draft.items === 'string' ? JSON.parse(draft.items || '[]') : []);
            const draftWithItems = { ...draft, items };

            const { order, error: createError } = await createOrderFromDraft(draftWithItems);
            if (createError || !order) {
                console.error('paymentCallback: createOrderFromDraft failed', createError || 'no order');
                await query(
                    "UPDATE order_drafts SET status = 'failed' WHERE id = $1",
                    [draftId],
                );
                return res.redirect(302, `${FRONTEND_URL}/order-failed?reason=order_create_failed`);
            }

            // Confirmed order is in orders; remove draft so order_drafts only keeps failed/pending
            await query('DELETE FROM order_drafts WHERE id = $1', [draftId]);

            return res.redirect(302, `${FRONTEND_URL}/order-success?order_id=${order.id}`);
        }

        // Payment failed: keep draft in order_drafts and mark as failed (only failed/pending stay in order_drafts)
        if (draftId) {
            await query(
                "UPDATE order_drafts SET status = 'failed' WHERE id = $1",
                [draftId],
            ).catch(() => {});
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
