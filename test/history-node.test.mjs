import assert from 'node:assert/strict';
import { createWriteStream, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import test from 'node:test';
import { createZstdCompress } from 'node:zlib';
import { exportLocal, exportLocalMetadata, exportActiveLocalMetadata, snapshotFromDailyDocuments } from '../scripts/contribute.mjs';
import { scanCopilotActive, scanVSCodeCopilotActive } from '../scripts/history-scanner.mjs';
import { parseDailyDocument } from '../src/daily-usage.ts';

const at = (seconds) => new Date(Date.UTC(2025, 0, 1) + seconds * 1000).toISOString();
const source = (name, path) => ({ name, path });

test('weekly activity counts each observed session–model–UTC-day once, including a long-running session', async () => {
    const home = mkdtempSync(join(tmpdir(), 'tides-active-days-'));
    const path = join(home, 'history.db');
    const db = new DatabaseSync(path);
    try {
        db.exec('CREATE TABLE session (id TEXT PRIMARY KEY, time_created INTEGER); CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT)');
        const monday = Date.UTC(2026, 8, 28);
        db.prepare('INSERT INTO session VALUES (?, ?)').run('private-one', monday);
        db.prepare('INSERT INTO session VALUES (?, ?)').run('private-two', monday + 86_400_000);
        const insert = db.prepare('INSERT INTO message VALUES (?, ?, ?, ?)');
        for (const [id, session, offset, model] of [
            ['private-a', 'private-one', 1, 'gpt-5'],
            ['private-b', 'private-one', 2, 'gpt-5'],
            ['private-c', 'private-one', 86_400_001, 'gpt-5'],
            ['private-d', 'private-one', 86_400_002, 'claude-sonnet'],
            ['private-e', 'private-one', 2 * 86_400_000 + 1, 'gpt-5'],
            ['private-f', 'private-two', 86_400_003, 'gpt-5'],
        ]) insert.run(id, session, monday + offset, JSON.stringify({ role: 'assistant', providerID: model.startsWith('claude') ? 'anthropic' : 'openai', modelID: model, content: 'private transcript' }));
        const weekly = await exportLocal([source('OpenCode', path)]);
        assert.deepEqual(weekly, { format: 'model-tides-weekly', version: 2, weeks: [
            { week: '2026-09-28', models: { 'anthropic/claude-sonnet': 1, 'openai/gpt-5': 4 } },
        ] });
        assert.doesNotMatch(JSON.stringify(weekly), /private|content|session_id|message_id|2026-09-29/i);
    } finally { db.close(); rmSync(home, { recursive: true, force: true }); }
});

test('Codex repeated rollouts and Claude message updates count each active model once per session and day', async () => {
    const home = mkdtempSync(join(tmpdir(), 'tides-activity-history-'));
    try {
        const codex = join(home, 'codex');
        const claude = join(home, 'claude');
        mkdirSync(codex);
        mkdirSync(claude);
        const atDay = (day, seconds = 0) => new Date(Date.UTC(2026, 8, 28 + day, 0, 0, seconds)).toISOString();
        const meta = { type: 'session_meta', payload: { id: 'private-thread', timestamp: atDay(0) } };
        const turn = (day, model) => ({ type: 'turn_context', timestamp: atDay(day, 1), payload: { model, instructions: 'private prompt' } });
        writeFileSync(join(codex, 'rollout-a.jsonl'), [meta, turn(0, 'gpt-5'), turn(0, 'gpt-5'), turn(1, 'gpt-5')].map(JSON.stringify).join('\n') + '\n');
        writeFileSync(join(codex, 'rollout-aa.jsonl'), [{ ...meta, payload: { ...meta.payload, id: 'other-thread' } },
            turn(0, 'gpt-5')].map(JSON.stringify).join('\n') + '\n');
        writeFileSync(join(codex, 'rollout-b.jsonl'), [meta, turn(1, 'gpt-5'), turn(1, 'gpt-5-codex')].map(JSON.stringify).join('\n') + '\n');
        const message = (day, id, model) => ({ type: 'assistant', timestamp: atDay(day, 5), message: {
            id, model, role: 'assistant', content: 'private reply',
        } });
        writeFileSync(join(claude, 'main.jsonl'), [message(0, 'private-update', 'claude-sonnet'),
            message(0, 'private-update', 'claude-sonnet'), message(1, 'private-next', 'claude-sonnet')]
            .map(JSON.stringify).join('\n') + '\n');
        const daily = await exportActiveLocalMetadata([source('Codex', codex), source('Claude Code', claude)]);
        assert.deepEqual(parseDailyDocument(daily).days, [
            { day: '2026-09-28', models: { 'anthropic/claude-sonnet': 1, 'openai/gpt-5': 2 } },
            { day: '2026-09-29', models: { 'anthropic/claude-sonnet': 1, 'openai/gpt-5': 1, 'openai/gpt-5-codex': 1 } },
        ]);
        assert.deepEqual(snapshotFromDailyDocuments([daily]).weeks, [
            { week: '2026-09-28', models: { 'anthropic/claude-sonnet': 2, 'openai/gpt-5': 3, 'openai/gpt-5-codex': 1 } },
        ]);
        assert.doesNotMatch(JSON.stringify(daily), /private|prompt|reply|thread|message|sessionId/);
    } finally { rmSync(home, { recursive: true, force: true }); }
});

test('Pi session trees count dated assistant models once per session and UTC day, without exporting identities or messages', async () => {
    const home = mkdtempSync(join(tmpdir(), 'tides-pi-history-'));
    try {
        const root = join(home, 'sessions');
        const project = join(root, '--project--');
        mkdirSync(project, { recursive: true });
        const when = (day, seconds = 0) => Date.UTC(2026, 8, 28 + day, 0, 0, seconds);
        const entry = (type, id, parentId, day, fields) => ({ type, id, parentId,
            timestamp: new Date(when(day)).toISOString(), ...fields });
        const assistant = (id, parentId, day, provider, model) => entry('message', id, parentId, day, {
            message: { role: 'assistant', provider, model, timestamp: when(day),
                content: [{ type: 'text', text: 'private reply' }], usage: { input: 3, output: 2 }, stopReason: 'stop' },
        });
        const late = assistant('private-late', 'private-c', 2, 'openai', 'gpt-5-nano');
        late.message.timestamp = when(1);
        const first = [
            { type: 'session', version: 3, id: 'private-session-id', timestamp: new Date(when(0)).toISOString(), cwd: '/private/path' },
            entry('message', 'private-user', null, 0, { message: { role: 'user', content: 'private prompt' } }),
            entry('model_change', 'private-select', 'private-user', 0, { provider: 'openai', modelId: 'unused-selected' }),
            assistant('private-a', 'private-select', 0, 'openai', 'gpt-5'),
            assistant('private-b', 'private-a', 0, 'openai', 'gpt-5'),
            assistant('private-c', 'private-b', 1, 'openai', 'gpt-5'),
            late,
            assistant('private-branch', 'private-a', 1, 'anthropic', 'claude-sonnet'),
            entry('usage', 'private-cache', 'private-branch', 2, { provider: 'openai', model: 'cache-model', usage: { output: 5 } }),
            entry('compaction', 'private-summary', 'private-cache', 2, { summary: 'private transcript', firstKeptEntryId: 'private-a' }),
        ];
        writeFileSync(join(project, '2026-09-28_private-session-id.jsonl'), first.map(JSON.stringify).join('\n') + '\n');
        writeFileSync(join(project, '2026-09-30_duplicate.jsonl'), [...first,
            assistant('private-reopened', 'private-branch', 2, 'openai', 'gpt-5')].map(JSON.stringify).join('\n') + '\n');
        writeFileSync(join(project, '2026-09-28_empty.jsonl'), JSON.stringify({ type: 'session', version: 3,
            id: 'private-other-session', timestamp: new Date(when(1)).toISOString() }) + '\n');
        const second = [
            { type: 'session', version: 2, id: 'private-other-session', timestamp: new Date(when(1)).toISOString(), cwd: '/private/other' },
            assistant('private-d', null, 1, 'openai', 'gpt-5'),
        ];
        writeFileSync(join(project, '2026-09-29_private-other-session.jsonl'), second.map(JSON.stringify).join('\n') + '\n');
        const document = await exportActiveLocalMetadata([source('Pi', root)]);
        assert.deepEqual(parseDailyDocument(document), { format: 'model-tides-daily', version: 2, source: 'pi', days: [
            { day: '2026-09-28', models: { 'openai/gpt-5': 1 } },
            { day: '2026-09-29', models: { 'anthropic/claude-sonnet': 1, 'openai/gpt-5': 2, 'openai/gpt-5-nano': 1 } },
            { day: '2026-09-30', models: { 'openai/gpt-5': 1 } },
        ] });
        assert.deepEqual(snapshotFromDailyDocuments([document]).weeks, [{ week: '2026-09-28', models: {
            'anthropic/claude-sonnet': 1, 'openai/gpt-5': 4, 'openai/gpt-5-nano': 1,
        } }]);
        assert.doesNotMatch(JSON.stringify(document), /private|prompt|reply|transcript|cwd|session|cache-model|unused-selected|timestamp/);
    } finally { rmSync(home, { recursive: true, force: true }); }
});

test('Pi ignores only a partial live final record, rejects malformed complete records and symlink roots', async () => {
    const home = mkdtempSync(join(tmpdir(), 'tides-pi-lines-'));
    try {
        const path = join(home, 'session.jsonl');
        const header = { type: 'session', version: 3, id: 'private-id', cwd: '/private/path', timestamp: at(0) };
        const assistant = { type: 'message', id: 'private-message', parentId: null, timestamp: at(1), message: {
            role: 'assistant', provider: 'openai', model: 'gpt-5', timestamp: Date.UTC(2025, 0, 1, 0, 0, 1),
            content: [{ type: 'text', text: 'private reply' }],
        } };
        const prefix = [header, assistant].map(JSON.stringify).join('\n') + '\n';
        writeFileSync(path, prefix + '{"private transcript":');
        const scan = (root) => exportActiveLocalMetadata([source('Pi', root)]);
        assert.deepEqual((await scan(path)).days, [{ day: '2025-01-01', models: { 'openai/gpt-5': 1 } }]);
        writeFileSync(path, prefix + '{"private transcript":\n');
        await assert.rejects(scan(path), /Pi has a malformed history record/);
        writeFileSync(path, [header, assistant, { type: 'usage', provider: 'openai', model: 'unused', timestamp: at(2) }]
            .map(JSON.stringify).join('\n') + '\n');
        assert.deepEqual((await scan(path)).days, [{ day: '2025-01-01', models: { 'openai/gpt-5': 1 } }]);
        const link = join(home, 'linked.jsonl');
        symlinkSync(path, link);
        await assert.rejects(scan(link), /Pi could not be read/);
        writeFileSync(path, JSON.stringify({ ...header, version: 4 }) + '\n');
        await assert.rejects(scan(path), /Pi could not be read/);
    } finally { rmSync(home, { recursive: true, force: true }); }
});

test('GitHub Copilot CLI, desktop app, and VS Code CLI-backed sessions share one activity count', async () => {
    const home = mkdtempSync(join(tmpdir(), 'tides-copilot-history-'));
    try {
        const root = join(home, 'session-state');
        const first = join(root, 'first');
        const copy = join(root, 'copy');
        const empty = join(root, 'empty');
        for (const path of [first, copy, empty]) mkdirSync(path, { recursive: true });
        const start = { type: 'session.start', timestamp: at(0), data: { sessionId: 'private-session-id',
            selectedModel: 'auto', context: { cwd: '/private/path' } } };
        const reply = (seconds, model, interactionId = 'main') => ({ type: 'assistant.message',
            timestamp: at(seconds), data: { model, interactionId, content: 'private reply', messageId: 'private-message-id' } });
        const entries = [start,
            { type: 'session.model_change', timestamp: at(1), data: { selectedModel: 'unused-selected' } },
            { type: 'user.message', timestamp: at(2), data: { content: 'private prompt' } },
            reply(3, 'gpt-5'), reply(4, 'gpt-5'), reply(86_403, 'gpt-5'),
            { type: 'user.message', timestamp: at(86_404), data: { interactionId: 'child', parentAgentTaskId: 'private-task' } },
            reply(86_405, 'claude-haiku', 'child'), reply(86_406, 'auto'),
            reply(86_407, 'github-copilot/auto'), reply(86_408, 'claude-sonnet-4.5'),
            { type: 'assistant.message', timestamp: at(2 * 86_400), data: { model: 'gpt-5-nano', content: 'private main reply' } },
            { type: 'user.message', timestamp: at(2 * 86_400 + 1), data: { parentAgentTaskId: 'unidentified-child' } },
            { type: 'assistant.message', timestamp: at(2 * 86_400 + 2), data: { model: 'skip-child' } },
            { type: 'user.message', timestamp: at(2 * 86_400 + 3), data: { content: 'main user reply' } },
            { type: 'assistant.message', timestamp: at(2 * 86_400 + 4), data: { model: 'claude-opus-4.6' } },
        ];
        writeFileSync(join(first, 'events.jsonl'), entries.map(JSON.stringify).join('\n') + '\n');
        writeFileSync(join(copy, 'events.jsonl'), [start, reply(3, 'gpt-5')].map(JSON.stringify).join('\n') + '\n');
        writeFileSync(join(empty, 'events.jsonl'), JSON.stringify(start) + '\n');
        const daily = await exportActiveLocalMetadata([source('GitHub Copilot', root)]);
        assert.deepEqual(parseDailyDocument(daily).days, [
            { day: '2025-01-01', models: { 'github-copilot/gpt-5': 1 } },
            { day: '2025-01-02', models: { 'github-copilot/claude-sonnet-4.5': 1, 'github-copilot/gpt-5': 1 } },
            { day: '2025-01-03', models: { 'github-copilot/claude-opus-4.6': 1, 'github-copilot/gpt-5-nano': 1 } },
        ]);
        assert.doesNotMatch(JSON.stringify(daily), /private|prompt|reply|sessionId|selected|timestamp|auto/);
        assert.deepEqual((await scanCopilotActive(root)).days, daily.days);
        writeFileSync(join(first, 'events.jsonl'), entries.map(JSON.stringify).join('\n') + '\n{"private transcript":');
        assert.deepEqual((await scanCopilotActive(root)).days, daily.days);
        writeFileSync(join(first, 'events.jsonl'), entries.map(JSON.stringify).join('\n') + '\n{"private transcript":\n');
        await assert.rejects(scanCopilotActive(root), /history record is malformed/);
        rmSync(join(first, 'events.jsonl'));
        symlinkSync(join(copy, 'events.jsonl'), join(first, 'events.jsonl'));
        assert.deepEqual((await scanCopilotActive(root)).days, [{ day: '2025-01-01', models: { 'github-copilot/gpt-5': 1 } }]);
    } finally { rmSync(home, { recursive: true, force: true }); }
});

test('VS Code built-in Copilot Chat uses completed local requests, not drafts or auto model selections', async () => {
    const home = mkdtempSync(join(tmpdir(), 'tides-vscode-history-'));
    try {
        const root = join(home, 'Code/User');
        const workspace = join(root, 'workspaceStorage/fixture/chatSessions');
        const emptyWindow = join(root, 'globalStorage/emptyWindowChatSessions');
        mkdirSync(workspace, { recursive: true });
        mkdirSync(emptyWindow, { recursive: true });
        const request = (seconds, model, state = 1) => ({ requestId: `private-request-${seconds}`,
            timestamp: Date.UTC(2026, 8, 28, 0, 0, seconds), modelId: model,
            modelState: { value: state }, responseTimestamp: Date.UTC(2026, 8, 28, 0, 0, seconds + 1),
            response: [{ value: 'private reply' }], message: 'private prompt',
        });
        const initial = { version: 3, sessionId: 'private-session', responderUsername: 'GitHub Copilot',
            requests: [request(1, 'gpt-5'), request(2, 'auto'), request(3, 'unused-selected', 0)],
            inputState: { selectedModel: 'unused-draft' }, workingDirectory: '/private/path' };
        const ops = [{ kind: 0, v: initial },
            { kind: 1, k: ['requests', 2, 'modelId'], v: 'claude-sonnet-4.5' },
            { kind: 1, k: ['requests', 2, 'modelState'], v: { value: 1 } },
            { kind: 2, k: ['requests'], v: [request(4, 'gpt-5')] },
            { kind: 2, k: ['requests'], i: 3 },
        ];
        writeFileSync(join(workspace, 'private-session.jsonl'), ops.map(JSON.stringify).join('\n') + '\n');
        writeFileSync(join(emptyWindow, 'private-copy.json'), JSON.stringify({ ...initial, requests: [request(1, 'gpt-5')] }));
        writeFileSync(join(emptyWindow, 'private-uncertain.json'), JSON.stringify({ ...initial, sessionId: 'uncertain',
            responderUsername: 'Other Agent', requests: [request(5, 'gpt-5')] }));
        writeFileSync(join(emptyWindow, 'cross-midnight.json'), JSON.stringify({ ...initial, sessionId: 'cross-midnight',
            requests: [{ ...request(5, 'gpt-5-nano'), timestamp: Date.UTC(2026, 8, 28, 23, 59, 59),
                responseTimestamp: Date.UTC(2026, 8, 29) }] }));
        const daily = await scanVSCodeCopilotActive([root]);
        assert.deepEqual(daily.days, [
            { day: '2026-09-28', models: { 'github-copilot/claude-sonnet-4.5': 1, 'github-copilot/gpt-5': 1 } },
            { day: '2026-09-29', models: { 'github-copilot/gpt-5-nano': 1 } },
        ]);
        assert.doesNotMatch(JSON.stringify(daily), /private|prompt|reply|selected|sessionId|2026-09-28T/);
        assert.deepEqual((await exportActiveLocalMetadata([source('VS Code Copilot Chat', [root])])).days, daily.days);
    } finally { rmSync(home, { recursive: true, force: true }); }
});

test('daily export rejects exact-time or identity fields and cannot reinterpret v1 event metadata', () => {
    const day = { format: 'model-tides-daily', version: 2, source: 'opencode', days: [
        { day: '2026-09-28', models: { 'openai/gpt-5': 1 } },
    ] };
    assert.deepEqual(parseDailyDocument(day), day);
    for (const invalid of [
        { ...day, sessionId: 'private' },
        { ...day, days: [{ ...day.days[0], transcript: 'private' }] },
        { ...day, days: [{ ...day.days[0], day: '2026-09-28T01:00:00Z' }] },
        { ...day, days: [...day.days, day.days[0]] },
        { ...day, days: [{ ...day.days[0], models: { 'openai/gpt-5': 10_001 } }] },
        { format: 'model-tides', version: 1, source: 'opencode', events: [] },
    ]) assert.throws(() => parseDailyDocument(invalid), TypeError);
});

test('Node SQLite reads committed live WAL without changing database or sidecars, and exports no private data', async () => {
    const home = mkdtempSync(join(tmpdir(), 'tides-node-sqlite-'));
    const path = join(home, 'history.db');
    const db = new DatabaseSync(path);
    try {
        db.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE session (id TEXT PRIMARY KEY, time_created INTEGER); CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT)');
        const started = Date.UTC(2025, 0, 1);
        db.prepare('INSERT INTO session VALUES (?, ?)').run('private-session-id', started);
        const insert = db.prepare('INSERT INTO message VALUES (?, ?, ?, ?)');
        insert.run('private-message-1', 'private-session-id', started + 1000,
            JSON.stringify({ role: 'assistant', providerID: 'openai', modelID: 'gpt-5', content: 'private reply' }));
        insert.run('private-message-2', 'private-session-id', started + 2000,
            JSON.stringify({ role: 'assistant', providerID: 'openai', modelID: 'gpt-5' }));
        insert.run('private-message-3', 'private-session-id', started + 3000,
            JSON.stringify({ role: 'assistant', providerID: 'anthropic', modelID: 'claude-sonnet', content: 'private prompt' }));
        assert.equal(statSync(`${path}-wal`).size > 0, true);
        const before = [path, `${path}-wal`].map((file) => readFileSync(file));
        const result = await exportLocalMetadata([source('OpenCode', path)]);
        assert.deepEqual(result.events, [
            { time: started, model: 'openai/gpt-5', kind: 'session' },
            { time: started + 3000, model: 'anthropic/claude-sonnet', kind: 'switch', fromModel: 'openai/gpt-5', fromTime: started },
        ]);
        assert.doesNotMatch(JSON.stringify(result), /private|content|session_id|message_id/i);
        for (const [index, file] of [path, `${path}-wal`].entries()) {
            assert.deepEqual(readFileSync(file), before[index]);
        }
        // SQLite uses transient read locks in the shared-memory sidecar while the writer is live.
        assert.equal(statSync(`${path}-shm`).size > 0, true);
    } finally { db.close(); rmSync(home, { recursive: true, force: true }); }
});

