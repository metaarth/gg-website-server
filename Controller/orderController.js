import { query } from '../config/db.js';
import pool from '../config/db.js';
import { ensureCashbackSchema } from './cashbackController.js';
import { evaluateCouponForCart } from './couponController.js';

export const createOrder = async (req, res) => {
    const client = await pool.connect();
    try {
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
            payment_method,
            notes,
            use_wallet = false,
            wallet_amount_to_use = 0,
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
        if (!payment_method) {
            return res.status(400).json({
                success: false,
                message: 'Payment method is required',
            });
        }

        const normalizedPaymentMethod =
            String(payment_method).toLowerCase() === 'cod' ? 'cod' : String(payment_method);
        let appliedCoupon = null;
        let couponDiscountAmount = 0;
        if (coupon_code) {
            const couponEval = await evaluateCouponForCart({
                code: coupon_code,
                items,
                userId: user_id,
            });
            if (!couponEval.ok) {
                return res.status(couponEval.status || 400).json({
                    success: false,
                    message: couponEval.message || 'Invalid coupon',
                });
            }
            appliedCoupon = couponEval.coupon;
            couponDiscountAmount = Number(couponEval.discount_amount || 0);
        }

        const effectiveDiscount = Math.max(Number(discount_amount) || 0, couponDiscountAmount);
        const computedFinalAmount =
            (Number(total_amount) || 0) -
            effectiveDiscount +
            (Number(shipping_charges) || 0) +
            (Number(blessing_charge) || 0);
        const requestedWalletAmount = use_wallet ? Math.max(0, Number(wallet_amount_to_use) || 0) : 0;
        const today = new Date().toISOString().split('T')[0].replace(/-/g, '');
        const todayStart = new Date().toISOString().split('T')[0];

        const countRes = await query(
            'SELECT COUNT(*) AS c FROM orders WHERE created_at >= $1::date',
            [todayStart],
        );
        const count = parseInt(countRes.rows[0]?.c || 0, 10);
        const orderNumber = `GG-${today}-${String(count + 1).padStart(5, '0')}`;

        await client.query('BEGIN');
        await ensureCashbackSchema();

        let walletAmountUsed = 0;
        let walletBalanceAfter = null;
        if (requestedWalletAmount > 0) {
            const walletRes = await client.query(
                'SELECT COALESCE(cashback_amount, 0) AS balance FROM users WHERE id = $1 FOR UPDATE',
                [user_id],
            );
            const currentBalance = Number(walletRes.rows[0]?.balance || 0);
            walletAmountUsed = Math.min(requestedWalletAmount, currentBalance, computedFinalAmount);
            if (walletAmountUsed > 0) {
                walletBalanceAfter = currentBalance - walletAmountUsed;
                await client.query(
                    'UPDATE users SET cashback_amount = $1 WHERE id = $2',
                    [walletBalanceAfter, user_id],
                );
            }
        }

        const final_amount = Math.max(0, computedFinalAmount - walletAmountUsed);

        const orderData = {
            user_id,
            order_number: orderNumber,
            address_id,
            total_amount: Number(total_amount) || 0,
            discount_amount: effectiveDiscount,
            shipping_charges: Number(shipping_charges) || 0,
            final_amount,
            payment_method:
                final_amount <= 0 && walletAmountUsed > 0 ? 'wallet' : normalizedPaymentMethod,
            payment_status: final_amount <= 0 ? 'paid' : 'pending',
            order_status: 'pending',
            notes:
                Number(blessing_charge) > 0
                    ? [notes, `Special Blessing Service: +₹${Number(blessing_charge)}`]
                        .filter(Boolean)
                        .join(' | ')
                    : [notes, appliedCoupon ? `Coupon Applied: ${appliedCoupon.code}` : null]
                        .filter(Boolean)
                        .join(' | ') || null,
        };

        if (Number.isNaN(orderData.final_amount)) {
            await client.query('ROLLBACK');
            return res.status(400).json({
                success: false,
                message: 'Invalid amount values',
            });
        }

        const orderRes = await client.query(
            `INSERT INTO orders (user_id, order_number, address_id, total_amount, discount_amount, shipping_charges, final_amount, payment_method, payment_status, order_status, notes)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
             RETURNING *`,
            [
                orderData.user_id,
                orderData.order_number,
                orderData.address_id,
                orderData.total_amount,
                orderData.discount_amount,
                orderData.shipping_charges,
                orderData.final_amount,
                orderData.payment_method,
                orderData.payment_status,
                orderData.order_status,
                orderData.notes,
            ],
        );
        const order = orderRes.rows[0];
        if (!order) {
            await client.query('ROLLBACK');
            return res.status(500).json({
                success: false,
                message: 'Failed to create order',
            });
        }

        for (const item of items) {
            await client.query(
                `INSERT INTO order_items (order_id, product_id, product_name, product_price, quantity, subtotal)
                 VALUES ($1, $2, $3, $4, $5, $6)`,
                [
                    order.id,
                    item.product_id,
                    item.product_name,
                    item.product_price,
                    item.quantity,
                    (item.product_price || 0) * (item.quantity || 0),
                ],
            );
        }

        if (walletAmountUsed > 0) {
            const numericSourceId = Number.isFinite(Number(order.id)) ? Number(order.id) : null;
            await client.query(
                `INSERT INTO wallet_transactions (user_id, txn_type, source_type, source_id, amount, balance_before, balance_after, remarks)
                 VALUES ($1, 'debit', 'order', $2, $3, $4, $5, $6)`,
                [
                    user_id,
                    numericSourceId,
                    walletAmountUsed,
                    walletBalanceAfter + walletAmountUsed,
                    walletBalanceAfter,
                    `Wallet used in order ${order.order_number} (id: ${order.id})`,
                ],
            );
        }

        if (appliedCoupon) {
            await client.query(
                `INSERT INTO coupon_usages (coupon_id, user_id, order_id, discount_amount)
                 VALUES ($1, $2, $3, $4)`,
                [appliedCoupon.id, user_id, order.id, effectiveDiscount],
            );
        }

        const itemsRes = await client.query('SELECT * FROM order_items WHERE order_id = $1', [order.id]);
        const addrRes = await client.query('SELECT * FROM addresses WHERE id = $1', [order.address_id]);
        await client.query('COMMIT');
        const responseData = {
            ...order,
            addresses: addrRes.rows[0] || null,
            order_items: itemsRes.rows || [],
            wallet_amount_used: walletAmountUsed,
            payable_after_wallet: final_amount,
            coupon_code: appliedCoupon?.code || null,
        };

        res.status(201).json({
            success: true,
            message: 'Order created successfully',
            data: responseData,
        });
    } catch (error) {
        await client.query('ROLLBACK');
        res.status(500).json({
            success: false,
            message: 'Internal server error',
        });
    } finally {
        client.release();
    }
};

