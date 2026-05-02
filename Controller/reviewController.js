import crypto from 'crypto';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { query } from '../config/db.js';

const S3_REGION = process.env.AWS_REGION || 'ap-south-1';
const REVIEWS_BUCKET = process.env.AWS_S3_BUCKET || 'ggimg-images';
const REVIEWS_PREFIX = String(process.env.AWS_REVIEW_PREFIX || 'reviews-img').replace(/^\/+|\/+$/g, '');
const s3 = new S3Client({ region: S3_REGION });

const MIME_TO_EXT = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
};

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const isUuid = (value) => UUID_REGEX.test(String(value || '').trim());
let productsHasUuidColumn = null;
let usersHasUuidColumn = null;

const checkProductsUuidColumn = async () => {
    if (productsHasUuidColumn != null) return productsHasUuidColumn;
    const metaRes = await query(
        `SELECT 1
         FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name = 'products'
           AND column_name = 'uuid'
         LIMIT 1`,
        [],
    );
    productsHasUuidColumn = (metaRes.rows || []).length > 0;
    return productsHasUuidColumn;
};

const checkUsersUuidColumn = async () => {
    if (usersHasUuidColumn != null) return usersHasUuidColumn;
    const metaRes = await query(
        `SELECT 1
         FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name = 'users'
           AND column_name = 'uuid'
         LIMIT 1`,
        [],
    );
    usersHasUuidColumn = (metaRes.rows || []).length > 0;
    return usersHasUuidColumn;
};

const resolveReviewProductId = async (rawProductId) => {
    const productId = String(rawProductId || '').trim();
    if (!productId) return null;
    if (isUuid(productId)) return productId;

    // Primary mapping: reviews.product_id references products.id (uuid in this schema).
    const byId = await query(
        'SELECT id::text AS review_product_id FROM products WHERE id::text = $1 LIMIT 1',
        [productId],
    );
    const idResolved = byId.rows?.[0]?.review_product_id;
    if (idResolved && isUuid(idResolved)) return String(idResolved).trim();

    // Optional legacy mapping: numeric products.id + products.uuid shadow column.
    const hasUuidColumn = await checkProductsUuidColumn();
    if (!hasUuidColumn) return null;

    const byLegacyId = await query(
        'SELECT uuid::text AS review_product_id FROM products WHERE id::text = $1 LIMIT 1',
        [productId],
    );
    let legacyResolved = byLegacyId.rows?.[0]?.review_product_id;
    if (!legacyResolved) {
        const hydrated = await query(
            `UPDATE products
             SET uuid = gen_random_uuid()
             WHERE id::text = $1 AND uuid IS NULL
             RETURNING uuid::text AS review_product_id`,
            [productId],
        );
        legacyResolved = hydrated.rows?.[0]?.review_product_id;
    }
    if (legacyResolved && isUuid(legacyResolved)) return String(legacyResolved).trim();

    return null;
};

const resolveReviewUserId = async (rawUserId) => {
    const userId = String(rawUserId || '').trim();
    if (!userId) return null;
    if (isUuid(userId)) return userId;

    const hasUuidColumn = await checkUsersUuidColumn();
    // Current schema has users.id as bigint and reviews.user_id as uuid (nullable),
    // so when no users.uuid exists we store null instead of failing insert.
    if (!hasUuidColumn) return null;

    const uuidRes = await query(
        'SELECT uuid::text AS review_user_id FROM users WHERE id::text = $1 LIMIT 1',
        [userId],
    );
    let resolved = uuidRes.rows?.[0]?.review_user_id;
    if (!resolved) {
        const hydrated = await query(
            `UPDATE users
             SET uuid = gen_random_uuid()
             WHERE id::text = $1 AND uuid IS NULL
             RETURNING uuid::text AS review_user_id`,
            [userId],
        );
        resolved = hydrated.rows?.[0]?.review_user_id;
    }
    if (resolved && isUuid(resolved)) return String(resolved).trim();

    return null;
};

