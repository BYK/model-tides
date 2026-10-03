/** Local-only history extraction. Only model names and times leave these readers. */
import { createReadStream, lstatSync, readdirSync } from 'node:fs';
import { basename, join, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createZstdDecompress } from 'node:zlib';
import { MAX_EVENTS, MAX_JSON_BYTES } from '../src/usage-data.ts';
import { parseDailyDocument } from '../src/daily-usage.ts';

const MAX_LINE_BYTES = MAX_JSON_BYTES;
const MAX_OBSERVATIONS = MAX_EVENTS * 5;
const stamp = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/;
const utf8 = new TextDecoder('utf-8', { fatal: true });
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const file = (path) => { try { return lstatSync(path).isFile(); } catch { return false; } };
const OPEN_CODE_QUERY = `
    SELECT message.session_id, message.time_created AS message_time,
           session.time_created AS session_time,
           json_extract(message.data, '$.providerID') AS provider_id,
           json_extract(message.data, '$.modelID') AS model_id
    FROM message INNER JOIN session ON session.id = message.session_id
    WHERE json_valid(message.data)
      AND json_extract(message.data, '$.role') = 'assistant'
      AND json_type(message.data, '$.providerID') = 'text'
      AND json_type(message.data, '$.modelID') = 'text'
    ORDER BY message.session_id, message.time_created, message.id
`;

function recordActivity(days, time, model) {
    if (!Number.isSafeInteger(time) || time < Date.UTC(1999, 11, 27) || time > Date.now() + 7 * 86_400_000 || !validModel(model)) return null;
    const day = new Date(time).toISOString().slice(0, 10);
    const models = days.get(day) ?? new Map();
    models.set(model, (models.get(model) ?? 0) + 1);
    days.set(day, models);
    return `${day}\u0000${model}`;
}

function activeDocument(source, days) {
    const document = { format: 'model-tides-daily', version: 2, source,
        days: [...days].sort(([a], [b]) => a.localeCompare(b)).map(([day, models]) => ({
            day, models: Object.fromEntries([...models].sort(([a], [b]) => a.localeCompare(b))),
        })) };
    return document.days.length ? parseDailyDocument(document) : document;
}

export function scanOpenCodeActive(path) {
    if (!file(path) || [`${path}-wal`, `${path}-shm`].some((sidecar) => {
        try { return lstatSync(sidecar).isSymbolicLink(); } catch { return false; }
    })) throw new Error('History path must be a regular file.');
    const db = new DatabaseSync(path, { readOnly: true });
    try {
        db.exec('PRAGMA query_only = ON; PRAGMA temp_store = FILE');
        const days = new Map();
        const previous = { session: null, seen: new Set() };
        for (const row of db.prepare(OPEN_CODE_QUERY).iterate()) {
            const { session_id, message_time, provider_id, model_id } = row;
            if (typeof provider_id !== 'string' || typeof model_id !== 'string' ||
                !provider_id || !model_id || provider_id.length > 100 || model_id.length > 200) continue;
            const model = `${provider_id}/${model_id}`;
            if (previous.session !== session_id) {
                previous.session = session_id;
                previous.seen.clear();
            }
            if (!Number.isSafeInteger(message_time) || Math.abs(message_time) > 8_640_000_000_000_000 || !validModel(model)) continue;
            const key = `${new Date(message_time).toISOString().slice(0, 10)}\u0000${model}`;
            if (previous.seen.has(key)) continue;
            if (recordActivity(days, message_time, model) !== null) previous.seen.add(key);
            if (days.size > MAX_EVENTS || previous.seen.size > MAX_OBSERVATIONS) throw new Error('Too many active days.');
        }
        return activeDocument('opencode', days);
    } finally { db.close(); }
}