test('Node zstd reads old Codex rollouts without external tools, prefers plain siblings, and fails closed on corrupt frames', async () => {
    const home = mkdtempSync(join(tmpdir(), 'tides-node-zstd-'));
    try {
        const root = join(home, 'sessions');
        mkdirSync(root);
        const plain = join(root, 'rollout-old.jsonl');
        const compressed = `${plain}.zst`;
        const meta = { type: 'session_meta', timestamp: at(0), payload: { id: 'private-session', timestamp: at(0), cwd: '/private/path' } };
        const history = [meta, { type: 'turn_context', timestamp: at(1), payload: { model: 'gpt-4o', instructions: 'private prompt' } }]
            .map(JSON.stringify).join('\n') + '\n';
        await pipeline(Readable.from([history]), createZstdCompress(), createWriteStream(compressed));
        const scan = () => exportLocalMetadata([source('Codex', root)]);
        assert.deepEqual((await scan()).events, [{ time: Date.UTC(2025, 0, 1), model: 'openai/gpt-4o', kind: 'session' }]);
        writeFileSync(plain, [JSON.stringify(meta), JSON.stringify({ type: 'turn_context', timestamp: at(1), payload: { model: 'gpt-5' } })].join('\n') + '\n');
        assert.deepEqual((await scan()).events, [{ time: Date.UTC(2025, 0, 1), model: 'openai/gpt-5', kind: 'session' }]);
        rmSync(plain);
        writeFileSync(compressed, 'corrupted private frame');
        await assert.rejects(scan(), /Codex could not be read/);
    } finally { rmSync(home, { recursive: true, force: true }); }
});

