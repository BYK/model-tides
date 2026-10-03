#!/usr/bin/env node
/** Discover local harnesses, show the exact weekly snapshot, then ask before sending it. */
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { isSea } from 'node:sea';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { brotliCompressSync } from 'node:zlib';
import { scanHistory, scanHistoryActive, scanOpenCode, scanOpenCodeActive, scanPiActive } from './history-scanner.mjs';
import { parseUsageDocument, MAX_EVENTS, MAX_JSON_BYTES } from '../src/usage-data.ts';
import { parseDailyDocument } from '../src/daily-usage.ts';
import { buildWeeklySnapshot, buildActiveWeeklySnapshot, parseOwnedReport } from '../src/weekly-snapshot.ts';

const api = 'https://modeltides.dev/api/contributions';
const credential = join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'model-tides', 'contribution.json');

const regular = (path) => {
    try { return lstatSync(path).isFile(); } catch { return false; }
};
const directory = (path) => {
    try { return lstatSync(path).isDirectory(); } catch { return false; }
};

function hasHistory(root, source) {
    if (source !== 'codex' && source !== 'claude-code' && source !== 'pi') throw new TypeError('Unsupported history source.');
    if (!directory(root)) return false;
    const pending = [root];
    try {
        while (pending.length) {
            const current = pending.pop();
            for (const entry of readdirSync(current, { withFileTypes: true })) {
                if (entry.isDirectory()) {
                    if (source !== 'claude-code' || entry.name !== 'subagents') pending.push(join(current, entry.name));
                } else if (entry.isFile() && (source === 'codex'
                    ? entry.name.startsWith('rollout-') && /\.jsonl(?:\.zst)?$/.test(entry.name)
                    : entry.name.endsWith('.jsonl') && (source === 'pi' || !entry.name.startsWith('agent-')))) {
                    return true;
                }
            }
        }
    } catch {
        throw new Error('Could not scan local history directories.');
    }
    return false;
}

function readMetadata(bytes) {
    if (bytes.length > MAX_JSON_BYTES) throw new Error('Metadata exceeds the local import limit.');
    try {
        return parseDailyDocument(JSON.parse(bytes.toString('utf8')));
    } catch (error) {
        if (error instanceof SyntaxError) throw new TypeError('Expected a Model Tides v2 daily activity file.');
        throw error;
    }
}

export function collectSources(home = homedir()) {
    const opencode = join(home, '.local/share/opencode/opencode.db');
    const codex = join(home, '.codex');
    const claude = join(home, '.claude/projects');
    const pi = join(home, '.pi/agent/sessions');
    return [
        ...(regular(opencode) ? [{ name: 'OpenCode', path: opencode }] : []),
        ...(hasHistory(codex, 'codex') ? [{ name: 'Codex', path: codex }] : []),
        ...(hasHistory(claude, 'claude-code') ? [{ name: 'Claude Code', path: claude }] : []),
        ...(hasHistory(pi, 'pi') ? [{ name: 'Pi', path: pi }] : []),
    ];
}

export function snapshotFromDocuments(documents) {
    return buildWeeklySnapshot((function* () {
        for (const document of documents) {
            const parsed = parseUsageDocument(document);
            if (parsed.source === 'example') throw new Error('Mock data cannot be contributed.');
            yield* parsed.events;
        }
    })());
}

export function snapshotFromDailyDocuments(documents) {
    const parsed = documents.map(parseDailyDocument);
    if (parsed.some((document) => document.source === 'example')) throw new Error('Mock data cannot be contributed.');
    return buildActiveWeeklySnapshot(parsed);
}

