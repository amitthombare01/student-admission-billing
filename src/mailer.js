'use strict';

const nodemailer = require('nodemailer');
const { createEmailVerificationToken, escapeHtml, validateSigningSecret } = require('./security');
const { parseInteger, withTransaction } = require('./database');

function createMailService() {
    const appBaseUrl = validateBaseUrl(process.env.APP_BASE_URL);
    const mailFrom = String(process.env.MAIL_FROM || '').trim();
    const smtpHost = String(process.env.SMTP_HOST || '').trim();
    const smtpUser = String(process.env.SMTP_USER || '').trim();
    const smtpPassword = String(process.env.SMTP_PASSWORD || '');
    const useJsonTransport = process.env.NODE_ENV === 'test' && process.env.MAIL_TRANSPORT === 'json';
    const emailVerificationSecret = validateSigningSecret(process.env.EMAIL_VERIFICATION_SECRET);

    if (useJsonTransport) {
        return {
            appBaseUrl,
            emailVerificationSecret,
            mailFrom: mailFrom || 'test-notifications@example.test',
            transporter: nodemailer.createTransport({ jsonTransport: true }),
            mode: 'json'
        };
    }

    if (!smtpHost) {
        if (process.env.NODE_ENV === 'production') {
            throw new Error('SMTP_HOST is required in production so pending registrations can notify an administrator.');
        }
        console.warn('SMTP is not configured; notification emails will be logged as sent only in local development.');
        return {
            appBaseUrl,
            emailVerificationSecret,
            mailFrom: mailFrom || 'notifications@localhost',
            transporter: nodemailer.createTransport({ jsonTransport: true }),
            mode: 'json'
        };
    }
    if (!mailFrom) {
        throw new Error('MAIL_FROM is required when SMTP_HOST is configured.');
    }
    if (Boolean(smtpUser) !== Boolean(smtpPassword)) {
        throw new Error('SMTP_USER and SMTP_PASSWORD must be configured together.');
    }
    if (process.env.NODE_ENV === 'production' && (!smtpUser || !smtpPassword)) {
        throw new Error('SMTP_USER and SMTP_PASSWORD are required for authenticated SMTP in production.');
    }

    const secure = parseBoolean(process.env.SMTP_SECURE, false, 'SMTP_SECURE');
    const port = parseInteger(process.env.SMTP_PORT, secure ? 465 : 587, 1, 65535, 'SMTP_PORT');

    return {
        appBaseUrl,
        emailVerificationSecret,
        mailFrom,
        mode: 'smtp',
        transporter: nodemailer.createTransport({
            host: smtpHost,
            port,
            secure,
            requireTLS: !secure,
            auth: smtpUser ? { user: smtpUser, pass: smtpPassword } : undefined,
            connectionTimeout: 5000,
            greetingTimeout: 5000,
            socketTimeout: 7000,
            tls: { minVersion: 'TLSv1.2', rejectUnauthorized: true }
        })
    };
}

function startOutboxWorker({ pool, isMemoryDatabase, mailService }) {
    const pollMilliseconds = parseInteger(process.env.OUTBOX_POLL_MS, 5000, 50, 60000, 'OUTBOX_POLL_MS');
    const retryBaseSeconds = parseInteger(process.env.OUTBOX_RETRY_BASE_SECONDS, 60, 1, 3600, 'OUTBOX_RETRY_BASE_SECONDS');
    let stopped = false;
    let running = false;
    let activeRun = Promise.resolve();

    function processAvailableMessages() {
        if (stopped || running) {
            return activeRun;
        }
        running = true;
        activeRun = (async () => {
            try {
                for (let processed = 0; processed < 20 && !stopped; processed += 1) {
                    const message = await claimNextMessage(pool, isMemoryDatabase);
                    if (!message) {
                        break;
                    }
                    await deliverMessage(pool, mailService, message, retryBaseSeconds);
                }
            } catch (error) {
                console.error('Notification outbox worker error:', error.message);
            } finally {
                running = false;
            }
        })();
        return activeRun;
    }

    const timer = setInterval(processAvailableMessages, pollMilliseconds);
    timer.unref();
    setImmediate(processAvailableMessages);

    return {
        wake: processAvailableMessages,
        async stop() {
            stopped = true;
            clearInterval(timer);
            await activeRun;
        }
    };
}

