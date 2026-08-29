'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const test = require('node:test');
const ExcelJS = require('exceljs');
const { types } = require('pg');
const { buildPostgresPoolConfig } = require('../src/database');
const { createMailService, renderNotification } = require('../src/mailer');
const { createEmailVerificationToken, readEmailVerificationToken } = require('../src/security');

const projectRoot = path.resolve(__dirname, '..');
const verificationSecret = 'test-email-verification-secret-with-more-than-32-characters';

test('PostgreSQL URL parameters cannot weaken verified TLS or discard the configured CA', () => {
    const certificate = '-----BEGIN CERTIFICATE-----\nTEST-CERTIFICATE\n-----END CERTIFICATE-----';
    const config = buildPostgresPoolConfig({
        NODE_ENV: 'production',
        DATABASE_URL: 'postgresql://user:password@db.example.test/school?sslmode=require&ssl=true',
        DATABASE_SSL: 'require',
        DATABASE_CA_BASE64: Buffer.from(certificate).toString('base64')
    });
    assert.equal(config.ssl.rejectUnauthorized, true);
    assert.equal(config.ssl.ca, certificate);
    assert.doesNotMatch(config.connectionString, /sslmode/i);
    assert.doesNotMatch(config.connectionString, /[?&]ssl=/i);

    const productionDefault = buildPostgresPoolConfig({
        NODE_ENV: 'production',
        DATABASE_URL: 'postgresql://user:password@db.example.test/school'
    });
    assert.equal(productionDefault.ssl.rejectUnauthorized, true);

    assert.throws(() => buildPostgresPoolConfig({
        NODE_ENV: 'production',
        DATABASE_URL: 'postgresql://user:password@db.example.test/school?sslmode=no-verify',
        DATABASE_SSL: 'require'
    }), /unsafe or ambiguous sslmode/i);

    for (const unsafeValue of ['no-verify', 'false', '0']) {
        assert.throws(() => buildPostgresPoolConfig({
            NODE_ENV: 'production',
            DATABASE_URL: `postgresql://user:password@db.example.test/school?ssl=${unsafeValue}`
        }), unsafeValue === 'no-verify' ? /unsafe or ambiguous ssl parameter/i : /conflict/i);
    }

    assert.throws(() => buildPostgresPoolConfig({
        NODE_ENV: 'production',
        DATABASE_URL: 'postgresql://user:password@db.example.test/school?sslmode=disable'
    }), /conflict/i);

    assert.throws(() => buildPostgresPoolConfig({
        NODE_ENV: 'development',
        DATABASE_URL: 'postgresql://user:password@db.example.test/school?ssl=true',
        DATABASE_SSL: 'disable'
    }), /conflict/i);

    const explicitlyDisabled = buildPostgresPoolConfig({
        NODE_ENV: 'development',
        DATABASE_URL: 'postgresql://user:password@db.example.test/school?ssl=0',
        DATABASE_SSL: 'disable'
    });
    assert.equal(explicitlyDisabled.ssl, false);
    assert.doesNotMatch(explicitlyDisabled.connectionString, /[?&]ssl=/i);
});

test('PostgreSQL DATE values remain timezone-free calendar strings', () => {
    assert.equal(types.getTypeParser(1082)('2026-08-22'), '2026-08-22');
});

test('production SMTP configuration requires authenticated credentials', () => {
    const variableNames = [
        'NODE_ENV', 'APP_BASE_URL', 'EMAIL_VERIFICATION_SECRET', 'SMTP_HOST',
        'SMTP_USER', 'SMTP_PASSWORD', 'MAIL_FROM', 'MAIL_TRANSPORT'
    ];
    const original = Object.fromEntries(variableNames.map((name) => [name, process.env[name]]));
    try {
        process.env.NODE_ENV = 'production';
        process.env.APP_BASE_URL = 'https://school.example.test';
        process.env.EMAIL_VERIFICATION_SECRET = verificationSecret;
        process.env.SMTP_HOST = 'smtp.example.test';
        process.env.MAIL_FROM = 'notifications@example.test';
        delete process.env.SMTP_USER;
        delete process.env.SMTP_PASSWORD;
        delete process.env.MAIL_TRANSPORT;
        assert.throws(() => createMailService(), /required for authenticated SMTP/i);
    } finally {
        for (const [name, value] of Object.entries(original)) {
            if (value === undefined) delete process.env[name];
            else process.env[name] = value;
        }
    }
});