export function scanOpenCode(path) {
    if (!file(path) || [`${path}-wal`, `${path}-shm`].some((sidecar) => {
        try { return lstatSync(sidecar).isSymbolicLink(); } catch { return false; }
    })) throw new Error('History path must be a regular file.');
    const db = new DatabaseSync(path, { readOnly: true });
    try {
        db.exec('PRAGMA query_only = ON; PRAGMA temp_store = FILE');
        const rows = db.prepare(OPEN_CODE_QUERY);
        const events = [];
        // The SQL order keeps one session's state at a time; never retain rows or transcripts.
        const previous = { session: null, model: null, time: null };
        for (const row of rows.iterate()) {
            const { session_id, message_time, session_time, provider_id, model_id } = row;
            if (typeof provider_id !== 'string' || typeof model_id !== 'string' ||
                !provider_id || !model_id || provider_id.length > 100 || model_id.length > 200 ||
                !Number.isSafeInteger(message_time)) continue;
            const model = `${provider_id}/${model_id}`;
            if (model.trim() !== model || /[\u0000-\u001f\u007f]/.test(model)) continue;
            if (previous.session !== session_id) {
                const time = Number.isSafeInteger(session_time) && session_time <= message_time ? session_time : message_time;
                events.push({ time, model, kind: 'session' });
                previous.session = session_id;
                previous.model = model;
                previous.time = time;
            } else if (previous.model !== model) {
                events.push({ time: message_time, model, kind: 'switch', fromModel: previous.model, fromTime: previous.time });
                previous.model = model;
                previous.time = message_time;
            }
            if (events.length > MAX_EVENTS) throw new Error('Too many model events.');
        }
        return { format: 'model-tides', version: 1, source: 'opencode', events };
    } finally { db.close(); }
}

function selectedPaths(root, source) {
    const stat = lstatSync(root);
    if (!stat.isDirectory() && !stat.isFile()) throw new Error('History path must be a regular file or directory.');
    const pending = [root];
    const paths = [];
    while (pending.length) {
        const current = pending.pop();
        if (file(current)) {
            const name = basename(current);
            if (source === 'codex'
                ? (name.endsWith('.jsonl') || name.endsWith('.jsonl.zst')) && (current === root || name.startsWith('rollout-'))
                : source === 'pi' ? name.endsWith('.jsonl')
                    : name.endsWith('.jsonl') && !name.startsWith('agent-') && !current.split(sep).includes('subagents')) paths.push(current);
            continue;
        }
        for (const entry of readdirSync(current, { withFileTypes: true })) {
            if (entry.isDirectory() && (source !== 'claude-code' || entry.name !== 'subagents')) pending.push(join(current, entry.name));
            else if (entry.isFile()) pending.push(join(current, entry.name));
        }
    }
    return paths.filter((path) => !path.endsWith('.zst') || !file(path.slice(0, -4))).sort();
}

function parseLine(line, allowIncomplete = false) {
    let text;
    try {
        text = utf8.decode(line);
        const value = JSON.parse(text);
        return object(value) ? value : null;
    } catch (error) {
        if (allowIncomplete && error instanceof SyntaxError &&
            (/Unexpected end of JSON input|Unterminated string in JSON/.test(error.message) ||
                error.message.includes(`at position ${text.length} `))) return null;
        throw new Error('A complete history record is malformed.');
    }
}