async function claimNextMessage(pool, isMemoryDatabase) {
    if (isMemoryDatabase) {
        return withTransaction(pool, async (client) => {
            const selected = await client.query(`
                SELECT *
                FROM notification_outbox
                WHERE status IN ('pending', 'retry') AND next_attempt_at <= NOW()
                ORDER BY id
                LIMIT 1
            `);
            if (!selected.rowCount) {
                return null;
            }
            const claimed = await client.query(`
                UPDATE notification_outbox
                SET status = 'sending', attempts = attempts + 1, locked_at = NOW()
                WHERE id = $1
                RETURNING *
            `, [selected.rows[0].id]);
            return claimed.rows[0];
        });
    }

    const result = await pool.query(`
        WITH candidate AS (
            SELECT id
            FROM notification_outbox
            WHERE (
                status IN ('pending', 'retry') AND next_attempt_at <= NOW()
            ) OR (
                status = 'sending' AND locked_at < NOW() - INTERVAL '10 minutes'
            )
            ORDER BY id
            FOR UPDATE SKIP LOCKED
            LIMIT 1
        )
        UPDATE notification_outbox AS outbox
        SET status = 'sending', attempts = attempts + 1, locked_at = NOW()
        FROM candidate
        WHERE outbox.id = candidate.id
        RETURNING outbox.*
    `);
    return result.rows[0] || null;
}

async function deliverMessage(pool, mailService, message, retryBaseSeconds) {
    try {
        const rendered = renderNotification(message, mailService.appBaseUrl, mailService.emailVerificationSecret);
        const info = await mailService.transporter.sendMail({
            from: mailService.mailFrom,
            to: message.recipient,
            subject: rendered.subject,
            text: rendered.text,
            html: rendered.html,
            headers: { 'X-Admission-Notification-ID': String(message.id) }
        });
        await pool.query(`
            UPDATE notification_outbox
            SET status = 'sent', sent_at = NOW(), locked_at = NULL, last_error = ''
            WHERE id = $1
        `, [message.id]);
        console.log(`Notification ${message.id} sent to ${maskEmail(message.recipient)} (${info.messageId || mailService.mode}).`);
    } catch (error) {
        const attempts = Number(message.attempts || 1);
        const failedPermanently = attempts >= 10;
        const retryDelay = Math.min(retryBaseSeconds * (2 ** Math.max(0, attempts - 1)), 3600);
        await pool.query(`
            UPDATE notification_outbox
            SET status = $2,
                next_attempt_at = NOW() + ($3 * INTERVAL '1 second'),
                locked_at = NULL,
                last_error = $4
            WHERE id = $1
        `, [
            message.id,
            failedPermanently ? 'failed' : 'retry',
            retryDelay,
            String(error.message || 'Mail delivery failed').slice(0, 500)
        ]);
        console.error(`Notification ${message.id} delivery failed; ${failedPermanently ? 'marked failed' : 'scheduled for retry'}.`);
    }
}

