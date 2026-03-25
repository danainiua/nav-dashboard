async function checkSiteAvailability(url, options = {}) {
    const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 8000;
    const startedAt = Date.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => {
        controller.abort();
    }, timeoutMs);

    try {
        const response = await fetch(url, {
            method: 'GET',
            redirect: 'follow',
            signal: controller.signal,
            headers: {
                'User-Agent': 'NavDashboard-AvailabilityCheck/1.0'
            }
        });

        const responseTimeMs = Date.now() - startedAt;
        const isSuccess = response.status < 400;

        return {
            status: isSuccess ? 'success' : 'failed',
            httpStatus: response.status,
            error: isSuccess ? null : `HTTP ${response.status}`,
            finalUrl: response.url || url,
            responseTimeMs
        };
    } catch (error) {
        const responseTimeMs = Date.now() - startedAt;
        const isAbort = error && (error.name === 'AbortError' || /abort/i.test(error.message || ''));
        return {
            status: 'failed',
            httpStatus: null,
            error: isAbort ? `Request timeout after ${timeoutMs}ms` : (error?.message || 'Request failed'),
            finalUrl: url,
            responseTimeMs
        };
    } finally {
        clearTimeout(timeout);
    }
}

module.exports = {
    checkSiteAvailability
};