async function* records(path) {
    const compressed = path.endsWith('.zst');
    const input = createReadStream(path);
    const decoder = compressed ? createZstdDecompress() : null;
    if (decoder) {
        input.on('error', (error) => decoder.destroy(error));
        input.pipe(decoder);
    }
    const stream = decoder ?? input;
    const chunks = [];
    const pending = { size: 0 };
    const parse = () => parseLine(Buffer.concat(chunks));
    try {
        for await (const chunk of stream) {
            // Search native Buffer chunks; keep only one bounded JSONL record in memory.
            const cursor = { start: 0 };
            while (true) {
                const index = chunk.indexOf(10, cursor.start);
                if (index === -1) break;
                const part = chunk.subarray(cursor.start, index);
                pending.size += part.length;
                if (pending.size > MAX_LINE_BYTES) throw new Error('Oversized history record.');
                chunks.push(part);
                const record = parse();
                if (record) yield record;
                chunks.length = 0;
                pending.size = 0;
                cursor.start = index + 1;
            }
            if (cursor.start < chunk.length) {
                const part = chunk.subarray(cursor.start);
                pending.size += part.length;
                if (pending.size > MAX_LINE_BYTES) throw new Error('Oversized history record.');
                chunks.push(part);
            }
        }
        if (chunks.length) {
            // Only a syntactically incomplete plain final line is ignored.
            const record = parseLine(Buffer.concat(chunks), !compressed);
            if (record) yield record;
        }
    } finally {
        stream.destroy();
        input.destroy();
    }
}

function milliseconds(value) {
    if (typeof value !== 'string' || !stamp.test(value)) return null;
    const time = Date.parse(value);
    if (!Number.isSafeInteger(time) || Math.abs(time) > 8_640_000_000_000_000) return null;
    const parts = /^([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})/.exec(value);
    // Date.parse normalizes out-of-range calendar dates on some Node releases.
    const day = Number(parts[3]);
    const daysInMonth = new Date(Date.UTC(Number(parts[1]), Number(parts[2]), 0)).getUTCDate();
    if (Number(parts[1]) === 0 || day < 1 || day > daysInMonth ||
        Number(parts[4]) > 23 || Number(parts[5]) > 59 || Number(parts[6]) > 59) return null;
    return time;
}

function validModel(value) {
    return typeof value === 'string' && value.length > 0 && value.length <= 320 &&
        value.trim() === value && !/[\u0000-\u001f\u007f\ud800-\udfff]/u.test(value);
}

function codexModel(value, provider) {
    if (!validModel(value)) return null;
    if (value.includes('/')) return value;
    if (provider !== undefined && provider !== null && (!validModel(provider) || provider.includes('/'))) return null;
    const result = `${provider ?? 'openai'}/${value}`;
    return validModel(result) ? result : null;
}

function claudeModel(value) {
    if (!validModel(value)) return null;
    if (value.startsWith('anthropic/claude-')) return value;
    if (value.startsWith('claude-') || value.startsWith('anthropic.claude-') || value.includes('.anthropic.claude-')) {
        const result = `anthropic/${value}`;
        return validModel(result) ? result : null;
    }
    return null;
}

function subagent(meta) {
    const source = meta.source;
    return Boolean(meta.parent_thread_id) || meta.thread_source === 'subagent' ||
        (typeof source === 'string' && source.toLowerCase().includes('subagent')) ||
        (object(source) && Object.keys(source).some((key) => key.toLowerCase().includes('subagent')));
}

async function codexSession(path) {
    const state = { meta: null, observations: [] };
    for await (const record of records(path)) {
        const payload = record.payload;
        if (!object(payload)) continue;
        if (record.type === 'session_meta' && !state.meta) {
            state.meta = { id: payload.id, timestamp: payload.timestamp, model_provider: payload.model_provider };
            if (subagent(payload)) return null;
        } else if (record.type === 'turn_context' && state.meta) {
            const time = milliseconds(record.timestamp);
            const model = codexModel(payload.model, state.meta.model_provider);
            if (time !== null && model !== null) {
                state.observations.push([time, model]);
                if (state.observations.length > MAX_OBSERVATIONS) throw new Error('Too many observations.');
            }
        }
    }
    return state.meta && typeof state.meta.id === 'string' && state.observations.length
        ? [state.meta.id, milliseconds(state.meta.timestamp), state.observations] : null;
}

async function codexSessionId(path) {
    for await (const record of records(path)) {
        if (record.type !== 'session_meta') continue;
        const payload = record.payload;
        return object(payload) && !subagent(payload) && typeof payload.id === 'string' &&
            payload.id.length > 0 && payload.id.length <= 256 ? payload.id : null;
    }
    return null;
}

