import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { brotliCompressSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { handleContributions as handleRealContributions, parseSnapshot } from '../worker/contributions.ts';
import { getReport } from '../worker/public-pages.ts';
import worker from '../worker/index.ts';
import { buildWeeklySnapshot, parseOwnedReport, parsePublicReport } from '../src/weekly-snapshot.ts';

function database(migrated = true) {
    const sqlite = new DatabaseSync(':memory:');
    sqlite.exec('PRAGMA foreign_keys = ON');
    sqlite.exec(readFileSync(new URL('../migrations/0001_contributions.sql', import.meta.url), 'utf8'));
    const migrate = () => {
        sqlite.exec(readFileSync(new URL('../migrations/0002_private_contributions.sql', import.meta.url), 'utf8'));
        sqlite.exec(readFileSync(new URL('../migrations/0003_counts_revision.sql', import.meta.url), 'utf8'));
        sqlite.exec(readFileSync(new URL('../migrations/0004_personal_reports.sql', import.meta.url), 'utf8'));
        sqlite.exec(readFileSync(new URL('../migrations/0005_active_session_days.sql', import.meta.url), 'utf8'));
    };
    if (migrated) migrate();
    const prepare = (sql) => {
        const statement = {
            values: [],
            bind(...values) {
                if (values.length > 100) throw new RangeError('D1 allows at most 100 bound parameters per query.');
                this.values = values;
                return this;
            },
            first() { return Promise.resolve(sqlite.prepare(sql).get(...this.values) ?? null); },
            all() { return Promise.resolve({ results: sqlite.prepare(sql).all(...this.values) }); },
            run() {
                // D1 includes rows removed by ON DELETE CASCADE in meta.changes.
                const cascaded = sql.startsWith('DELETE FROM contributors')
                    ? sqlite.prepare('SELECT count(*) AS count FROM weekly_counts WHERE contributor_id = ?').get(this.values[0]).count
                    : 0;
                const changes = Number(sqlite.prepare(sql).run(...this.values).changes);
                return Promise.resolve({ meta: { changes: changes + (changes ? cascaded : 0) } });
            },
        };
        return statement;
    };
    return {
        prepare,
        async batch(statements) {
            sqlite.exec('BEGIN');
            try {
                const result = [];
                for (const statement of statements) result.push(await statement.run());
                sqlite.exec('COMMIT');
                return result;
            } catch (error) {
                sqlite.exec('ROLLBACK');
                throw error;
            }
        },
        close() { sqlite.close(); },
        migrate,
    };
}

const day = Date.UTC(2026, 8, 28);
const snapshot = (count = 2) => ({
    format: 'model-tides-weekly', version: 1,
    weeks: [{ week: '2026-09-28', models: { 'anthropic/claude-sonnet': count } }],
});
const limit = { async limit() { return { success: true }; } };
const handleContributions = handleRealContributions;

function upload(data, pathname = '/api/contributions/private', method = 'POST', token, visibility = 'private', aggregate = 'included') {
    const bytes = brotliCompressSync(Buffer.from(JSON.stringify(data)));
    return new Request(`https://modeltides.dev${pathname}`, {
        method, body: bytes,
        headers: {
            'Content-Type': 'application/vnd.model-tides.weekly+json',
            'Content-Encoding': 'br',
            'X-Model-Tides-Schema': `weekly-v${data.version}`,
            'X-Model-Tides-Report': pathname === '/api/contributions/personal-v2' ? 'personal-v2' :
                pathname === '/api/contributions/personal' ? 'personal-v1' : 'private-v1',
            ...(method === 'PUT' ? { 'X-Model-Tides-Expected-Visibility': visibility,
                'X-Model-Tides-Expected-Aggregate': aggregate } : {}),
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
    });
}

test('weekly snapshot copies only week, model, and event count', () => {
    const input = [
        { time: day, model: 'anthropic/claude-sonnet', kind: 'session', sessionId: 'private-one', text: 'private prompt' },
        { time: day + 86_400_000, model: 'anthropic/claude-sonnet', kind: 'switch', fromModel: 'openai/gpt-5', fromTime: day, sessionId: 'private-two' },
    ];
    assert.deepEqual(buildWeeklySnapshot(input), snapshot());
    const wire = JSON.stringify(buildWeeklySnapshot(input));
    for (const privateValue of ['sessionId', 'private-one', 'private-two', 'text', 'private prompt', 'fromModel', 'fromTime']) {
        assert.equal(wire.includes(privateValue), false);
    }
});

test('new private creation uses a path the old Worker cannot treat as a public contribution', async () => {
    const db = database();
    try {
        const path = '/api/contributions/private';
        const env = { DB: db, UPLOAD_LIMIT: limit, ASSETS: { async fetch() { return new Response('<html><head></head><body><div id="app"></div></body></html>'); } } };
        const created = await worker.fetch(upload(snapshot(), path), env);
        assert.equal(created.status, 201);
        const { id, token, published } = await created.json();
        assert.equal(published, false);
        assert.equal((await db.prepare('SELECT published FROM contributors WHERE id = ?').bind(id).first()).published, 0);
        assert.equal((await worker.fetch(new Request(`https://modeltides.dev/u/${id}`), env)).status, 404);
        assert.equal((await worker.fetch(new Request(`https://modeltides.dev/api/contributions/${id}`, {
            headers: { Authorization: `Bearer ${token}` },
        }), env)).status, 200);
        const oldPath = await worker.fetch(upload(snapshot(), '/api/contributions'), env);
        assert.equal(oldPath.status, 426, 'old clients must not create contributions at the unversioned path');
        assert.equal((await db.prepare('SELECT count(*) AS count FROM contributors').first()).count, 1);
    } finally { db.close(); }
});

test('personal upload has a working link but never enters aggregate until separate consent', async () => {
    const db = database();
    try {
        const path = '/api/contributions/personal';
        const created = await handleContributions(upload(snapshot(), path), db, limit, path);
        assert.equal(created.status, 201);
        const { id, token, url } = await created.json();
        assert.equal(url, `https://modeltides.dev/u/${id}`);
        assert.equal((await db.prepare('SELECT count(*) AS count FROM weekly_counts WHERE contributor_id = ?').bind(id).first()).count, 1);
        assert.equal((await db.prepare('SELECT in_aggregate FROM contributors WHERE id = ?').bind(id).first()).in_aggregate, 0);
        assert.equal((await getReport(db, id)).total, 2);
        const env = { DB: db, UPLOAD_LIMIT: limit, ASSETS: { async fetch() {
            return new Response('<html><head><title>Model Tides</title></head><body><div id="app"></div><script type="module" src="/assets/index-hashed.js"></script></body></html>');
        } } };
        const page = await worker.fetch(new Request(`https://modeltides.dev/u/${id}`), env);
        assert.equal(page.status, 200);
        assert.match(await page.text(), /<script type="module" src="\/assets\/index-hashed\.js"><\/script>/);
        assert.equal((await worker.fetch(new Request(`https://modeltides.dev/u/${id}`, { method: 'HEAD' }), env)).status, 200);
        const aggregate = await handleContributions(new Request('https://modeltides.dev/api/aggregate'), db, limit, '/api/aggregate');
        const emptyAggregate = await aggregate.json();
        assert.deepEqual(emptyAggregate.weeks, []);
        assert.equal(emptyAggregate.uploadedReports, 1, 'personal uploads count even before opt-in');
        assert.equal(emptyAggregate.optedInReports, 0);
        const owner = await handleContributions(new Request(`https://modeltides.dev/api/contributions/${id}`, {
            headers: { Authorization: `Bearer ${token}` },
        }), db, limit, `/api/contributions/${id}`);
        assert.equal((await owner.json()).inAggregate, false);
        const contributePath = `/api/contributions/${id}/contribute`;
        const contribute = await handleContributions(new Request(`https://modeltides.dev${contributePath}`, {
            method: 'POST', headers: { Authorization: `Bearer ${token}`, 'X-Model-Tides-Reviewed-Revision': '0' },
        }), db, limit, contributePath);
        assert.equal(contribute.status, 200);
        assert.equal((await db.prepare('SELECT in_aggregate FROM contributors WHERE id = ?').bind(id).first()).in_aggregate, 1);
        const visible = await handleContributions(new Request('https://modeltides.dev/api/aggregate'), db, limit, '/api/aggregate');
        const visibleAggregate = await visible.json();
        assert.deepEqual(visibleAggregate.weeks, [
            { week: '2026-09-28', model: 'anthropic/claude-sonnet', count: 2, contributors: 1 },
        ], 'one opted-in contributor is visible without a five-ID threshold');
        assert.equal(visibleAggregate.uploadedReports, 1);
        assert.equal(visibleAggregate.optedInReports, 1);
        const withdrawPath = `/api/contributions/${id}/withdraw`;
        const withdraw = await handleContributions(new Request(`https://modeltides.dev${withdrawPath}`, {
            method: 'POST', headers: { Authorization: `Bearer ${token}` },
        }), db, limit, withdrawPath);
        assert.equal(withdraw.status, 200);
        assert.equal((await db.prepare('SELECT in_aggregate FROM contributors WHERE id = ?').bind(id).first()).in_aggregate, 0);
        assert.equal((await getReport(db, id)).total, 2, 'withdrawal retains the personal link and data');
        const afterWithdrawal = await (await handleContributions(new Request('https://modeltides.dev/api/aggregate'),
            db, limit, '/api/aggregate')).json();
        assert.equal(afterWithdrawal.uploadedReports, 1);
        assert.equal(afterWithdrawal.optedInReports, 0);
        const delayed = await handleContributions(new Request(`https://modeltides.dev${contributePath}`, {
            method: 'POST', headers: { Authorization: `Bearer ${token}`, 'X-Model-Tides-Reviewed-Revision': '0' },
        }), db, limit, contributePath);
        assert.equal(delayed.status, 409);
    } finally { db.close(); }
});

test('legacy counts remain readable, but active-day totals never mix with them; owner migrates atomically', async () => {
    const db = database();
    try {
        const legacy = await (await handleContributions(upload(snapshot(), '/api/contributions/personal'),
            db, limit, '/api/contributions/personal')).json();
        const legacyPath = `/api/contributions/${legacy.id}`;
        const contribute = async (id, token, revision) => handleContributions(new Request(`https://modeltides.dev/api/contributions/${id}/contribute`, {
            method: 'POST', headers: { Authorization: `Bearer ${token}`, 'X-Model-Tides-Reviewed-Revision': String(revision) },
        }), db, limit, `/api/contributions/${id}/contribute`);
        assert.equal((await contribute(legacy.id, legacy.token, 0)).status, 200);
        const aggregate = async () => (await (await handleContributions(new Request('https://modeltides.dev/api/aggregate'),
            db, limit, '/api/aggregate')).json());
        assert.equal((await aggregate()).metricVersion, 1);
        assert.equal((await aggregate()).weeks[0].count, 2);
        const legacyOwner = await (await handleContributions(new Request(`https://modeltides.dev${legacyPath}`, {
            headers: { Authorization: `Bearer ${legacy.token}` },
        }), db, limit, legacyPath)).json();
        assert.equal('metricVersion' in legacyOwner, false, 'existing owner clients can still parse a legacy report');

        const active = { ...snapshot(3), version: 2 };
        const v2Path = '/api/contributions/personal-v2';
        const created = await handleContributions(upload(active, v2Path), db, limit, v2Path);
        assert.equal(created.status, 201);
        const newOwner = await created.json();
        assert.equal(newOwner.metricVersion, 2);
        assert.equal((await contribute(newOwner.id, newOwner.token, 0)).status, 200);
        assert.deepEqual((await aggregate()).weeks.map(({ count }) => count), [3], 'old and new metrics never add together');
        assert.equal((await aggregate()).metricVersion, 2);
        assert.equal((await getReport(db, newOwner.id)).metricVersion, 2);
        assert.equal((await getReport(db, legacy.id)).total, 2, 'legacy public report remains intact');
        const newLegacy = await handleContributions(upload(snapshot(), '/api/contributions/personal'),
            db, limit, '/api/contributions/personal');
        assert.equal(newLegacy.status, 426, 'old clients cannot create invisible legacy uploads after the new metric is active');
        assert.equal((await contribute(legacy.id, legacy.token, 1)).status, 426,
            'legacy opt-in cannot silently enter an invisible metric');

        const migrationPath = `${legacyPath}/migrate-v2`;
        const replacement = { ...snapshot(4), version: 2 };
        const migrate = (revision) => {
            const request = upload(replacement, migrationPath, 'PUT', legacy.token, 'public', 'included');
            request.headers.set('X-Model-Tides-Reviewed-Revision', String(revision));
            return handleContributions(request, db, limit, migrationPath);
        };
        assert.equal((await migrate(0)).status, 409, 'a stale review cannot migrate a report');
        assert.equal((await migrate(1)).status, 200);
        const owned = await (await handleContributions(new Request(`https://modeltides.dev${legacyPath}`, {
            headers: { Authorization: `Bearer ${legacy.token}` },
        }), db, limit, legacyPath)).json();
        assert.equal(parseOwnedReport(owned, legacy.id).metricVersion, 2);
        assert.deepEqual(owned.counts, [{ week: '2026-09-28', model: 'anthropic/claude-sonnet', count: 4 }]);
        assert.equal((await aggregate()).weeks[0].count, 7);
        assert.equal((await migrate(1)).status, 409, 'a second migration cannot reuse the old review');
    } finally { db.close(); }
});

test('gist donation creates an opted-in v2 report with a separate owner key; public links cannot opt in someone else', async () => {
    const db = database();
    try {
        const active = { ...snapshot(3), version: 2 };
        const privatePath = '/api/contributions/personal-v2';
        const original = await (await handleContributions(upload(active, privatePath), db, limit, privatePath)).json();
        const originalPath = `/api/contributions/${original.id}`;
        const publicReport = () => handleContributions(new Request(`https://modeltides.dev${originalPath}`), db, limit, originalPath);
        const statusPath = `${originalPath}/aggregate-status`;
        const publicStatus = () => handleContributions(new Request(`https://modeltides.dev${statusPath}`), db, limit, statusPath);
        const before = await (await publicReport()).json();
        assert.equal('inAggregate' in before, false, 'older cached report pages still accept the public response');
        assert.equal('revision' in before, false, 'the public report does not expose owner revision');
        assert.deepEqual(await (await publicStatus()).json(), { id: original.id, inAggregate: false });
        const donatePath = '/api/contributions/donate-v2';
        const request = upload(active, donatePath);
        request.headers.set('X-Model-Tides-Report', 'donated-v2');
        const donated = await handleContributions(request, db, limit, donatePath);
        assert.equal(donated.status, 201);
        const result = await donated.json();
        assert.equal(result.published, true);
        assert.equal(result.inAggregate, true);
        assert.equal(result.metricVersion, 2);
        assert.equal(result.token.length, 43);
        const aggregate = () => handleContributions(new Request('https://modeltides.dev/api/aggregate'), db, limit, '/api/aggregate');
        assert.deepEqual((await (await aggregate()).json()).weeks.map(({ count, contributors }) => ({ count, contributors })),
            [{ count: 3, contributors: 1 }]);

        const noOwnerPath = `/api/contributions/${original.id}/contribute`;
        const stranger = await handleContributions(new Request(`https://modeltides.dev${noOwnerPath}`, {
            method: 'POST', headers: { 'X-Model-Tides-Reviewed-Revision': '0' },
        }), db, limit, noOwnerPath);
        assert.equal(stranger.status, 401);
        assert.equal((await (await aggregate()).json()).weeks[0].count, 3);
        assert.equal((await handleContributions(upload(active, '/api/contributions/donate-v2'), db, limit, donatePath)).status,
            426, 'a donation requires its versioned opt-in contract');

        const owner = await handleContributions(new Request(`https://modeltides.dev${noOwnerPath}`, {
            method: 'POST', headers: { Authorization: `Bearer ${original.token}`, 'X-Model-Tides-Reviewed-Revision': '0' },
        }), db, limit, noOwnerPath);
        assert.equal(owner.status, 200);
        assert.equal((await (await aggregate()).json()).weeks[0].count, 6);
        assert.deepEqual(await (await publicStatus()).json(), { id: original.id, inAggregate: true },
            'a refreshed shared report can hide the donation form');
        const hiddenPath = `${originalPath}/unshare`;
        assert.equal((await handleContributions(new Request(`https://modeltides.dev${hiddenPath}`, {
            method: 'POST', headers: { Authorization: `Bearer ${original.token}` },
        }), db, limit, hiddenPath)).status, 200);
        assert.equal((await publicStatus()).status, 404, 'hidden reports never reveal aggregate membership');
    } finally { db.close(); }
});

test('a visibility change between migration review and its transaction preserves every legacy row', async () => {
    const db = database();
    try {
        const original = await (await handleContributions(upload(snapshot(), '/api/contributions/personal'),
            db, limit, '/api/contributions/personal')).json();
        const oldBatch = db.batch.bind(db);
        db.batch = async (statements) => {
            await db.prepare('UPDATE contributors SET published = 0, report_revision = report_revision + 1 WHERE id = ?')
                .bind(original.id).run();
            return oldBatch(statements);
        };
        const path = `/api/contributions/${original.id}/migrate-v2`;
        const request = upload({ ...snapshot(9), version: 2 }, path, 'PUT', original.token, 'public', 'excluded');
        request.headers.set('X-Model-Tides-Reviewed-Revision', '0');
        assert.equal((await handleContributions(request, db, limit, path)).status, 409);
        assert.deepEqual({ ...await db.prepare('SELECT metric_version, published, report_revision, migration_nonce FROM contributors WHERE id = ?')
            .bind(original.id).first() }, { metric_version: 1, published: 0, report_revision: 1, migration_nonce: null });
        const { results } = await db.prepare('SELECT week, model, count FROM weekly_counts WHERE contributor_id = ?')
            .bind(original.id).all();
        assert.deepEqual(results.map((row) => ({ ...row })),
            [{ week: '2026-09-28', model: 'anthropic/claude-sonnet', count: 2 }]);
    } finally { db.close(); }
});

test('replacement cannot silently enter the aggregate after participation changes since preview', async () => {
    const db = database();
    try {
        const path = '/api/contributions/personal';
        const { id, token } = await (await handleContributions(upload(snapshot(), path), db, limit, path)).json();
        const contribute = `/api/contributions/${id}/contribute`;
        assert.equal((await handleContributions(new Request(`https://modeltides.dev${contribute}`, {
            method: 'POST', headers: { Authorization: `Bearer ${token}`, 'X-Model-Tides-Reviewed-Revision': '0' },
        }), db, limit, contribute)).status, 200);
        const replace = `/api/contributions/${id}`;
        const stale = upload(snapshot(9), replace, 'PUT', token, 'public');
        stale.headers.set('X-Model-Tides-Expected-Aggregate', 'excluded');
        const result = await handleContributions(stale, db, limit, replace);
        assert.equal(result.status, 409);
        assert.equal((await getReport(db, id)).total, 2);
    } finally { db.close(); }
});

test('D1 accepts a 222-cell private upload and replacement without exceeding its parameter limit', async () => {
    const db = database();
    try {
        const large = { format: 'model-tides-weekly', version: 1,
            weeks: Array.from({ length: 38 }, (_, index) => ({
                week: new Date(Date.UTC(2026, 0, 5 + index * 7)).toISOString().slice(0, 10),
                models: Object.fromEntries(Array.from({ length: index < 32 ? 6 : 5 }, (_, model) =>
                    [`synthetic/model-${model}`, 1])),
            })) };
        const created = await handleContributions(upload(large), db, limit, '/api/contributions/private');
        assert.equal(created.status, 201);
        const { id, token } = await created.json();
        const path = `/api/contributions/${id}`;
        assert.equal((await db.prepare('SELECT count(*) AS count FROM weekly_counts WHERE contributor_id = ?')
            .bind(id).first()).count, 222);
        const replaced = await handleContributions(upload(large, path, 'PUT', token), db, limit, path);
        assert.equal(replaced.status, 200);
        assert.equal((await db.prepare('SELECT count(*) AS count FROM weekly_counts WHERE contributor_id = ?')
            .bind(id).first()).count, 222);
    } finally { db.close(); }
});

test('local preview rejects dates the upload endpoint cannot accept', () => {
    assert.throws(() => buildWeeklySnapshot([
        { time: Date.UTC(2100, 0, 1), model: 'openai/gpt-5' },
    ]), RangeError);
    const emoji = { ...snapshot(), weeks: [{ week: '2026-09-28', models: { 'custom/🦄': 1 } }] };
    assert.deepEqual(parseSnapshot(emoji), emoji);
    assert.throws(() => buildWeeklySnapshot([{ time: day, model: 'custom/\ud800' }]), TypeError);
});

test('reject unsupported schemas, extra fields, bad weeks, excessive counts, and private fields', () => {
    const valid = snapshot();
    assert.deepEqual(parseSnapshot(valid), valid);
    for (const invalid of [
        { ...valid, sessionId: 'private' },
        { ...valid, version: 3 },
        { ...valid, weeks: [{ week: '2026-09-27', models: { ok: 1 } }] },
        { ...valid, weeks: [{ week: '2026-09-28', models: { ok: 10_001 } }] },
        { ...valid, weeks: [{ week: '2026-09-28', models: { ok: 1 }, transcript: 'private' }] },
        { ...valid, weeks: [...valid.weeks, ...valid.weeks] },
    ]) assert.throws(() => parseSnapshot(invalid), TypeError);
});

test('owner review rejects malformed counts, duplicate cells, and untrusted revisions', () => {
    const id = '0199abcf-22aa-7333-8abc-0123456789ab';
    const report = { id, published: false, revision: 0,
        counts: [{ week: '2026-09-28', model: 'openai/gpt-5', count: 1 }] };
    assert.deepEqual(parseOwnedReport(report, id).snapshot.weeks, [
        { week: '2026-09-28', models: { 'openai/gpt-5': 1 } },
    ]);
    for (const invalid of [
        { ...report, revision: -1 }, { ...report, revision: '0' },
        { ...report, counts: [...report.counts, ...report.counts] },
        { ...report, counts: [{ ...report.counts[0], text: 'private prompt' }] },
        { ...report, counts: [] }, { ...report, counts: [{ ...report.counts[0], week: '2026-09-27' }] },
        { ...report, events: [{ text: 'private prompt' }] },
    ]) assert.throws(() => parseOwnedReport(invalid, id), TypeError);
});

test('public report parsing rejects hidden, extra-field, and malformed response data', () => {
    const id = '0199abcf-22aa-7333-8abc-0123456789ab';
    const valid = { id, published: true, counts: [{ week: '2026-09-28', model: 'openai/gpt-5', count: 2 }] };
    assert.deepEqual(parsePublicReport(valid, id).weeks, [{ week: '2026-09-28', models: { 'openai/gpt-5': 2 } }]);
    for (const invalid of [{ ...valid, published: false }, { ...valid, token: 'private' },
        { ...valid, inAggregate: false },
        { ...valid, counts: [{ ...valid.counts[0], model: '<script>', prompt: 'private' }] }]) {
        assert.throws(() => parsePublicReport(invalid, id), TypeError);
    }
});

test('reviewed historical and route-specific model IDs can be shared without a registry request', async () => {
    const db = database();
    try {
        const historical = { ...snapshot(), weeks: [{ week: '2026-09-28', models: {
            'anthropic/claude-3-5-haiku-latest': 1, 'github-copilot/claude-opus-4.5': 2,
            'openrouter/inclusionai/ling-3.0-flash-vl:free': 3, 'xai/grok-4-fast': 4,
        } }] };
        const created = await handleContributions(upload(historical), db, limit, '/api/contributions/private');
        assert.equal(created.status, 201);
        const { id, token } = await created.json();
        const path = `/api/contributions/${id}`;
        const replace = await handleContributions(upload(historical, path, 'PUT', token),
            db, limit, `/api/contributions/${id}`);
        assert.equal(replace.status, 200);
        const after = await handleContributions(new Request(`https://modeltides.dev${path}`, {
            headers: { Authorization: `Bearer ${token}` },
        }), db, limit, path);
        assert.deepEqual((await after.json()).counts, Object.entries(historical.weeks[0].models).sort(([a], [b]) => a.localeCompare(b))
            .map(([model, count]) => ({ week: '2026-09-28', model, count })));
        assert.equal((await handleContributions(new Request('https://modeltides.dev/api/models'), db, limit, '/api/models')).status, 404);
    } finally { db.close(); }
});

test('Brotli upload saves a private contribution; replacing weeks does not add duplicate counts', async () => {
    const db = database();
    try {
        const created = await handleContributions(upload(snapshot()), db, limit, '/api/contributions/private');
        assert.equal(created.status, 201);
        const { id, url, token } = await created.json();
        assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-7/);
        assert.equal(url, undefined);
        assert.equal(token.length, 43);

        const personal = await handleContributions(new Request(`https://modeltides.dev/api/contributions/${id}`, {
            headers: { Authorization: `Bearer ${token}` },
        }), db, limit, `/api/contributions/${id}`);
        assert.deepEqual((await personal.json()).counts, [{ week: '2026-09-28', model: 'anthropic/claude-sonnet', count: 2 }]);

        const replaced = await handleContributions(upload(snapshot(3), `/api/contributions/${id}`, 'PUT', token), db, limit, `/api/contributions/${id}`);
        assert.equal(replaced.status, 200);
        const retry = await handleContributions(upload(snapshot(3), `/api/contributions/${id}`, 'PUT', token), db, limit, `/api/contributions/${id}`);
        assert.equal(retry.status, 200);
        const after = await handleContributions(new Request(`https://modeltides.dev/api/contributions/${id}`, {
            headers: { Authorization: `Bearer ${token}` },
        }), db, limit, `/api/contributions/${id}`);
        assert.equal((await after.json()).counts[0].count, 3);

        const badToken = 'A'.repeat(43);
        const denied = await handleContributions(upload(snapshot(9), `/api/contributions/${id}`, 'PUT', badToken), db, limit, `/api/contributions/${id}`);
        assert.equal(denied.status, 401);
        const still = await handleContributions(new Request(`https://modeltides.dev/api/contributions/${id}`, {
            headers: { Authorization: `Bearer ${token}` },
        }), db, limit, `/api/contributions/${id}`);
        assert.equal((await still.json()).counts[0].count, 3);

        const rotatePath = `/api/contributions/${id}/rotate`;
        const rotated = await handleContributions(new Request(`https://modeltides.dev${rotatePath}`, {
            method: 'POST', headers: { Authorization: `Bearer ${token}` },
        }), db, limit, rotatePath);
        const newToken = (await rotated.json()).token;
        assert.equal(rotated.status, 200);
        assert.notEqual(newToken, token);
        const deletedWithOld = await handleContributions(new Request(`https://modeltides.dev/api/contributions/${id}`, {
            method: 'DELETE', headers: { Authorization: `Bearer ${token}` },
        }), db, limit, `/api/contributions/${id}`);
        assert.equal(deletedWithOld.status, 401);
        const deleted = await handleContributions(new Request(`https://modeltides.dev/api/contributions/${id}`, {
            method: 'DELETE', headers: { Authorization: `Bearer ${newToken}` },
        }), db, limit, `/api/contributions/${id}`);
        assert.equal(deleted.status, 200);
        const missing = await handleContributions(new Request(`https://modeltides.dev/api/contributions/${id}`), db, limit, `/api/contributions/${id}`);
        assert.equal(missing.status, 404);
    } finally { db.close(); }
});

test('new uploads count toward the aggregate without exposing a personal report until the owner shares', async () => {
    const db = database();
    try {
        const created = await handleContributions(upload(snapshot()), db, limit, '/api/contributions/private');
        assert.equal(created.status, 201);
        const { id, token, published, url } = await created.json();
        assert.equal(published, false);
        assert.equal(url, undefined);
        const path = `/api/contributions/${id}`;
        const env = { DB: db, UPLOAD_LIMIT: limit, ASSETS: { async fetch() { return new Response('<html><head></head><body><div id="app"></div></body></html>'); } } };
        const read = (pathname, auth, method = 'GET') => worker.fetch(new Request(`https://modeltides.dev${pathname}`, {
            method, headers: auth ? { Authorization: `Bearer ${auth}` } : {},
        }), env);
        assert.equal((await read(path)).status, 404);
        assert.equal((await read(`/u/${id}`)).status, 404);
        assert.equal((await read(`/og/${id}.png`, null)).status, 404);
        assert.deepEqual((await (await read(path, token)).json()).counts,
            [{ week: '2026-09-28', model: 'anthropic/claude-sonnet', count: 2 }]);
        assert.equal((await read(path, 'A'.repeat(43))).status, 404);
        assert.equal(await getReport(db, id), null);

        const sharePath = `${path}/share`;
        assert.equal((await worker.fetch(new Request(`https://modeltides.dev${sharePath}`, { method: 'POST' }), env)).status, 401);
        assert.equal((await worker.fetch(new Request(`https://modeltides.dev${sharePath}`, {
            method: 'POST', headers: { Authorization: `Bearer ${'A'.repeat(43)}`, 'X-Model-Tides-Reviewed-Revision': '0' },
        }), env)).status, 401);
        const share = () => worker.fetch(new Request(`https://modeltides.dev${sharePath}`, {
            method: 'POST', headers: { Authorization: `Bearer ${token}`, 'X-Model-Tides-Reviewed-Revision': '0' },
        }), env);
        assert.deepEqual(await (await share()).json(), { id, published: true, url: `https://modeltides.dev/u/${id}` });
        assert.equal((await share()).status, 409, 'a previous review cannot be reused after publication');
        const sharedRevision = (await (await read(path, token)).json()).revision;
        assert.equal(sharedRevision, 1);
        assert.equal((await handleContributions(new Request(`https://modeltides.dev${sharePath}`, {
            method: 'POST', headers: { Authorization: `Bearer ${token}`,
                'X-Model-Tides-Reviewed-Revision': String(sharedRevision) },
        }), db, limit, sharePath)).status, 200, 'a fresh review can share again without changing counts');
        assert.equal((await read(path)).status, 200);
        assert.equal((await read(path, 'A'.repeat(43))).status, 404, 'a public report never validates an invalid private key');
        assert.equal((await read(`/u/${id}`)).status, 200);
        assert.equal((await read(`/og/${id}.png`, null, 'HEAD')).status, 200);
        const replacedWhileShared = await handleContributions(upload(snapshot(3), path, 'PUT', token, 'public'), db, limit, path);
        assert.equal((await replacedWhileShared.json()).published, true);
        assert.equal((await getReport(db, id)).total, 3);

        const hidePath = `${path}/unshare`;
        const hide = () => worker.fetch(new Request(`https://modeltides.dev${hidePath}`, {
            method: 'POST', headers: { Authorization: `Bearer ${token}` },
        }), env);
        assert.deepEqual(await (await hide()).json(), { id, published: false });
        assert.equal((await hide()).status, 200, 'hiding is idempotent');
        assert.equal((await read(path)).status, 404);
        assert.equal((await read(`/u/${id}`)).status, 404);
        assert.equal((await read(`/og/${id}.png`)).status, 404);
        assert.equal((await read(path, token)).status, 200);
        const replacedWhilePrivate = await handleContributions(upload(snapshot(4), path, 'PUT', token), db, limit, path);
        assert.equal((await replacedWhilePrivate.json()).published, false);
        assert.equal((await read(path)).status, 404);
        assert.equal(await getReport(db, id), null);
    } finally { db.close(); }
});

test('sharing requires a review of all retained weeks and refuses a stale revision', async () => {
    const db = database();
    try {
        const created = await handleContributions(upload(snapshot()), db, limit, '/api/contributions/private');
        const { id, token } = await created.json();
        const path = `/api/contributions/${id}`;
        const read = async () => (await handleContributions(new Request(`https://modeltides.dev${path}`, {
            headers: { Authorization: `Bearer ${token}` },
        }), db, limit, path)).json();
        const first = await read();
        assert.equal(first.revision, 0);
        const older = { ...snapshot(), weeks: [{ week: '2026-09-21', models: { 'openai/gpt-5': 4 } }] };
        const replaced = await handleContributions(upload(older, path, 'PUT', token), db, limit, path);
        assert.equal(replaced.status, 200);
        const reviewed = await read();
        assert.equal(reviewed.revision, 1);
        assert.deepEqual(reviewed.counts, [
            { week: '2026-09-21', model: 'openai/gpt-5', count: 4 },
            { week: '2026-09-28', model: 'anthropic/claude-sonnet', count: 2 },
        ], 'the owner sees retained weeks as well as newly replaced weeks');
        const sharePath = `${path}/share`;
        const share = (revision) => handleContributions(new Request(`https://modeltides.dev${sharePath}`, {
            method: 'POST', headers: { Authorization: `Bearer ${token}`,
                ...(revision === null ? {} : { 'X-Model-Tides-Reviewed-Revision': String(revision) }) },
        }), db, limit, sharePath);
        assert.equal((await share(null)).status, 426, 'old clients cannot publish without a review');
        assert.equal((await share(first.revision)).status, 409, 'stale review cannot publish retained or new counts');
        assert.equal(await getReport(db, id), null);
        assert.equal((await share(reviewed.revision)).status, 200);
        assert.equal((await getReport(db, id)).total, 6);
    } finally { db.close(); }
});

test('a delayed reviewed share cannot republish a report after an idempotent hide', async () => {
    const db = database();
    try {
        const { id, token } = await (await handleContributions(upload(snapshot()), db, limit,
            '/api/contributions/private')).json();
        const path = `/api/contributions/${id}`;
        const post = (suffix, revision) => handleContributions(new Request(`https://modeltides.dev${path}/${suffix}`, {
            method: 'POST', headers: { Authorization: `Bearer ${token}`,
                ...(revision === undefined ? {} : { 'X-Model-Tides-Reviewed-Revision': String(revision) }) },
        }), db, limit, `${path}/${suffix}`);
        const reviewed = await (await handleContributions(new Request(`https://modeltides.dev${path}`, {
            headers: { Authorization: `Bearer ${token}` },
        }), db, limit, path)).json();
        assert.equal((await post('unshare')).status, 200, 'even hiding an already hidden report advances visibility');
        assert.equal((await post('share', reviewed.revision)).status, 409);
        assert.equal(await getReport(db, id), null);
    } finally { db.close(); }
});

test('accumulated cells cannot grow beyond the upload limit, while migrated oversized reports remain manageable', async () => {
    const db = database();
    try {
        const models = Object.fromEntries(Array.from({ length: 2048 }, (_, i) => [`model/${i}`, 1]));
        const full = { ...snapshot(), weeks: [{ week: '2026-09-28', models }] };
        const { id, token } = await (await handleContributions(upload(full), db, limit,
            '/api/contributions/private')).json();
        const path = `/api/contributions/${id}`;
        const extra = { ...snapshot(), weeks: [{ week: '2026-09-21', models: { 'older/model': 1 } }] };
        assert.equal((await handleContributions(upload(extra, path, 'PUT', token), db, limit, path)).status, 413);
        assert.equal((await db.prepare('SELECT count(*) AS count FROM weekly_counts WHERE contributor_id = ?')
            .bind(id).first()).count, 2048);
        const report = await (await handleContributions(new Request(`https://modeltides.dev${path}`, {
            headers: { Authorization: `Bearer ${token}` },
        }), db, limit, path)).json();
        assert.equal(parseOwnedReport(report, id).snapshot.weeks[0].models['model/2047'], 1);

        const old = database(false);
        try {
            const oldId = '0199abcf-22aa-7333-8abc-0123456789ab';
            const oldToken = 's'.repeat(43);
            const hash = createHash('sha256').update(oldToken).digest('hex');
            await old.prepare('INSERT INTO contributors (id, token_hash, created_at, updated_at) VALUES (?, ?, ?, ?)')
                .bind(oldId, hash, 1, 1).run();
            for (const [model, count] of Object.entries(models)) await old.prepare(
                'INSERT INTO weekly_counts (contributor_id, week, model, count) VALUES (?, ?, ?, ?)')
                .bind(oldId, '2026-09-28', model, count).run();
            await old.prepare('INSERT INTO weekly_counts (contributor_id, week, model, count) VALUES (?, ?, ?, ?)')
                .bind(oldId, '2026-09-21', 'older/model', 1).run();
            old.migrate();
            const oldPath = `/api/contributions/${oldId}`;
            const migrated = await (await handleContributions(new Request(`https://modeltides.dev${oldPath}`, {
                headers: { Authorization: `Bearer ${oldToken}` },
            }), old, limit, oldPath)).json();
            assert.equal(parseOwnedReport(migrated, oldId).snapshot.weeks.length, 2);
            assert.equal((await handleContributions(new Request(`https://modeltides.dev${oldPath}/unshare`, {
                method: 'POST', headers: { Authorization: `Bearer ${oldToken}` },
            }), old, limit, `${oldPath}/unshare`)).status, 200);
            assert.equal(await getReport(old, oldId), null);
            assert.equal((await old.prepare('SELECT count(*) AS count FROM weekly_counts WHERE contributor_id = ?')
                .bind(oldId).first()).count, 2049);
        } finally { old.close(); }
    } finally { db.close(); }
});

test('stored weeks cannot exceed 520 across valid uploads', async () => {
    const db = database();
    try {
        const first = Date.UTC(2014, 0, 6);
        const weeks = Array.from({ length: 520 }, (_, index) => ({
            week: new Date(first + index * 7 * 86_400_000).toISOString().slice(0, 10),
            models: { 'openai/gpt-5': 1 },
        }));
        const { id, token } = await (await handleContributions(upload({ ...snapshot(), weeks }), db, limit,
            '/api/contributions/private')).json();
        const path = `/api/contributions/${id}`;
        const older = { ...snapshot(), weeks: [{ week: '2000-01-03', models: { 'older/model': 1 } }] };
        assert.equal((await handleContributions(upload(older, path, 'PUT', token), db, limit, path)).status, 413);
        assert.equal((await db.prepare('SELECT COUNT(DISTINCT week) AS count FROM weekly_counts WHERE contributor_id = ?')
            .bind(id).first()).count, 520);
    } finally { db.close(); }
});

test('a concurrent replacement that fills the last stored cell rejects the other upload without a service error', async () => {
    assert.match(readFileSync(new URL('../migrations/0003_counts_revision.sql', import.meta.url), 'utf8'),
        /RAISE\(ABORT, 'MODEL_TIDES_STORED_REPORT_LIMIT'\)/);
    const db = database();
    try {
        const models = Object.fromEntries(Array.from({ length: 2047 }, (_, index) => [`model/${index}`, 1]));
        const initial = { ...snapshot(), weeks: [{ week: '2026-09-28', models }] };
        const { id, token } = await (await handleContributions(upload(initial), db, limit,
            '/api/contributions/private')).json();
        const path = `/api/contributions/${id}`;
        const waiting = Promise.withResolvers();
        const resume = Promise.withResolvers();
        const delayed = {
            prepare: (sql) => db.prepare(sql),
            async batch(statements) { waiting.resolve(); await resume.promise; return db.batch(statements); },
        };
        const next = (week, model) => ({ ...snapshot(), weeks: [{ week, models: { [model]: 1 } }] });
        const rejected = handleContributions(upload(next('2026-09-14', 'model/rejected'), path, 'PUT', token),
            delayed, limit, path);
        try {
            await waiting.promise;
            assert.equal((await handleContributions(upload(next('2026-09-21', 'model/accepted'), path, 'PUT', token),
                db, limit, path)).status, 200);
        } finally { resume.resolve(); }
        assert.equal((await rejected).status, 413);
        assert.deepEqual({ ...await db.prepare('SELECT COUNT(*) AS cells FROM weekly_counts WHERE contributor_id = ?')
            .bind(id).first() }, { cells: 2048 });
        assert.equal((await db.prepare('SELECT COUNT(*) AS count FROM weekly_counts WHERE contributor_id = ? AND model = ?')
            .bind(id, 'model/rejected').first()).count, 0);
        assert.equal((await db.prepare('SELECT report_revision FROM contributors WHERE id = ?').bind(id).first()).report_revision, 1);
    } finally { db.close(); }
});

test('a concurrent limit does not disguise an unrelated batch failure', async () => {
    const db = database();
    try {
        const models = Object.fromEntries(Array.from({ length: 2047 }, (_, index) => [`model/${index}`, 1]));
        const initial = { ...snapshot(), weeks: [{ week: '2026-09-28', models }] };
        const { id, token } = await (await handleContributions(upload(initial), db, limit,
            '/api/contributions/private')).json();
        const path = `/api/contributions/${id}`;
        const waiting = Promise.withResolvers();
        const resume = Promise.withResolvers();
        const failingDb = {
            prepare: (sql) => db.prepare(sql),
            async batch() {
                waiting.resolve();
                await resume.promise;
                throw new Error('synthetic database failure');
            },
        };
        const next = (week, model) => ({ ...snapshot(), weeks: [{ week, models: { [model]: 1 } }] });
        const pending = worker.fetch(upload(next('2026-09-14', 'model/rejected'), path, 'PUT', token), {
            DB: failingDb, UPLOAD_LIMIT: limit, ASSETS: { async fetch() { return new Response('asset'); } },
        });
        try {
            await waiting.promise;
            assert.equal((await handleContributions(upload(next('2026-09-21', 'model/accepted'), path, 'PUT', token),
                db, limit, path)).status, 200);
        } finally { resume.resolve(); }
        const result = await pending;
        assert.equal(result.status, 503);
        assert.equal((await result.text()).includes('synthetic database failure'), false);
        assert.equal((await db.prepare('SELECT COUNT(*) AS count FROM weekly_counts WHERE contributor_id = ?')
            .bind(id).first()).count, 2048);
        assert.equal((await db.prepare('SELECT report_revision FROM contributors WHERE id = ?').bind(id).first()).report_revision, 1);
    } finally { db.close(); }
});

test('an oversized migrated report returns only a bounded owner summary and can still be hidden', async () => {
    const db = database(false);
    try {
        const id = '0199abcf-22aa-7333-8abc-0123456789ab';
        const token = 's'.repeat(43);
        await db.prepare('INSERT INTO contributors (id, token_hash, created_at, updated_at) VALUES (?, ?, ?, ?)')
            .bind(id, createHash('sha256').update(token).digest('hex'), 1, 1).run();
        const insert = db.prepare('INSERT INTO weekly_counts (contributor_id, week, model, count) VALUES (?, ?, ?, ?)');
        for (const index of Array.from({ length: 8193 }, (_, i) => i)) {
            await insert.bind(id, '2026-09-28', `model/${index}`, 1).run();
        }
        db.migrate();
        const path = `/api/contributions/${id}`;
        const result = await handleContributions(new Request(`https://modeltides.dev${path}`, {
            headers: { Authorization: `Bearer ${token}` },
        }), db, limit, path);
        assert.deepEqual(await result.json(), { id, published: true, inAggregate: true, revision: 0, tooLarge: true });
        assert.equal((await handleContributions(new Request(`https://modeltides.dev${path}/unshare`, {
            method: 'POST', headers: { Authorization: `Bearer ${token}` },
        }), db, limit, `${path}/unshare`)).status, 200);
        const revision = (await db.prepare('SELECT report_revision FROM contributors WHERE id = ?').bind(id).first()).report_revision;
        assert.equal((await handleContributions(new Request(`https://modeltides.dev${path}/share`, {
            method: 'POST', headers: { Authorization: `Bearer ${token}`,
                'X-Model-Tides-Reviewed-Revision': String(revision) },
        }), db, limit, `${path}/share`)).status, 409,
        'a summary without stored counts cannot authorize publication');
        assert.equal((await getReport(db, id)), null);
        assert.equal((await db.prepare('SELECT count(*) AS count FROM weekly_counts WHERE contributor_id = ?')
            .bind(id).first()).count, 8193);
    } finally { db.close(); }
});

test('replacement refuses to publish counts if another owner session shared the report after preview', async () => {
    const db = database();
    try {
        const created = await handleContributions(upload(snapshot()), db, limit, '/api/contributions/private');
        const { id, token } = await created.json();
        const path = `/api/contributions/${id}`;
        const sharePath = `${path}/share`;
        assert.equal((await handleContributions(new Request(`https://modeltides.dev${sharePath}`, {
            method: 'POST', headers: { Authorization: `Bearer ${token}`, 'X-Model-Tides-Reviewed-Revision': '0' },
        }), db, limit, sharePath)).status, 200);
        const outdated = await handleContributions(upload(snapshot(9), path, 'PUT', token, 'private'), db, limit, path);
        assert.equal(outdated.status, 409);
        assert.equal((await getReport(db, id)).total, 2, 'mismatched visibility never writes the reviewed counts');
        const reviewed = await handleContributions(upload(snapshot(9), path, 'PUT', token, 'public'), db, limit, path);
        assert.equal(reviewed.status, 200);
        assert.equal((await getReport(db, id)).total, 9);
    } finally { db.close(); }
});

test('existing links remain public when the publication migration is applied', async () => {
    const db = database(false);
    try {
        const id = '0199abcf-22aa-7333-8abc-0123456789ab';
        await db.prepare('INSERT INTO contributors (id, token_hash, created_at, updated_at) VALUES (?, ?, ?, ?)')
            .bind(id, 'previously-published', 1, 1).run();
        await db.prepare('INSERT INTO weekly_counts (contributor_id, week, model, count) VALUES (?, ?, ?, ?)')
            .bind(id, '2026-09-28', 'openai/gpt-5', 1).run();
        db.migrate();
        assert.deepEqual({ ...await db.prepare('SELECT published, report_revision, in_aggregate FROM contributors WHERE id = ?').bind(id).first() },
            { published: 1, report_revision: 0, in_aggregate: 1 });
        assert.equal((await getReport(db, id)).total, 1);
    } finally { db.close(); }
});

test('aggregate displays even a single opted-in contributor and updates after deletion', async () => {
    const db = database();
    try {
        const aggregate = () => handleContributions(new Request('https://modeltides.dev/api/aggregate'), db, limit, '/api/aggregate');
        const ids = [];
        for (const _index of [1, 2, 3, 4]) {
            const created = await handleContributions(upload(snapshot()), db, limit, '/api/contributions/private');
            ids.push(await created.json());
        }
        assert.deepEqual((await (await aggregate()).json()).weeks, [
            { week: '2026-09-28', model: 'anthropic/claude-sonnet', count: 8, contributors: 4 },
        ]);
        const fifth = await handleContributions(upload(snapshot(7)), db, limit, '/api/contributions/private');
        ids.push(await fifth.json());
        assert.deepEqual((await (await aggregate()).json()).weeks, [{
            week: '2026-09-28', model: 'anthropic/claude-sonnet', count: 15, contributors: 5,
        }]);
        const { id, token } = ids[0];
        await handleContributions(new Request(`https://modeltides.dev/api/contributions/${id}`, {
            method: 'DELETE', headers: { Authorization: `Bearer ${token}` },
        }), db, limit, `/api/contributions/${id}`);
        assert.deepEqual((await (await aggregate()).json()).weeks, [
            { week: '2026-09-28', model: 'anthropic/claude-sonnet', count: 13, contributors: 4 },
        ]);
    } finally { db.close(); }
});

test('five personal links remain outside the aggregate until each owner opts in', async () => {
    const db = database();
    try {
        const owners = [];
        for (const _index of [1, 2, 3, 4, 5]) {
            const created = await handleContributions(upload(snapshot(), '/api/contributions/personal'),
                db, limit, '/api/contributions/personal');
            owners.push(await created.json());
        }
        const aggregate = async () => (await handleContributions(new Request('https://modeltides.dev/api/aggregate'),
            db, limit, '/api/aggregate')).json();
        assert.deepEqual((await aggregate()).weeks, []);
        for (const { id, token } of owners) {
            const path = `/api/contributions/${id}/contribute`;
            const result = await handleContributions(new Request(`https://modeltides.dev${path}`, {
                method: 'POST', headers: { Authorization: `Bearer ${token}`, 'X-Model-Tides-Reviewed-Revision': '0' },
            }), db, limit, path);
            assert.equal(result.status, 200);
        }
        assert.deepEqual((await aggregate()).weeks, [{
            week: '2026-09-28', model: 'anthropic/claude-sonnet', count: 10, contributors: 5,
        }]);
    } finally { db.close(); }
});

test('headers and rate limit reject invalid uploads before body is read or database written', async () => {
    const db = database();
    try {
        let called = 0;
        const rejectLimit = { async limit() { called++; return { success: false }; } };
        const badType = new Request('https://modeltides.dev/api/contributions', { method: 'POST', body: 'private transcript' });
        assert.equal((await handleContributions(badType, db, rejectLimit, '/api/contributions')).status, 415);
        assert.equal(called, 0);
        const oldClient = upload(snapshot(), '/api/contributions');
        oldClient.headers.delete('X-Model-Tides-Report');
        assert.equal((await handleContributions(oldClient, db, rejectLimit, '/api/contributions')).status, 426);
        assert.equal((await handleContributions(upload(snapshot(), '/api/contributions'), db, rejectLimit,
            '/api/contributions')).status, 426, 'the old path cannot create even with the new header');
        assert.equal(called, 0);
        assert.equal((await db.prepare('SELECT count(*) AS count FROM contributors').first()).count, 0);
        assert.equal((await handleContributions(upload(snapshot()), db, rejectLimit, '/api/contributions/private')).status, 429);
        assert.equal(called, 1);
        const tooLarge = new Request('https://modeltides.dev/api/contributions/private', {
            method: 'POST', body: 'private transcript',
            headers: {
                'Content-Type': 'application/vnd.model-tides.weekly+json',
                'Content-Encoding': 'br', 'X-Model-Tides-Schema': 'weekly-v1',
                'Content-Length': '65537',
            },
        });
        assert.equal((await handleContributions(tooLarge, db, limit, '/api/contributions/private')).status, 413);
        const expanded = { ...snapshot(), note: 'x'.repeat(600_000) };
        assert.equal((await handleContributions(upload(expanded), db, limit, '/api/contributions/private')).status, 400);
        const created = await handleContributions(upload(snapshot()), db, limit, '/api/contributions/private');
        const { id, token } = await created.json();
        const olderReplace = upload(snapshot(4), `/api/contributions/${id}`, 'PUT', token);
        olderReplace.headers.delete('X-Model-Tides-Expected-Visibility');
        assert.equal((await handleContributions(olderReplace, db, rejectLimit,
            `/api/contributions/${id}`)).status, 426);
        assert.equal(called, 1, 'an old client cannot replace without an explicit visibility check');
        const keys = [];
        const record = { async limit({ key }) { keys.push(key); return { success: true }; } };
        const denied = await handleContributions(upload(snapshot(4), `/api/contributions/${id}`, 'PUT', 'A'.repeat(43)),
            db, record, `/api/contributions/${id}`);
        assert.equal(denied.status, 401);
        assert.equal(keys.length, 1, 'invalid credentials never consume the real owner bucket');
        assert.equal(keys[0].startsWith('write:'), true);
        assert.equal((await db.prepare('SELECT count(*) AS count FROM contributors').first()).count, 1);
    } finally { db.close(); }
});
