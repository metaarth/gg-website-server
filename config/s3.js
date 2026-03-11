/**
 * Build public URL for S3 object (bucket: ggimg-images).
 * Use when DB stores a key/path like "products/xyz.jpg" or "StaticImg/Rudrakshas/file.png"
 */
const BUCKET = process.env.AWS_S3_BUCKET || 'ggimg-images';
const REGION = process.env.AWS_REGION || 'ap-south-1';

const BASE = `https://${BUCKET}.s3.${REGION}.amazonaws.com`;

export function getS3PublicUrl(keyOrPath) {
    if (!keyOrPath || typeof keyOrPath !== 'string') return null;
    const trimmed = keyOrPath.trim();
    if (!trimmed) return null;
    if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) return trimmed;
    const path = trimmed.startsWith('/') ? trimmed.slice(1) : trimmed;
    return `${BASE}/${path}`;
}

/** For static images: folder = Rudrakshas|Zodiac, file_name = filename */
export function getStaticImageUrl(folder, file_name) {
    if (!folder || !file_name) return null;
    const path = `StaticImg/${encodeURIComponent(folder)}/${encodeURIComponent(file_name)}`;
    return getS3PublicUrl(path);
}

export { BASE as S3_PUBLIC_BASE };