async function claudeSession(path) {
    const observations = [];
    const seen = new Set();
    let firstUser = null;
    for await (const record of records(path)) {
        if (record.isSidechain === true || record.agentId || record.agent_id) continue;
        const time = milliseconds(record.timestamp);
        if (time === null) continue;
        if (record.type === 'user' && record.isMeta !== true) firstUser = firstUser === null ? time : Math.min(firstUser, time);
        if (record.type !== 'assistant' || !object(record.message) || record.message.role !== 'assistant') continue;
        const model = claudeModel(record.message.model);
        if (model === null) continue;
        const id = record.message.id;
        if (typeof id === 'string') {
            if (seen.has(id)) continue;
            seen.add(id);
            if (seen.size > MAX_OBSERVATIONS) throw new Error('Too many message identifiers.');
        }
        observations.push([time, model]);
        if (observations.length > MAX_OBSERVATIONS) throw new Error('Too many observations.');
    }
    return observations.length ? [firstUser, observations] : null;
}

function appendEvents(events, start, observations) {
    // Stable sort retains the first model when two different observations have the same time.
    const unique = new Map();
    for (const [time, model] of observations) unique.set(`${time}\u0000${model}`, [time, model]);
    const ordered = [...unique.values()].sort((left, right) => left[0] - right[0]);
    const [firstTime, firstModel] = ordered[0];
    const started = start === null ? firstTime : Math.min(start, firstTime);
    events.push({ time: started, model: firstModel, kind: 'session' });
    let previousModel = firstModel;
    let previousTime = started;
    for (const [index, [time, model]] of ordered.entries()) {
        if (index === 0) continue;
        if (model !== previousModel) {
            events.push({ time, model, kind: 'switch', fromModel: previousModel, fromTime: previousTime });
            previousModel = model;
            previousTime = time;
        }
        if (events.length > MAX_EVENTS) throw new Error('Too many model events.');
    }
    if (events.length > MAX_EVENTS) throw new Error('Too many model events.');
}

export async function scanHistory(source, root) {
    if (source !== 'codex' && source !== 'claude-code') throw new TypeError('Unsupported history source.');
    const files = selectedPaths(root, source);
    const events = [];
    if (source === 'codex') {
        const sessions = new Map();
        let total = 0;
        for (const path of files) {
            const session = await codexSession(path);
            if (!session) continue;
            const [id, start, observations] = session;
            if (!sessions.has(id)) sessions.set(id, { start, observations: [] });
            const previous = sessions.get(id);
            if (start !== null && (previous.start === null || start < previous.start)) previous.start = start;
            for (const observation of observations) previous.observations.push(observation);
            total += observations.length;
            if (total > MAX_OBSERVATIONS || previous.observations.length > MAX_OBSERVATIONS) throw new Error('Too many observations.');
        }
        for (const { start, observations } of sessions.values()) appendEvents(events, start, observations);
    } else {
        for (const path of files) {
            const session = await claudeSession(path);
            if (session) appendEvents(events, ...session);
        }
    }
    events.sort((left, right) => left.time - right.time);
    return { format: 'model-tides', version: 1, source, events };
}

