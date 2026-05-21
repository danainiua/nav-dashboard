const { validateRemoteImageUrl } = require('./validator');

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_REDIRECTS = 3;
const IMAGE_EXTENSIONS = {
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'image/gif': '.gif',
    'image/webp': '.webp',
    'image/x-icon': '.ico',
    'image/vnd.microsoft.icon': '.ico'
};

function normalizeContentType(contentType) {
    return String(contentType || '').split(';')[0].trim().toLowerCase();
}

function getImageExtension(contentType) {
    return IMAGE_EXTENSIONS[normalizeContentType(contentType)] || null;
}

async function readResponseWithLimit(response, maxBytes = MAX_IMAGE_BYTES) {
    const chunks = [];
    let total = 0;

    for await (const chunk of response.body) {
        const buffer = Buffer.from(chunk);
        total += buffer.length;
        if (total > maxBytes) {
            throw Object.assign(new Error('Image too large'), { code: 'IMAGE_TOO_LARGE' });
        }
        chunks.push(buffer);
    }

    return Buffer.concat(chunks, total);
}

async function fetchRemoteImage(imageUrl, options = {}) {
    const maxBytes = options.maxBytes || MAX_IMAGE_BYTES;
    const timeoutMs = options.timeoutMs || 5000;
    let currentUrl = imageUrl;

    for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount++) {
        const validation = await validateRemoteImageUrl(currentUrl);
        if (!validation.valid) {
            return { success: false, status: validation.status, error: validation.error };
        }

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), timeoutMs);
        let response;
        try {
            response = await fetch(currentUrl, {
                signal: controller.signal,
                redirect: 'manual',
                headers: {
                    'User-Agent': 'Mozilla/5.0 (compatible; NavDashboard/1.0)',
                    'Accept': 'image/*'
                }
            });
        } catch (error) {
            clearTimeout(timeout);
            if (error.name === 'AbortError') {
                return { success: false, status: 504, error: 'Image proxy timeout' };
            }
            throw error;
        }
        clearTimeout(timeout);

        if ([301, 302, 303, 307, 308].includes(response.status)) {
            const location = response.headers.get('location');
            if (!location) {
                return { success: false, status: 502, error: 'Redirect missing location' };
            }
            currentUrl = new URL(location, currentUrl).toString();
            continue;
        }

        if (!response.ok) {
            return { success: false, status: 502, error: 'Image fetch failed', upstreamStatus: response.status };
        }

        const contentType = normalizeContentType(response.headers.get('content-type'));
        const extension = getImageExtension(contentType);
        if (!extension) {
            return { success: false, status: 400, error: contentType === 'image/svg+xml' ? 'SVG images are not allowed' : 'Not an allowed image type', contentType };
        }

        const contentLength = parseInt(response.headers.get('content-length') || '0', 10);
        if (contentLength > maxBytes) {
            return { success: false, status: 413, error: 'Image too large' };
        }

        try {
            const buffer = await readResponseWithLimit(response, maxBytes);
            return { success: true, buffer, contentType, extension, finalUrl: currentUrl };
        } catch (error) {
            if (error.code === 'IMAGE_TOO_LARGE') {
                return { success: false, status: 413, error: 'Image too large' };
            }
            throw error;
        }
    }

    return { success: false, status: 400, error: 'Too many redirects' };
}

module.exports = {
    MAX_IMAGE_BYTES,
    IMAGE_EXTENSIONS,
    getImageExtension,
    fetchRemoteImage
};
