import { query } from '../config/db.js';

export const getReviewsByProduct = async (req, res) => {
    try {
        const { productId } = req.params;
        if (!productId) {
            return res.status(400).json({
                success: false,
                message: 'Product ID is required',
            });
        }

        const resQ = await query(
            'SELECT id, product_id, user_id, reviewer_name, rating, comment, image_url, verified, created_at FROM reviews WHERE product_id = $1 ORDER BY created_at DESC',
            [productId],
        );
        res.status(200).json({ success: true, data: resQ.rows || [] });
    } catch (err) {
        console.error('getReviewsByProduct:', err);
        res.status(500).json({
            success: false,
            message: 'Internal server error',
            error: err.message,
        });
    }
};

export const addReview = async (req, res) => {
    try {
        const body = req.body || {};
        const { product_id, user_id, reviewer_name, rating, comment, image_url } = body;

        if (!product_id || !reviewer_name || rating == null || rating === '') {
            return res.status(400).json({
                success: false,
                message: 'product_id, reviewer_name, and rating are required',
            });
        }

        const r = Number(rating);
        if (!Number.isInteger(r) || r < 1 || r > 5) {
            return res.status(400).json({
                success: false,
                message: 'rating must be an integer between 1 and 5',
            });
        }

        const resQ = await query(
            `INSERT INTO reviews (product_id, user_id, reviewer_name, rating, comment, image_url, verified)
             VALUES ($1, $2, $3, $4, $5, $6, false)
             RETURNING *`,
            [
                product_id,
                user_id || null,
                String(reviewer_name).trim(),
                r,
                comment ? String(comment).trim() : null,
                image_url ? String(image_url).trim() : null,
            ],
        );
        const data = resQ.rows[0];
        res.status(201).json({
            success: true,
            message: 'Review added',
            data,
        });
    } catch (err) {
        console.error('addReview:', err);
        res.status(500).json({
            success: false,
            message: 'Internal server error',
            error: err.message,
        });
    }
};

export const deleteReview = async (req, res) => {
    try {
        const { id } = req.params;
        const { user_id } = req.body;

        if (!id) {
            return res.status(400).json({
                success: false,
                message: 'Review ID is required',
            });
        }

        const existingRes = await query(
            'SELECT id, user_id FROM reviews WHERE id = $1',
            [id],
        );
        const existing = existingRes.rows[0];

        if (!existing) {
            return res.status(404).json({ success: false, message: 'Review not found' });
        }

        if (existing.user_id != null && user_id !== existing.user_id) {
            return res.status(403).json({
                success: false,
                message: 'You can only delete your own review',
            });
        }

        await query('DELETE FROM reviews WHERE id = $1', [id]);
        res.status(200).json({ success: true, message: 'Review deleted' });
    } catch (err) {
        console.error('deleteReview:', err);
        res.status(500).json({
            success: false,
            message: 'Internal server error',
            error: err.message,
        });
    }
};
