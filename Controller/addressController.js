import { query } from '../config/db.js';

export const getUserAddresses = async (req, res) => {
    try {
        const userId = req.user?.id;
        const { userId: paramUserId } = req.params;
        if (!userId) {
            return res.status(401).json({ success: false, message: 'Not authenticated' });
        }
        if (paramUserId && String(paramUserId) !== String(userId)) {
            return res.status(403).json({ success: false, message: 'Forbidden' });
        }

        const resQ = await query(
            'SELECT * FROM addresses WHERE user_id = $1 AND is_active = true ORDER BY is_default DESC, created_at DESC',
            [userId],
        );
        res.status(200).json({ success: true, data: resQ.rows || [] });
    } catch (error) {
        res.status(500).json({
            success: false,
            message: 'Internal server error',
        });
    }
};

export const getAddressById = async (req, res) => {
    try {
        const { id } = req.params;
        const userId = req.user?.id;
        if (!userId) {
            return res.status(401).json({ success: false, message: 'Not authenticated' });
        }
        if (!id) {
            return res.status(400).json({
                success: false,
                message: 'Address ID is required',
            });
        }

        const resQ = await query(
            'SELECT * FROM addresses WHERE id = $1 AND user_id = $2 AND is_active = true',
            [id, userId],
        );
        const data = resQ.rows[0];
        if (!data) {
            return res.status(404).json({
                success: false,
                message: 'Address not found',
            });
        }
        res.status(200).json({ success: true, data });
    } catch (error) {
        res.status(500).json({
            success: false,
            message: 'Internal server error',
        });
    }
};

export const createAddress = async (req, res) => {
    try {
        const userId = req.user?.id;
        if (!userId) {
            return res.status(401).json({ success: false, message: 'Not authenticated' });
        }
        const {
            receiver_name,
            receiver_phone,
            address_line1,
            address_line2,
            city,
            state,
            postal_code,
            country,
            latitude,
            longitude,
            is_default,
        } = req.body;

        if (
            !receiver_name ||
            !receiver_phone ||
            !address_line1 ||
            !city ||
            !state ||
            !postal_code
        ) {
            return res.status(400).json({
                success: false,
                message:
                    'Missing required fields: receiver_name, receiver_phone, address_line1, city, state, postal_code',
            });
        }

        const uid = String(userId);

        if (is_default) {
            await query(
                'UPDATE addresses SET is_default = false WHERE user_id = $1 AND is_default = true',
                [uid],
            );
        }

        // addresses.id may be UUID (no default); generate it so INSERT works
        const resQ = await query(
            `INSERT INTO addresses (id, user_id, receiver_name, receiver_phone, address_line1, address_line2, city, state, postal_code, country, latitude, longitude, is_default, is_active)
             VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, true)
             RETURNING *`,
            [
                uid,
                receiver_name,
                receiver_phone,
                address_line1,
                address_line2 || null,
                city,
                state,
                postal_code,
                country || 'India',
                latitude ?? null,
                longitude ?? null,
                is_default || false,
            ],
        );
        const data = resQ.rows[0];
        res.status(201).json({
            success: true,
            message: 'Address created successfully',
            data,
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            message: 'Internal server error',
        });
    }
};

export const updateAddress = async (req, res) => {
    try {
        const { id } = req.params;
        const userId = req.user?.id;
        if (!userId) {
            return res.status(401).json({ success: false, message: 'Not authenticated' });
        }
        const {
            receiver_name,
            receiver_phone,
            address_line1,
            address_line2,
            city,
            state,
            postal_code,
            country,
            latitude,
            longitude,
            is_default,
        } = req.body;

        if (!id) {
            return res.status(400).json({
                success: false,
                message: 'Address ID is required',
            });
        }

        const updateData = {};
        if (receiver_name !== undefined) updateData.receiver_name = receiver_name;
        if (receiver_phone !== undefined) updateData.receiver_phone = receiver_phone;
        if (address_line1 !== undefined) updateData.address_line1 = address_line1;
        if (address_line2 !== undefined) updateData.address_line2 = address_line2;
        if (city !== undefined) updateData.city = city;
        if (state !== undefined) updateData.state = state;
        if (postal_code !== undefined) updateData.postal_code = postal_code;
        if (country !== undefined) updateData.country = country;
        if (latitude !== undefined) updateData.latitude = latitude;
        if (longitude !== undefined) updateData.longitude = longitude;
        if (is_default !== undefined) updateData.is_default = is_default;

        if (is_default === true) {
            await query(
                'UPDATE addresses SET is_default = false WHERE user_id = $1 AND id != $2',
                [userId, id],
            );
        }

        const keys = Object.keys(updateData);
        if (keys.length === 0) {
            const one = await query('SELECT * FROM addresses WHERE id = $1 AND user_id = $2', [
                id,
                userId,
            ]);
            const data = one.rows[0];
            if (!data) {
                return res.status(404).json({ success: false, message: 'Address not found' });
            }
            return res.status(200).json({
                success: true,
                message: 'Address updated successfully',
                data,
            });
        }

        const setClause = keys.map((k, i) => `${k} = $${i + 1}`).join(', ');
        const values = keys.map((k) => updateData[k]);
        values.push(id, userId);

        const resQ = await query(
            `UPDATE addresses SET ${setClause} WHERE id = $${keys.length + 1} AND user_id = $${keys.length + 2} RETURNING *`,
            values,
        );
        const data = resQ.rows[0];
        if (!data) {
            return res.status(404).json({ success: false, message: 'Address not found' });
        }
        res.status(200).json({
            success: true,
            message: 'Address updated successfully',
            data,
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            message: 'Internal server error',
        });
    }
};

export const deleteAddress = async (req, res) => {
    try {
        const { id } = req.params;
        const userId = req.user?.id;
        if (!userId) {
            return res.status(401).json({ success: false, message: 'Not authenticated' });
        }
        if (!id) {
            return res.status(400).json({
                success: false,
                message: 'Address ID is required',
            });
        }

        const resQ = await query(
            'UPDATE addresses SET is_active = false WHERE id = $1 AND user_id = $2 RETURNING *',
            [id, userId],
        );
        const data = resQ.rows[0];
        if (!data) {
            return res.status(404).json({ success: false, message: 'Address not found' });
        }
        res.status(200).json({
            success: true,
            message: 'Address deleted successfully',
            data,
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            message: 'Internal server error',
        });
    }
};

export const setDefaultAddress = async (req, res) => {
    try {
        const { id } = req.params;
        const userId = req.user?.id;
        if (!userId) {
            return res.status(401).json({ success: false, message: 'Not authenticated' });
        }
        if (!id) {
            return res.status(400).json({
                success: false,
                message: 'Address ID is required',
            });
        }

        await query('UPDATE addresses SET is_default = false WHERE user_id = $1', [userId]);
        const resQ = await query(
            'UPDATE addresses SET is_default = true WHERE id = $1 AND user_id = $2 RETURNING *',
            [id, userId],
        );
        const data = resQ.rows[0];
        if (!data) {
            return res.status(404).json({ success: false, message: 'Address not found' });
        }
        res.status(200).json({
            success: true,
            message: 'Default address updated successfully',
            data,
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            message: 'Internal server error',
        });
    }
};
