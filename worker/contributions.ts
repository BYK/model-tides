import { brotliDecompressSync } from 'node:zlib';
import { MAX_CELLS, MAX_REVIEW_CELLS, MAX_WEEKS, parseSnapshot, type WeeklySnapshot } from '../src/weekly-snapshot.ts';
export { parseSnapshot } from '../src/weekly-snapshot.ts';

const storedLimitTrigger = 'MODEL_TIDES_STORED_REPORT_LIMIT';
// D1 permits at most 100 bound parameters per statement, including statements in batch().
const maxD1Parameters = 100;

export interface Statement {
    bind(...values: (string | number)[]): Statement;
    first<T>(): Promise<T | null>;
    all<T>(): Promise<{ results: T[] }>;
    run(): Promise<{ meta: { changes: number } }>;
}

export interface Database {
    prepare(sql: string): Statement;
    batch(statements: Statement[]): Promise<{ meta: { changes: number } }[]>;
}

export interface UploadLimit {
    limit(options: { key: string }): Promise<{ success: boolean }>;
}

const compressedLimit = 64 * 1024;
const expandedLimit = 512 * 1024;
const contributionId = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const tokenPattern = /^Bearer ([A-Za-z0-9_-]{43})$/;

function response(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
    });
}

function uuidv7(): string {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    const time = Date.now();
    for (const index of [0, 1, 2, 3, 4, 5]) bytes[index] = Math.floor(time / 256 ** (5 - index)) & 255;
    bytes[6] = 0x70 | (bytes[6] & 0x0f);
    bytes[8] = 0x80 | (bytes[8] & 0x3f);
    const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function newToken(): string {
    return Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url');
}

async function tokenHash(token: string): Promise<string> {
    return Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))).toString('hex');
}

function uploadHeaders(request: Request): Response | null {
    if (request.headers.get('Content-Type') !== 'application/vnd.model-tides.weekly+json' ||
        request.headers.get('Content-Encoding') !== 'br' ||
        !['weekly-v1', 'weekly-v2'].includes(request.headers.get('X-Model-Tides-Schema') ?? '')) {
        return response({ error: 'Expected a Brotli-compressed weekly snapshot.' }, 415);
    }
    const length = request.headers.get('Content-Length');
    if (length !== null && (!/^[1-9]\d*$/.test(length) || Number(length) > compressedLimit)) {
        return response({ error: 'Upload exceeds the compressed size limit.' }, 413);
    }
    return null;
}

async function readSnapshot(request: Request): Promise<WeeklySnapshot | Response> {
    const length = request.headers.get('Content-Length');
    if (!request.body) return response({ error: 'Empty upload.' }, 400);
    const reader = request.body.getReader();
    const parts: Uint8Array[] = [];
    const size = await (async () => {
        const total = { value: 0 };
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            total.value += value.byteLength;
            if (total.value > compressedLimit) {
                await reader.cancel();
                return -1;
            }
            parts.push(value);
        }
        return total.value;
    })();
    if (size < 0) return response({ error: 'Upload exceeds the compressed size limit.' }, 413);
    if (size === 0 || (length !== null && Number(length) !== size)) return response({ error: 'Invalid upload length.' }, 400);
    try {
        const buffer = Buffer.concat(parts, size);
        const bytes = brotliDecompressSync(buffer, { maxOutputLength: expandedLimit });
        const parsed = parseSnapshot(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
        return request.headers.get('X-Model-Tides-Schema') === `weekly-v${parsed.version}` ? parsed :
            response({ error: 'Snapshot version does not match its schema header.' }, 400);
    } catch {
        return response({ error: 'Invalid compressed weekly snapshot.' }, 400);
    }
}

function rows(snapshot: WeeklySnapshot): { week: string; model: string; count: number }[] {
    return snapshot.weeks.flatMap(({ week, models }) =>
        Object.entries(models).map(([model, count]) => ({ week, model, count })));
}