test('notification email links to the protected admin page without carrying approval authority', () => {
    const rendered = renderNotification({
        id: 1,
        event_type: 'registration_pending',
        payload: {
            reviewId: '3cbd093d-c9e1-43bb-82c5-01d0dbff14f4',
            fullName: '<Test Admin Request>',
            username: 'staff@example.test',
            password: 'must-never-appear'
        }
    }, new URL('https://school.example.test/'));

    assert.match(rendered.text, /https:\/\/school\.example\.test\/admin\.html\?review=/);
    assert.match(rendered.text, /explicitly approve or reject/i);
    assert.doesNotMatch(rendered.text, /must-never-appear/);
    assert.doesNotMatch(rendered.html, /must-never-appear/);
    assert.match(rendered.html, /&lt;Test Admin Request&gt;/);
});

test('email verification links use a fragment and require an explicit confirmation action', () => {
    const rendered = renderNotification({
        id: 2,
        event_type: 'registration_pending',
        payload: {
            notificationKind: 'email_verification',
            reviewId: '3cbd093d-c9e1-43bb-82c5-01d0dbff14f4',
            fullName: 'Test\nStaff',
            username: 'staff@example.test',
            password: 'must-never-appear'
        }
    }, new URL('https://school.example.test/'), verificationSecret);

    assert.match(rendered.text, /index\.html#verify=/);
    assert.match(rendered.text, /press Confirm email/i);
    assert.doesNotMatch(rendered.text, /must-never-appear/);
    assert.doesNotMatch(rendered.text, /Test\nStaff/);
    const token = decodeURIComponent(rendered.text.match(/#verify=([^\s]+)/)[1]);
    const parsed = readEmailVerificationToken(token, verificationSecret);
    assert.equal(parsed.reviewId, '3cbd093d-c9e1-43bb-82c5-01d0dbff14f4');
});

test('cloud workflow keeps registrations pending until a remote admin approves', async (context) => {
    const application = await startApplication();
    context.after(async () => stopApplication(application.child));

    const health = await api(application.baseUrl, '/api/health');
    assert.equal(health.status, 200);
    assert.deepEqual(health.data, { status: 'ok', database: 'ready' });

    const registration = await api(application.baseUrl, '/api/register', {
        method: 'POST',
        body: {
            fullName: 'Test Staff Member',
            username: 'staff@example.test',
            password: 'correct-horse-battery-staple'
        }
    });
    assert.equal(registration.status, 202);
    assert.equal(registration.data.status, 'pending_email');
    assert.equal('token' in registration.data, false);
    assert.ok(registration.data.requestId);

    const duplicate = await api(application.baseUrl, '/api/register', {
        method: 'POST',
        body: {
            fullName: 'Duplicate Staff',
            username: 'STAFF@example.test',
            password: 'another-secure-password'
        }
    });
    assert.equal(duplicate.status, 409);

    const pendingLogin = await api(application.baseUrl, '/api/login', {
        method: 'POST',
        body: {
            username: 'staff@example.test',
            password: 'correct-horse-battery-staple'
        }
    });
    assert.equal(pendingLogin.status, 403);
    assert.match(pendingLogin.data.error, /confirm your email/i);

    const adminLogin = await api(application.baseUrl, '/api/admin/login', {
        method: 'POST',
        body: {
            username: 'admin@example.test',
            password: 'a-long-test-admin-password'
        }
    });
    assert.equal(adminLogin.status, 200);
    assert.equal(adminLogin.data.user.role, 'admin');
    const adminHeaders = { Authorization: `Bearer ${adminLogin.data.token}` };

    const reviewPage = await fetch(`${application.baseUrl}/admin.html?review=${registration.data.requestId}`);
    assert.equal(reviewPage.status, 200);

    let users = await api(application.baseUrl, '/api/admin/users', { headers: adminHeaders });
    let staffUser = users.data.users.find((user) => user.username === 'staff@example.test');
    assert.equal(staffUser.status, 'pending');
    assert.equal(staffUser.emailVerified, false);
    assert.equal(staffUser.reviewId, registration.data.requestId);

    const prematureApproval = await api(application.baseUrl, `/api/admin/users/${staffUser.id}/approve`, {
        method: 'POST', headers: adminHeaders, body: {}
    });
    assert.equal(prematureApproval.status, 409);

    const verificationToken = createEmailVerificationToken(
        registration.data.requestId,
        new Date(Date.now() + 60 * 60 * 1000),
        verificationSecret
    );
    const verificationPage = await fetch(`${application.baseUrl}/index.html#verify=${encodeURIComponent(verificationToken)}`);
    assert.equal(verificationPage.status, 200);
    users = await api(application.baseUrl, '/api/admin/users', { headers: adminHeaders });
    staffUser = users.data.users.find((user) => user.username === 'staff@example.test');
    assert.equal(staffUser.emailVerified, false);

    const tamperedVerification = await api(application.baseUrl, '/api/verify-email', {
        method: 'POST', body: { token: `${verificationToken}x` }
    });
    assert.equal(tamperedVerification.status, 400);

    const expiredToken = createEmailVerificationToken(
        registration.data.requestId,
        new Date(Date.now() - 1000),
        verificationSecret
    );
    const expiredVerification = await api(application.baseUrl, '/api/verify-email', {
        method: 'POST', body: { token: expiredToken }
    });
    assert.equal(expiredVerification.status, 410);

    const wrongPasswordResend = await api(application.baseUrl, '/api/resend-verification', {
        method: 'POST',
        body: { username: 'staff@example.test', password: 'not-the-registration-password' }
    });
    const resend = await api(application.baseUrl, '/api/resend-verification', {
        method: 'POST',
        body: { username: 'staff@example.test', password: 'correct-horse-battery-staple' }
    });
    assert.equal(wrongPasswordResend.status, 202);
    assert.equal(resend.status, 202);
    assert.equal(wrongPasswordResend.data.message, resend.data.message);

    const verified = await api(application.baseUrl, '/api/verify-email', {
        method: 'POST', body: { token: verificationToken }
    });
    assert.equal(verified.status, 200);
    assert.equal(verified.data.status, 'pending_admin');

    users = await api(application.baseUrl, '/api/admin/users', { headers: adminHeaders });
    staffUser = users.data.users.find((user) => user.username === 'staff@example.test');
    assert.equal(staffUser.emailVerified, true);

    const approved = await api(application.baseUrl, `/api/admin/users/${staffUser.id}/approve`, {
        method: 'POST',
        headers: adminHeaders,
        body: {}
    });
    assert.equal(approved.status, 200);
    assert.equal(approved.data.user.status, 'active');

    const approvalReplay = await api(application.baseUrl, `/api/admin/users/${staffUser.id}/approve`, {
        method: 'POST',
        headers: adminHeaders,
        body: {}
    });
    assert.equal(approvalReplay.status, 409);

    const verificationReplayAfterApproval = await api(application.baseUrl, '/api/verify-email', {
        method: 'POST', body: { token: verificationToken }
    });
    assert.equal(verificationReplayAfterApproval.status, 409);

    const userLogin = await api(application.baseUrl, '/api/login', {
        method: 'POST',
        body: {
            username: 'staff@example.test',
            password: 'correct-horse-battery-staple'
        }
    });
    assert.equal(userLogin.status, 200);
    const userHeaders = { Authorization: `Bearer ${userLogin.data.token}` };

    for (let attempt = 0; attempt < 5; attempt += 1) {
        const failed = await api(application.baseUrl, '/api/login', {
            method: 'POST',
            body: { username: 'rate-limited@example.test', password: 'wrong-password' }
        });
        assert.equal(failed.status, 401);
    }
    const unrelatedSuccess = await api(application.baseUrl, '/api/login', {
        method: 'POST',
        body: { username: 'staff@example.test', password: 'correct-horse-battery-staple' }
    });
    assert.equal(unrelatedSuccess.status, 200);
    for (let attempt = 0; attempt < 5; attempt += 1) {
        const failed = await api(application.baseUrl, '/api/login', {
            method: 'POST',
            body: { username: 'rate-limited@example.test', password: 'wrong-password' }
        });
        assert.equal(failed.status, 401);
    }
    const rateLimited = await api(application.baseUrl, '/api/login', {
        method: 'POST',
        body: { username: 'rate-limited@example.test', password: 'wrong-password' }
    });
    assert.equal(rateLimited.status, 429);

    const staffAdminAttempt = await api(application.baseUrl, '/api/admin/users', { headers: userHeaders });
    assert.equal(staffAdminAttempt.status, 403);

    const invalidClass = await api(application.baseUrl, '/api/records', {
        method: 'POST',
        headers: userHeaders,
        body: recordPayload({ className: '__proto__' })
    });
    assert.equal(invalidClass.status, 400);

    const createdRecord = await api(application.baseUrl, '/api/records', {
        method: 'POST',
        headers: userHeaders,
        body: recordPayload()
    });
    assert.equal(createdRecord.status, 201);
    assert.match(createdRecord.data.record.rollNumber, /^ADM-\d{6}$/);

    const adminRecords = await api(application.baseUrl, '/api/records', { headers: adminHeaders });
    assert.equal(adminRecords.status, 200);
    assert.equal(adminRecords.data.records[0].createdByName, 'Test Staff Member');
    const staffRecords = await api(application.baseUrl, '/api/records', { headers: userHeaders });
    assert.equal(staffRecords.data.records[0].createdByName, '');

    const legacyBackup = {
        exportedAt: '2026-08-22T12:00:00',
        totalRecords: 1,
        records: [{
            schoolName: 'Legacy School',
            studentName: '=HYPERLINK("https://evil.invalid","Click")',
            rollNumber: '00017',
            className: '5',
            parentName: '+Legacy Parent',
            contactNumber: '0012345678901234',
            emailAddress: 'student@example.test',
            dateOfBirth: '2015-01-02',
            address: 'पत्ता <School & Home>\n@not-a-formula\u0001',
            TotalFee: 1500,
            transportFee: 100,
            sportsFee: 0,
            otherFee: 0,
            paymentMode: 'cash',
            amountPaid: 500,
            sessionYear: '2026-2027',
            admissionDate: '2026-06-15',
            dateAdded: '2026-06-15T09:30:00'
        }]
    };
    const imported = await api(application.baseUrl, '/api/import', {
        method: 'POST', headers: adminHeaders, body: legacyBackup
    });
    assert.equal(imported.status, 200);
    assert.equal(imported.data.imported, 1);
    const importedAgain = await api(application.baseUrl, '/api/import', {
        method: 'POST', headers: adminHeaders, body: legacyBackup
    });
    assert.equal(importedAgain.status, 200);

    const exported = await api(application.baseUrl, '/api/export', { headers: adminHeaders });
    assert.equal(exported.status, 200);
    assert.equal(exported.data.totalRecords, 1);
    assert.equal(exported.data.records[0].emailAddress, 'student@example.test');
    assert.equal(exported.data.records[0].tuitionFee, 1500);
    assert.match(exported.data.records[0].dateAdded, /T04:00:00\.000Z$/);

    const anonymousExcel = await fetch(`${application.baseUrl}/api/export.xlsx`);
    assert.equal(anonymousExcel.status, 401);
    const staffExcel = await fetch(`${application.baseUrl}/api/export.xlsx`, { headers: userHeaders });
    assert.equal(staffExcel.status, 403);
    const excelResponse = await fetch(`${application.baseUrl}/api/export.xlsx`, { headers: adminHeaders });
    assert.equal(excelResponse.status, 200);
    assert.equal(excelResponse.headers.get('content-type'), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    assert.match(excelResponse.headers.get('content-disposition'), /^attachment; filename="student-records-\d{4}-\d{2}-\d{2}\.xlsx"$/);
    assert.match(excelResponse.headers.get('cache-control'), /private/);
    assert.match(excelResponse.headers.get('cache-control'), /no-store/);
    const excelBytes = Buffer.from(await excelResponse.arrayBuffer());
    assert.equal(excelBytes.subarray(0, 2).toString('ascii'), 'PK');
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(excelBytes);
    const worksheet = workbook.getWorksheet('Student Records');
    assert.ok(worksheet);
    assert.equal(worksheet.rowCount, 2);
    assert.deepEqual(worksheet.getRow(1).values.slice(1, 5), ['Record ID', 'School', 'Student', 'Roll Number']);
    assert.equal(worksheet.getCell('C2').type, ExcelJS.ValueType.String);
    assert.equal(worksheet.getCell('C2').value, '\'=HYPERLINK("https://evil.invalid","Click")');
    assert.equal(worksheet.getCell('D2').value, '00017');
    assert.equal(worksheet.getCell('F2').value, '\'+Legacy Parent');
    assert.equal(worksheet.getCell('G2').value, '0012345678901234');
    assert.match(worksheet.getCell('J2').value, /पत्ता <School & Home>/);
    assert.doesNotMatch(worksheet.getCell('J2').value, /\u0001/);
    assert.equal(worksheet.getCell('K2').value, 1500);
    assert.equal(worksheet.getCell('O2').value, 1600);
    assert.equal(worksheet.getCell('Q2').value, 1100);
    assert.equal(worksheet.getCell('I2').value.toISOString().slice(0, 10), '2015-01-02');
    assert.equal(worksheet.getCell('T2').value.toISOString().slice(0, 10), '2026-06-15');
    worksheet.eachRow((row) => row.eachCell({ includeEmpty: true }, (cell) => {
        assert.notEqual(cell.type, ExcelJS.ValueType.Formula);
        assert.notEqual(cell.type, ExcelJS.ValueType.Hyperlink);
    }));

    const invalidRestore = structuredClone(legacyBackup);
    invalidRestore.records.push({ ...legacyBackup.records[0], studentName: 'Bad Record', className: 'invalid' });
    const rollbackResult = await api(application.baseUrl, '/api/import', {
        method: 'POST', headers: adminHeaders, body: invalidRestore
    });
    assert.equal(rollbackResult.status, 400);
    const afterRollback = await api(application.baseUrl, '/api/export', { headers: adminHeaders });
    assert.equal(afterRollback.data.totalRecords, 1);

    const background = await api(application.baseUrl, '/api/settings/background', {
        method: 'PUT', headers: adminHeaders, body: { backgroundImage: 'data:image/png;base64,aGVsbG8=' }
    });
    assert.equal(background.status, 200);

    const disabled = await api(application.baseUrl, `/api/admin/users/${staffUser.id}/status`, {
        method: 'PUT', headers: adminHeaders, body: { status: 'disabled' }
    });
    assert.equal(disabled.status, 200);
    const revokedSession = await api(application.baseUrl, '/api/session', { headers: userHeaders });
    assert.equal(revokedSession.status, 401);

    const clearedRecords = await api(application.baseUrl, '/api/records', {
        method: 'DELETE', headers: adminHeaders
    });
    assert.equal(clearedRecords.status, 200);
    const emptyExcelResponse = await fetch(`${application.baseUrl}/api/export.xlsx`, { headers: adminHeaders });
    assert.equal(emptyExcelResponse.status, 200);
    const emptyWorkbook = new ExcelJS.Workbook();
    await emptyWorkbook.xlsx.load(Buffer.from(await emptyExcelResponse.arrayBuffer()));
    assert.equal(emptyWorkbook.getWorksheet('Student Records').rowCount, 1);

    const secondRegistration = await api(application.baseUrl, '/api/register', {
        method: 'POST',
        body: {
            fullName: 'Rejected Staff',
            username: 'rejected@example.test',
            password: 'correct-horse-battery-staple'
        }
    });
    assert.equal(secondRegistration.status, 202);
    const secondVerificationToken = createEmailVerificationToken(
        secondRegistration.data.requestId,
        new Date(Date.now() + 60 * 60 * 1000),
        verificationSecret
    );
    const secondVerified = await api(application.baseUrl, '/api/verify-email', {
        method: 'POST', body: { token: secondVerificationToken }
    });
    assert.equal(secondVerified.status, 200);
    users = await api(application.baseUrl, '/api/admin/users', { headers: adminHeaders });
    staffUser = users.data.users.find((user) => user.username === 'rejected@example.test');
    const rejected = await api(application.baseUrl, `/api/admin/users/${staffUser.id}/reject`, {
        method: 'POST', headers: adminHeaders, body: {}
    });
    assert.equal(rejected.status, 200);
    assert.equal(rejected.data.user.status, 'rejected');

    await waitFor(async () => {
        const notifications = await api(application.baseUrl, '/api/admin/notifications', { headers: adminHeaders });
        return Number(notifications.data.counts.sent || 0) >= 7;
    }, 3000);
});

function recordPayload(overrides = {}) {
    return {
        schoolName: 'Test School',
        studentName: 'Student One',
        className: '5',
        parentName: 'Parent One',
        contactNumber: '9876543210',
        dateOfBirth: '2015-01-02',
        address: 'Test address',
        tuitionFee: 1000,
        transportFee: 200,
        sportsFee: 0,
        otherFee: 50,
        paymentMode: 'online',
        amountPaid: 500,
        sessionYear: '2026-2027',
        admissionDate: '2026-08-22',
        ...overrides
    };
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

function startApplication() {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ['server.js'], {
            cwd: projectRoot,
            env: {
                ...process.env,
                HOST: '127.0.0.1',
                PORT: '0',
                NODE_ENV: 'test',
                USE_PG_MEM: '1',
                MAIL_TRANSPORT: 'json',
                APP_BASE_URL: 'https://school.example.test',
                EMAIL_VERIFICATION_SECRET: verificationSecret,
                MAIL_FROM: 'notifications@example.test',
                OUTBOX_POLL_MS: '50',
                ADMIN_EMAIL: 'admin@example.test',
                ADMIN_PASSWORD: 'a-long-test-admin-password',
                ADMIN_NAME: 'Test Administrator'
            },
            stdio: ['ignore', 'pipe', 'pipe']
        });
        let stdout = '';
        let stderr = '';
        const timeout = setTimeout(() => {
            child.kill('SIGKILL');
            reject(new Error(`Server did not start in time.\nstdout:\n${stdout}\nstderr:\n${stderr}`));
        }, 15000);
        child.stdout.setEncoding('utf8');
        child.stderr.setEncoding('utf8');
        child.stderr.on('data', (chunk) => { stderr += chunk; });
        child.stdout.on('data', (chunk) => {
            stdout += chunk;
            const match = stdout.match(/listening on http:\/\/[^:]+:(\d+)/);
            if (match) {
                clearTimeout(timeout);
                resolve({ child, baseUrl: `http://127.0.0.1:${match[1]}` });
            }
        });
        child.once('exit', (code) => {
            clearTimeout(timeout);
            if (!stdout.includes('listening on')) reject(new Error(`Server exited with code ${code}.\nstdout:\n${stdout}\nstderr:\n${stderr}`));
        });
        child.once('error', (error) => {
            clearTimeout(timeout);
            reject(error);
        });
    });
}

async function stopApplication(child) {
    if (!child || child.exitCode !== null) return;
    let killTimer;
    const exited = new Promise((resolve) => child.once('exit', resolve));
    child.kill('SIGTERM');
    await Promise.race([
        exited,
        new Promise((resolve) => {
            killTimer = setTimeout(() => {
                if (child.exitCode === null) child.kill('SIGKILL');
                resolve();
            }, 5000);
            killTimer.unref();
        })
    ]);
    if (killTimer) clearTimeout(killTimer);
}

async function waitFor(predicate, timeoutMilliseconds) {
    const deadline = Date.now() + timeoutMilliseconds;
    while (Date.now() < deadline) {
        if (await predicate()) return;
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error('Condition was not met before timeout.');
}