async function documentsFromSources(sources, onProgress = () => {}) {
    const documents = [];
    for (const source of sources) {
        onProgress(`Scanning ${source.name} history…`);
        let document;
        try {
            switch (source.name) {
                case 'OpenCode': document = scanOpenCode(source.path); break;
                case 'Codex': document = await scanHistory('codex', source.path); break;
                case 'Claude Code': document = await scanHistory('claude-code', source.path); break;
                default: throw new TypeError('Unsupported history source.');
            }
        } catch (error) {
            if (error?.message === 'A complete history record is malformed.') {
                throw new Error(`${source.name} has a malformed history record. Nothing was exported.`);
            }
            throw new Error(`${source.name} could not be read. Check its local history.`, { cause: error });
        }
        if (Buffer.byteLength(JSON.stringify(document)) > MAX_JSON_BYTES) {
            throw new Error(`${source.name} metadata exceeds the export limit.`);
        }
        const parsed = parseUsageDocument(document);
        if (!parsed.events.length) {
            onProgress(`${source.name} has no model observations; skipped.`);
            continue;
        }
        documents.push(parsed);
        onProgress(`${source.name} scan complete.`);
    }
    return documents;
}

export async function exportLocal(sources, onProgress) {
    return snapshotFromDailyDocuments(await activeDocumentsFromSources(sources, onProgress));
}

async function activeDocumentsFromSources(sources, onProgress = () => {}) {
    const documents = [];
    for (const source of sources) {
        onProgress(`Scanning ${source.name} history…`);
        const document = await (async () => {
            try {
                switch (source.name) {
                    case 'OpenCode': return scanOpenCodeActive(source.path);
                    case 'Codex': return await scanHistoryActive('codex', source.path);
                    case 'Claude Code': return await scanHistoryActive('claude-code', source.path);
                    case 'Pi': return await scanPiActive(source.path);
                    default: throw new TypeError('Unsupported history source.');
                }
            } catch (error) {
                if (error?.message === 'A complete history record is malformed.') {
                    throw new Error(`${source.name} has a malformed history record. Nothing was exported.`);
                }
                throw new Error(`${source.name} could not be read. Check its local history.`, { cause: error });
            }
        })();
        if (!document.days.length) {
            onProgress(`${source.name} has no model observations; skipped.`);
            continue;
        }
        if (Buffer.byteLength(JSON.stringify(document)) > MAX_JSON_BYTES) throw new Error(`${source.name} activity exceeds the export limit.`);
        documents.push(parseDailyDocument(document));
        onProgress(`${source.name} scan complete.`);
    }
    if (!documents.length) throw new Error('No model observations found.');
    return documents;
}

export async function exportActiveLocalMetadata(sources, onProgress) {
    const documents = await activeDocumentsFromSources(sources, onProgress);
    const days = new Map();
    for (const document of documents) for (const { day, models: daily } of document.days) {
        const models = days.get(day) ?? new Map();
        for (const [model, count] of Object.entries(daily)) models.set(model, (models.get(model) ?? 0) + count);
        days.set(day, models);
    }
    const combined = parseDailyDocument({ format: 'model-tides-daily', version: 2,
        source: documents.length === 1 ? documents[0].source : 'multiple',
        days: [...days].sort(([a], [b]) => a.localeCompare(b)).map(([day, models]) => ({
            day, models: Object.fromEntries([...models].sort(([a], [b]) => a.localeCompare(b))),
        })) });
    if (Buffer.byteLength(JSON.stringify(combined)) > MAX_JSON_BYTES) throw new Error('Combined activity exceeds the export limit.');
    return combined;
}

export async function exportLocalMetadata(sources, onProgress) {
    const documents = await documentsFromSources(sources, onProgress);
    const events = documents.flatMap(({ events }) => events);
    if (events.length > MAX_EVENTS) throw new Error('Combined history exceeds the metadata export limit. Export one harness at a time.');
    const document = parseUsageDocument({
        format: 'model-tides', version: 1,
        source: documents.length === 1 ? documents[0].source : 'multiple',
        events: events.sort((left, right) => left.time - right.time),
    });
    if (!document.events.length) throw new Error('No model observations found.');
    return document;
}

