/**
 * Wave 3B (P1-04): Object Storage Adapter cho ảnh chứng từ phiếu chi
 * Hỗ trợ STORAGE_PROVIDER=s3|r2|supabase|local (mặc định local lưu nhị phân trong uploads/receipts/
 * thay vì nhồi chuỗi Base64 vào PostgreSQL).
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DEFAULT_LOCAL_ROOT = path.resolve(__dirname, '..', 'uploads', 'receipts');

const MIME_TO_EXT = {
    'image/webp': 'webp',
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/png': 'png',
};

function sanitizeSegment(str, fallback = 'DEFAULT') {
    const cleaned = String(str || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64);
    return cleaned || fallback;
}

/**
 * Giải mã dataUrl (`data:image/webp;base64,...` hoặc `base64:...`) thành Buffer nhị phân.
 */
function decodeImagePayload(dataUrlOrBase64, fallbackMime = 'image/webp') {
    const raw = String(dataUrlOrBase64 || '').trim();
    let mimeType = String(fallbackMime || 'image/webp').toLowerCase();
    let base64Body = '';

    if (raw.startsWith('data:')) {
        const match = raw.match(/^data:([^;]+);base64,(.+)$/i);
        if (!match) {
            throw new Error('INVALID_DATA_URL');
        }
        mimeType = match[1].toLowerCase();
        base64Body = match[2];
    } else if (raw.startsWith('base64:')) {
        base64Body = raw.slice(7);
    } else {
        throw new Error('INVALID_IMAGE_ENCODING');
    }

    if (!MIME_TO_EXT[mimeType]) {
        mimeType = 'image/webp';
    }
    const buffer = Buffer.from(base64Body, 'base64');
    if (buffer.length === 0) {
        throw new Error('EMPTY_IMAGE_BUFFER');
    }
    return {
        buffer,
        mimeType,
        ext: MIME_TO_EXT[mimeType] || 'webp',
    };
}

function getConfiguredProvider() {
    const raw = String(process.env.STORAGE_PROVIDER || 'local').trim().toLowerCase();
    if (['s3', 'r2', 'supabase', 'local'].includes(raw)) return raw;
    return 'local';
}

