import { query } from '../config/db.js';
import { getS3PublicUrl } from '../config/s3.js';

export const getCarouselImages = async (req, res) => {
    try {
        const { device_type } = req.query;
        const filterDeviceType = (device_type || 'desktop').toLowerCase();

        const resQ = await query(
            'SELECT id, image_url, device_type, created_at FROM website_carousel WHERE device_type = $1 ORDER BY created_at DESC',
            [filterDeviceType],
        );
        const rows = resQ.rows || [];
        const data = rows.map((row) => ({
            ...row,
            image_url: getS3PublicUrl(row.image_url) || row.image_url,
        }));
        res.json(data);
    } catch (error) {
        console.error('Server error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
};