export async function publishSnapshot(snapshot, owner = null, fetchImpl = fetch, endpoint = api,
    published = null, inAggregate = null, reviewedRevision = null) {
    if (owner && (typeof published !== 'boolean' || typeof inAggregate !== 'boolean')) throw new TypeError('Expected report state.');
    const migrating = !!owner && snapshot.version === 2 && reviewedRevision !== null;
    if (migrating && (!Number.isSafeInteger(reviewedRevision) || reviewedRevision < 0)) throw new TypeError('Expected reviewed revision.');
    const body = brotliCompressSync(Buffer.from(JSON.stringify(snapshot)));
    const response = await fetchImpl(owner ? `${endpoint}/${owner.id}${migrating ? '/migrate-v2' : ''}` :
        `${endpoint}/${snapshot.version === 2 ? 'personal-v2' : 'personal'}`, {
        method: owner ? 'PUT' : 'POST',
        headers: {
            'Content-Type': 'application/vnd.model-tides.weekly+json',
            'Content-Encoding': 'br',
            'X-Model-Tides-Schema': `weekly-v${snapshot.version}`,
            ...(!owner ? { 'X-Model-Tides-Report': `personal-v${snapshot.version}` } : {}),
            ...(owner ? { Authorization: `Bearer ${owner.token}`,
                'X-Model-Tides-Expected-Visibility': published ? 'public' : 'private',
                'X-Model-Tides-Expected-Aggregate': inAggregate ? 'included' : 'excluded',
                ...(migrating ? { 'X-Model-Tides-Reviewed-Revision': String(reviewedRevision) } : {}) } : {}),
        },
        body,
    });
    if (!response.ok) throw new Error(`Upload failed (HTTP ${response.status}). No successful upload was confirmed; your local history is unchanged.`);
    return response.json();
}

export async function getOwnedReport(owner, fetchImpl = fetch, endpoint = api) {
    try {
        const response = await fetchImpl(`${endpoint}/${owner.id}`, {
            headers: { Authorization: `Bearer ${owner.token}` }, cache: 'no-store',
        });
        if (!response.ok) throw new TypeError('Unavailable report.');
        return parseOwnedReport(await response.json(), owner.id);
    } catch {
        throw new Error('Could not confirm personal report visibility and counts. No sharing change was started.');
    }
}

export async function setSharing(owner, published, fetchImpl = fetch, endpoint = api, reviewed = null) {
    if (published && (!reviewed || !reviewed.snapshot || !Number.isSafeInteger(reviewed.revision) || reviewed.revision < 0)) {
        throw new Error('Review every stored weekly count before sharing.');
    }
    const revision = reviewed?.revision;
    const response = await fetchImpl(`${endpoint}/${owner.id}/${published ? 'share' : 'unshare'}`, {
        method: 'POST', headers: { Authorization: `Bearer ${owner.token}`,
            ...(published ? { 'X-Model-Tides-Reviewed-Revision': String(revision) } : {}) },
    }).catch(() => null);
    if (response && !response.ok) throw new Error('Sharing was rejected. Review the current report before retrying.');
    try {
        if (!response) throw new TypeError('Sharing response unavailable.');
        const result = await response.json();
        if (result.id !== owner.id || result.published !== published ||
            (published && result.url !== `${new URL(endpoint).origin}/u/${owner.id}`)) {
            throw new TypeError('Invalid sharing response.');
        }
        return result;
    } catch {
        const current = await getOwnedReport(owner, fetchImpl, endpoint).catch(() => null);
        if (!current) throw new Error('Could not confirm personal report visibility. The change may have happened; check before retrying.');
        if (current.published !== published || (published &&
            (current.revision !== revision + 1 || JSON.stringify(current.snapshot) !== JSON.stringify(reviewed.snapshot)))) {
            throw new Error(`The personal report is ${current.published ? 'public' : 'hidden'}. The sharing change was not confirmed; review again before retrying.`);
        }
        return { id: owner.id, published, ...(published ? { url: `${new URL(endpoint).origin}/u/${owner.id}` } : {}) };
    }
}

export async function reportVisibility(owner, fetchImpl = fetch, endpoint = api) {
    try {
        const report = await getOwnedReport(owner, fetchImpl, endpoint);
        if (report.inAggregate === null) throw new TypeError('Unknown aggregate participation.');
        return report;
    } catch {
        throw new Error('Could not confirm personal report visibility and aggregate participation. No upload was started.');
    }
}

