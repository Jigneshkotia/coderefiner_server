import crypto from 'crypto';
function readProvidedKey(req) {
    const header = req.header('X-Admin-Key');
    if (typeof header === 'string' && header.trim()) {
        return header.trim();
    }
    const body = req.body;
    if (typeof body?.adminKey === 'string' && body.adminKey.trim()) {
        return body.adminKey.trim();
    }
    return undefined;
}
function keysMatch(provided, expected) {
    const providedBuf = Buffer.from(provided);
    const expectedBuf = Buffer.from(expected);
    if (providedBuf.length !== expectedBuf.length) {
        return false;
    }
    return crypto.timingSafeEqual(providedBuf, expectedBuf);
}
export function requireAdminKey(req, res, next) {
    const configured = process.env.ADMIN_KEY?.trim();
    if (!configured) {
        res.status(503).json({ error: 'Admin operations are not configured (ADMIN_KEY missing)' });
        return;
    }
    const provided = readProvidedKey(req);
    if (!provided) {
        res.status(401).json({ error: 'Admin key required' });
        return;
    }
    if (!keysMatch(provided, configured)) {
        res.status(401).json({ error: 'Invalid admin key' });
        return;
    }
    next();
}
export function warnIfAdminKeyMissing() {
    if (!process.env.ADMIN_KEY?.trim()) {
        console.warn('WARNING: ADMIN_KEY is not set — delete repo and remove analytics endpoints will return 503');
    }
}
