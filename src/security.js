'use strict';

const crypto = require('node:crypto');
const { promisify } = require('node:util');

const scrypt = promisify(crypto.scrypt);

async function hashPassword(password) {
    const salt = crypto.randomBytes(16);
    const cost = 16384;
    const blockSize = 8;
    const parallelization = 1;
    const derivedKey = await scrypt(String(password), salt, 64, {
        N: cost,
        r: blockSize,
        p: parallelization,
        maxmem: 64 * 1024 * 1024
    });
    return ['scrypt', cost, blockSize, parallelization, salt.toString('base64url'), derivedKey.toString('base64url')].join('$');
}

async function verifyPassword(password, encodedHash) {
    try {
        const [algorithm, costText, blockSizeText, parallelizationText, saltText, keyText] = String(encodedHash).split('$');
        const cost = Number(costText);
        const blockSize = Number(blockSizeText);
        const parallelization = Number(parallelizationText);
        if (
            algorithm !== 'scrypt' ||
            cost < 16384 || cost > 131072 ||
            blockSize < 1 || blockSize > 16 ||
            parallelization < 1 || parallelization > 4
        ) {
            return false;
        }
        const expectedKey = Buffer.from(keyText, 'base64url');
        if (expectedKey.length !== 64) {
            return false;
        }
        const actualKey = await scrypt(String(password), Buffer.from(saltText, 'base64url'), expectedKey.length, {
            N: cost,
            r: blockSize,
            p: parallelization,
            maxmem: 128 * 1024 * 1024
        });
        return crypto.timingSafeEqual(expectedKey, actualKey);
    } catch (_error) {
        return false;
    }
}

function hashToken(value) {
    return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function randomToken() {
    return crypto.randomBytes(32).toString('base64url');
}

function createEmailVerificationToken(reviewId, expiresAt, secret) {
    const issuedAt = new Date();
    const payload = Buffer.from(JSON.stringify({
        version: 1,
        purpose: 'verify-email',
        reviewId: String(reviewId),
        issuedAt: issuedAt.toISOString(),
        expiresAt: new Date(expiresAt).toISOString()
    }), 'utf8').toString('base64url');
    const signature = crypto.createHmac('sha256', validateSigningSecret(secret)).update(payload).digest('base64url');
    return `${payload}.${signature}`;
}

function readEmailVerificationToken(token, secret) {
    try {
        const text = String(token || '');
        const match = text.match(/^([A-Za-z0-9_-]{20,1000})\.([A-Za-z0-9_-]{43})$/);
        if (!match) return null;
        const expectedSignature = crypto.createHmac('sha256', validateSigningSecret(secret)).update(match[1]).digest();
        const suppliedSignature = Buffer.from(match[2], 'base64url');
        if (suppliedSignature.length !== expectedSignature.length || !crypto.timingSafeEqual(suppliedSignature, expectedSignature)) return null;
        const payload = JSON.parse(Buffer.from(match[1], 'base64url').toString('utf8'));
        if (payload.version !== 1 || payload.purpose !== 'verify-email' || typeof payload.reviewId !== 'string') return null;
        const issuedAt = new Date(payload.issuedAt);
        const expiresAt = new Date(payload.expiresAt);
        if (Number.isNaN(issuedAt.getTime()) || Number.isNaN(expiresAt.getTime())) return null;
        return { reviewId: payload.reviewId, issuedAt, expiresAt };
    } catch (_error) {
        return null;
    }
}

function validateSigningSecret(secret) {
    const value = String(secret || '');
    if (Buffer.byteLength(value, 'utf8') < 32) {
        throw new Error('EMAIL_VERIFICATION_SECRET must contain at least 32 characters.');
    }
    return value;
}

function escapeHtml(value) {
    const replacements = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' };
    return String(value == null ? '' : value).replace(/[&<>"']/g, (character) => replacements[character]);
}

module.exports = {
    createEmailVerificationToken,
    escapeHtml,
    hashPassword,
    hashToken,
    randomToken,
    readEmailVerificationToken,
    validateSigningSecret,
    verifyPassword
};
