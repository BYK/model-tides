import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const binary = process.argv[2];
if (!binary) throw new Error('Pass the host-platform Model Tides binary.');
const command = resolve(binary);
const root = mkdtempSync(join(tmpdir(), 'model-tides-standalone-'));
try {
    const home = join(root, 'home');
    const data = join(home, '.local/share/opencode');
    mkdirSync(data, { recursive: true });
    const db = new DatabaseSync(join(data, 'opencode.db'));
    try {
        db.exec(`CREATE TABLE session (id TEXT PRIMARY KEY, time_created INTEGER);
            CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT);`);
        db.prepare('INSERT INTO session VALUES (?, ?)').run('private-session-id', Date.UTC(2026, 8, 28));
        db.prepare('INSERT INTO message VALUES (?, ?, ?, ?)').run('private-message-id', 'private-session-id',
            Date.UTC(2026, 8, 28, 12), JSON.stringify({ role: 'assistant', providerID: 'openai', modelID: 'gpt-5', content: 'private prompt and reply' }));
        db.prepare('INSERT INTO message VALUES (?, ?, ?, ?)').run('private-message-2', 'private-session-id',
            Date.UTC(2026, 8, 28, 16), JSON.stringify({ role: 'assistant', providerID: 'openai', modelID: 'gpt-5' }));
        db.prepare('INSERT INTO message VALUES (?, ?, ?, ?)').run('private-message-3', 'private-session-id',
            Date.UTC(2026, 8, 29, 11), JSON.stringify({ role: 'assistant', providerID: 'anthropic', modelID: 'claude-sonnet-4-5' }));
    } finally { db.close(); }
    const pi = join(home, '.pi/agent/sessions/--project--');
    mkdirSync(pi, { recursive: true });
    writeFileSync(join(pi, '2026-09-28_private-pi-id.jsonl'), [
        { type: 'session', version: 3, id: 'private-pi-id', cwd: '/private/path', timestamp: '2026-09-28T08:00:00Z' },
        { type: 'message', id: 'private-pi-message', parentId: null, timestamp: '2026-09-28T10:00:00Z', message: {
            role: 'assistant', provider: 'openai', model: 'gpt-5', timestamp: Date.UTC(2026, 8, 28, 10),
            content: [{ type: 'text', text: 'private Pi reply' }],
        } },
        { type: 'message', id: 'private-pi-branch', parentId: null, timestamp: '2026-09-29T10:00:00Z', message: {
            role: 'assistant', provider: 'anthropic', model: 'claude-haiku-4-5', timestamp: Date.UTC(2026, 8, 29, 10),
            content: [{ type: 'text', text: 'private Pi reply' }],
        } },
    ].map(JSON.stringify).join('\n') + '\n');
    const copilot = join(home, '.copilot/session-state/fixture');
    mkdirSync(copilot, { recursive: true });
    writeFileSync(join(copilot, 'events.jsonl'), [
        { type: 'session.start', data: { sessionId: 'private-copilot-id', selectedModel: 'auto' }, timestamp: '2026-09-28T00:00:00Z' },
        { type: 'assistant.message', data: { model: 'gpt-5', content: 'private Copilot reply' }, timestamp: '2026-09-28T12:00:00Z' },
    ].map(JSON.stringify).join('\n') + '\n');
    const vscode = process.platform === 'darwin' ?
        join(home, 'Library/Application Support/Code/User/globalStorage/emptyWindowChatSessions') :
        join(root, 'config/Code/User/globalStorage/emptyWindowChatSessions');
    mkdirSync(vscode, { recursive: true });
    writeFileSync(join(vscode, 'fixture.json'), JSON.stringify({ version: 3, sessionId: 'private-vscode-id',
        responderUsername: 'GitHub Copilot', requests: [{ timestamp: Date.UTC(2026, 8, 29, 12),
            modelId: 'claude-sonnet-4.5', modelState: { value: 1 }, response: ['private Copilot reply'] }] }));

    const bin = join(root, 'bin');
    mkdirSync(bin);
    symlinkSync(command, join(bin, 'model-tides'));
    const env = { ...process.env, CODEX_HOME: '', CLAUDE_CONFIG_DIR: '', COPILOT_HOME: '',
        HOME: home, XDG_CONFIG_HOME: join(root, 'config'),
        XDG_DATA_HOME: join(root, 'data'), PATH: bin };
    const help = spawnSync('model-tides', ['--help'], { encoding: 'utf8', env, cwd: root, timeout: 20_000 });
    assert.ifError(help.error);
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, /upload.*contribute.*withdraw/s);
    assert.match(help.stdout, /key\s+Reveal your local owner key/);
    const bare = spawnSync('model-tides', [], { encoding: 'utf8', env, cwd: root, timeout: 20_000 });
    assert.ifError(bare.error);
    assert.equal(bare.status, 0, bare.stderr);
    assert.match(bare.stdout, /Usage: model-tides/);
    const redirectedKey = spawnSync('model-tides', ['key'], {
        encoding: 'utf8', env, cwd: root, input: 'YES\n', timeout: 20_000,
    });
    assert.ifError(redirectedKey.error);
    assert.equal(redirectedKey.status, 1);
    assert.match(redirectedKey.stderr, /interactive terminal/);
    const output = join(root, 'metadata.json');
    const exported = spawnSync('model-tides', ['export', '--output', output], { encoding: 'utf8', env, cwd: root, timeout: 20_000 });
    assert.ifError(exported.error);
    assert.equal(exported.status, 0, exported.stderr);
    const json = readFileSync(output, 'utf8');
    assert.deepEqual(JSON.parse(json), { format: 'model-tides-daily', version: 2, source: 'multiple', days: [
        { day: '2026-09-28', models: { 'github-copilot/gpt-5': 1, 'openai/gpt-5': 2 } },
        { day: '2026-09-29', models: { 'anthropic/claude-haiku-4-5': 1, 'anthropic/claude-sonnet-4-5': 1,
            'github-copilot/claude-sonnet-4.5': 1 } },
    ] });
    assert.doesNotMatch(json, /private-(?:session|message|pi|copilot|vscode)|private prompt and reply|private Pi reply|private Copilot reply|\/private\/path/);
    console.log('Standalone help and synthetic read-only SQLite/Pi/Copilot export passed.');
} finally { rmSync(root, { recursive: true, force: true }); }