function insertRows(db: Database, id: string, entries: ReturnType<typeof rows>, hash?: string,
    expectedPublished?: number, expectedAggregate?: number, metricVersion?: number, nonce?: string): Statement[] {
    const statements: Statement[] = [];
    const perRow = hash ? 3 : 4;
    const fixed = hash ? 5 + (metricVersion === undefined ? 0 : 1) + (nonce === undefined ? 0 : 1) : 0;
    const batchSize = Math.floor((maxD1Parameters - fixed) / perRow);
    for (let start = 0; start < entries.length; start += batchSize) {
        const slice = entries.slice(start, start + batchSize);
        const values = slice.flatMap((entry) => [entry.week, entry.model, entry.count]);
        if (hash) {
            if ((expectedPublished !== 0 && expectedPublished !== 1) || (expectedAggregate !== 0 && expectedAggregate !== 1)) {
                throw new TypeError('Expected report state.');
            }
            const sql = `WITH input(week, model, count) AS (VALUES ${slice.map(() => '(?, ?, ?)').join(', ')})
                INSERT INTO weekly_counts (contributor_id, week, model, count)
                SELECT ?, week, model, count FROM input WHERE EXISTS
                (SELECT 1 FROM contributors WHERE id = ? AND token_hash = ? AND published = ? AND in_aggregate = ?
                ${metricVersion === undefined ? '' : 'AND metric_version = ?'} ${nonce === undefined ? '' : 'AND migration_nonce = ?'})`;
            statements.push(db.prepare(sql).bind(...values, id, id, hash, expectedPublished, expectedAggregate,
                ...(metricVersion === undefined ? [] : [metricVersion]), ...(nonce === undefined ? [] : [nonce])));
        } else {
            const sql = `INSERT INTO weekly_counts (contributor_id, week, model, count) VALUES ${slice.map(() => '(?, ?, ?, ?)').join(', ')}`;
            statements.push(db.prepare(sql).bind(...slice.flatMap((entry) => [id, entry.week, entry.model, entry.count])));
        }
    }
    return statements;
}

function bearer(request: Request): string | null {
    return tokenPattern.exec(request.headers.get('Authorization') ?? '')?.[1] ?? null;
}

export async function getAggregate(db: Database): Promise<{
    weeks: { week: string; model: string; count: number; contributors: number }[];
    truncated: boolean;
    metricVersion: 1 | 2;
    uploadedReports: number;
    optedInReports: number;
}> {
    const metric = await db.prepare('SELECT MAX(metric_version) AS version FROM contributors WHERE in_aggregate = 1')
        .first<{ version: number | null }>();
    const metricVersion = metric?.version ?? 2;
    if (metricVersion !== 1 && metricVersion !== 2) throw new TypeError('Unknown aggregate metric.');
    const reportCounts = await db.prepare(`SELECT
        (SELECT COUNT(*) FROM contributors) AS uploadedReports,
        (SELECT COUNT(*) FROM contributors WHERE in_aggregate = 1 AND metric_version = ?) AS optedInReports`)
        .bind(metricVersion).first<{ uploadedReports: number; optedInReports: number }>();
    if (!reportCounts || !Number.isSafeInteger(reportCounts.uploadedReports) ||
        !Number.isSafeInteger(reportCounts.optedInReports)) throw new TypeError('Invalid report totals.');
    const { results } = await db.prepare(`SELECT w.week, w.model, SUM(w.count) AS count, COUNT(*) AS contributors
        FROM weekly_counts w JOIN contributors c ON c.id = w.contributor_id
        WHERE c.in_aggregate = 1 AND c.metric_version = ? GROUP BY w.week, w.model
        ORDER BY w.week, w.model LIMIT 3001`).bind(metricVersion).all<{
        week: string; model: string; count: number; contributors: number;
    }>();
    return { weeks: results.slice(0, 3000), truncated: results.length > 3000, metricVersion,
        uploadedReports: reportCounts.uploadedReports, optedInReports: reportCounts.optedInReports };
}

