'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const { URL } = require('node:url');
const { createDatabasePool, parseInteger, runMigrations, withTransaction } = require('./database');
const { summarizeRecords, writeSessionHistoryWorkbook, writeStudentRecordsWorkbook } = require('./excel-export');
const {
    hashPassword,
    hashToken,
    randomToken,
    verifyPassword
} = require('./security');

const ROOT_DIR = path.join(__dirname, '..');
const STATIC_DIR = path.join(ROOT_DIR, '_internal');
const HOST = process.env.HOST || '0.0.0.0';
const PORT = parseInteger(process.env.PORT, 3000, 0, 65535, 'PORT');
const SESSION_TTL_HOURS = parseInteger(process.env.SESSION_TTL_HOURS, 24, 1, 24 * 365, 'SESSION_TTL_HOURS');
const EMAIL_VERIFICATION_TTL_HOURS = parseInteger(process.env.EMAIL_VERIFICATION_TTL_HOURS, 24, 1, 168, 'EMAIL_VERIFICATION_TTL_HOURS');
const TRUST_PROXY = process.env.TRUST_PROXY === '1';
const TRUSTED_CLIENT_IP_HEADER = String(process.env.TRUSTED_CLIENT_IP_HEADER || '').trim().toLowerCase();
const MAX_STANDARD_BODY_BYTES = 1024 * 1024;
const MAX_LARGE_BODY_BYTES = parseInteger(process.env.MAX_JSON_MB, 12, 1, 50, 'MAX_JSON_MB') * 1024 * 1024;
const PASSWORD_MIN_LENGTH = 4;
const PASSWORD_MAX_LENGTH = 200;
const MAX_EXCEL_EXPORT_ROWS = parseInteger(process.env.MAX_EXCEL_EXPORT_ROWS, 10000, 1, 50000, 'MAX_EXCEL_EXPORT_ROWS');
const MAX_CONCURRENT_EXCEL_EXPORTS = parseInteger(process.env.MAX_CONCURRENT_EXCEL_EXPORTS, 2, 1, 10, 'MAX_CONCURRENT_EXCEL_EXPORTS');
const ALLOWED_CLASSES = new Set(['Nursery', 'KG', ...Array.from({ length: 12 }, (_value, index) => String(index + 1))]);
let activeExcelExports = 0;

const STATIC_FILES = new Map([
    ['/', { file: 'index.html', type: 'text/html; charset=utf-8', cache: 'no-store' }],
    ['/index.html', { file: 'index.html', type: 'text/html; charset=utf-8', cache: 'no-store' }],
    ['/admin.html', { file: 'admin.html', type: 'text/html; charset=utf-8', cache: 'no-store' }],
    ['/script.js', { file: 'script.js', type: 'text/javascript; charset=utf-8', cache: 'public, max-age=300' }],
    ['/admin.js', { file: 'admin.js', type: 'text/javascript; charset=utf-8', cache: 'public, max-age=300' }],
    ['/style.css', { file: 'style.css', type: 'text/css; charset=utf-8', cache: 'public, max-age=300' }],
    ['/manifest.json', { file: 'manifest.json', type: 'application/manifest+json; charset=utf-8', cache: 'public, max-age=300' }],
    ['/service-worker.js', { file: 'service-worker.js', type: 'text/javascript; charset=utf-8', cache: 'no-cache' }],
    ['/school-icon.png', { file: 'school-icon.png', type: 'image/png', cache: 'public, max-age=86400' }]
]);

class HttpError extends Error {
    constructor(status, message, headers = {}) {
        super(message);
        this.status = status;
        this.headers = headers;
    }
}

async function startApplication() {
    const { pool, isMemoryDatabase } = createDatabasePool();
    await runMigrations(pool, isMemoryDatabase);
    await ensureBootstrapAdmin(pool, isMemoryDatabase);
    const dummyPasswordHash = await hashPassword('not-a-real-account-password');
    const context = { pool, isMemoryDatabase, dummyPasswordHash };

    const server = http.createServer(async (request, response) => {
        try {
            applySecurityHeaders(request, response);
            const requestUrl = new URL(request.url || '/', 'http://localhost');
            if (requestUrl.pathname.startsWith('/api/')) {
                await handleApiRequest(context, request, response, requestUrl.pathname);
                return;
            }
            serveStaticFile(request, response, requestUrl.pathname);
        } catch (error) {
            handleRequestError(response, error);
        }
    });

    server.headersTimeout = 15000;
    server.requestTimeout = 30000;
    server.keepAliveTimeout = 5000;
    server.maxRequestsPerSocket = 1000;
    server.on('clientError', (_error, socket) => {
        if (socket.writable) {
            socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
        }
    });

    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(PORT, HOST, () => {
            server.off('error', reject);
            resolve();
        });
    });

    const address = server.address();
    const listeningPort = typeof address === 'object' && address ? address.port : PORT;
    console.log(`Student Admission Billing System listening on http://${HOST}:${listeningPort}`);
    console.log('Database: PostgreSQL');

    let closing = false;
    async function close() {
        if (closing) return;
        closing = true;
        await new Promise((resolve) => server.close(resolve));
        await pool.end();
    }

    function installSignalHandlers() {
        const shutdown = (signal) => {
            console.log(`Received ${signal}; shutting down.`);
            const forceTimer = setTimeout(() => process.exit(1), 10000);
            forceTimer.unref();
            close().then(() => process.exit(0)).catch((error) => {
                console.error('Shutdown error:', error.message);
                process.exit(1);
            });
        };
        process.once('SIGINT', () => shutdown('SIGINT'));
        process.once('SIGTERM', () => shutdown('SIGTERM'));
    }

    return { close, installSignalHandlers, listeningPort, pool, server };
}

