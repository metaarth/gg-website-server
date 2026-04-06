import { query } from '../config/db.js';
import { getS3PublicUrl } from '../config/s3.js';

/** Read discount from DB row (node-pg uses snake_case; tolerate camelCase). Null/empty → null; 0+ → number. */
function pickDiscountPercent(row) {
    if (!row || typeof row !== 'object') return null;
    const raw = row.discount_percent ?? row.discountPercent;
    if (raw === null || raw === undefined || raw === '') return null;
    const n = parseFloat(raw);
    if (!Number.isFinite(n)) return null;
    return n;
}

function toProductImages(imagesData) {
    const out = [];
    if (!imagesData) return out;
    for (const key of ['image1', 'image2', 'image3', 'image4']) {
        const v = imagesData[key];
        if (v != null && String(v).trim() !== '' && String(v).toLowerCase() !== 'null') {
            out.push(getS3PublicUrl(v) || v);
        }
    }
    return out;
}

// Get products by category with filters
export const getProductsByCategory = async (req, res) => {
    try {
        const { category, subcategory, deity, planet, rarity, search, featured } = req.query;

        let categoryId = null;
        if (category) {
            const catRes = await query(
                'SELECT id FROM categories WHERE LOWER(name) = LOWER($1)',
                [category],
            );
            if (catRes.rows.length === 0) {
                return res.status(200).json({ success: true, data: [] });
            }
            categoryId = catRes.rows[0].id;
        }

        let sql = `
            SELECT id, name, description, short_description, price, stock_quantity,
                   category_id, subcategory, deity, benefits, planet, rarity, status, created_at,
                   discount_percent, is_featured
            FROM products
            WHERE status = 'active'
        `;
        const params = [];
        let idx = 1;

        if (categoryId != null) {
            sql += ` AND category_id = $${idx}`;
            params.push(categoryId);
            idx++;
        }
        if (subcategory && subcategory !== 'all') {
            sql += ` AND LOWER(TRIM(subcategory)) = LOWER(TRIM($${idx}::text))`;
            params.push(subcategory);
            idx++;
        }
        if (deity && deity !== 'all') {
            sql += ` AND deity = $${idx}`;
            params.push(deity);
            idx++;
        }
        if (planet && planet !== 'all') {
            sql += ` AND planet = $${idx}`;
            params.push(planet);
            idx++;
        }
        if (rarity && rarity !== 'all') {
            sql += ` AND rarity = $${idx}`;
            params.push(rarity);
            idx++;
        }
        if (search) {
            sql += ` AND (name ILIKE $${idx} OR description ILIKE $${idx})`;
            params.push(`%${search}%`);
            idx++;
        }
        if (featured !== undefined) {
            const featuredValue = String(featured).toLowerCase() === 'true';
            sql += ` AND is_featured = $${idx}`;
            params.push(featuredValue);
            idx++;
        }

        const limit = Math.min(parseInt(req.query.limit, 10) || 50, 100);
        const offset = parseInt(req.query.offset, 10) || 0;
        sql += ` ORDER BY created_at DESC LIMIT $${idx} OFFSET $${idx + 1}`;
        params.push(limit, offset);

        const productsRes = await query(sql, params);
        const products = productsRes.rows || [];

        let productImagesMap = {};
        if (products.length > 0) {
            const ids = products.map((p) => p.id);
            const placeholders = ids.map((_, i) => `$${i + 1}`).join(', ');
            const imgRes = await query(
                `SELECT * FROM product_images WHERE product_id IN (${placeholders})`,
                ids,
            );
            (imgRes.rows || []).forEach((img) => {
                if (!productImagesMap[img.product_id]) productImagesMap[img.product_id] = [];
                toProductImages(img).forEach((url) => productImagesMap[img.product_id].push(url));
            });
        }

        const transformedProducts = products.map((product) => ({
            id: product.id,
            name: product.name,
            description: product.description,
            short_description: product.short_description || '',
            price: parseFloat(product.price),
            stock: product.stock_quantity,
            subcategory: product.subcategory || '',
            deity: product.deity || '',
            benefits: product.benefits || '',
            planet: product.planet || '',
            rarity: product.rarity || '',
            discount_percent: pickDiscountPercent(product),
            is_featured: product.is_featured ?? false,
            images: productImagesMap[product.id] || [],
        }));

        res.status(200).json({ success: true, data: transformedProducts });
    } catch (error) {
        console.error('[getProductsByCategory]', error?.message || error);
        res.status(500).json({
            success: false,
            error: 'Internal server error',
        });
    }
};

// Get unique filter values for a category
export const getFilterOptions = async (req, res) => {
    try {
        const { category } = req.query;
        if (!category) {
            return res.status(400).json({
                success: false,
                error: 'Category parameter is required',
            });
        }

        const catRes = await query(
            'SELECT id FROM categories WHERE LOWER(name) = LOWER($1)',
            [category],
        );
        if (catRes.rows.length === 0) {
            return res.status(200).json({
                success: true,
                data: { subcategories: [], deities: [], planets: [], rarities: [] },
            });
        }

        const catId = catRes.rows[0].id;
        const prodsRes = await query(
            'SELECT subcategory, deity, planet, rarity FROM products WHERE category_id = $1 AND status = $2',
            [catId, 'active'],
        );
        const products = prodsRes.rows || [];

        const subcategories = [...new Set(products.map((p) => p.subcategory).filter(Boolean))].sort();
        const deities = [...new Set(products.map((p) => p.deity).filter(Boolean))].sort();
        const planets = [...new Set(products.map((p) => p.planet).filter(Boolean))].sort();
        const rarities = [...new Set(products.map((p) => p.rarity).filter(Boolean))].sort();

        res.status(200).json({
            success: true,
            data: { subcategories, deities, planets, rarities },
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: 'Internal server error',
        });
    }
};

// Get single product by ID
export const getProductById = async (req, res) => {
    try {
        const { id } = req.params;
        if (!id) {
            return res.status(400).json({
                success: false,
                error: 'Product ID is required',
            });
        }

        const productRes = await query(
            `SELECT id, name, description, short_description, price, stock_quantity,
                    category_id, subcategory, deity, benefits, planet, rarity, status, created_at,
                    discount_percent, is_featured
             FROM products WHERE id = $1 AND status = 'active'`,
            [id],
        );
        const product = productRes.rows[0];
        if (!product) {
            return res.status(404).json({ success: false, error: 'Product not found' });
        }

        const imgRes = await query(
            'SELECT * FROM product_images WHERE product_id = $1',
            [id],
        );
        let images = [];
        if (imgRes.rows[0]) images = toProductImages(imgRes.rows[0]);

        let categoryName = '';
        if (product.category_id) {
            const catRes = await query('SELECT name FROM categories WHERE id = $1', [
                product.category_id,
            ]);
            if (catRes.rows[0]) categoryName = catRes.rows[0].name;
        }

        res.status(200).json({
            success: true,
            data: {
                id: product.id,
                name: product.name,
                description: product.description,
                short_description: product.short_description || '',
                price: parseFloat(product.price),
                stock: product.stock_quantity,
                category: categoryName,
                subcategory: product.subcategory || '',
                deity: product.deity || '',
                benefits: product.benefits || '',
                planet: product.planet || '',
                rarity: product.rarity || '',
                discount_percent: pickDiscountPercent(product),
                is_featured: product.is_featured ?? false,
                images,
            },
        });
    } catch (error) {
        console.error('[getProductById]', error?.message || error);
        res.status(500).json({
            success: false,
            error: 'Internal server error',
        });
    }
};