export async function setAggregate(owner, contribute, fetchImpl = fetch, endpoint = api, reviewed = null) {
    if (contribute && (!reviewed?.snapshot || !Number.isSafeInteger(reviewed.revision) || reviewed.revision < 0)) {
        throw new Error('Review every stored weekly count before contributing.');
    }
    const response = await fetchImpl(`${endpoint}/${owner.id}/${contribute ? 'contribute' : 'withdraw'}`, {
        method: 'POST', headers: { Authorization: `Bearer ${owner.token}`,
            ...(contribute ? { 'X-Model-Tides-Reviewed-Revision': String(reviewed.revision) } : {}) },
    }).catch(() => null);
    if (response && !response.ok) throw new Error('Aggregate change was rejected. Review your current report before retrying.');
    try {
        if (!response) throw new TypeError('Aggregate response unavailable.');
        const result = await response.json();
        if (result.id !== owner.id || result.inAggregate !== contribute) throw new TypeError('Invalid aggregate response.');
        return result;
    } catch {
        const current = await getOwnedReport(owner, fetchImpl, endpoint).catch(() => null);
        if (!current || current.inAggregate !== contribute || (contribute &&
            (current.revision !== reviewed.revision + 1 || JSON.stringify(current.snapshot) !== JSON.stringify(reviewed.snapshot)))) {
            throw new Error('Could not confirm the aggregate change. Check your report before retrying.');
        }
        return { id: owner.id, inAggregate: contribute };
    }
}

function loadCredential() {
    if (!existsSync(credential)) return null;
    const stats = lstatSync(credential);
    if (!stats.isFile() || (stats.mode & 0o077) !== 0) {
        throw new Error('Private key file must be a regular file readable only by you.');
    }
    if (stats.size > 4096) throw new Error('Invalid local private key file.');
    const owner = (() => {
        try { return JSON.parse(readFileSync(credential, 'utf8')); }
        catch (error) {
            if (error instanceof SyntaxError) throw new Error('Invalid local private key file.');
            throw error;
        }
    })();
    if (!owner || Object.keys(owner).sort().join() !== 'id,token' ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(owner.id) ||
        !/^[A-Za-z0-9_-]{43}$/.test(owner.token)) throw new Error('Invalid local private key file.');
    return owner;
}

function saveNewCredential(owner) {
    mkdirSync(dirname(credential), { recursive: true, mode: 0o700 });
    if (!directory(dirname(credential))) throw new Error('Private key directory must not be a symlink.');
    writeFileSync(credential, JSON.stringify(owner) + '\n', { mode: 0o600, flag: 'wx' });
}

async function confirm(question) {
    const prompt = createInterface({ input: process.stdin, output: process.stdout });
    try { return (await prompt.question(`${question} Type YES to confirm: `)) === 'YES'; }
    finally { prompt.close(); }
}

const help = `Model Tides — your models, over time

Usage: model-tides <command> [options]

  upload [--input activity.json]  Publish a personal weekly chart; do not enter the community aggregate
  contribute                   Add all stored weekly counts to the community aggregate after review
  withdraw                     Remove counts from the aggregate; keep your personal chart
  share                        Make a hidden personal chart viewable by its link
  unshare                      Hide your personal chart without deleting stored counts
  gist [--input activity.json]  Create an unlisted GitHub gist of weekly counts (requires gh)
  link                         Print your personal chart URL
  key                          Reveal your local owner key after confirmation on a terminal
  export [--output file.json]  Export daily model activity for offline use
  upload --rotate              Rotate your private replacement key
  upload --delete              Delete your stored report and its aggregate counts
  help                         Show this help

Uploads, aggregate opt-ins, personal shares, and gists preview stored counts before consent. Gists are unlisted, not private.`;

const hasGh = () => spawnSync('gh', ['--version'], { stdio: 'ignore', timeout: 2000 }).status === 0;

function preview(snapshot) {
    if (snapshot.weeks.length === 0) throw new Error('No model observations found.');
    for (const { week, models } of snapshot.weeks) {
        console.log(`Week of ${week}`);
        for (const [model, count] of Object.entries(models)) console.log(`  ${model}: ${count}`);
    }
}