async function uploadToSupabase({ storageKey, buffer, mimeType }) {
    const supabaseUrl = String(process.env.SUPABASE_URL || '').replace(/\/+$/, '');
    const serviceKey = String(process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
    const bucket = String(process.env.SUPABASE_STORAGE_BUCKET || 'receipts').trim();
    if (!supabaseUrl || !serviceKey) {
        return null;
    }
    const uploadEndpoint = `${supabaseUrl}/storage/v1/object/${encodeURIComponent(bucket)}/${storageKey}`;
    const res = await fetch(uploadEndpoint, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${serviceKey}`,
            apikey: serviceKey,
            'Content-Type': mimeType,
            'x-upsert': 'true',
        },
        body: buffer,
    });
    if (!res.ok) {
        const errText = await res.text().catch(() => '');
        throw new Error(`SUPABASE_STORAGE_UPLOAD_FAILED (${res.status}): ${errText.slice(0, 200)}`);
    }
    const publicBase = String(process.env.STORAGE_PUBLIC_BASE_URL || `${supabaseUrl}/storage/v1/object/public/${bucket}`).replace(/\/+$/, '');
    return {
        storageProvider: 'SUPABASE',
        storageKey,
        storageUrl: `${publicBase}/${storageKey}`,
    };
}

async function uploadToS3Compatible({ provider, storageKey, buffer, mimeType }) {
    const endpoint = String(process.env.S3_ENDPOINT || process.env.R2_ENDPOINT || '').replace(/\/+$/, '');
    const bucket = String(process.env.S3_BUCKET || process.env.R2_BUCKET || '').trim();
    const accessKey = String(process.env.S3_ACCESS_KEY_ID || process.env.R2_ACCESS_KEY_ID || '').trim();
    const secretKey = String(process.env.S3_SECRET_ACCESS_KEY || process.env.R2_SECRET_ACCESS_KEY || '').trim();
    const region = String(process.env.S3_REGION || (provider === 'r2' ? 'auto' : 'ap-southeast-1')).trim();

    if (!endpoint || !bucket || !accessKey || !secretKey) {
        return null;
    }

    // AWS Signature Version 4 tối giản cho PUT Object (không cần SDK nặng)
    const now = new Date();
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
    const dateStamp = amzDate.slice(0, 8);
    const payloadHash = crypto.createHash('sha256').update(buffer).digest('hex');

    const targetUrl = new URL(`${endpoint}/${encodeURIComponent(bucket)}/${storageKey}`);
    const canonicalUri = targetUrl.pathname;
    const canonicalHeaders = `host:${targetUrl.host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`;
    const signedHeaders = 'host;x-amz-content-sha256;x-amz-date';
    const canonicalRequest = ['PUT', canonicalUri, '', canonicalHeaders, signedHeaders, payloadHash].join('\n');

    const algorithm = 'AWS4-HMAC-SHA256';
    const credentialScope = `${dateStamp}/${region}/s3/aws4_request`;
    const stringToSign = [
        algorithm,
        amzDate,
        credentialScope,
        crypto.createHash('sha256').update(canonicalRequest).digest('hex'),
    ].join('\n');

    const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();
    const kDate = hmac(`AWS4${secretKey}`, dateStamp);
    const kRegion = hmac(kDate, region);
    const kService = hmac(kRegion, 's3');
    const kSigning = hmac(kService, 'aws4_request');
    const signature = crypto.createHmac('sha256', kSigning).update(stringToSign).digest('hex');

    const authorization = `${algorithm} Credential=${accessKey}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
    const res = await fetch(targetUrl.toString(), {
        method: 'PUT',
        headers: {
            'Content-Type': mimeType,
            'x-amz-content-sha256': payloadHash,
            'x-amz-date': amzDate,
            Authorization: authorization,
        },
        body: buffer,
    });
    if (!res.ok) {
        const errText = await res.text().catch(() => '');
        throw new Error(`${provider.toUpperCase()}_UPLOAD_FAILED (${res.status}): ${errText.slice(0, 200)}`);
    }

    const publicBase = String(process.env.STORAGE_PUBLIC_BASE_URL || `${endpoint}/${bucket}`).replace(/\/+$/, '');
    return {
        storageProvider: provider.toUpperCase(),
        storageKey,
        storageUrl: `${publicBase}/${storageKey}`,
    };
}

async function uploadToLocal({ storageKey, buffer, idChungTu, localRoot = DEFAULT_LOCAL_ROOT }) {
    const absPath = path.resolve(localRoot, storageKey);
    if (!absPath.startsWith(path.resolve(localRoot))) {
        throw new Error('INVALID_STORAGE_KEY');
    }
    await fs.promises.mkdir(path.dirname(absPath), { recursive: true });
    await fs.promises.writeFile(absPath, buffer);
    return {
        storageProvider: 'LOCAL',
        storageKey,
        storageUrl: `/api/uploads/receipt-photo/${idChungTu}`,
        localPath: absPath,
    };
}

/**
 * Upload ảnh chứng từ ra Object Storage (S3/R2/Supabase) hoặc fallback Local binary file.
 * Không nhồi chuỗi Base64 vào PostgreSQL.
 */
async function uploadReceiptPhoto({ tenantId, idChungTu, dataUrl, mimeType = 'image/webp', localRoot = DEFAULT_LOCAL_ROOT }) {
    const decoded = decodeImagePayload(dataUrl, mimeType);
    const safeTenant = sanitizeSegment(tenantId, 'DEFAULT');
    const safeId = sanitizeSegment(idChungTu, `RCP_${Date.now()}`);
    const storageKey = `${safeTenant}/${safeId}.${decoded.ext}`;

    const provider = getConfiguredProvider();
    let uploaded = null;

    if (provider === 'supabase') {
        uploaded = await uploadToSupabase({ storageKey, buffer: decoded.buffer, mimeType: decoded.mimeType });
    } else if (provider === 's3' || provider === 'r2') {
        uploaded = await uploadToS3Compatible({ provider, storageKey, buffer: decoded.buffer, mimeType: decoded.mimeType });
    }

    if (!uploaded) {
        uploaded = await uploadToLocal({ storageKey, buffer: decoded.buffer, idChungTu: safeId, localRoot });
    }

    return {
        ...uploaded,
        mimeType: decoded.mimeType,
        sizeBytes: decoded.buffer.length,
    };
}

/**
 * Đọc lại tệp ảnh nhị phân từ Local storage (khi xem lại qua API).
 */
async function readLocalReceiptPhoto(storageKey, localRoot = DEFAULT_LOCAL_ROOT) {
    if (!storageKey) return null;
    const absPath = path.resolve(localRoot, String(storageKey));
    if (!absPath.startsWith(path.resolve(localRoot))) return null;
    try {
        return await fs.promises.readFile(absPath);
    } catch {
        return null;
    }
}

module.exports = {
    DEFAULT_LOCAL_ROOT,
    decodeImagePayload,
    getConfiguredProvider,
    uploadReceiptPhoto,
    readLocalReceiptPhoto,
};