test('Node JSONL ignores only an incomplete plain final record, rejects malformed complete lines and symlink roots', async () => {
    const home = mkdtempSync(join(tmpdir(), 'tides-node-lines-'));
    try {
        const file = join(home, 'rollout-main.jsonl');
        const prefix = [
            { type: 'session_meta', timestamp: at(0), payload: { id: 'private-session', timestamp: at(0) } },
            { type: 'turn_context', timestamp: at(1), payload: { model: 'gpt-5' } },
        ].map(JSON.stringify).join('\n') + '\n';
        writeFileSync(file, prefix + '{"private transcript":');
        const scan = (path) => exportLocalMetadata([source('Codex', path)]);
        assert.equal((await scan(file)).events[0].model, 'openai/gpt-5');
        writeFileSync(file, prefix + '{"private transcript":\n');
        await assert.rejects(scan(file), /Codex.*malformed history record/i);
        writeFileSync(file, prefix + '{"private transcript":garbage');
        await assert.rejects(scan(file), /Codex.*malformed history record/i);
        const link = join(home, 'linked.jsonl');
        symlinkSync(file, link);
        await assert.rejects(scan(link), /Codex could not be read/);
    } finally { rmSync(home, { recursive: true, force: true }); }
});

test('Node Codex merges repeated rollout sessions, orders switches by time, and skips subagents', async () => {
    const home = mkdtempSync(join(tmpdir(), 'tides-node-codex-'));
    try {
        const root = join(home, 'sessions');
        mkdirSync(root);
        const meta = { type: 'session_meta', payload: { id: 'private-id', timestamp: at(0), model_provider: 'openai', base_instructions: 'private prompt' } };
        const turn = (seconds, model) => ({ type: 'turn_context', timestamp: at(seconds), payload: { model, content: 'private reply' } });
        writeFileSync(join(root, 'rollout-main.jsonl'), [meta, turn(4, 'gpt-5'), turn(1, 'gpt-5'), turn(3, 'gpt-5-codex')].map(JSON.stringify).join('\n') + '\n');
        writeFileSync(join(root, 'rollout-repeat.jsonl'), [meta, turn(1, 'gpt-5')].map(JSON.stringify).join('\n') + '\n');
        writeFileSync(join(root, 'rollout-agent.jsonl'), [
            { type: 'session_meta', payload: { id: 'private-agent', parent_thread_id: 'private-id', timestamp: at(0) } },
            turn(2, 'gpt-5-nano'),
        ].map(JSON.stringify).join('\n') + '\n');
        const result = await exportLocalMetadata([source('Codex', root)]);
        assert.deepEqual(result.events, [
            { time: Date.UTC(2025, 0, 1), model: 'openai/gpt-5', kind: 'session' },
            { time: Date.UTC(2025, 0, 1) + 3000, model: 'openai/gpt-5-codex', kind: 'switch', fromModel: 'openai/gpt-5', fromTime: Date.UTC(2025, 0, 1) },
            { time: Date.UTC(2025, 0, 1) + 4000, model: 'openai/gpt-5', kind: 'switch', fromModel: 'openai/gpt-5-codex', fromTime: Date.UTC(2025, 0, 1) + 3000 },
        ]);
        assert.doesNotMatch(JSON.stringify(result), /private|prompt|reply|sessionId|messageId/);
    } finally { rmSync(home, { recursive: true, force: true }); }
});

