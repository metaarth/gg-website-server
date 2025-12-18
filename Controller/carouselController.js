import supabase from '../config/supabaseClient.js';

// Get all carousel images
export const getCarouselImages = async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('website_carousel')
            .select('id, image_url, created_at')
            .order('created_at', { ascending: false });

        if (error) {
            console.error('Supabase error:', error);
            return res.status(500).json({ error: 'Failed to fetch carousel images' });
        }

        res.json(data || []);
    } catch (error) {
        console.error('Server error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
};

