import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createWriteStream, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { createZstdCompress } from 'node:zlib';
import test from 'node:test';
import { parseDailyDocument } from '../src/daily-usage.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const isolatedEnvironment = { ...process.env, CODEX_HOME: '', CLAUDE_CONFIG_DIR: '', COPILOT_HOME: '' };

test('npm package includes only the Node scanner, metadata validator, and command, without Python or the app', async () => {
    const app = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    const cli = JSON.parse(readFileSync(join(root, 'cli/package.json'), 'utf8'));
    assert.equal(app.private, true, 'never publish the site source as the CLI');
    assert.equal(cli.name, 'model-tides');
    assert.deepEqual(cli.bin, { 'model-tides': 'dist/scripts/contribute.mjs' });
    const output = execFileSync('npm', ['pack', './cli', '--dry-run', '--json'], { cwd: root, encoding: 'utf8' });
    const [packageInfo] = JSON.parse(output);
    const names = packageInfo.files.map((file) => file.path).sort();
    assert.deepEqual(names, [
        'LICENSE', 'README.md',
        'dist/scripts/contribute.mjs', 'dist/scripts/history-scanner.mjs',
        'dist/src/daily-usage.js', 'dist/src/usage-data.js', 'dist/src/weekly-snapshot.js', 'package.json',
    ]);
    assert.equal(packageInfo.name, 'model-tides');
    assert.equal(packageInfo.version, cli.version);
    const directory = mkdtempSync(join(tmpdir(), 'model-tides-bin-'));
    try {
        const bin = join(directory, 'model-tides');
        symlinkSync(join(root, 'cli/dist/scripts/contribute.mjs'), bin);
        assert.throws(() => execFileSync('node', [bin, 'upload', '--wrong'], {
            cwd: directory, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
        }), (error) => error.status === 1 && /Usage: model-tides upload/.test(error.stderr));
        const file = join(directory, 'metadata.json');
        writeFileSync(file, JSON.stringify({
            format: 'model-tides-daily', version: 2, source: 'test',
            days: [{ day: '2026-09-28', models: { 'openai/gpt-5': 1 } }],
        }));
        const interceptor = join(directory, 'registry.mjs');
        writeFileSync(interceptor, 'globalThis.fetch = () => { throw new Error("Unexpected network request before consent."); };');
        const review = execFileSync('node', ['--import', interceptor, bin, 'upload', '--input', file], {
            cwd: directory, encoding: 'utf8', input: 'NO\n',
            env: { ...isolatedEnvironment, HOME: directory, XDG_CONFIG_HOME: directory },
        });
        assert.match(review, /Week of 2026-09-28\s+openai\/gpt-5: 1/);
        assert.match(review, /Type YES to confirm/);
        assert.doesNotMatch(review, /Public link:/);

        const id = '0199abcf-22aa-7333-8abc-0123456789ab';
        const token = 's'.repeat(43);
        writeFileSync(interceptor, `globalThis.fetch = async (url, options) => {
            if (url !== 'https://modeltides.dev/api/contributions/personal-v2' || options?.method !== 'POST' ||
                options.headers['X-Model-Tides-Schema'] !== 'weekly-v2') {
                throw new Error('Unexpected network request: ' + String(url) + ' ' + String(options?.method));
            }
            return Response.json({ id: '${id}', token: '${token}', published: true, inAggregate: false, metricVersion: 2,
                url: 'https://modeltides.dev/u/${id}' }, { status: 201 });
        };`);
        const environment = { ...isolatedEnvironment, HOME: directory, XDG_CONFIG_HOME: join(directory, 'config') };
        const uploaded = execFileSync('node', ['--import', interceptor, bin, 'upload', '--input', file], {
            cwd: directory, encoding: 'utf8', input: 'YES\n', env: environment,
        });
        assert.match(uploaded, new RegExp(`Personal chart: https://modeltides\\.dev/u/${id}`));
        assert.match(uploaded, /not added to the community aggregate/);
        assert.doesNotMatch(uploaded, new RegExp(token));
        const savedKey = join(directory, 'config/model-tides/contribution.json');
        assert.equal(statSync(savedKey).mode & 0o777, 0o600);
        const repeatedLink = execFileSync('node', [bin, 'link'], { cwd: directory, encoding: 'utf8', env: environment });
        assert.match(repeatedLink, new RegExp(`^Public link: https://modeltides\\.dev/u/${id}\\n`));
        assert.match(repeatedLink, /link works only while your personal report is shared/);
        assert.doesNotMatch(repeatedLink, new RegExp(token));

        writeFileSync(interceptor, `globalThis.fetch = async (url, options) => {
            if (url === 'https://modeltides.dev/api/contributions/${id}' && options?.method === undefined) {
                return Response.json({ id: '${id}', published: false, inAggregate: false, metricVersion: 2, revision: 0,
                    counts: [{ week: '2026-09-28', model: 'openai/gpt-5', count: 1 }] });
            }
            if (options?.method !== 'POST' || options?.headers?.Authorization !== 'Bearer ${token}') {
                throw new Error('Share requires the existing owner key.');
            }
            if (url === 'https://modeltides.dev/api/contributions/${id}/share') {
                if (options.headers['X-Model-Tides-Reviewed-Revision'] !== '0') throw new Error('Reviewed revision required.');
                return Response.json({ id: '${id}', published: true, url: 'https://modeltides.dev/u/${id}' });
            }
            if (url === 'https://modeltides.dev/api/contributions/${id}/unshare') {
                return Response.json({ id: '${id}', published: false });
            }
            throw new Error('Unexpected sharing request.');
        };`);
        const shared = execFileSync('node', ['--import', interceptor, bin, 'share'], {
            cwd: directory, encoding: 'utf8', input: 'YES\n', env: environment,
        });
        assert.match(shared, /Week of 2026-09-28\s+openai\/gpt-5: 1/);
        assert.match(shared, new RegExp(`Public link: https://modeltides\\.dev/u/${id}`));
        const hidden = execFileSync('node', ['--import', interceptor, bin, 'unshare'], {
            cwd: directory, encoding: 'utf8', input: 'YES\n', env: environment,
        });
        assert.match(hidden, /personal report is hidden/);

        const history = join(directory, '.codex/sessions/2025/01/01');
        mkdirSync(history, { recursive: true });
        writeFileSync(join(history, 'rollout-test.jsonl'), [
            { timestamp: '2025-01-01T00:00:00Z', type: 'session_meta', payload: { id: 'private-id', timestamp: '2025-01-01T00:00:00Z' } },
            { timestamp: '2025-01-01T00:00:01Z', type: 'turn_context', payload: { model: 'gpt-5', content: 'private prompt' } },
        ].map(JSON.stringify).join('\n') + '\n');
        const exportPath = join(directory, 'export.json');
        const saved = execFileSync('node', [bin, 'export', '--output', exportPath], {
            cwd: directory, encoding: 'utf8', env: { ...isolatedEnvironment, HOME: directory, XDG_CONFIG_HOME: directory },
        });
        assert.match(saved, /Use --input to review weekly counts locally before sharing/);
        const exported = readFileSync(exportPath, 'utf8');
        assert.deepEqual(parseDailyDocument(JSON.parse(exported)).days, [
            { day: '2025-01-01', models: { 'openai/gpt-5': 1 } },
        ]);
        assert.doesNotMatch(exported, /private|prompt|content|session_meta/i);
        const plain = join(history, 'rollout-test.jsonl');
        await pipeline(Readable.from([readFileSync(plain)]), createZstdCompress(), createWriteStream(`${plain}.zst`));
        rmSync(plain);
        const compressedExport = join(directory, 'compressed.json');
        execFileSync(process.execPath, [bin, 'export', '--output', compressedExport], {
            cwd: directory, encoding: 'utf8', env: { ...environment, PATH: '' },
        });
        assert.deepEqual(JSON.parse(readFileSync(compressedExport, 'utf8')).days, JSON.parse(exported).days);
        rmSync(join(directory, '.codex'), { recursive: true, force: true });
        const pi = join(directory, '.pi/agent/sessions/--project--');
        mkdirSync(pi, { recursive: true });
        writeFileSync(join(pi, '2025-01-01_private-id.jsonl'), [
            { type: 'session', version: 3, id: 'private-id', cwd: '/private/path', timestamp: '2025-01-01T00:00:00Z' },
            { type: 'message', id: 'private-message', parentId: null, timestamp: '2025-01-01T00:00:01Z', message: {
                role: 'assistant', provider: 'openai', model: 'gpt-5', timestamp: Date.UTC(2025, 0, 1, 0, 0, 1),
                content: [{ type: 'text', text: 'private reply' }],
            } },
        ].map(JSON.stringify).join('\n') + '\n');
        const piExport = join(directory, 'pi-export.json');
        execFileSync(process.execPath, [bin, 'export', '--output', piExport], {
            cwd: directory, encoding: 'utf8', env: { ...environment, PATH: '' },
        });
        assert.deepEqual(JSON.parse(readFileSync(piExport, 'utf8')), {
            format: 'model-tides-daily', version: 2, source: 'pi',
            days: [{ day: '2025-01-01', models: { 'openai/gpt-5': 1 } }],
        });
        const piReview = execFileSync(process.execPath, ['--import', interceptor, bin, 'upload', '--input', piExport], {
            cwd: directory, encoding: 'utf8', input: 'NO\n', env: environment,
        });
        assert.match(piReview, /Week of 2024-12-30\s+openai\/gpt-5: 1/);
        assert.doesNotMatch(piReview, /private-id|private reply|private\/path|Public link:/i);
        rmSync(join(directory, '.pi'), { recursive: true, force: true });
        const copilot = join(directory, '.copilot/session-state/fixture');
        mkdirSync(copilot, { recursive: true });
        writeFileSync(join(copilot, 'events.jsonl'), [
            { type: 'session.start', data: { sessionId: 'private-copilot-session', selectedModel: 'auto' }, timestamp: '2025-01-01T00:00:00Z' },
            { type: 'assistant.message', data: { model: 'gpt-5', content: 'private reply' }, timestamp: '2025-01-01T00:00:01Z' },
        ].map(JSON.stringify).join('\n') + '\n');
        const vscode = join(directory, 'config/Code/User/globalStorage/emptyWindowChatSessions');
        mkdirSync(vscode, { recursive: true });
        writeFileSync(join(vscode, 'private.json'), JSON.stringify({ version: 3, sessionId: 'private-vscode',
            responderUsername: 'GitHub Copilot', requests: [{ timestamp: Date.UTC(2025, 0, 1, 0, 0, 2),
                modelId: 'claude-sonnet-4.5', modelState: { value: 1 }, response: ['private reply'] }] }));
        const copilotExport = join(directory, 'copilot-export.json');
        execFileSync(process.execPath, [bin, 'export', '--output', copilotExport], {
            cwd: directory, encoding: 'utf8', env: { ...environment, PATH: '' },
        });
        assert.deepEqual(JSON.parse(readFileSync(copilotExport, 'utf8')), {
            format: 'model-tides-daily', version: 2, source: 'multiple',
            days: [{ day: '2025-01-01', models: {
                'github-copilot/claude-sonnet-4.5': 1, 'github-copilot/gpt-5': 1,
            } }],
        });
        assert.doesNotMatch(readFileSync(copilotExport, 'utf8'), /private|reply|session|selectedModel|timestamp/);
    } finally { rmSync(directory, { recursive: true, force: true }); }
});
