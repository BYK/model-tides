import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

test('standalone verification never falls through to another model-tides on PATH', () => {
    const root = mkdtempSync(join(tmpdir(), 'model-tides-verifier-'));
    try {
        const binary = join(root, 'downloaded-binary');
        writeFileSync(binary, 'not executable', { mode: 0o644 });
        const fallback = join(root, 'fallback');
        mkdirSync(fallback);
        const cli = fileURLToPath(new URL('../scripts/contribute.mjs', import.meta.url));
        writeFileSync(join(fallback, 'model-tides'), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(cli)} "$@"\n`, {
            mode: 0o755,
        });
        const verifier = fileURLToPath(new URL('../scripts/verify-standalone.mjs', import.meta.url));
        const result = spawnSync(process.execPath, [verifier, binary], {
            cwd: root, encoding: 'utf8', timeout: 20_000,
            env: { ...process.env, PATH: `${fallback}${delimiter}${process.env.PATH ?? ''}` },
        });
        assert.notEqual(result.status, 0, 'An unexecutable target must fail even if another CLI is on PATH.');
        assert.doesNotMatch(result.stdout, /Standalone help and synthetic read-only SQLite\/Pi\/Copilot export passed/);
    } finally { rmSync(root, { recursive: true, force: true }); }
});