export async function scanHistoryActive(source, root) {
    if (source !== 'codex' && source !== 'claude-code') throw new TypeError('Unsupported history source.');
    const days = new Map();
    const files = selectedPaths(root, source);
    if (source === 'codex') {
        // Index only file-to-session metadata. Group rollouts before reading model
        // observations so only one session's deduplication state is held at once.
        const indexed = [];
        for (const path of files) {
            const id = await codexSessionId(path);
            if (id) indexed.push({ id, path });
        }
        indexed.sort((a, b) => a.id.localeCompare(b.id) || a.path.localeCompare(b.path));
        const previous = { id: null, seen: new Set() };
        const total = { observations: 0 };
        const flush = () => {
            for (const key of previous.seen) {
                const [day, model] = key.split('\u0000');
                recordActivity(days, Date.parse(`${day}T00:00:00Z`), model);
            }
            previous.seen.clear();
        };
        for (const { id: indexedId, path } of indexed) {
            const session = await codexSession(path);
            if (!session) continue;
            const [id, , observations] = session;
            if (id !== indexedId) throw new Error('History changed during scan.');
            if (previous.id !== id) {
                flush();
                previous.id = id;
            }
            for (const [time, model] of observations) {
                const key = `${new Date(time).toISOString().slice(0, 10)}\u0000${model}`;
                previous.seen.add(key);
            }
            total.observations += observations.length;
            if (total.observations > MAX_OBSERVATIONS || previous.seen.size > MAX_OBSERVATIONS) throw new Error('Too many observations.');
        }
        flush();
    } else {
        for (const path of files) {
            const session = await claudeSession(path);
            if (!session) continue;
            const seen = new Set();
            for (const [time, model] of session[1]) seen.add(`${new Date(time).toISOString().slice(0, 10)}\u0000${model}`);
            for (const key of seen) {
                const [day, model] = key.split('\u0000');
                recordActivity(days, Date.parse(`${day}T00:00:00Z`), model);
            }
        }
    }
    return activeDocument(source, days);
}

function piHeader(record) {
    if (record.type !== 'session' || typeof record.id !== 'string' ||
        !record.id || record.id.length > 256) return null;
    if (![1, 2, 3].includes(record.version ?? 1)) throw new Error('Unsupported Pi session version.');
    return record.id;
}

async function piSessionId(path) {
    for await (const record of records(path)) return piHeader(record);
    return null;
}

export async function scanPiActive(root) {
    const indexed = [];
    for (const path of selectedPaths(root, 'pi')) {
        const id = await piSessionId(path);
        if (id) indexed.push({ id, path });
        if (indexed.length > MAX_OBSERVATIONS) throw new Error('Too many sessions.');
    }
    indexed.sort((a, b) => a.id.localeCompare(b.id) || a.path.localeCompare(b.path));
    const days = new Map();
    const previous = { id: null, seen: new Set() };
    const total = { observations: 0 };
    const flush = () => {
        for (const key of previous.seen) {
            const [day, model] = key.split('\u0000');
            recordActivity(days, Date.parse(`${day}T00:00:00Z`), model);
        }
        previous.seen.clear();
        if (days.size > MAX_EVENTS) throw new Error('Too many active days.');
    };
    for (const { id, path } of indexed) {
        if (previous.id !== id) {
            flush();
            previous.id = id;
        }
        let header = true;
        for await (const record of records(path)) {
            if (header) {
                header = false;
                if (piHeader(record) !== id) throw new Error('History changed during scan.');
                continue;
            }
            if (record.type !== 'message' || !object(record.message) || record.message.role !== 'assistant') continue;
            const { provider, model: modelId } = record.message;
            if (!validModel(provider) || provider.includes('/') || !validModel(modelId)) continue;
            const model = `${provider}/${modelId}`;
            const time = record.message.timestamp === undefined ? milliseconds(record.timestamp) : record.message.timestamp;
            if (!validModel(model) || !Number.isSafeInteger(time) || time < Date.UTC(1999, 11, 27) ||
                time > Date.now() + 7 * 86_400_000) continue;
            previous.seen.add(`${new Date(time).toISOString().slice(0, 10)}\u0000${model}`);
            total.observations++;
            if (total.observations > MAX_OBSERVATIONS || previous.seen.size > MAX_OBSERVATIONS) {
                throw new Error('Too many observations.');
            }
        }
    }
    // Pi persists tree branches and duplicate files. Grouping by session ID
    // counts each observed model and UTC day once, not selections or background usage.
    flush();
    return activeDocument('pi', days);
}
