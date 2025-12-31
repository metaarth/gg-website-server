import supabase from '../config/supabaseClient.js';

// Get products by category with filters
export const getProductsByCategory = async (req, res) => {
    try {
        const { category, subcategory, deity, planet, rarity, search } = req.query;

        // Build query - fetch products without relationship first
        let query = supabase
            .from('products')
            .select(`
                id,
                name,
                description,
                short_description,
                price,
                stock_quantity,
                category_id,
                subcategory,
                deity,
                benefits,
                planet,
                rarity,
                status,
                created_at
            `)
            .eq('status', 'active')
            .order('created_at', { ascending: false });

        // Filter by category name
        if (category) {
            // Try exact match first
            let { data: categoryData, error: categoryError } = await supabase
                .from('categories')
                .select('id, name')
                .eq('name', category)
                .maybeSingle();
            
            // If no exact match, try case-insensitive search
            if (!categoryData && !categoryError) {
                const { data: allCategories } = await supabase
                    .from('categories')
                    .select('id, name');
                
                if (allCategories) {
                    categoryData = allCategories.find(cat => 
                        cat.name.toLowerCase() === category.toLowerCase()
                    );
                }
            }
            
            if (categoryData) {
                query = query.eq('category_id', categoryData.id);
            } else {
                return res.status(200).json({
                    success: true,
                    data: []
                });
            }
        }

        // Apply additional filters
        if (subcategory && subcategory !== 'all') {
            query = query.eq('subcategory', subcategory);
        }

        if (deity && deity !== 'all') {
            query = query.eq('deity', deity);
        }

        if (planet && planet !== 'all') {
            query = query.eq('planet', planet);
        }

        if (rarity && rarity !== 'all') {
            query = query.eq('rarity', rarity);
        }

        if (search) {
            query = query.or(`name.ilike.%${search}%,description.ilike.%${search}%`);
        }

        const { data: products, error } = await query;

        if (error) {
            return res.status(500).json({ 
                success: false,
                error: 'Failed to fetch products',
                details: error.message 
            });
        }

        // Fetch images separately for all products
        let productImagesMap = {};
        if (products && products.length > 0) {
            const productIds = products.map(p => p.id);
            
            const { data: imagesData, error: imagesError } = await supabase
                .from('product_images')
                .select('*')
                .in('product_id', productIds);
            
            if (!imagesError && imagesData && imagesData.length > 0) {
                imagesData.forEach(img => {
                    if (!productImagesMap[img.product_id]) {
                        productImagesMap[img.product_id] = [];
                    }
                    if (img.image1) productImagesMap[img.product_id].push(img.image1);
                    if (img.image2) productImagesMap[img.product_id].push(img.image2);
                    if (img.image3) productImagesMap[img.product_id].push(img.image3);
                    if (img.image4) productImagesMap[img.product_id].push(img.image4);
                });
            }
        }

        // Transform data
        const transformedProducts = products.map(product => {
            // Extract images from the map
            let images = [];
            
            if (productImagesMap[product.id]) {
                images = productImagesMap[product.id].filter(img => 
                    img !== null && 
                    img !== undefined && 
                    img !== '' &&
                    String(img).trim() !== '' &&
                    String(img).toLowerCase() !== 'null'
                );
            }

            return {
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
                images: images
            };
        });

        res.status(200).json({
            success: true,
            data: transformedProducts
        });

    } catch (error) {
        res.status(500).json({ 
            success: false,
            error: 'Internal server error' 
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
                error: 'Category parameter is required'
            });
        }

        // Get category ID - try exact match first, then case-insensitive
        let { data: categoryData, error: categoryError } = await supabase
            .from('categories')
            .select('id, name')
            .eq('name', category)
            .maybeSingle();
        
        // If no exact match, try case-insensitive search
        if (!categoryData && !categoryError) {
            const { data: allCategories } = await supabase
                .from('categories')
                .select('id, name');
            
            if (allCategories) {
                categoryData = allCategories.find(cat => 
                    cat.name.toLowerCase() === category.toLowerCase()
                );
            }
        }

        if (!categoryData) {
            return res.status(200).json({
                success: true,
                data: {
                    subcategories: [],
                    deities: [],
                    planets: [],
                    rarities: []
                }
            });
        }

        // Get all products in this category
        const { data: products, error } = await supabase
            .from('products')
            .select('subcategory, deity, planet, rarity')
            .eq('category_id', categoryData.id)
            .eq('status', 'active');

        if (error) {
            return res.status(500).json({ 
                success: false,
                error: 'Failed to fetch filter options' 
            });
        }

        // Extract unique values
        const subcategories = [...new Set(products.map(p => p.subcategory).filter(Boolean))].sort();
        const deities = [...new Set(products.map(p => p.deity).filter(Boolean))].sort();
        const planets = [...new Set(products.map(p => p.planet).filter(Boolean))].sort();
        const rarities = [...new Set(products.map(p => p.rarity).filter(Boolean))].sort();

        res.status(200).json({
            success: true,
            data: {
                subcategories,
                deities,
                planets,
                rarities
            }
        });

    } catch (error) {
        res.status(500).json({ 
            success: false,
            error: 'Internal server error' 
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
                error: 'Product ID is required'
            });
        }

        // Fetch product
        const { data: product, error: productError } = await supabase
            .from('products')
            .select(`
                id,
                name,
                description,
                short_description,
                price,
                stock_quantity,
                category_id,
                subcategory,
                deity,
                benefits,
                planet,
                rarity,
                status,
                created_at
            `)
            .eq('id', id)
            .eq('status', 'active')
            .maybeSingle();

        if (productError) {
            return res.status(500).json({ 
                success: false,
                error: 'Failed to fetch product',
                details: productError.message 
            });
        }

        if (!product) {
            return res.status(404).json({
                success: false,
                error: 'Product not found'
            });
        }

        // Fetch images
        const { data: imagesData, error: imagesError } = await supabase
            .from('product_images')
            .select('*')
            .eq('product_id', id)
            .maybeSingle();

        let images = [];
        if (!imagesError && imagesData) {
            if (imagesData.image1) images.push(imagesData.image1);
            if (imagesData.image2) images.push(imagesData.image2);
            if (imagesData.image3) images.push(imagesData.image3);
            if (imagesData.image4) images.push(imagesData.image4);
        }

        // Get category name
        let categoryName = '';
        if (product.category_id) {
            const { data: categoryData } = await supabase
                .from('categories')
                .select('name')
                .eq('id', product.category_id)
                .maybeSingle();
            
            if (categoryData) {
                categoryName = categoryData.name;
            }
        }

        // Transform data
        const transformedProduct = {
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
            images: images.filter(img => 
                img !== null && 
                img !== undefined && 
                img !== '' &&
                String(img).trim() !== '' &&
                String(img).toLowerCase() !== 'null'
            )
        };

        res.status(200).json({
            success: true,
            data: transformedProduct
        });

    } catch (error) {
        res.status(500).json({ 
            success: false,
            error: 'Internal server error' 
        });
    }
};

