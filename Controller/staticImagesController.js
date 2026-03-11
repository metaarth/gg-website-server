import { query } from '../config/db.js';
import { getStaticImageUrl } from '../config/s3.js';

export const getStaticImages = async (req, res) => {
    try {
        const { folder } = req.query;

        let sql =
            'SELECT id, folder, key, file_name, url, sort_order FROM static_images ORDER BY sort_order ASC, key ASC';
        const params = [];
        if (folder) {
            sql = 'SELECT id, folder, key, file_name, url, sort_order FROM static_images WHERE folder = $1 ORDER BY sort_order ASC, key ASC';
            params.push(folder);
        }

        const resQ = await query(sql, params);
        const rows = resQ.rows || [];

        const items = rows.map((row) => ({
            id: row.id,
            folder: row.folder,
            key: row.key,
            file_name: row.file_name,
            sort_order: row.sort_order,
            url: row.url || getStaticImageUrl(row.folder, row.file_name),
        }));

        if (folder) {
            return res.json(items);
        }

        const byFolder = items.reduce((acc, item) => {
            if (!acc[item.folder]) acc[item.folder] = [];
            acc[item.folder].push(item);
            return acc;
        }, {});

        res.json(byFolder);
    } catch (err) {
        console.error('getStaticImages error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
};