test('Node Claude Code counts main-thread assistant messages once, from the first user turn', async () => {
    const home = mkdtempSync(join(tmpdir(), 'tides-node-claude-'));
    try {
        const root = join(home, 'projects');
        mkdirSync(root);
        const message = (seconds, id, model) => ({ type: 'assistant', timestamp: at(seconds), message: {
            id, role: 'assistant', model, content: 'private reply',
        } });
        writeFileSync(join(root, 'main.jsonl'), [
            { type: 'user', timestamp: at(0), message: { content: 'private prompt' } },
            message(1, 'private-message', 'claude-sonnet-4-5'),
            message(2, 'private-message', 'claude-sonnet-4-5'),
            { ...message(3, 'child', 'claude-haiku-4-5'), isSidechain: true },
            message(4, 'private-switch', 'claude-opus-4-6'),
        ].map(JSON.stringify).join('\n') + '\n');
        writeFileSync(join(root, 'agent-other.jsonl'), JSON.stringify(message(5, 'agent', 'claude-haiku-4-5')) + '\n');
        const subagents = join(root, 'subagents');
        mkdirSync(subagents);
        const child = join(subagents, 'child.jsonl');
        writeFileSync(child, JSON.stringify(message(5, 'child', 'claude-haiku-4-5')) + '\n');
        await assert.rejects(exportLocalMetadata([source('Claude Code', child)]), /No model observations found/);
        const result = await exportLocalMetadata([source('Claude Code', root)]);
        assert.deepEqual(result.events, [
            { time: Date.UTC(2025, 0, 1), model: 'anthropic/claude-sonnet-4-5', kind: 'session' },
            { time: Date.UTC(2025, 0, 1) + 4000, model: 'anthropic/claude-opus-4-6', kind: 'switch', fromModel: 'anthropic/claude-sonnet-4-5', fromTime: Date.UTC(2025, 0, 1) },
        ]);
        assert.doesNotMatch(JSON.stringify(result), /private|prompt|reply|sessionId|messageId/);
    } finally { rmSync(home, { recursive: true, force: true }); }
});