async function createGist(snapshot, confirmGist = confirm) {
    console.log('The following weekly counts would go into an unlisted GitHub gist:');
    preview(snapshot);
    console.log('Anyone with the gist URL can read these counts. GitHub stores the gist and its revisions. No exact event times, source paths, prompts, replies, or session IDs are included.');
    if (!await confirmGist('Create this unlisted gist of weekly counts?')) return;
    const created = spawnSync('gh', ['gist', 'create', '--filename', 'model-tides-weekly.json', '-'], {
        input: JSON.stringify(snapshot) + '\n', encoding: 'utf8', timeout: 30_000, maxBuffer: 1024,
    });
    if (created.error?.code === 'ENOENT') throw new Error('GitHub CLI (gh) is required to create a gist.');
    if (created.error || created.status !== 0) throw new Error('Could not create the unlisted gist. Check that gh is authenticated with gist access.');
    const url = created.stdout.trim();
    const match = /^https:\/\/gist\.github\.com\/(?:(\w[\w-]{0,38})\/)?([a-f0-9]{32})$/.exec(url);
    if (!match) throw new Error('GitHub CLI returned an invalid gist URL.');
    console.log(`Unlisted gist: ${url}`);
    const identity = match[1] ? null : spawnSync('gh', ['api', 'user', '--jq', '.login'], {
        encoding: 'utf8', timeout: 10_000, maxBuffer: 256,
    });
    const owner = match[1] ?? (identity?.status === 0 ? identity.stdout.trim() : '');
    if (/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(owner)) {
        console.log(`View in browser: https://modeltides.dev/gist#${owner}/${match[2]}`);
    } else {
        console.log('The gist was created. Its Model Tides viewer link could not be determined; open the gist URL above.');
    }
}