export const getUserOrders = async (req, res) => {
    try {
        const authUserId = req.user?.id;
        if (!authUserId) {
            return res.status(401).json({ success: false, message: 'Not authenticated' });
        }

        const ordersRes = await query(
            'SELECT * FROM orders WHERE user_id = $1 ORDER BY created_at DESC',
            [authUserId],
        );
        const orders = ordersRes.rows || [];
        if (orders.length === 0) {
            return res.status(200).json({ success: true, data: [] });
        }

        const orderIds = orders.map((o) => o.id);
        const addressIds = [...new Set(orders.map((o) => o.address_id).filter(Boolean))];
        const [itemsRes, addrRes] = await Promise.all([
            query('SELECT * FROM order_items WHERE order_id = ANY($1::uuid[])', [orderIds]),
            addressIds.length > 0
                ? query('SELECT * FROM addresses WHERE id = ANY($1)', [addressIds])
                : { rows: [] },
        ]);

        const itemsByOrder = (itemsRes.rows || []).reduce((acc, row) => {
            if (!acc[row.order_id]) acc[row.order_id] = [];
            acc[row.order_id].push(row);
            return acc;
        }, {});
        const addrMap = (addrRes.rows || []).reduce((acc, row) => {
            acc[row.id] = row;
            return acc;
        }, {});

        const data = orders.map((o) => ({
            ...o,
            order_items: itemsByOrder[o.id] || [],
            addresses: addrMap[o.address_id] || null,
        }));

        res.status(200).json({ success: true, data });
    } catch (error) {
        console.error('getUserOrders error:', error);
        res.status(500).json({
            success: false,
            message: 'Internal server error',
        });
    }
};

