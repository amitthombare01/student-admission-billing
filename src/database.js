'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { Pool, types } = require('pg');

// PostgreSQL DATE values have no timezone. Keeping the wire value as text avoids
// shifting a school date to the previous day in positive UTC offsets.
types.setTypeParser(1082, (value) => value);

function createDatabasePool() {
    const useMemoryDatabase = process.env.NODE_ENV === 'test' && process.env.USE_PG_MEM === '1';
    if (useMemoryDatabase) {
        const { newDb } = require('pg-mem');
        const memoryDatabase = newDb({ autoCreateForeignKeyIndices: true });
        const adapter = memoryDatabase.adapters.createPg();
        return { pool: new adapter.Pool(), isMemoryDatabase: true };
    }

    const pool = new Pool({
        ...buildPostgresPoolConfig(process.env),
        max: parseInteger(process.env.DATABASE_POOL_MAX, 10, 1, 50, 'DATABASE_POOL_MAX'),
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 10000,
        application_name: 'student-admission-billing-system'
    });
    pool.on('error', (error) => console.error('Unexpected PostgreSQL pool error:', error.message));
    return { pool, isMemoryDatabase: false };
}

function buildPostgresPoolConfig(environment) {
    const connectionString = String(environment.DATABASE_URL || '').trim();
    if (!connectionString) {
        throw new Error('DATABASE_URL is required. Use the managed PostgreSQL connection string supplied by your cloud provider.');
    }

    let parsedUrl;
    try {
        parsedUrl = new URL(connectionString);
    } catch (_error) {
        throw new Error('DATABASE_URL must be a valid PostgreSQL URL.');
    }
    if (!['postgres:', 'postgresql:'].includes(parsedUrl.protocol)) {
        throw new Error('DATABASE_URL must use the postgres or postgresql protocol.');
    }

    const urlSslModeValues = parsedUrl.searchParams.getAll('sslmode');
    const urlSslValues = parsedUrl.searchParams.getAll('ssl');
    if (urlSslModeValues.length > 1 || urlSslValues.length > 1) {
        throw new Error('DATABASE_URL contains duplicate SSL parameters. Configure TLS with DATABASE_SSL instead.');
    }

    const urlSslMode = String(urlSslModeValues[0] || '').toLowerCase();
    if (urlSslMode && !['disable', 'require', 'verify-ca', 'verify-full'].includes(urlSslMode)) {
        throw new Error('DATABASE_URL contains an unsafe or ambiguous sslmode. Use DATABASE_SSL=require instead.');
    }
    const urlSslValue = String(urlSslValues[0] || '').toLowerCase();
    if (urlSslValues.length && !['true', '1', 'false', '0'].includes(urlSslValue)) {
        throw new Error('DATABASE_URL contains an unsafe or ambiguous ssl parameter. Use DATABASE_SSL=require instead.');
    }
    const forbiddenSslParameters = ['sslcert', 'sslkey', 'sslrootcert'];
    if (forbiddenSslParameters.some((name) => parsedUrl.searchParams.has(name))) {
        throw new Error('Put the database CA in DATABASE_CA_BASE64 instead of SSL certificate parameters in DATABASE_URL.');
    }

    const configuredSslMode = String(environment.DATABASE_SSL || '').toLowerCase();
    const urlSslModeHint = urlSslMode ? (urlSslMode === 'disable' ? 'disable' : 'require') : '';
    const urlSslValueHint = urlSslValues.length ? (['false', '0'].includes(urlSslValue) ? 'disable' : 'require') : '';
    if (urlSslModeHint && urlSslValueHint && urlSslModeHint !== urlSslValueHint) {
        throw new Error('DATABASE_URL contains conflicting SSL parameters. Configure TLS with DATABASE_SSL instead.');
    }
    const urlSslHint = urlSslModeHint || urlSslValueHint;
    const sslMode = configuredSslMode || (environment.NODE_ENV === 'production' ? 'require' : (urlSslHint || 'disable'));
    if (!['disable', 'require'].includes(sslMode)) {
        throw new Error('DATABASE_SSL must be either disable or require.');
    }
    if (urlSslHint && urlSslHint !== sslMode) {
        throw new Error('DATABASE_URL SSL parameters conflict with DATABASE_SSL. Remove them from the URL.');
    }

    parsedUrl.searchParams.delete('sslmode');
    parsedUrl.searchParams.delete('ssl');
    let ssl = false;
    if (sslMode === 'require') {
        const caBase64 = String(environment.DATABASE_CA_BASE64 || '').trim();
        const ca = caBase64 ? Buffer.from(caBase64, 'base64').toString('utf8') : '';
        if (caBase64 && !/-----BEGIN CERTIFICATE-----[\s\S]+-----END CERTIFICATE-----/.test(ca)) {
            throw new Error('DATABASE_CA_BASE64 must decode to a PEM certificate.');
        }
        ssl = { rejectUnauthorized: true, ...(ca ? { ca } : {}) };
    }

    return { connectionString: parsedUrl.toString(), ssl };
}

async function runMigrations(pool, isMemoryDatabase) {
    const client = await pool.connect();
    try {
        if (!isMemoryDatabase) {
            await client.query('SELECT pg_advisory_lock($1)', [72420260822]);
        }
        await client.query(`
            CREATE TABLE IF NOT EXISTS schema_migrations (
                version INTEGER PRIMARY KEY,
                name TEXT NOT NULL,
                applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
        `);

        const migrationDirectory = path.join(__dirname, '..', 'migrations');
        const migrationFiles = fs.readdirSync(migrationDirectory)
            .filter((fileName) => /^\d+_.+\.sql$/.test(fileName))
            .sort();

        const appliedResult = await client.query('SELECT version FROM schema_migrations');
        const appliedVersions = new Set(appliedResult.rows.map((row) => Number(row.version)));

        for (const fileName of migrationFiles) {
            const version = Number(fileName.split('_')[0]);
            if (appliedVersions.has(version)) {
                continue;
            }
            const sql = fs.readFileSync(path.join(migrationDirectory, fileName), 'utf8');
            await client.query('BEGIN');
            try {
                await client.query(sql);
                await client.query(
                    'INSERT INTO schema_migrations (version, name) VALUES ($1, $2)',
                    [version, fileName]
                );
                await client.query('COMMIT');
                console.log(`Applied database migration ${fileName}`);
            } catch (error) {
                await client.query('ROLLBACK');
                throw error;
            }
        }
    } finally {
        if (!isMemoryDatabase) {
            try {
                await client.query('SELECT pg_advisory_unlock($1)', [72420260822]);
            } catch (_error) {}
        }
        client.release();
    }
}

async function withTransaction(pool, callback) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const result = await callback(client);
        await client.query('COMMIT');
        return result;
    } catch (error) {
        try {
            await client.query('ROLLBACK');
        } catch (_rollbackError) {}
        throw error;
    } finally {
        client.release();
    }
}

function parseInteger(value, fallback, minimum, maximum, name) {
    if (value == null || value === '') {
        return fallback;
    }
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
        throw new Error(`${name} must be an integer between ${minimum} and ${maximum}.`);
    }
    return parsed;
}

module.exports = { buildPostgresPoolConfig, createDatabasePool, parseInteger, runMigrations, withTransaction };