async function main() {
    const args = process.argv.slice(2);
    if (args.length === 0 || (args.length === 1 && (args[0] === 'help' || args[0] === '--help' || args[0] === '-h'))) {
        console.log(help);
        return;
    }
    if (args[0] === 'export') {
        if (args.length !== 1 && (args.length !== 3 || args[1] !== '--output' || !args[2])) {
            throw new Error('Usage: model-tides export [--output activity.json]');
        }
        const sources = collectSources();
        if (!sources.length) throw new Error('No supported harness history was found.');
        const document = await exportActiveLocalMetadata(sources, console.log);
        const bytes = Buffer.from(JSON.stringify(document) + '\n');
        if (bytes.length > MAX_JSON_BYTES) throw new Error('Combined metadata exceeds the export limit. Export one harness at a time.');
        const output = args[2] ?? 'model-tides.json';
        writeFileSync(output, bytes, { mode: 0o600, flag: 'wx' });
        console.log(`Saved ${document.days.length} active days to ${output}. Use --input to review weekly counts locally before sharing. This file contains model names and daily session counts; keep it private.`);
        return;
    }
    if (args[0] === 'gist') {
        if (args.length !== 1 && (args.length !== 3 || args[1] !== '--input' || !args[2])) {
            throw new Error('Usage: model-tides gist [--input activity.json]');
        }
        const input = args[2];
        if (input && !regular(input)) throw new Error('Input must be a regular metadata JSON file.');
        const sources = input ? [] : collectSources();
        if (!input && !sources.length) throw new Error('No supported harness history was found. Use --input for an existing metadata JSON.');
        const snapshot = input ? snapshotFromDailyDocuments([readMetadata(readFileSync(input))]) : await exportLocal(sources, console.log);
        await createGist(snapshot);
        return;
    }
    if (args[0] === 'link') {
        if (args.length !== 1) throw new Error('Usage: model-tides link');
        const owner = loadCredential();
        if (!owner) throw new Error('No private key file exists for this contribution.');
        console.log(`Public link: https://modeltides.dev/u/${owner.id}`);
        console.log('This link works only while your personal report is shared. Run model-tides share to publish it.');
        return;
    }
    if (args[0] === 'key') {
        if (args.length !== 1) throw new Error('Usage: model-tides key');
        if (!process.stdin.isTTY || !process.stdout.isTTY) {
            throw new Error('Use an interactive terminal to reveal your private owner key.');
        }
        const owner = loadCredential();
        if (!owner) throw new Error('No local private key exists. Upload a personal report first.');
        if (!await confirm('Reveal your private owner key on this terminal? Anyone who sees it can change your report.')) return;
        console.log(`Private owner key: ${owner.token}`);
        console.log('Paste it into the Donate your data form on your personal link. Never put the key in the URL.');
        return;
    }
    if (args[0] === 'contribute' || args[0] === 'withdraw') {
        if (args.length !== 1) throw new Error('Usage: model-tides contribute | withdraw');
        const owner = loadCredential();
        if (!owner) throw new Error('No local private key exists. Upload a personal report first.');
        const contribute = args[0] === 'contribute';
        const report = await getOwnedReport(owner);
        if (report.inAggregate === null) throw new Error('Could not confirm aggregate participation. Update the site and try again.');
        if (contribute) {
            if (!report.snapshot) throw new Error('Stored report is too large to review for aggregate contribution.');
            console.log('Review every stored weekly count before adding them to the community aggregate:');
            preview(report.snapshot);
        }
        if (!await confirm(contribute
            ? 'Add all these counts to the community aggregate? Your personal chart remains independent.'
            : 'Remove your counts from the community aggregate? Your personal chart remains available.')) return;
        await setAggregate(owner, contribute, fetch, api, report);
        console.log(contribute ? 'Counts added to the community aggregate.' : 'Counts removed from the aggregate. Your personal link remains available.');
        return;
    }
    if (args[0] === 'share' || args[0] === 'unshare') {
        if (args.length !== 1) throw new Error('Usage: model-tides share | unshare');
        const owner = loadCredential();
        if (!owner) throw new Error('No private key file exists for this report. Upload weekly counts first.');
        const published = args[0] === 'share';
        const report = published ? await getOwnedReport(owner) : null;
        if (report) {
            if (!report.snapshot) throw new Error('The stored report is too large to review. You can still hide or delete it.');
            console.log('Review every stored count below. Sharing publishes all of these weeks, including earlier uploads:');
            preview(report.snapshot);
        }
        if (!await confirm(published
            ? 'Publish all of these personal weekly counts at a public link?'
            : 'Hide your personal report? Aggregate participation stays as it is.')) return;
        await setSharing(owner, published, fetch, api, report);
        console.log(published ? `Public link: https://modeltides.dev/u/${owner.id}` :
            'Your personal report is hidden. Your aggregate participation is unchanged.');
        return;
    }
    if (args[0] !== 'upload') throw new Error(`Unknown command.\n\n${help}`);
    args.shift();
    const option = args[0];
    if (args.length > 2 || (option && !['--input', '--delete', '--rotate'].includes(option)) ||
        ((option === '--input') !== (args.length === 2))) {
        throw new Error('Usage: model-tides upload [--input activity.json | --delete | --rotate]');
    }
    const owner = loadCredential();
    if (option === '--delete' || option === '--rotate') {
        if (!owner) throw new Error('No private key file exists for this contribution.');
        if (!await confirm(option === '--delete' ? 'Delete your shared weekly counts?' : 'Rotate your private replacement key?')) return;
        const response = await fetch(`${api}/${owner.id}${option === '--rotate' ? '/rotate' : ''}`, {
            method: option === '--rotate' ? 'POST' : 'DELETE',
            headers: { Authorization: `Bearer ${owner.token}` },
        });
        if (!response.ok) throw new Error(`Request failed (HTTP ${response.status}).`);
        if (option === '--delete') {
            unlinkSync(credential);
            console.log('Your shared weekly counts were deleted.');
        } else {
            const { token } = await response.json();
            const temporary = `${credential}.new`;
            writeFileSync(temporary, JSON.stringify({ id: owner.id, token }) + '\n', { mode: 0o600, flag: 'wx' });
            renameSync(temporary, credential);
            console.log('Your private replacement key was rotated.');
        }
        return;
    }

    const sources = option === '--input' ? [{ name: 'metadata file', path: args[1] }] : collectSources();
    if (!sources.length) throw new Error('No supported harness history was found. Use --input for an existing metadata JSON.');
    if (option === '--input' && !regular(sources[0].path)) throw new Error('Input must be a regular metadata JSON file.');
    const snapshot = option === '--input'
        ? snapshotFromDailyDocuments([readMetadata(readFileSync(sources[0].path))])
        : await exportLocal(sources, console.log);
    console.log(`Checked ${sources.map(({ name }) => name).join(', ')}. The following weekly counts would be uploaded:`);
    preview(snapshot);
    console.log('Only the displayed weeks, model names, and counts are uploaded. No prompts, replies, paths, exact times, or session IDs.');
    const report = owner ? await reportVisibility(owner) : null;
    const published = report?.published ?? true;
    if (owner) {
        if (report.metricVersion === 1) {
            if (!report.snapshot) throw new Error('Earlier report is too large to review before replacing it. Withdraw or delete it separately.');
            console.log('This replaces ALL earlier start/switch counts with the reviewed active session-day counts while keeping your personal link and private key. Earlier stored weeks will be removed.');
        } else if (report.metricVersion !== 2) throw new Error('Unknown report metric. No upload was started.');
        console.log(published
            ? 'Your personal report is already public. These reviewed counts will be public immediately after replacement.'
            : 'Your personal report is private. Replacing these weeks keeps it private.');
        console.log(report.inAggregate ? 'Your counts are already in the community aggregate. Run model-tides withdraw to remove them.' :
            'Your counts are not in the community aggregate. Run model-tides contribute if you want to add them.');
    } else {
        console.log('Your personal chart will be viewable by anyone with its link. These counts will not enter the community aggregate.');
    }
    const gistAvailable = hasGh();
    if (gistAvailable) console.log('GitHub CLI detected. Choose GIST below to create an unlisted gist of these reviewed counts instead. Anyone with the gist URL can read them; GitHub keeps revisions.');
    const prompt = createInterface({ input: process.stdin, output: process.stdout });
    const choice = await (async () => {
        try {
            const selected = await prompt.question(`${owner ? 'Replace these weeks?' : 'Publish this personal chart?'} Type YES to confirm${gistAvailable ? ', GIST for an unlisted gist' : ''}, or anything else to cancel: `);
            if (selected === 'GIST' && gistAvailable) await createGist(snapshot, async () => true);
            return selected;
        } finally { prompt.close(); }
    })();
    if (choice === 'GIST') return;
    if (choice !== 'YES') return;
    const result = await publishSnapshot(snapshot, owner, fetch, api, published, report?.inAggregate ?? null,
        report?.metricVersion === 1 ? report.revision : null);
    if (!result || !/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(result.id) ||
        result.id !== (owner?.id ?? result.id) || typeof result.published !== 'boolean' ||
        typeof result.inAggregate !== 'boolean' || result.metricVersion !== snapshot.version ||
        (!owner && (typeof result.token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(result.token)))) {
        throw new Error('Invalid upload response.');
    }
    if ((!owner && (result.published !== true || result.inAggregate !== false ||
        result.url !== `https://modeltides.dev/u/${result.id}`)) ||
        (owner && (result.published !== published || result.inAggregate !== report.inAggregate))) {
        if (!owner) await fetch(`${api}/${result.id}`, { method: 'DELETE', headers: {
            Authorization: `Bearer ${result.token}` },
        }).catch(() => {});
        throw new Error('Upload response did not match the reviewed report state. Check your report before retrying.');
    }
    if (!owner) {
        try { saveNewCredential({ id: result.id, token: result.token }); }
        catch {
            const removed = await fetch(`${api}/${result.id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${result.token}` } });
            throw new Error(removed.ok ? 'Could not save your private key; the new contribution was removed.' :
                'Could not save your private key or remove the new contribution.');
        }
    }
    console.log(result.published ? `Personal chart: https://modeltides.dev/u/${result.id}` :
        'Your personal report is hidden. Run model-tides share to publish it.');
    console.log(report?.inAggregate ? 'Your earlier aggregate contribution remains active. Run model-tides withdraw to remove it.' :
        'These counts were not added to the community aggregate. Run model-tides contribute to opt in.');
    console.log('A separate private replacement key is stored in your local config directory. Never share it.');
}

if (isSea() || (process.argv[1] && existsSync(process.argv[1]) &&
    fileURLToPath(import.meta.url) === realpathSync(process.argv[1]))) {
    main().catch((error) => { console.error(error instanceof Error ? error.message : 'Could not contribute.'); process.exitCode = 1; });
}
