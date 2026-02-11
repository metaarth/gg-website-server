import supabase from '../config/supabaseClient.js';
import { sendMail } from '../config/mailer.js';
import { preorderConfirmation } from '../templates/emailTemplates.js';

/**
 * Create preorder entries (one row per cart item).
 * Body: { user_id?, email?, items: [...] }
 * When user_id is provided, recipient email is taken from Supabase Auth (logged-in user). Otherwise email from body is required.
 */
export const createPreorders = async (req, res) => {
    try {
        const { user_id, email, items } = req.body;

        if (!items || !Array.isArray(items) || items.length === 0) {
            return res.status(400).json({
                success: false,
                message: 'Missing required field: items (non-empty array)'
            });
        }

        let emailToUse = email ? String(email).trim().toLowerCase() : null;

        if (user_id) {
            const { data: userData, error: userError } = await supabase.auth.admin.getUserById(user_id);
            if (userError || !userData?.user?.email) {
                return res.status(401).json({
                    success: false,
                    message: 'Invalid user. Please log in again.',
                    error: userError?.message
                });
            }
            emailToUse = userData.user.email.trim().toLowerCase();
        }

        if (!emailToUse) {
            return res.status(400).json({
                success: false,
                message: 'Missing email. Please log in or provide your email.'
            });
        }

        const rows = items.map((item) => ({
            user_id: user_id || null,
            email: emailToUse,
            product_id: item.product_id,
            product_name: item.product_name || 'Product',
            product_price: Number(item.product_price) || 0,
            quantity: Math.max(1, parseInt(item.quantity, 10) || 1)
        }));

        const { data, error } = await supabase
            .from('preorders')
            .insert(rows)
            .select('id, email, product_name, quantity, created_at');

        if (error) {
            const isRls = error.message?.toLowerCase().includes('policy') ||
                error.message?.toLowerCase().includes('row-level security') ||
                error.code === '42501';
            return res.status(500).json({
                success: false,
                message: 'Failed to save preorders',
                error: error.message,
                hint: isRls ? 'Ensure preorders table exists and RLS allows service role. Run Server/preorders-table.sql in Supabase.' : undefined
            });
        }

        const emailData = preorderConfirmation(data || rows);
        const mailResult = await sendMail({
            to: emailToUse,
            subject: emailData.subject,
            text: emailData.text,
            html: emailData.html
        });

        if (!mailResult.success) {
            console.error('[Preorder] Email not sent:', mailResult.error);
        }

        res.status(201).json({
            success: true,
            message: 'Preorder saved. We’ll notify you when we launch!',
            emailSent: mailResult.success,
            data: data || rows
        });
    } catch (err) {
        res.status(500).json({
            success: false,
            message: 'Internal server error',
            error: err?.message || String(err)
        });
    }
};

/**
 * Get all preorders (e.g. for admin dashboard or export).
 */
export const getAllPreorders = async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('preorders')
            .select('*')
            .order('created_at', { ascending: false });

        if (error) {
            return res.status(500).json({
                success: false,
                message: 'Failed to fetch preorders',
                error: error.message
            });
        }

        res.status(200).json({
            success: true,
            data: data || []
        });
    } catch (err) {
        res.status(500).json({
            success: false,
            message: 'Internal server error',
            error: err?.message || String(err)
        });
    }
};