async function ensureBootstrapAdmin(pool, isMemoryDatabase) {
    await withTransaction(pool, async (client) => {
        if (!isMemoryDatabase) await client.query('SELECT pg_advisory_xact_lock($1)', [72420260823]);
        const username = normalizeEmail(process.env.ADMIN_EMAIL || '');
        const password = String(process.env.ADMIN_PASSWORD || '');
        const fullName = requireSingleLineText(process.env.ADMIN_NAME || 'School Administrator', 'Administrator name', 2, 120);
        if (!isValidEmail(username) || password.length < PASSWORD_MIN_LENGTH || password.length > PASSWORD_MAX_LENGTH) {
            throw new Error(`No administrator exists. Set ADMIN_EMAIL and an ADMIN_PASSWORD of at least ${PASSWORD_MIN_LENGTH} characters, then restart.`);
        }
        const passwordHash = await hashPassword(password);
        const existingUser = await client.query('SELECT id FROM users WHERE LOWER(username) = LOWER($1)', [username]);
        let adminId;
        if (existingUser.rowCount) {
            const updated = await client.query(`
                UPDATE users SET full_name = $1, password_hash = $2, role = 'admin', status = 'active',
                    status_changed_at = NOW(), approved_at = NOW(), email_verified_at = COALESCE(email_verified_at, NOW())
                WHERE id = $3 RETURNING id
            `, [fullName, passwordHash, existingUser.rows[0].id]);
            adminId = updated.rows[0].id;
        } else {
            const inserted = await client.query(`
                INSERT INTO users (review_id, full_name, username, password_hash, role, status, status_changed_at, approved_at, email_verified_at)
                VALUES ($1, $2, $3, $4, 'admin', 'active', NOW(), NOW(), NOW()) RETURNING id
            `, [crypto.randomUUID(), fullName, username, passwordHash]);
            adminId = inserted.rows[0].id;
        }
        await insertAuditEvent(client, { actorUserId: adminId, targetUserId: adminId, eventType: 'bootstrap_admin_configured', newStatus: 'active' });
        console.log(`Configured bootstrap administrator: ${username}`);
    });
}