export const getReviewsByProduct = async (req, res) => {
    try {
        const { productId } = req.params;
        if (!productId) {
            return res.status(400).json({
                success: false,
                message: 'Product ID is required',
            });
        }

        const resolvedProductId = await resolveReviewProductId(productId);
        if (!resolvedProductId) {
            return res.status(400).json({
                success: false,
                message: 'Invalid product ID',
            });
        }

        const authUserUuid = await resolveReviewUserId(req.user?.id);
        const selectCols =
            'id, product_id, user_id, reviewer_name, rating, comment, image_url, verified, created_at';

        let resQ;
        if (authUserUuid) {
            resQ = await query(
                `SELECT ${selectCols} FROM reviews
                 WHERE product_id = $1
                   AND (verified = true OR (user_id IS NOT NULL AND user_id = $2 AND verified = false))
                 ORDER BY created_at DESC`,
                [resolvedProductId, authUserUuid],
            );
        } else {
            resQ = await query(
                `SELECT ${selectCols} FROM reviews
                 WHERE product_id = $1 AND verified = true
                 ORDER BY created_at DESC`,
                [resolvedProductId],
            );
        }
        res.status(200).json({ success: true, data: resQ.rows || [] });
    } catch (err) {
        res.status(500).json({
            success: false,
            message: 'Internal server error',
        });
    }
};

export const addReview = async (req, res) => {
    try {
        const authUserId = req.user?.id ?? null;
        const user_id = await resolveReviewUserId(authUserId);
        const body = req.body || {};
        const { product_id, reviewer_name, rating, comment, image_url } = body;

        if (!product_id || !reviewer_name || rating == null || rating === '') {
            return res.status(400).json({
                success: false,
                message: 'product_id, reviewer_name, and rating are required',
            });
        }

        const resolvedProductId = await resolveReviewProductId(product_id);
        if (!resolvedProductId) {
            return res.status(400).json({
                success: false,
                message: 'Invalid product_id',
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
                resolvedProductId,
                user_id,
                String(reviewer_name).trim(),
                r,
                comment ? String(comment).trim() : null,
                image_url ? String(image_url).trim() : null,
            ],
        );
        const data = resQ.rows[0];
        res.status(201).json({
            success: true,
            message: 'Review submitted. It will appear publicly after approval.',
            data,
        });
    } catch (err) {
        res.status(500).json({
            success: false,
            message: 'Internal server error',
        });
    }
};

export const uploadReviewImage = async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({
                success: false,
                message: 'Image file is required',
            });
        }

        const ext = MIME_TO_EXT[req.file.mimetype] || 'jpg';
        const objectKey = `${REVIEWS_PREFIX}/${Date.now()}-${crypto.randomUUID()}.${ext}`;

        await s3.send(
            new PutObjectCommand({
                Bucket: REVIEWS_BUCKET,
                Key: objectKey,
                Body: req.file.buffer,
                ContentType: req.file.mimetype,
            }),
        );

        const imageUrl = `https://${REVIEWS_BUCKET}.s3.${S3_REGION}.amazonaws.com/${objectKey}`;
        return res.status(201).json({
            success: true,
            message: 'Review image uploaded',
            data: { image_url: imageUrl },
        });
    } catch (err) {
        const awsCode = err?.Code || err?.code || err?.name;
        const awsMessage = err?.message || 'Unknown upload error';
        console.error('[review-image-upload] S3 upload failed', {
            bucket: REVIEWS_BUCKET,
            keyPrefix: REVIEWS_PREFIX,
            region: S3_REGION,
            code: awsCode,
            message: awsMessage,
        });

        if (awsCode === 'NoSuchBucket') {
            return res.status(500).json({
                success: false,
                message: `Review image bucket '${REVIEWS_BUCKET}' was not found in region '${S3_REGION}'.`,
            });
        }

        if (awsCode === 'AccessDenied' || awsCode === 'InvalidAccessKeyId' || awsCode === 'SignatureDoesNotMatch') {
            return res.status(500).json({
                success: false,
                message: 'AWS credentials or bucket permissions are invalid for review image upload.',
            });
        }

        return res.status(500).json({
            success: false,
            message: `Failed to upload review image: ${awsMessage}`,
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

        const authUserId = await resolveReviewUserId(req.user?.id);
        if (!authUserId || (existing.user_id != null && String(authUserId) !== String(existing.user_id))) {
            return res.status(403).json({
                success: false,
                message: 'You can only delete your own review',
            });
        }

        await query('DELETE FROM reviews WHERE id = $1', [id]);
        res.status(200).json({ success: true, message: 'Review deleted' });
    } catch (err) {
        res.status(500).json({
            success: false,
            message: 'Internal server error',
        });
    }
};