export async function handleContributions(
    request: Request, db: Database, limit: UploadLimit, path: string,
): Promise<Response> {
    if (path === '/api/aggregate' && request.method === 'GET') {
        return response({ ...await getAggregate(db), note: 'Self-reported counts from opted-in reports; individual IDs do not prove distinct people.' });
    }

    const personalCreatePath = '/api/contributions/personal';
    const activeCreatePath = '/api/contributions/personal-v2';
    const donatedCreatePath = '/api/contributions/donate-v2';
    const privateCreatePath = '/api/contributions/private';
    const match = /^\/api\/contributions\/([^/]+)(\/(?:rotate|share|unshare|contribute|withdraw|migrate-v2|aggregate-status))?$/.exec(path);
    if (path !== '/api/contributions' && path !== personalCreatePath && path !== activeCreatePath &&
        path !== donatedCreatePath && path !== privateCreatePath && !match) return response({ error: 'Not found.' }, 404);
    const id = path === personalCreatePath || path === activeCreatePath || path === donatedCreatePath ||
        path === privateCreatePath ? undefined : match?.[1];
    if (id && !contributionId.test(id)) return response({ error: 'Not found.' }, 404);
    if (id && match?.[2] === '/aggregate-status' && request.method === 'GET') {
        const row = await db.prepare('SELECT in_aggregate FROM contributors WHERE id = ? AND published = 1')
            .bind(id).first<{ in_aggregate: number }>();
        return row ? response({ id, inAggregate: row.in_aggregate === 1 }) : response({ error: 'Not found.' }, 404);
    }
    if (id && !match?.[2] && request.method === 'GET') {
        const authorization = request.headers.get('Authorization');
        const token = bearer(request);
        if (authorization !== null && !token) return response({ error: 'Private token required.' }, 401);
        const access = token ? 'c.token_hash = ?' : 'c.published = 1';
        const { results } = await db.prepare(`SELECT w.week, w.model, w.count, c.published, c.report_revision, c.in_aggregate, c.metric_version
            FROM contributors c JOIN weekly_counts w ON w.contributor_id = c.id
            WHERE c.id = ? AND ${access} ORDER BY w.week, w.model LIMIT ?`)
            .bind(id!, ...(token ? [await tokenHash(token)] : []), MAX_REVIEW_CELLS + 1).all<{
                week: string; model: string; count: number; published: number; report_revision: number; in_aggregate: number; metric_version: number;
            }>();
        if (!results.length) return response({ error: 'Not found.' }, 404);
        const metric = results[0].metric_version === 1 ? {} : { metricVersion: results[0].metric_version };
        if (results.length > MAX_REVIEW_CELLS) return token
            ? response({ id, published: results[0].published === 1, inAggregate: results[0].in_aggregate === 1,
                ...metric,
                revision: results[0].report_revision, tooLarge: true })
            : response({ error: 'Report exceeds the display limit.' }, 413);
        return response({ id, counts: results.map(({ week, model, count }) => ({ week, model, count })),
            ...metric,
            published: results[0].published === 1, ...(token ? {
                inAggregate: results[0].in_aggregate === 1, revision: results[0].report_revision,
            } : {}) });
    }

    const isPersonalCreate = (path === personalCreatePath || path === activeCreatePath) && request.method === 'POST';
    const isDonatedCreate = path === donatedCreatePath && request.method === 'POST';
    const isCreate = (isPersonalCreate || isDonatedCreate || path === privateCreatePath) && request.method === 'POST';
    const isLegacyCreate = path === '/api/contributions' && request.method === 'POST';
    const isReplace = !!id && !match?.[2] && request.method === 'PUT';
    const isMigrate = !!id && match?.[2] === '/migrate-v2' && request.method === 'PUT';
    const isDelete = !!id && !match?.[2] && request.method === 'DELETE';
    const isRotate = !!id && match?.[2] === '/rotate' && request.method === 'POST';
    const isShare = !!id && match?.[2] === '/share' && request.method === 'POST';
    const isUnshare = !!id && match?.[2] === '/unshare' && request.method === 'POST';
    const isContribute = !!id && match?.[2] === '/contribute' && request.method === 'POST';
    const isWithdraw = !!id && match?.[2] === '/withdraw' && request.method === 'POST';
    if (!isCreate && !isLegacyCreate && !isReplace && !isMigrate && !isDelete && !isRotate && !isShare && !isUnshare && !isContribute && !isWithdraw) {
        return response({ error: 'Method not allowed.' }, 405);
    }

    const token = isCreate || isLegacyCreate ? null : bearer(request);
    if (!isCreate && !isLegacyCreate && !token) return response({ error: 'Private token required.' }, 401);
    if (isCreate || isLegacyCreate || isReplace || isMigrate) {
        const invalidHeaders = uploadHeaders(request);
        if (invalidHeaders) return invalidHeaders;
    }
    if (isLegacyCreate || (isCreate && request.headers.get('X-Model-Tides-Report') !==
        (isDonatedCreate ? 'donated-v2' : path === activeCreatePath ? 'personal-v2' : isPersonalCreate ? 'personal-v1' : 'private-v1'))) {
        return response({ error: 'Update Model Tides before uploading a personal report.' }, 426);
    }
    if (path === personalCreatePath && request.method === 'POST' &&
        await db.prepare('SELECT 1 AS active FROM contributors WHERE metric_version = 2 AND in_aggregate = 1 LIMIT 1').first()) {
        return response({ error: 'Rescan local history with the current Model Tides CLI for active session-day counts.' }, 426);
    }
    const expectedVisibility = isReplace || isMigrate ? request.headers.get('X-Model-Tides-Expected-Visibility') : null;
    if ((isReplace || isMigrate) && expectedVisibility !== 'private' && expectedVisibility !== 'public') {
        return response({ error: 'Update Model Tides before replacing a contribution.' }, 426);
    }
    const expectedAggregateHeader = isReplace || isMigrate ? request.headers.get('X-Model-Tides-Expected-Aggregate') : null;
    if ((isReplace || isMigrate) && expectedAggregateHeader !== 'included' && expectedAggregateHeader !== 'excluded') {
        return response({ error: 'Update Model Tides before replacing a report.' }, 426);
    }
    const expectedPublished = expectedVisibility === 'public' ? 1 : 0;
    const expectedAggregate = expectedAggregateHeader === 'included' ? 1 : 0;
    const reviewed = isShare || isContribute || isMigrate ? request.headers.get('X-Model-Tides-Reviewed-Revision') : null;
    if ((isShare || isContribute || isMigrate) && (reviewed === null || !/^(0|[1-9]\d*)$/.test(reviewed) ||
        !Number.isSafeInteger(Number(reviewed)))) {
        return response({ error: 'Update Model Tides and review every weekly count before sharing.' }, 426);
    }
    const rate = await limit.limit({ key: `write:${request.headers.get('CF-Connecting-IP') ?? 'unattributed'}` });
    if (!rate.success) return response({ error: 'Too many uploads. Try again later.' }, 429);
    const hash = token ? await tokenHash(token) : null;
    if (!isCreate) {
        const authenticated = await db.prepare('SELECT id, metric_version, in_aggregate FROM contributors WHERE id = ? AND token_hash = ?')
            .bind(id!, hash!).first<{ id: string; metric_version: number; in_aggregate: number }>();
        if (!authenticated) return response({ error: 'Invalid contribution or token.' }, 401);
        if ((isContribute || (isReplace && authenticated.in_aggregate === 1)) && authenticated.metric_version === 1 &&
            await db.prepare('SELECT 1 AS active FROM contributors WHERE metric_version = 2 AND in_aggregate = 1 LIMIT 1').first()) {
            return response({ error: 'Rescan local history with the current Model Tides CLI for active session-day counts.' }, 426);
        }
        const ownerRate = await limit.limit({ key: `owner:${id}` });
        if (!ownerRate.success) return response({ error: 'Too many uploads. Try again later.' }, 429);
    }
    const now = Date.now();
    if (isDelete) {
        const result = await db.prepare('DELETE FROM contributors WHERE id = ? AND token_hash = ?').bind(id!, hash!).run();
        return result.meta.changes > 0 ? response({ deleted: true }) : response({ error: 'Invalid contribution or token.' }, 401);
    }
    if (isRotate) {
        const replacement = newToken();
        const result = await db.prepare('UPDATE contributors SET token_hash = ?, updated_at = ? WHERE id = ? AND token_hash = ?')
            .bind(await tokenHash(replacement), now, id!, hash!).run();
        return result.meta.changes === 1 ? response({ id, token: replacement }) : response({ error: 'Invalid contribution or token.' }, 401);
    }
    if (isShare || isUnshare) {
        const published = isShare ? 1 : 0;
        const sql = isShare
            ? `UPDATE contributors SET published = ?, updated_at = ?, report_revision = report_revision + 1
                WHERE id = ? AND token_hash = ? AND report_revision = ?
                AND (SELECT COUNT(*) FROM (SELECT 1 FROM weekly_counts WHERE contributor_id = ? LIMIT ?)) BETWEEN 1 AND ?`
            : 'UPDATE contributors SET published = ?, updated_at = ?, report_revision = report_revision + 1 WHERE id = ? AND token_hash = ?';
        const result = await db.prepare(sql).bind(published, now, id!, hash!, ...(isShare
            ? [Number(reviewed), id!, MAX_REVIEW_CELLS + 1, MAX_REVIEW_CELLS] : [])).run();
        if (result.meta.changes !== 1) return response({ error: 'Report changed. Review all counts before sharing.' }, 409);
        return response({ id, published: isShare, ...(isShare ? { url: `${new URL(request.url).origin}/u/${id}` } : {}) });
    }
    if (isContribute || isWithdraw) {
        const sql = isContribute
            ? `UPDATE contributors SET in_aggregate = 1, updated_at = ?, report_revision = report_revision + 1
                WHERE id = ? AND token_hash = ? AND report_revision = ?
                AND (SELECT COUNT(*) FROM (SELECT 1 FROM weekly_counts WHERE contributor_id = ? LIMIT ?)) BETWEEN 1 AND ?`
            : 'UPDATE contributors SET in_aggregate = 0, updated_at = ?, report_revision = report_revision + 1 WHERE id = ? AND token_hash = ?';
        const result = await db.prepare(sql).bind(now, id!, hash!, ...(isContribute
            ? [Number(reviewed), id!, MAX_REVIEW_CELLS + 1, MAX_REVIEW_CELLS] : [])).run();
        return result.meta.changes === 1 ? response({ id, inAggregate: isContribute }) :
            response({ error: 'Report changed. Review all counts before contributing.' }, 409);
    }
    const snapshot = await readSnapshot(request);
    if (snapshot instanceof Response) return snapshot;
    if (isCreate && snapshot.version !== (path === activeCreatePath || isDonatedCreate ? 2 : 1)) {
        return response({ error: 'Snapshot metric does not match this creation path.' }, 400);
    }
    if (isReplace || isMigrate) {
        const current = await db.prepare('SELECT metric_version FROM contributors WHERE id = ? AND token_hash = ?')
            .bind(id!, hash!).first<{ metric_version: number }>();
        if (!current || current.metric_version !== (isMigrate ? 1 : snapshot.version) ||
            (isMigrate && snapshot.version !== 2)) {
            return response({ error: 'Use a matching report metric to replace these counts.' }, 409);
        }
    }
    const entries = rows(snapshot);
    if (isCreate) {
        const createdId = uuidv7();
        const secret = newToken();
        await db.batch([
            db.prepare('INSERT INTO contributors (id, token_hash, created_at, updated_at, published, in_aggregate, metric_version) VALUES (?, ?, ?, ?, ?, ?, ?)')
                .bind(createdId, await tokenHash(secret), now, now, isPersonalCreate || isDonatedCreate ? 1 : 0,
                    isDonatedCreate || !isPersonalCreate ? 1 : 0, snapshot.version),
            ...insertRows(db, createdId, entries),
        ]);
        return response({ id: createdId, published: isPersonalCreate || isDonatedCreate,
            inAggregate: isDonatedCreate || !isPersonalCreate, token: secret,
            metricVersion: snapshot.version,
            ...(isPersonalCreate || isDonatedCreate ? { url: `${new URL(request.url).origin}/u/${createdId}` } : {}) }, 201);
    }
    const weeks = snapshot.weeks.map(({ week }) => week);
    if (isMigrate) {
        const nonce = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString('hex');
        const result = await db.batch([
            db.prepare(`UPDATE contributors SET metric_version = 2, migration_nonce = ?, updated_at = ?, report_revision = report_revision + 1
                WHERE id = ? AND token_hash = ? AND metric_version = 1 AND report_revision = ? AND published = ? AND in_aggregate = ?`)
                .bind(nonce, now, id!, hash!, Number(reviewed), expectedPublished, expectedAggregate),
            db.prepare(`DELETE FROM weekly_counts WHERE contributor_id = ? AND EXISTS
                (SELECT 1 FROM contributors WHERE id = ? AND token_hash = ? AND migration_nonce = ?)`)
                .bind(id!, id!, hash!, nonce),
            ...insertRows(db, id!, entries, hash!, expectedPublished, expectedAggregate, 2, nonce),
            db.prepare('UPDATE contributors SET migration_nonce = NULL WHERE id = ? AND token_hash = ? AND migration_nonce = ?')
                .bind(id!, hash!, nonce),
        ]);
        return result[0].meta.changes === 1 ? response({ id, replacedWeeks: weeks.length,
            metricVersion: 2, published: expectedPublished === 1, inAggregate: expectedAggregate === 1 }) :
            response({ error: 'Report changed. Review all counts before migrating.' }, 409);
    }
    const exceedsStoredLimit = async (): Promise<boolean> => {
        const retained = await db.prepare(`SELECT COUNT(*) AS cells, COUNT(DISTINCT week) AS weeks FROM weekly_counts
            WHERE contributor_id = ? AND week NOT IN (SELECT value FROM json_each(?))`)
            .bind(id!, JSON.stringify(weeks)).first<{ cells: number; weeks: number }>();
        if (!retained) throw new Error('Could not check stored report size.');
        return retained.cells + entries.length > MAX_CELLS || retained.weeks + weeks.length > MAX_WEEKS;
    };
    if (await exceedsStoredLimit()) {
        return response({ error: 'Stored report exceeds the weekly count limit.' }, 413);
    }
    const statements = [
        db.prepare('UPDATE contributors SET updated_at = ?, report_revision = report_revision + 1 WHERE id = ? AND token_hash = ? AND published = ? AND in_aggregate = ?')
            .bind(now, id!, hash!, expectedPublished, expectedAggregate),
        db.prepare(`DELETE FROM weekly_counts WHERE contributor_id = ? AND week IN (SELECT value FROM json_each(?))
            AND EXISTS (SELECT 1 FROM contributors WHERE id = ? AND token_hash = ? AND published = ? AND in_aggregate = ?)`)
            .bind(id!, JSON.stringify(weeks), id!, hash!, expectedPublished, expectedAggregate),
        ...insertRows(db, id!, entries, hash!, expectedPublished, expectedAggregate, snapshot.version),
    ];
    const result = await db.batch(statements).catch(async (error: unknown) => {
        if (error instanceof Error && error.message.includes(storedLimitTrigger) && await exceedsStoredLimit()) return null;
        throw error;
    });
    if (!result) return response({ error: 'Stored report exceeds the weekly count limit.' }, 413);
    if (result[0].meta.changes !== 1) return response({ error: 'Report visibility changed. Review before replacing.' }, 409);
    const current = await db.prepare('SELECT published, in_aggregate FROM contributors WHERE id = ? AND token_hash = ?')
        .bind(id!, hash!).first<{ published: number; in_aggregate: number }>();
    return current ? response({ id, replacedWeeks: weeks.length, metricVersion: snapshot.version, published: current.published === 1,
        inAggregate: current.in_aggregate === 1 }) :
        response({ error: 'Invalid contribution or token.' }, 401);
}