async function handleApiRequest(context, request, response, pathname) {
    const { pool, dummyPasswordHash } = context;
    const method = String(request.method || 'GET').toUpperCase();

    if (method === 'GET' && pathname === '/api/health') {
        try {
            await pool.query('SELECT 1 AS ready');
            sendJson(response, 200, { status: 'ok', database: 'ready' });
        } catch (_error) {
            sendJson(response, 503, { status: 'unavailable', database: 'unavailable' });
        }
        return;
    }

    if (method === 'POST' && pathname === '/api/register') {
        const clientAddress = getClientAddress(request);
        await consumeRateLimit(pool, 'registration_ip', clientAddress, 8, 60 * 60 * 1000);
        const body = await readJsonBody(request, MAX_STANDARD_BODY_BYTES);
        const fullName = requireSingleLineText(body.fullName, 'Full name', 2, 120);
        const username = normalizeUserId(body.username);
        const password = validatePassword(body.password);
        if (!isValidUserId(username)) {
            throw new HttpError(400, 'User ID must be 3–80 characters and may contain lowercase letters, numbers, dots, hyphens, or underscores.');
        }
        const passwordHash = await hashPassword(password);
        try {
            const user = await withTransaction(pool, async (client) => {
                const inserted = await client.query(`
                    INSERT INTO users (review_id, full_name, username, password_hash, role, status, created_at, status_changed_at, approved_at, email_verified_at)
                    VALUES ($1, $2, $3, $4, 'staff', 'active', NOW(), NOW(), NOW(), NOW()) RETURNING *
                `, [crypto.randomUUID(), fullName, username, passwordHash]);
                const createdUser = inserted.rows[0];
                await insertAuditEvent(client, { targetUserId: createdUser.id, eventType: 'staff_self_registered', newStatus: 'active', request });
                return createdUser;
            });
            sendJson(response, 201, {
                registered: true,
                user: toPublicUser(user),
                message: 'Registration successful. You can now log in with your user ID and password.'
            });
        } catch (error) {
            if (isUniqueViolation(error)) throw new HttpError(409, 'This user ID is already registered. Choose a different user ID.');
            throw error;
        }
        return;
    }

    if (method === 'POST' && ['/api/resend-verification', '/api/verify-email'].includes(pathname)) {
        throw new HttpError(404, 'Email verification is not used for this application. Register with a user ID and password instead.');
    }

    if (method === 'POST' && pathname === '/api/resend-verification') {
        const clientAddress = getClientAddress(request);
        await consumeRateLimit(pool, 'verification_resend_ip', clientAddress, 5, 60 * 60 * 1000);
        const body = await readJsonBody(request, MAX_STANDARD_BODY_BYTES);
        const username = normalizeEmail(body.username);
        await consumeRateLimit(pool, 'verification_resend_account', username || 'missing-username', 3, 60 * 60 * 1000);
        const suppliedPassword = String(body.password || '');
        const password = suppliedPassword.length <= PASSWORD_MAX_LENGTH ? suppliedPassword : '';
        const userResult = await pool.query('SELECT * FROM users WHERE LOWER(username) = LOWER($1)', [username]);
        const user = userResult.rows[0];
        const passwordMatches = await verifyPassword(password, user ? user.password_hash : dummyPasswordHash);
        let queued = false;

        if (user && passwordMatches && user.role === 'staff' && user.status === 'pending' && !user.email_verified_at) {
            queued = await withTransaction(pool, async (client) => {
                const current = await lockUserForUpdate(client, user.id);
                if (!current || current.status !== 'pending' || current.email_verified_at) return false;
                await queueEmailVerificationNotification(
                    client,
                    current,
                    `email-verification:${current.id}:${crypto.randomUUID()}`
                );
                await insertAuditEvent(client, {
                    targetUserId: current.id,
                    eventType: 'email_verification_resent',
                    oldStatus: 'pending',
                    newStatus: 'pending',
                    request
                });
                return true;
            });
        }
        if (queued) outboxWorker.wake();
        sendJson(response, 202, {
            message: 'If an unverified registration matches those credentials, a new confirmation email has been queued.'
        });
        return;
    }

    if (method === 'POST' && pathname === '/api/verify-email') {
        await consumeRateLimit(pool, 'email_verification_ip', getClientAddress(request), 20, 60 * 60 * 1000);
        const body = await readJsonBody(request, MAX_STANDARD_BODY_BYTES);
        const parsedToken = readEmailVerificationToken(body.token, context.mailService.emailVerificationSecret);
        if (!parsedToken) throw new HttpError(400, 'This email confirmation link is invalid.');
        if (parsedToken.expiresAt.getTime() <= Date.now()) throw new HttpError(410, 'This email confirmation link has expired. Please contact the administrator.');
        const signedLifetime = parsedToken.expiresAt.getTime() - parsedToken.issuedAt.getTime();
        if (parsedToken.issuedAt.getTime() > Date.now() + (5 * 60 * 1000) || signedLifetime <= 0 || signedLifetime > (168 * 60 * 60 * 1000) + (5 * 60 * 1000)) {
            throw new HttpError(400, 'This email confirmation link is invalid.');
        }

        const result = await withTransaction(pool, async (client) => {
            const updated = await client.query(`
                UPDATE users SET email_verified_at = NOW(), status_changed_at = NOW()
                WHERE review_id = $1 AND role = 'staff' AND status = 'pending' AND email_verified_at IS NULL
                RETURNING *
            `, [parsedToken.reviewId]);
            if (!updated.rowCount) {
                const existing = await client.query('SELECT * FROM users WHERE review_id = $1', [parsedToken.reviewId]);
                if (!existing.rowCount) throw new HttpError(400, 'This email confirmation link is invalid.');
                if (existing.rows[0].email_verified_at && existing.rows[0].status === 'pending') {
                    return { user: existing.rows[0], newlyVerified: false };
                }
                if (existing.rows[0].email_verified_at) {
                    throw new HttpError(409, `This account request was already processed and is now ${existing.rows[0].status}.`);
                }
                throw new HttpError(409, 'This account request can no longer be confirmed.');
            }

            const user = updated.rows[0];
            const recipients = await getAdminNotificationRecipients(client);
            for (const recipient of recipients) {
                await queueNotification(client, {
                    eventType: 'registration_pending',
                    recipient,
                    payload: {
                        notificationKind: 'admin_review',
                        reviewId: user.review_id,
                        fullName: user.full_name,
                        username: user.username
                    },
                    dedupeKey: `registration:verified:${user.id}:${hashToken(recipient)}`
                });
            }
            await insertAuditEvent(client, { targetUserId: user.id, eventType: 'registration_email_verified', oldStatus: 'pending', newStatus: 'pending', request });
            return { user, newlyVerified: true };
        });
        if (result.newlyVerified) outboxWorker.wake();
        sendJson(response, 200, {
            verified: true,
            status: 'pending_admin',
            message: result.newlyVerified
                ? 'Email confirmed. The administrator notification is queued, and your account must be approved before login.'
                : 'This email address was already confirmed. Your account is waiting for administrator approval.'
        });
        return;
    }

    if (method === 'POST' && (pathname === '/api/login' || pathname === '/api/admin/login')) {
        const adminLogin = pathname === '/api/admin/login';
        const clientAddress = getClientAddress(request);
        await consumeRateLimit(pool, 'login_ip', clientAddress, 100, 15 * 60 * 1000);
        const body = await readJsonBody(request, MAX_STANDARD_BODY_BYTES);
        const username = normalizeEmail(body.username);
        const accountRateKey = username || 'missing-username';
        await consumeRateLimit(pool, 'login_account', accountRateKey, 10, 15 * 60 * 1000);
        const suppliedPassword = String(body.password || '');
        const password = suppliedPassword.length <= PASSWORD_MAX_LENGTH ? suppliedPassword : '';
        const userResult = await pool.query('SELECT * FROM users WHERE LOWER(username) = LOWER($1)', [username]);
        const user = userResult.rows[0];
        const passwordMatches = await verifyPassword(password, user ? user.password_hash : dummyPasswordHash);
        if (!user || !passwordMatches) throw new HttpError(401, 'Invalid user ID or password.');
        if (adminLogin && user.role !== 'admin') throw new HttpError(403, 'Only an administrator can log in here.');
        if (user.status !== 'active') {
            const messages = {
                pending: user.email_verified_at
                    ? 'Your account is pending administrator approval.'
                    : 'Confirm your email address before the administrator can review your account.',
                disabled: 'This account is disabled. Contact an administrator.',
                rejected: 'This account request was not approved. Contact an administrator.'
            };
            throw new HttpError(403, messages[user.status] || 'This account cannot sign in.');
        }
        await clearRateLimit(pool, 'login_account', accountRateKey);
        const token = await createSession(pool, user.id);
        sendJson(response, 200, { token, user: toPublicUser(user), settings: await getSettings(pool) });
        return;
    }

    if (method === 'POST' && pathname === '/api/logout') {
        const token = getBearerToken(request);
        if (token) await pool.query('DELETE FROM sessions WHERE token_hash = $1', [hashToken(token)]);
        sendJson(response, 200, { message: 'Logged out.' });
        return;
    }

    if (method === 'GET' && pathname === '/api/session') {
        const user = await requireAuthenticatedUser(pool, request);
        sendJson(response, 200, { user: toPublicUser(user), settings: await getSettings(pool) });
        return;
    }

    if (method === 'PUT' && pathname === '/api/account/password') {
        const user = await requireAuthenticatedUser(pool, request);
        const body = await readJsonBody(request, MAX_STANDARD_BODY_BYTES);
        const currentPassword = String(body.currentPassword || '');
        const newPassword = validatePassword(body.newPassword);
        const passwordMatches = await verifyPassword(currentPassword, user.password_hash);
        if (!passwordMatches) throw new HttpError(400, 'Your current password is incorrect.');
        const passwordHash = await hashPassword(newPassword);
        const token = await withTransaction(pool, async (client) => {
            const current = await lockUserForUpdate(client, user.id);
            if (!current || current.status !== 'active') throw new HttpError(401, 'This account is no longer active.');
            await client.query('UPDATE users SET password_hash = $1 WHERE id = $2', [passwordHash, current.id]);
            await client.query('DELETE FROM sessions WHERE user_id = $1', [current.id]);
            await insertAuditEvent(client, { actorUserId: current.id, targetUserId: current.id, eventType: 'account_password_changed', request });
            return randomToken();
        });
        await pool.query('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES ($1, $2, NOW(), $3)', [
            hashToken(token), user.id, new Date(Date.now() + SESSION_TTL_HOURS * 60 * 60 * 1000)
        ]);
        sendJson(response, 200, { message: 'Password changed successfully.', token });
        return;
    }

    if (pathname === '/api/records' && method === 'GET') {
        const user = await requireAuthenticatedUser(pool, request);
        sendJson(response, 200, { records: await getAllRecords(pool, { includeCreator: user.role === 'admin' }) });
        return;
    }

    if (pathname === '/api/records' && method === 'POST') {
        const user = await requireAuthenticatedUser(pool, request);
        const body = await readJsonBody(request, MAX_STANDARD_BODY_BYTES);
        const record = await insertRecord(pool, validateRecordInput(body), user.id);
        sendJson(response, 201, { record });
        return;
    }

    if (pathname === '/api/records' && method === 'DELETE') {
        const admin = await requireAdmin(pool, request);
        await withTransaction(pool, async (client) => {
            await client.query('DELETE FROM student_records');
            await insertAuditEvent(client, { actorUserId: admin.id, eventType: 'all_records_deleted', request });
        });
        sendJson(response, 200, { message: 'All student records were deleted.' });
        return;
    }

    const recordMatch = pathname.match(/^\/api\/records\/(\d+)$/);
    if (recordMatch && method === 'DELETE') {
        const admin = await requireAdmin(pool, request);
        const recordId = parseSafeId(recordMatch[1]);
        const deleted = await withTransaction(pool, async (client) => {
            const result = await client.query('DELETE FROM student_records WHERE id = $1 RETURNING id', [recordId]);
            if (result.rowCount) await insertAuditEvent(client, { actorUserId: admin.id, eventType: 'student_record_deleted', request, details: { recordId: String(recordId) } });
            return result.rowCount;
        });
        if (!deleted) throw new HttpError(404, 'Student record not found.');
        sendJson(response, 200, { message: 'Student record deleted.' });
        return;
    }

    if (pathname === '/api/admin/users' && method === 'POST') {
        const admin = await requireAdmin(pool, request);
        const body = await readJsonBody(request, MAX_STANDARD_BODY_BYTES);
        const fullName = requireSingleLineText(body.fullName, 'Staff name', 2, 120);
        const username = normalizeUserId(body.username);
        const password = validatePassword(body.password);
        if (!isValidUserId(username)) throw new HttpError(400, 'User ID must use 3-80 letters, numbers, dots, hyphens, or underscores.');
        const passwordHash = await hashPassword(password);
        try {
            const user = await withTransaction(pool, async (client) => {
                const inserted = await client.query(`
                    INSERT INTO users (review_id, full_name, username, password_hash, role, status, status_changed_at, approved_at, approved_by, email_verified_at)
                    VALUES ($1, $2, $3, $4, 'staff', 'active', NOW(), NOW(), $5, NOW())
                    RETURNING *
                `, [crypto.randomUUID(), fullName, username, passwordHash, admin.id]);
                await insertAuditEvent(client, {
                    actorUserId: admin.id,
                    targetUserId: inserted.rows[0].id,
                    eventType: 'staff_account_created',
                    newStatus: 'active',
                    request,
                    details: { username }
                });
                return inserted.rows[0];
            });
            sendJson(response, 201, { message: 'Staff account created. Give the user ID and temporary password to the staff member securely.', user: toPublicUser(user) });
        } catch (error) {
            if (isUniqueViolation(error)) throw new HttpError(409, 'That user ID is already in use.');
            throw error;
        }
        return;
    }

    if (pathname === '/api/admin/users' && method === 'GET') {
        await requireAdmin(pool, request);
        const result = await pool.query('SELECT * FROM users ORDER BY created_at DESC, id DESC');
        sendJson(response, 200, { users: result.rows.map(toPublicUser) });
        return;
    }

    const approveMatch = pathname.match(/^\/api\/admin\/users\/(\d+)\/approve$/);
    if (approveMatch && method === 'POST') {
        const admin = await requireAdmin(pool, request);
        const target = await decidePendingUser(pool, request, admin, parseSafeId(approveMatch[1]), 'active');
        sendJson(response, 200, { message: 'User account approved.', user: toPublicUser(target) });
        return;
    }

    const rejectMatch = pathname.match(/^\/api\/admin\/users\/(\d+)\/reject$/);
    if (rejectMatch && method === 'POST') {
        const admin = await requireAdmin(pool, request);
        const target = await decidePendingUser(pool, request, admin, parseSafeId(rejectMatch[1]), 'rejected');
        sendJson(response, 200, { message: 'User account request rejected.', user: toPublicUser(target) });
        return;
    }

    const userStatusMatch = pathname.match(/^\/api\/admin\/users\/(\d+)\/status$/);
    if (userStatusMatch && method === 'PUT') {
        const admin = await requireAdmin(pool, request);
        const userId = parseSafeId(userStatusMatch[1]);
        const body = await readJsonBody(request, MAX_STANDARD_BODY_BYTES);
        const desiredStatus = body.status || (typeof body.isActive === 'boolean' ? (body.isActive ? 'active' : 'disabled') : '');
        if (!['active', 'disabled'].includes(desiredStatus)) throw new HttpError(400, 'Status must be active or disabled.');
        if (String(userId) === String(admin.id)) throw new HttpError(400, 'You cannot change your own administrator account.');
        const user = await withTransaction(pool, async (client) => {
            const target = await lockUserForUpdate(client, userId);
            if (!target) throw new HttpError(404, 'User account not found.');
            if (target.role === 'admin' || target.status === 'pending' || target.status === 'rejected') throw new HttpError(409, 'This account cannot use that status transition.');
            if (target.status === desiredStatus) return target;
            const updated = await client.query(`
                UPDATE users
                SET status = $1, status_changed_at = NOW()
                WHERE id = $2 AND status = $3
                RETURNING *
            `, [desiredStatus, userId, target.status]);
            if (!updated.rowCount) throw new HttpError(409, 'The account changed while this request was being processed. Reload and try again.');
            if (desiredStatus === 'disabled') await client.query('DELETE FROM sessions WHERE user_id = $1', [userId]);
            await insertAuditEvent(client, {
                actorUserId: admin.id, targetUserId: userId,
                eventType: desiredStatus === 'active' ? 'account_reactivated' : 'account_disabled',
                oldStatus: target.status, newStatus: desiredStatus, request
            });
            return updated.rows[0];
        });
        sendJson(response, 200, { user: toPublicUser(user) });
        return;
    }

    const userMatch = pathname.match(/^\/api\/admin\/users\/(\d+)$/);
    if (userMatch && method === 'DELETE') {
        const admin = await requireAdmin(pool, request);
        const userId = parseSafeId(userMatch[1]);
        if (String(userId) === String(admin.id)) throw new HttpError(400, 'You cannot delete your own administrator account.');
        const deleted = await withTransaction(pool, async (client) => {
            const target = await lockUserForUpdate(client, userId);
            if (!target) return 0;
            if (target.role === 'admin') throw new HttpError(403, 'Administrator accounts cannot be deleted here.');
            await insertAuditEvent(client, { actorUserId: admin.id, targetUserId: target.id, eventType: 'account_deleted', oldStatus: target.status, request, details: { username: target.username } });
            const result = await client.query("DELETE FROM users WHERE id = $1 AND role = 'staff' RETURNING id", [userId]);
            if (!result.rowCount) throw new HttpError(409, 'The account changed while this request was being processed. Reload and try again.');
            return 1;
        });
        if (!deleted) throw new HttpError(404, 'User account not found.');
        sendJson(response, 200, { message: 'User account deleted.' });
        return;
    }

    if (pathname === '/api/admin/notifications' && method === 'GET') {
        await requireAdmin(pool, request);
        const result = await pool.query('SELECT status, COUNT(*) AS count FROM notification_outbox GROUP BY status');
        sendJson(response, 200, { counts: Object.fromEntries(result.rows.map((row) => [row.status, Number(row.count)])) });
        return;
    }

    if (pathname === '/api/export-history.xlsx' && method === 'GET') {
        const admin = await requireAdmin(pool, request);
        const requestUrl = new URL(request.url || '/', 'http://localhost');
        const sessionYear = requireSingleLineText(requestUrl.searchParams.get('sessionYear'), 'Session year', 4, 30);
        await consumeRateLimit(pool, 'history_excel_export_user', String(admin.id), 5, 15 * 60 * 1000);
        if (activeExcelExports >= MAX_CONCURRENT_EXCEL_EXPORTS) {
            throw new HttpError(429, 'Too many Excel exports are already running. Please try again shortly.');
        }
        activeExcelExports += 1;
        try {
            const result = await pool.query(`
                SELECT * FROM student_records
                WHERE session_year = $1
                ORDER BY class_name ASC, student_name ASC, date_added ASC, id ASC
                LIMIT $2
            `, [sessionYear, MAX_EXCEL_EXPORT_ROWS + 1]);
            if (result.rowCount > MAX_EXCEL_EXPORT_ROWS) {
                throw new HttpError(413, `Excel export is limited to ${MAX_EXCEL_EXPORT_ROWS.toLocaleString('en-US')} records.`);
            }
            const records = result.rows.map(toPublicRecord);
            const summary = summarizeRecords(records);
            if (request.aborted || response.destroyed) return;
            await withTransaction(pool, async (client) => {
                await insertAuditEvent(client, {
                    actorUserId: admin.id,
                    eventType: 'student_history_excel_exported',
                    request,
                    details: {
                        sessionYear,
                        recordCount: summary.totalStudents,
                        totalCollected: summary.totalCollected
                    }
                });
            });
            const fileDate = new Date().toISOString().slice(0, 10);
            response.writeHead(200, {
                'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
                'Content-Disposition': `attachment; filename="student-history-${fileDate}.xlsx"`,
                'Cache-Control': 'private, no-store',
                Pragma: 'no-cache'
            });
            await writeSessionHistoryWorkbook(records, response, sessionYear);
        } finally {
            activeExcelExports -= 1;
        }
        return;
    }

    if (pathname === '/api/export.xlsx' && method === 'GET') {
        const admin = await requireAdmin(pool, request);
        await consumeRateLimit(pool, 'excel_export_user', String(admin.id), 5, 15 * 60 * 1000);
        if (activeExcelExports >= MAX_CONCURRENT_EXCEL_EXPORTS) {
            throw new HttpError(429, 'Too many Excel exports are already running. Please try again shortly.');
        }
        activeExcelExports += 1;
        try {
            const result = await pool.query(`
                SELECT * FROM student_records
                ORDER BY date_added DESC, id DESC
                LIMIT $1
            `, [MAX_EXCEL_EXPORT_ROWS + 1]);
            if (result.rowCount > MAX_EXCEL_EXPORT_ROWS) {
                throw new HttpError(413, `Excel export is limited to ${MAX_EXCEL_EXPORT_ROWS.toLocaleString('en-US')} records.`);
            }
            const records = result.rows.map(toPublicRecord);
            if (request.aborted || response.destroyed) return;
            await withTransaction(pool, async (client) => {
                await insertAuditEvent(client, {
                    actorUserId: admin.id,
                    eventType: 'student_records_excel_exported',
                    request,
                    details: { recordCount: records.length }
                });
            });
            const fileDate = new Date().toISOString().slice(0, 10);
            response.writeHead(200, {
                'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
                'Content-Disposition': `attachment; filename="student-records-${fileDate}.xlsx"`,
                'Cache-Control': 'private, no-store',
                Pragma: 'no-cache'
            });
            await writeStudentRecordsWorkbook(records, response);
        } finally {
            activeExcelExports -= 1;
        }
        return;
    }

    if (pathname === '/api/export' && method === 'GET') {
        await requireAdmin(pool, request);
        const records = await getAllRecords(pool);
        sendJson(response, 200, { version: 2, exportedAt: new Date().toISOString(), totalRecords: records.length, records });
        return;
    }

    if (pathname === '/api/import' && method === 'POST') {
        const admin = await requireAdmin(pool, request);
        const body = await readJsonBody(request, MAX_LARGE_BODY_BYTES);
        const records = Array.isArray(body) ? body : body.records;
        if (!Array.isArray(records)) throw new HttpError(400, 'The backup must contain a records array.');
        if (records.length > 10000) throw new HttpError(400, 'A single import can contain at most 10,000 records.');
        const validated = records.map((record, index) => {
            try {
                return validateRecordInput(record, { allowDateAdded: true, allowRollNumber: true, legacyImport: true });
            } catch (error) {
                throw new HttpError(400, `Record ${index + 1}: ${error.message}`);
            }
        });
        await withTransaction(pool, async (client) => {
            await client.query('DELETE FROM student_records');
            for (const record of validated) await insertRecord(client, record, admin.id);
            await insertAuditEvent(client, { actorUserId: admin.id, eventType: 'records_backup_restored', request, details: { imported: validated.length } });
        });
        sendJson(response, 200, { message: `${validated.length} record(s) restored from backup.`, imported: validated.length });
        return;
    }

    if (pathname === '/api/settings/background' && method === 'PUT') {
        await requireAdmin(pool, request);
        const body = await readJsonBody(request, MAX_LARGE_BODY_BYTES);
        const backgroundImage = validateBackgroundImage(body.backgroundImage);
        await pool.query(`INSERT INTO settings (key, value) VALUES ('backgroundImage', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [backgroundImage]);
        sendJson(response, 200, { backgroundImage });
        return;
    }

    throw new HttpError(404, 'API endpoint not found.');
}

async function decidePendingUser(pool, request, admin, userId, decisionStatus) {
    return withTransaction(pool, async (client) => {
        const updated = await client.query(`
            UPDATE users SET status = $1, status_changed_at = NOW(),
                approved_at = CASE WHEN $1 = 'active' THEN NOW() ELSE approved_at END,
                approved_by = $2
            WHERE id = $3 AND role = 'staff' AND status = 'pending' AND email_verified_at IS NOT NULL RETURNING *
        `, [decisionStatus, admin.id, userId]);
        if (!updated.rowCount) {
            const existing = await client.query('SELECT * FROM users WHERE id = $1', [userId]);
            if (!existing.rowCount) throw new HttpError(404, 'User account not found.');
            if (existing.rows[0].status === 'pending' && !existing.rows[0].email_verified_at) {
                throw new HttpError(409, 'The user must confirm their email address before this request can be approved or rejected.');
            }
            throw new HttpError(409, `This request was already processed and is now ${existing.rows[0].status}.`);
        }
        const user = updated.rows[0];
        await client.query('DELETE FROM sessions WHERE user_id = $1', [userId]);
        await insertAuditEvent(client, {
            actorUserId: admin.id, targetUserId: userId,
            eventType: decisionStatus === 'active' ? 'account_approved' : 'account_rejected',
            oldStatus: 'pending', newStatus: decisionStatus, request
        });
        await queueNotification(client, {
            eventType: decisionStatus === 'active' ? 'account_approved' : 'account_rejected',
            recipient: user.username,
            payload: { fullName: user.full_name, username: user.username },
            dedupeKey: `decision:${decisionStatus}:${user.id}`
        });
        return user;
    });
}

async function requireAuthenticatedUser(pool, request) {
    const token = getBearerToken(request);
    if (!token) throw new HttpError(401, 'Authentication required.');
    const result = await pool.query(`
        SELECT users.* FROM sessions JOIN users ON users.id = sessions.user_id
        WHERE sessions.token_hash = $1 AND sessions.expires_at > NOW() AND users.status = 'active'
    `, [hashToken(token)]);
    if (!result.rowCount) throw new HttpError(401, 'Your session has expired. Please log in again.');
    return result.rows[0];
}

async function requireAdmin(pool, request) {
    const user = await requireAuthenticatedUser(pool, request);
    if (user.role !== 'admin') throw new HttpError(403, 'Administrator access is required.');
    return user;
}

async function lockUserForUpdate(client, userId) {
    const result = await client.query('SELECT * FROM users WHERE id = $1 FOR UPDATE', [userId]);
    return result.rows[0] || null;
}

function getBearerToken(request) {
    const match = String(request.headers.authorization || '').match(/^Bearer\s+([A-Za-z0-9_-]{40,100})$/);
    return match ? match[1] : '';
}

async function createSession(pool, userId) {
    const token = randomToken();
    const expiresAt = new Date(Date.now() + SESSION_TTL_HOURS * 60 * 60 * 1000);
    await withTransaction(pool, async (client) => {
        const user = await lockUserForUpdate(client, userId);
        if (!user || user.status !== 'active') throw new HttpError(401, 'This account cannot start a new session.');
        await client.query('DELETE FROM sessions WHERE expires_at <= NOW()');
        await client.query(`
            DELETE FROM sessions
            WHERE token_hash IN (
                SELECT token_hash
                FROM sessions
                WHERE user_id = $1
                ORDER BY created_at DESC, token_hash DESC
                OFFSET 9
            )
        `, [userId]);
        await client.query('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES ($1, $2, NOW(), $3)', [hashToken(token), userId, expiresAt]);
    });
    return token;
}

async function consumeRateLimit(pool, action, key, maximumAttempts, windowMilliseconds) {
    const keyHash = hashToken(`${action}:${key}`);
    const cutoff = new Date(Date.now() - windowMilliseconds);
    const result = await pool.query(`
        INSERT INTO rate_limits (key_hash, action, attempt_count, window_started_at, updated_at)
        VALUES ($1, $2, 1, NOW(), NOW())
        ON CONFLICT (key_hash) DO UPDATE SET
            attempt_count = CASE WHEN rate_limits.window_started_at <= $3 THEN 1 ELSE rate_limits.attempt_count + 1 END,
            window_started_at = CASE WHEN rate_limits.window_started_at <= $3 THEN NOW() ELSE rate_limits.window_started_at END,
            updated_at = NOW()
        RETURNING attempt_count, window_started_at
    `, [keyHash, action, cutoff]);
    const entry = result.rows[0];
    if (Number(entry.attempt_count) > maximumAttempts) {
        const resetAt = new Date(entry.window_started_at).getTime() + windowMilliseconds;
        throw new HttpError(429, 'Too many attempts. Please try again later.', { 'Retry-After': String(Math.max(1, Math.ceil((resetAt - Date.now()) / 1000))) });
    }
}

async function clearRateLimit(pool, action, key) {
    await pool.query('DELETE FROM rate_limits WHERE key_hash = $1', [hashToken(`${action}:${key}`)]);
}

async function getAdminNotificationRecipients(client) {
    const result = await client.query("SELECT username FROM users WHERE role = 'admin' AND status = 'active'");
    const configured = String(process.env.ADMIN_NOTIFICATION_EMAILS || '').split(',').map(normalizeEmail).filter(Boolean);
    const recipients = new Set([...result.rows.map((row) => normalizeEmail(row.username)), ...configured]);
    const valid = [...recipients].filter(isValidEmail);
    if (!valid.length) throw new Error('No active administrator notification email is configured.');
    return valid;
}

async function queueNotification(client, { eventType, recipient, payload, dedupeKey }) {
    await client.query(`
        INSERT INTO notification_outbox (event_type, recipient, payload, dedupe_key)
        VALUES ($1, $2, $3::JSONB, $4) ON CONFLICT (dedupe_key) DO NOTHING
    `, [eventType, normalizeEmail(recipient), JSON.stringify(payload), dedupeKey]);
}

async function queueEmailVerificationNotification(client, user, dedupeKey) {
    await queueNotification(client, {
        eventType: 'registration_pending',
        recipient: user.username,
        payload: {
            notificationKind: 'email_verification',
            reviewId: user.review_id,
            fullName: user.full_name,
            username: user.username
        },
        dedupeKey
    });
}

async function queueUnverifiedRegistrationEmails(pool) {
    await withTransaction(pool, async (client) => {
        const result = await client.query(`
            SELECT * FROM users
            WHERE role = 'staff' AND status = 'pending' AND email_verified_at IS NULL
            ORDER BY id
            FOR UPDATE
        `);
        for (const user of result.rows) {
            await client.query(`
                DELETE FROM notification_outbox
                WHERE event_type = 'registration_pending'
                  AND status IN ('pending', 'retry', 'sending', 'failed')
                  AND COALESCE(payload ->> 'notificationKind', '') <> 'email_verification'
                  AND payload ->> 'reviewId' = $1
            `, [String(user.review_id)]);
            await queueEmailVerificationNotification(client, user, `email-verification:${user.id}`);
        }
    });
}

async function insertAuditEvent(client, event) {
    await client.query(`
        INSERT INTO audit_events (actor_user_id, target_user_id, event_type, old_status, new_status, ip_address, user_agent, details)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8::JSONB)
    `, [
        event.actorUserId || null, event.targetUserId || null, event.eventType,
        event.oldStatus || null, event.newStatus || null,
        event.request ? getClientAddress(event.request) : '',
        event.request ? String(event.request.headers['user-agent'] || '').slice(0, 500) : '',
        JSON.stringify(event.details || {})
    ]);
}

function toPublicUser(user) {
    return {
        id: Number(user.id), reviewId: user.review_id, fullName: user.full_name,
        username: user.username, role: user.role, status: user.status,
        isActive: user.status === 'active', isApproved: Boolean(user.approved_at),
        emailVerified: Boolean(user.email_verified_at),
        createdAt: toIsoString(user.created_at), approvedAt: toIsoString(user.approved_at)
    };
}

async function getSettings(client) {
    const result = await client.query('SELECT key, value FROM settings');
    return result.rows.reduce((settings, row) => { settings[row.key] = row.value; return settings; }, { backgroundImage: '' });
}

async function getAllRecords(client, { includeCreator = false } = {}) {
    const statement = includeCreator
        ? `
            SELECT student_records.*, users.full_name AS created_by_name
            FROM student_records
            LEFT JOIN users ON users.id = student_records.created_by
            ORDER BY student_records.date_added DESC, student_records.id DESC
        `
        : 'SELECT * FROM student_records ORDER BY date_added DESC, id DESC';
    const result = await client.query(statement);
    return result.rows.map(toPublicRecord);
}

async function insertRecord(client, input, createdBy) {
    const result = await client.query(`
        INSERT INTO student_records (
            school_name, student_name, roll_number, class_name, parent_name, contact_number,
            email_address, date_of_birth, address, tuition_fee, transport_fee, sports_fee,
            other_fee, payment_mode, amount_paid, session_year, admission_date, date_added, created_by
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) RETURNING *
    `, [
        input.schoolName, input.studentName, input.rollNumber || '', input.className, input.parentName,
        input.contactNumber, input.emailAddress, input.dateOfBirth || null, input.address, input.tuitionFee,
        input.transportFee, input.sportsFee, input.otherFee, input.paymentMode, input.amountPaid,
        input.sessionYear, input.admissionDate, input.dateAdded || new Date(), createdBy
    ]);
    let row = result.rows[0];
    if (!input.rollNumber) {
        const updated = await client.query('UPDATE student_records SET roll_number = $1 WHERE id = $2 RETURNING *', [`ADM-${String(row.id).padStart(6, '0')}`, row.id]);
        row = updated.rows[0];
    }
    return toPublicRecord(row);
}

function toPublicRecord(row) {
    return {
        id: Number(row.id), schoolName: row.school_name, studentName: row.student_name,
        rollNumber: row.roll_number, className: row.class_name, parentName: row.parent_name,
        contactNumber: row.contact_number, emailAddress: row.email_address || '',
        dateOfBirth: toDateOnly(row.date_of_birth), address: row.address,
        tuitionFee: Number(row.tuition_fee), transportFee: Number(row.transport_fee),
        sportsFee: Number(row.sports_fee), otherFee: Number(row.other_fee),
        paymentMode: row.payment_mode, amountPaid: Number(row.amount_paid), sessionYear: row.session_year,
        admissionDate: toDateOnly(row.admission_date), dateAdded: toIsoString(row.date_added),
        createdBy: row.created_by == null ? null : Number(row.created_by),
        createdByName: row.created_by_name || ''
    };
}

function validateRecordInput(body, options = {}) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'Record data must be a JSON object.');
    const className = requireText(body.className, 'Class', 1, 50);
    if (!ALLOWED_CLASSES.has(className)) throw new HttpError(400, 'Class must be one of the available school classes.');
    const input = {
        schoolName: requireText(body.schoolName, 'School name', 2, 300),
        studentName: requireText(body.studentName, 'Student name', 2, 160),
        rollNumber: options.allowRollNumber ? cleanText(body.rollNumber || '', 80) : '',
        className,
        parentName: requireText(body.parentName, 'Parent or guardian name', 2, 160),
        contactNumber: requireText(body.contactNumber, 'Contact number', 5, 30),
        emailAddress: validateOptionalEmail(body.emailAddress),
        dateOfBirth: validateIsoDate(body.dateOfBirth, 'Date of birth', false),
        address: cleanText(body.address || '', 1500),
        tuitionFee: validateMoney(options.legacyImport ? (body.tuitionFee ?? body.TotalFee ?? 0) : body.tuitionFee, 'Tuition fee'),
        transportFee: validateMoney(body.transportFee, 'Transport fee'),
        sportsFee: validateMoney(body.sportsFee, 'Sports fee'), otherFee: validateMoney(body.otherFee, 'Other fee'),
        paymentMode: String(body.paymentMode || 'cash').toLowerCase(), amountPaid: validateMoney(body.amountPaid, 'Amount paid'),
        sessionYear: requireText(body.sessionYear, 'Session year', 4, 30),
        admissionDate: validateIsoDate(body.admissionDate, 'Admission date', true),
        dateAdded: options.allowDateAdded ? validateIsoDateTime(body.dateAdded) : ''
    };
    if (!['cash', 'online'].includes(input.paymentMode)) throw new HttpError(400, 'Payment mode must be cash or online.');
    const total = input.tuitionFee + input.transportFee + input.sportsFee + input.otherFee;
    if (input.amountPaid > total) throw new HttpError(400, 'Amount paid cannot be greater than the total fees.');
    return input;
}

function serveStaticFile(request, response, pathname) {
    const method = String(request.method || 'GET').toUpperCase();
    if (method !== 'GET' && method !== 'HEAD') throw new HttpError(405, 'Method not allowed.', { Allow: 'GET, HEAD' });
    const asset = STATIC_FILES.get(pathname);
    if (!asset) throw new HttpError(404, 'Page not found.');
    const filePath = path.join(STATIC_DIR, asset.file);
    const stat = fs.statSync(filePath);
    response.writeHead(200, { 'Content-Type': asset.type, 'Content-Length': stat.size, 'Cache-Control': asset.cache });
    if (method === 'HEAD') return response.end();
    const stream = fs.createReadStream(filePath);
    stream.on('error', () => response.destroy());
    stream.pipe(response);
}

async function readJsonBody(request, maxBytes) {
    const contentType = String(request.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (contentType !== 'application/json') throw new HttpError(415, 'Content-Type must be application/json.');
    const contentLength = Number(request.headers['content-length'] || 0);
    if (Number.isFinite(contentLength) && contentLength > maxBytes) throw new HttpError(413, 'Request body is too large.');
    const chunks = [];
    let totalBytes = 0;
    for await (const chunk of request) {
        totalBytes += chunk.length;
        if (totalBytes > maxBytes) throw new HttpError(413, 'Request body is too large.');
        chunks.push(chunk);
    }
    if (!chunks.length) throw new HttpError(400, 'A JSON request body is required.');
    try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!parsed || typeof parsed !== 'object') throw new Error('not an object');
        return parsed;
    } catch (_error) {
        throw new HttpError(400, 'Request body contains invalid JSON.');
    }
}

function validatePassword(value) {
    const password = String(value || '');
    if (password.length < PASSWORD_MIN_LENGTH) throw new HttpError(400, `Password must be at least ${PASSWORD_MIN_LENGTH} characters.`);
    if (password.length > PASSWORD_MAX_LENGTH) throw new HttpError(400, `Password must be at most ${PASSWORD_MAX_LENGTH} characters.`);
    return password;
}

function validateMoney(value, label) {
    const number = typeof value === 'number' ? value : Number(value || 0);
    if (!Number.isFinite(number) || number < 0 || number > 1000000000) throw new HttpError(400, `${label} must be a valid non-negative amount.`);
    return Math.round(number * 100) / 100;
}

function validateIsoDate(value, label, required) {
    const text = String(value || '').trim();
    if (!text && !required) return '';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) throw new HttpError(400, `${label} must be a valid date.`);
    const parsed = new Date(`${text}T00:00:00Z`);
    if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== text) throw new HttpError(400, `${label} must be a valid date.`);
    return text;
}

function validateIsoDateTime(value) {
    const text = String(value || '').trim();
    if (!text) return '';
    const hasTimezone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(text);
    const legacyOffset = String(process.env.LEGACY_TIMEZONE_OFFSET || '+05:30');
    if (!/^[+-]\d{2}:\d{2}$/.test(legacyOffset)) throw new Error('LEGACY_TIMEZONE_OFFSET must look like +05:30.');
    const parsed = new Date(hasTimezone ? text : `${text}${legacyOffset}`);
    if (Number.isNaN(parsed.getTime())) throw new HttpError(400, 'Date added must be a valid date and time.');
    return parsed;
}

function validateBackgroundImage(value) {
    const image = String(value || '');
    if (!image) return '';
    if (!/^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/=\r\n]+$/.test(image)) throw new HttpError(400, 'Use a PNG, JPEG, WebP, or GIF image.');
    if (Buffer.byteLength(image, 'utf8') > 8 * 1024 * 1024) throw new HttpError(413, 'The background image must be smaller than 8 MB.');
    return image;
}

function validateOptionalEmail(value) {
    const email = normalizeEmail(value);
    if (email && !isValidEmail(email)) throw new HttpError(400, 'Student email address must be valid.');
    return email;
}

function requireText(value, label, minLength, maxLength) {
    const text = cleanText(value, maxLength);
    if (text.length < minLength) throw new HttpError(400, `${label} is required.`);
    return text;
}

function requireSingleLineText(value, label, minLength, maxLength) {
    const text = cleanText(value, maxLength).replace(/[\r\n\u2028\u2029]+/g, ' ').replace(/\s{2,}/g, ' ');
    if (text.length < minLength) throw new HttpError(400, `${label} is required.`);
    return text;
}

function cleanText(value, maxLength) {
    const text = String(value == null ? '' : value).trim();
    if (text.length > maxLength) throw new HttpError(400, `Text must be at most ${maxLength} characters.`);
    return text;
}

function normalizeEmail(value) { return String(value || '').trim().toLowerCase(); }
function isValidEmail(value) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) && value.length <= 254; }
function normalizeUserId(value) { return String(value || '').trim().toLowerCase(); }
function isValidUserId(value) { return /^[a-z0-9][a-z0-9._-]{2,79}$/.test(value); }
function isUniqueViolation(error) { return error && (error.code === '23505' || /unique constraint|duplicate key/i.test(String(error.message || ''))); }

function parseSafeId(value) {
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new HttpError(400, 'Invalid identifier.');
    return parsed;
}

function getClientAddress(request) {
    if (TRUST_PROXY && TRUSTED_CLIENT_IP_HEADER) {
        const clientAddress = String(request.headers[TRUSTED_CLIENT_IP_HEADER] || '').trim();
        if (net.isIP(clientAddress)) return clientAddress;
    }
    return String(request.socket.remoteAddress || 'unknown').slice(0, 100);
}

function toDateOnly(value) {
    if (!value) return '';
    if (typeof value === 'string') return value.slice(0, 10);
    const year = value.getFullYear();
    const month = String(value.getMonth() + 1).padStart(2, '0');
    const day = String(value.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

function toIsoString(value) {
    if (!value) return '';
    const date = value instanceof Date ? value : new Date(value);
    return Number.isNaN(date.getTime()) ? '' : date.toISOString();
}

function applySecurityHeaders(request, response) {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('X-Frame-Options', 'DENY');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    response.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'");
    if (process.env.NODE_ENV === 'production' || request.socket.encrypted) response.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
}

function sendJson(response, status, payload) {
    const body = JSON.stringify(payload);
    response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store' });
    response.end(body);
}

function handleRequestError(response, error) {
    if (response.headersSent) return response.destroy();
    if (error instanceof HttpError) {
        Object.entries(error.headers).forEach(([name, value]) => response.setHeader(name, value));
        return sendJson(response, error.status, { error: error.message });
    }
    if (error && error.code === 'ENOENT') return sendJson(response, 404, { error: 'Page not found.' });
    console.error(error);
    sendJson(response, 500, { error: 'An unexpected server error occurred.' });
}

module.exports = {
    HttpError,
    queueUnverifiedRegistrationEmails,
    startApplication,
    toPublicRecord,
    validateRecordInput
};