function renderNotification(message, appBaseUrl, emailVerificationSecret = '') {
    const payload = typeof message.payload === 'string' ? JSON.parse(message.payload) : message.payload;
    const fullName = toSingleLine(payload.fullName || 'Staff member');
    const username = String(payload.username || '');

    if (message.event_type === 'registration_pending') {
        if (payload.notificationKind === 'email_verification') {
            const verificationTtlHours = parseInteger(process.env.EMAIL_VERIFICATION_TTL_HOURS, 24, 1, 168, 'EMAIL_VERIFICATION_TTL_HOURS');
            const verificationExpiresAt = new Date(Date.now() + verificationTtlHours * 60 * 60 * 1000);
            const verificationToken = createEmailVerificationToken(
                payload.reviewId,
                verificationExpiresAt,
                emailVerificationSecret
            );
            const verificationUrl = new URL('/index.html', appBaseUrl);
            verificationUrl.hash = `verify=${encodeURIComponent(verificationToken)}`;
            const safeName = escapeHtml(fullName);
            const safeUrl = escapeHtml(verificationUrl.toString());
            return {
                subject: 'Confirm your school staff email address',
                text: `Hello ${fullName},\n\nConfirm that you own this email address before the school administrator reviews your account. Open ${verificationUrl} and press Confirm email. Opening the page alone does not verify the account. This link expires in ${verificationTtlHours} hours.`,
                html: `<p>Hello ${safeName},</p><p>Confirm that you own this email address before the school administrator reviews your account.</p><p><a href="${safeUrl}">Open the email confirmation page</a>, then press <strong>Confirm email</strong>. Opening the page alone does not verify the account.</p><p>This link expires in ${verificationTtlHours} hours.</p>`
            };
        }
        const reviewUrl = new URL('/admin.html', appBaseUrl);
        reviewUrl.searchParams.set('review', String(payload.reviewId || ''));
        const safeName = escapeHtml(fullName);
        const safeUsername = escapeHtml(username);
        const safeUrl = escapeHtml(reviewUrl.toString());
        return {
            subject: 'New staff account awaiting approval',
            text: `A new staff account is awaiting approval.\n\nName: ${fullName}\nEmail: ${username}\n\nReview this request: ${reviewUrl}\n\nLog in as an administrator and explicitly approve or reject it. This link does not approve the account by itself.`,
            html: `<p>A new staff account is awaiting approval.</p><p><strong>Name:</strong> ${safeName}<br><strong>Email:</strong> ${safeUsername}</p><p><a href="${safeUrl}">Open the protected admin review page</a></p><p>Log in as an administrator and explicitly approve or reject it. This link does not approve the account by itself.</p>`
        };
    }

    if (message.event_type === 'account_approved') {
        const loginUrl = new URL('/index.html', appBaseUrl);
        return {
            subject: 'Your school staff account was approved',
            text: `Hello ${fullName},\n\nYour school staff account (${username}) was approved. You can now sign in at ${loginUrl}`,
            html: `<p>Hello ${escapeHtml(fullName)},</p><p>Your school staff account (<strong>${escapeHtml(username)}</strong>) was approved.</p><p><a href="${escapeHtml(loginUrl.toString())}">Sign in to the school portal</a></p>`
        };
    }

    if (message.event_type === 'account_rejected') {
        const loginUrl = new URL('/index.html', appBaseUrl);
        return {
            subject: 'Your school staff account request was not approved',
            text: `Hello ${fullName},\n\nYour school staff account request (${username}) was not approved. Contact the school administrator if you believe this is a mistake. Portal: ${loginUrl}`,
            html: `<p>Hello ${escapeHtml(fullName)},</p><p>Your school staff account request (<strong>${escapeHtml(username)}</strong>) was not approved.</p><p>Contact the school administrator if you believe this is a mistake.</p>`
        };
    }

    throw new Error(`Unknown notification event type: ${message.event_type}`);
}

function toSingleLine(value) {
    return String(value == null ? '' : value).replace(/[\r\n\u2028\u2029]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
}

function maskEmail(value) {
    const email = String(value || '');
    const separator = email.lastIndexOf('@');
    if (separator <= 0) return 'recipient';
    const local = email.slice(0, separator);
    const domain = email.slice(separator + 1);
    return `${local.slice(0, Math.min(2, local.length))}***@${domain}`;
}

function validateBaseUrl(value) {
    const text = String(value || '').trim();
    if (!text) {
        if (process.env.NODE_ENV === 'test') {
            return new URL('http://127.0.0.1:3000/');
        }
        throw new Error('APP_BASE_URL is required so notification emails can link to the public web application.');
    }
    let url;
    try {
        url = new URL(text);
    } catch (_error) {
        throw new Error('APP_BASE_URL must be a valid absolute URL.');
    }
    if (url.username || url.password || url.search || url.hash) {
        throw new Error('APP_BASE_URL cannot include credentials, a query string, or a fragment.');
    }
    if (process.env.NODE_ENV === 'production' && url.protocol !== 'https:') {
        throw new Error('APP_BASE_URL must use HTTPS in production.');
    }
    if (!['http:', 'https:'].includes(url.protocol)) {
        throw new Error('APP_BASE_URL must use HTTP or HTTPS.');
    }
    return url;
}

function parseBoolean(value, fallback, name) {
    if (value == null || value === '') {
        return fallback;
    }
    if (String(value).toLowerCase() === 'true' || value === '1') {
        return true;
    }
    if (String(value).toLowerCase() === 'false' || value === '0') {
        return false;
    }
    throw new Error(`${name} must be true or false.`);
}

module.exports = { createMailService, renderNotification, startOutboxWorker };
