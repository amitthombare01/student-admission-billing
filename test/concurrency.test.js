'use strict';

process.env.NODE_ENV = 'test';
process.env.USE_PG_MEM = '1';
process.env.HOST = '127.0.0.1';
process.env.PORT = '0';
process.env.MAIL_TRANSPORT = 'json';
process.env.APP_BASE_URL = 'https://school.example.test';
process.env.MAIL_FROM = 'notifications@example.test';
process.env.OUTBOX_POLL_MS = '1000';
process.env.EMAIL_VERIFICATION_SECRET = 'a-dedicated-test-secret-of-at-least-32-characters';
process.env.ADMIN_EMAIL = 'concurrency-admin@example.test';
process.env.ADMIN_PASSWORD = 'a-long-concurrency-test-password';
process.env.ADMIN_NAME = 'Concurrency Test Administrator';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');
const { queueUnverifiedRegistrationEmails, startApplication } = require('../src/application');
const { hashPassword } = require('../src/security');

const STAFF_EMAIL = 'concurrency-staff@example.test';
const STAFF_PASSWORD = 'correct-horse-battery-staple';

test('account state changes are idempotent and sessions stay bounded and revocable', async (context) => {
    const application = await startApplication();
    context.after(async () => application.close());
    const baseUrl = `http://127.0.0.1:${application.listeningPort}`;

    const legacyReviewId = crypto.randomUUID();
    const legacyPasswordHash = await hashPassword('legacy-pending-password');
    const legacyUser = await application.pool.query(`
        INSERT INTO users (review_id, full_name, username, password_hash, role, status, email_verified_at)
        VALUES ($1, 'Legacy Pending Staff', 'legacy-pending@example.test', $2, 'staff', 'pending', NULL)
        RETURNING id
    `, [legacyReviewId, legacyPasswordHash]);
    await application.pool.query(`
        INSERT INTO notification_outbox (event_type, recipient, payload, dedupe_key)
        VALUES ('registration_pending', $1, $2::JSONB, $3)
    `, [process.env.ADMIN_EMAIL, JSON.stringify({ reviewId: legacyReviewId, fullName: 'Legacy Pending Staff', username: 'legacy-pending@example.test' }), `legacy-admin:${legacyUser.rows[0].id}`]);
    await queueUnverifiedRegistrationEmails(application.pool);
    const convertedNotifications = await application.pool.query(`
        SELECT recipient, payload FROM notification_outbox
        WHERE payload ->> 'reviewId' = $1
    `, [legacyReviewId]);
    assert.equal(convertedNotifications.rowCount, 1);
    assert.equal(convertedNotifications.rows[0].recipient, 'legacy-pending@example.test');
    assert.equal(convertedNotifications.rows[0].payload.notificationKind, 'email_verification');

    const passwordHash = await hashPassword(STAFF_PASSWORD);
    const inserted = await application.pool.query(`
        INSERT INTO users (
            review_id, full_name, username, password_hash, role, status,
            status_changed_at, approved_at, email_verified_at
        ) VALUES ($1, $2, $3, $4, 'staff', 'active', NOW(), NOW(), NOW())
        RETURNING id
    `, [crypto.randomUUID(), 'Concurrency Test Staff', STAFF_EMAIL, passwordHash]);
    const userId = inserted.rows[0].id;

    const adminLogin = await api(baseUrl, '/api/admin/login', {
        method: 'POST',
        body: {
            username: process.env.ADMIN_EMAIL,
            password: process.env.ADMIN_PASSWORD
        }
    });
    assert.equal(adminLogin.status, 200);
    const adminHeaders = { Authorization: `Bearer ${adminLogin.data.token}` };

    const initialLogin = await staffLogin(baseUrl);
    assert.equal(initialLogin.status, 200);

    const alreadyActive = await setStatus(baseUrl, adminHeaders, userId, 'active');
    assert.equal(alreadyActive.status, 200);
    assert.equal(await auditCount(application.pool, 'account_reactivated'), 0);

    const disableResults = await Promise.all([
        setStatus(baseUrl, adminHeaders, userId, 'disabled'),
        setStatus(baseUrl, adminHeaders, userId, 'disabled')
    ]);
    // pg-mem parses FOR UPDATE but does not emulate PostgreSQL's lock-wait scheduling,
    // so its losing request can observe the conditional-update conflict as 409.
    const disableStatuses = disableResults.map((result) => result.status);
    assert.ok(disableStatuses.includes(200));
    assert.ok(disableStatuses.every((status) => status === 200 || status === 409));
    const repeatedDisable = await setStatus(baseUrl, adminHeaders, userId, 'disabled');
    assert.equal(repeatedDisable.status, 200);
    assert.equal(await auditCount(application.pool, 'account_disabled'), 1);
    assert.equal(await sessionCount(application.pool, userId), 0);

    const revoked = await api(baseUrl, '/api/session', {
        headers: { Authorization: `Bearer ${initialLogin.data.token}` }
    });
    assert.equal(revoked.status, 401);

    const reactivated = await setStatus(baseUrl, adminHeaders, userId, 'active');
    const alreadyReactivated = await setStatus(baseUrl, adminHeaders, userId, 'active');
    assert.equal(reactivated.status, 200);
    assert.equal(alreadyReactivated.status, 200);
    assert.equal(await auditCount(application.pool, 'account_reactivated'), 1);

    for (let attempt = 0; attempt < 15; attempt += 1) {
        const login = await staffLogin(baseUrl);
        assert.equal(login.status, 200);
    }
    assert.equal(await sessionCount(application.pool, userId), 10);

    const deleted = await api(baseUrl, `/api/admin/users/${userId}`, {
        method: 'DELETE',
        headers: adminHeaders
    });
    const repeatedDelete = await api(baseUrl, `/api/admin/users/${userId}`, {
        method: 'DELETE',
        headers: adminHeaders
    });
    assert.equal(deleted.status, 200);
    assert.equal(repeatedDelete.status, 404);
    assert.equal(await auditCount(application.pool, 'account_deleted'), 1);
    assert.equal(await sessionCount(application.pool, userId), 0);
});

function setStatus(baseUrl, headers, userId, status) {
    return api(baseUrl, `/api/admin/users/${userId}/status`, {
        method: 'PUT', headers, body: { status }
    });
}

function staffLogin(baseUrl) {
    return api(baseUrl, '/api/login', {
        method: 'POST',
        body: { username: STAFF_EMAIL, password: STAFF_PASSWORD }
    });
}

async function auditCount(pool, eventType) {
    const result = await pool.query('SELECT COUNT(*) AS count FROM audit_events WHERE event_type = $1', [eventType]);
    return Number(result.rows[0].count);
}

async function sessionCount(pool, userId) {
    const result = await pool.query('SELECT COUNT(*) AS count FROM sessions WHERE user_id = $1', [userId]);
    return Number(result.rows[0].count);
}

async function api(baseUrl, pathname, options = {}) {
    const headers = { ...(options.headers || {}) };
    const fetchOptions = { method: options.method || 'GET', headers };
    if (Object.prototype.hasOwnProperty.call(options, 'body')) {
        headers['Content-Type'] = 'application/json';
        fetchOptions.body = JSON.stringify(options.body);
    }
    const response = await fetch(`${baseUrl}${pathname}`, fetchOptions);
    return { status: response.status, data: await response.json() };
}