export const getOrderById = async (req, res) => {
    try {
        const { id } = req.params;
        const authUserId = req.user?.id;
        if (!authUserId) {
            return res.status(401).json({ success: false, message: 'Not authenticated' });
        }
        if (!id) {
            return res.status(400).json({
                success: false,
                message: 'Order ID is required',
            });
        }

        const orderRes = await query('SELECT * FROM orders WHERE id = $1', [id]);
        const order = orderRes.rows[0];
        if (!order) {
            return res.status(404).json({ success: false, message: 'Order not found' });
        }
        if (String(order.user_id) !== String(authUserId)) {
            return res.status(404).json({ success: false, message: 'Order not found' });
        }

        const [itemsRes, addrRes] = await Promise.all([
            query('SELECT * FROM order_items WHERE order_id = $1', [id]),
            query('SELECT * FROM addresses WHERE id = $1', [order.address_id]),
        ]);

        res.status(200).json({
            success: true,
            data: {
                ...order,
                addresses: addrRes.rows[0] || null,
                order_items: itemsRes.rows || [],
            },
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            message: 'Internal server error',
        });
    }
};

// Only admins can set these order statuses; customers can only set CUSTOMER_ALLOWED_ORDER_STATUSES
const ADMIN_ONLY_ORDER_STATUSES = ['processing', 'shipped', 'delivered'];
const CUSTOMER_ALLOWED_ORDER_STATUSES = ['cancelled'];
// Only admins can update payment_status
const ALLOWED_ORDER_STATUSES = [...ADMIN_ONLY_ORDER_STATUSES, ...CUSTOMER_ALLOWED_ORDER_STATUSES];

export const updateOrderStatus = async (req, res) => {
    try {
        const { id } = req.params;
        const authUserId = req.user?.id;
        const userRole = (req.user?.role || 'user').toLowerCase();
        const isAdmin = userRole === 'admin';
        if (!authUserId) {
            return res.status(401).json({ success: false, message: 'Not authenticated' });
        }
        const { order_status, payment_status } = req.body;
        if (!id) {
            return res.status(400).json({
                success: false,
                message: 'Order ID is required',
            });
        }

        // Payment status can only be updated by admin
        if (payment_status !== undefined && payment_status !== null && payment_status !== '') {
            if (!isAdmin) {
                return res.status(403).json({
                    success: false,
                    message: 'Only admins can update payment status',
                });
            }
        }

        // Order status: admin can set any allowed value; customer can only set cancelled
        if (order_status !== undefined && order_status !== null && order_status !== '') {
            const status = String(order_status).trim().toLowerCase();
            if (!ALLOWED_ORDER_STATUSES.includes(status)) {
                return res.status(400).json({
                    success: false,
                    message: `Invalid order_status. Allowed: ${ALLOWED_ORDER_STATUSES.join(', ')}`,
                });
            }
            if (ADMIN_ONLY_ORDER_STATUSES.includes(status) && !isAdmin) {
                return res.status(403).json({
                    success: false,
                    message: 'Only admins can set order status to processing, shipped, or delivered',
                });
            }
            if (CUSTOMER_ALLOWED_ORDER_STATUSES.includes(status) && !isAdmin) {
                // Customer can only update their own order to cancelled
                const orderRes = await query('SELECT id, user_id FROM orders WHERE id = $1', [id]);
                const order = orderRes.rows[0];
                if (!order || String(order.user_id) !== String(authUserId)) {
                    return res.status(404).json({ success: false, message: 'Order not found' });
                }
            }
        }

        const updates = [];
        const params = [];
        let idx = 1;
        if (order_status) {
            updates.push(`order_status = $${idx}`);
            params.push(String(order_status).trim().toLowerCase());
            idx++;
        }
        if (payment_status) {
            updates.push(`payment_status = $${idx}`);
            params.push(payment_status);
            idx++;
        }
        if (updates.length === 0) {
            return res.status(400).json({
                success: false,
                message: 'Provide order_status and/or payment_status',
            });
        }
        // Admin can update any order; customer can only update their own (already validated for cancelled above)
        params.push(id);
        if (!isAdmin) {
            params.push(authUserId);
        }
        const whereClause = isAdmin
            ? `id = $${idx}`
            : `id = $${idx} AND user_id = $${idx + 1}`;
        const resQ = await query(
            `UPDATE orders SET ${updates.join(', ')} WHERE ${whereClause} RETURNING *`,
            params,
        );
        const data = resQ.rows[0];
        if (!data) {
            return res.status(404).json({ success: false, message: 'Order not found' });
        }

        res.status(200).json({
            success: true,
            message: 'Order updated successfully',
            data,
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            message: 'Internal server error',
        });
    }
};
