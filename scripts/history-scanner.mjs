/** Local-only history extraction. Only model names and times leave these readers. */
import { createReadStream, lstatSync, readFileSync, readdirSync, statSync } from 'node:fs';
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

function copilotPaths(root) {
    if (file(root)) {
        if (basename(root) !== 'events.jsonl') throw new Error('Expected a Copilot events.jsonl file.');
        return [root];
    }
    if (!lstatSync(root).isDirectory()) throw new Error('History path must be a regular file or directory.');
    const paths = [];
    for (const entry of readdirSync(root, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const path = join(root, entry.name, 'events.jsonl');
        if (file(path)) paths.push(path);
        if (paths.length > MAX_OBSERVATIONS) throw new Error('Too many sessions.');
    }
    return paths.sort();
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

function copilotHeader(record) {
    const id = record.type === 'session.start' && object(record.data) && record.data.sessionId;
    return typeof id === 'string' && id.length > 0 && id.length <= 256 ? id : null;
}

async function copilotSessionId(path) {
    for await (const record of records(path)) return copilotHeader(record);
    return null;
}

function copilotModel(value) {
    if (!validModel(value) || ['auto', 'auto_v2', 'hydrafusion'].includes(value.toLowerCase())) return null;
    const model = value.startsWith('github-copilot/') ? value : `github-copilot/${value}`;
    return validModel(model) ? model : null;
}

export async function scanCopilotActive(root) {
    // CLI, the Copilot desktop app and VS Code CLI-backed sessions use the
    // same session-state directory. Index headers, then group by durable ID.
    const indexed = [];
    for (const path of copilotPaths(root)) {
        const id = await copilotSessionId(path);
        if (id) indexed.push({ id, path });
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
        const childInteractions = new Set();
        const cursor = { first: true, childSession: false };
        for await (const record of records(path)) {
            if (cursor.first) {
                cursor.first = false;
                if (copilotHeader(record) !== id) throw new Error('History changed during scan.');
                continue;
            }
            const data = record.data;
            if (!object(data)) continue;
            if (record.type === 'user.message' && data.parentAgentTaskId) {
                cursor.childSession = true;
                if (typeof data.interactionId === 'string') childInteractions.add(data.interactionId);
                if (childInteractions.size > MAX_OBSERVATIONS) throw new Error('Too many observations.');
                continue;
            }
            if (record.type !== 'assistant.message' || cursor.childSession &&
                (typeof data.interactionId !== 'string' || childInteractions.has(data.interactionId))) continue;
            const model = copilotModel(data.model);
            const time = milliseconds(record.timestamp);
            if (model === null || time === null || time < Date.UTC(1999, 11, 27) ||
                time > Date.now() + 7 * 86_400_000) continue;
            previous.seen.add(`${new Date(time).toISOString().slice(0, 10)}\u0000${model}`);
            total.observations++;
            if (total.observations > MAX_OBSERVATIONS || previous.seen.size > MAX_OBSERVATIONS ||
                childInteractions.size > MAX_OBSERVATIONS) throw new Error('Too many observations.');
        }
    }
    flush();
    return activeDocument('github-copilot', days);
}

function vscodeChatPaths(roots) {
    const paths = [];
    const addChatFiles = (directory) => {
        if (!directoryFile(directory)) return;
        const names = readdirSync(directory, { withFileTypes: true });
        const logs = new Set(names.filter((entry) => entry.isFile() && entry.name.endsWith('.jsonl'))
            .map((entry) => entry.name.slice(0, -1)));
        for (const entry of names) {
            if (!entry.isFile() || !/\.jsonl?$/.test(entry.name) ||
                entry.name.endsWith('.json') && logs.has(entry.name)) continue;
            paths.push(join(directory, entry.name));
            if (paths.length > MAX_OBSERVATIONS) throw new Error('Too many sessions.');
        }
    };
    for (const root of Array.isArray(roots) ? roots : [roots]) {
        if (!directoryFile(root)) continue;
        addChatFiles(join(root, 'globalStorage/emptyWindowChatSessions'));
        const storage = join(root, 'workspaceStorage');
        if (!directoryFile(storage)) continue;
        for (const entry of readdirSync(storage, { withFileTypes: true })) {
            if (entry.isDirectory()) addChatFiles(join(storage, entry.name, 'chatSessions'));
        }
    }
    return paths.sort();
}

function directoryFile(path) {
    try { return lstatSync(path).isDirectory(); } catch { return false; }
}

function vscodeRequest(raw) {
    if (!object(raw)) return {};
    return { model: raw.modelId, timestamp: raw.timestamp, responseTimestamp: raw.responseTimestamp,
        state: raw.modelState?.value, hasResponse: Array.isArray(raw.response) && raw.response.length > 0,
        promptTokens: raw.promptTokens, completionTokens: raw.completionTokens };
}

function vscodeSessionState(raw) {
    const requests = Array.isArray(raw?.requests) ? raw.requests : [];
    if (requests.length > MAX_OBSERVATIONS) throw new Error('Too many observations.');
    return { id: raw?.sessionId, responder: raw?.responderUsername, requests: requests.map(vscodeRequest) };
}

function vscodeUpdate(state, entry) {
    if (entry.kind === 0) return vscodeSessionState(entry.v);
    if (![1, 2, 3].includes(entry.kind) || !Array.isArray(entry.k)) throw new Error('Unsupported VS Code chat log entry.');
    const [field, index, property, nested] = entry.k;
    if (field === 'responderUsername' && entry.kind === 1 && entry.k.length === 1) {
        state.responder = entry.v;
    } else if (field === 'requests') {
        if (entry.k.length === 1) {
            if (entry.kind === 1) {
                if (Array.isArray(entry.v) && entry.v.length > MAX_OBSERVATIONS) throw new Error('Too many observations.');
                state.requests = Array.isArray(entry.v) ? entry.v.map(vscodeRequest) : [];
            }
            if (entry.kind === 2) {
                if (entry.i !== undefined) {
                    if (!Number.isSafeInteger(entry.i) || entry.i < 0 || entry.i > state.requests.length) throw new Error('Invalid VS Code chat log.');
                    state.requests.length = entry.i;
                }
                if (Array.isArray(entry.v)) {
                    if (state.requests.length + entry.v.length > MAX_OBSERVATIONS) throw new Error('Too many observations.');
                    for (const request of entry.v) state.requests.push(vscodeRequest(request));
                }
            }
        } else if (Number.isSafeInteger(index) && index >= 0 && index < state.requests.length) {
            if (entry.k.length === 2 && entry.kind === 1) state.requests[index] = vscodeRequest(entry.v);
            else if (entry.k.length === 3) {
                const request = state.requests[index];
                if (property === 'modelId') request.model = entry.kind === 1 ? entry.v : null;
                if (property === 'responseTimestamp' || property === 'timestamp') request[property] = entry.kind === 1 ? entry.v : null;
                if (property === 'modelState') request.state = entry.kind === 1 ? entry.v?.value : null;
                if (property === 'response') request.hasResponse = entry.kind === 2 ?
                    Array.isArray(entry.v) && entry.v.length > 0 :
                    entry.kind === 1 && Array.isArray(entry.v) && entry.v.length > 0;
                if (property === 'promptTokens' || property === 'completionTokens') {
                    request[property] = entry.kind === 1 ? entry.v : null;
                }
            } else if (entry.k.length === 4 && property === 'modelState' && nested === 'value') {
                state.requests[index].state = entry.kind === 1 ? entry.v : null;
            } else if (entry.k.length === 4 && property === 'response' && entry.kind === 2) {
                state.requests[index].hasResponse ||= Array.isArray(entry.v) && entry.v.length > 0;
            }
        }
    }
    return state;
}

async function vscodeSession(path) {
    if (path.endsWith('.json')) {
        if (statSync(path).size > MAX_LINE_BYTES) throw new Error('Oversized history record.');
        const data = JSON.parse(readFileSync(path, 'utf8'));
        return vscodeSessionState(data);
    }
    const state = { id: null, responder: null, requests: [] };
    let current = state;
    for await (const record of records(path)) current = vscodeUpdate(current, record);
    return current;
}

export async function scanVSCodeCopilotActive(roots) {
    const indexed = [];
    for (const path of vscodeChatPaths(roots)) {
        const state = await vscodeSession(path);
        if (typeof state.id === 'string' && state.id.length > 0 && state.id.length <= 256) indexed.push({ id: state.id, path });
    }
    indexed.sort((a, b) => a.id.localeCompare(b.id) || a.path.localeCompare(b.path));
    const days = new Map();
    const previous = { id: null, seen: new Set() };
    const flush = () => {
        for (const key of previous.seen) {
            const [day, model] = key.split('\u0000');
            recordActivity(days, Date.parse(`${day}T00:00:00Z`), model);
        }
        previous.seen.clear();
        if (days.size > MAX_EVENTS) throw new Error('Too many active days.');
    };
    for (const { id, path } of indexed) {
        if (id !== previous.id) {
            flush();
            previous.id = id;
        }
        const state = await vscodeSession(path);
        if (state.id !== id) throw new Error('History changed during scan.');
        if (state.responder !== 'GitHub Copilot') continue;
        for (const request of state.requests) {
            if (request.state !== 1 || !(request.hasResponse || Number(request.promptTokens) > 0 ||
                Number(request.completionTokens) > 0)) continue;
            const model = copilotModel(request.model);
            const time = request.responseTimestamp ?? request.timestamp;
            if (model === null || !Number.isSafeInteger(time) || time < Date.UTC(1999, 11, 27) ||
                time > Date.now() + 7 * 86_400_000) continue;
            previous.seen.add(`${new Date(time).toISOString().slice(0, 10)}\u0000${model}`);
            if (previous.seen.size > MAX_OBSERVATIONS) throw new Error('Too many observations.');
        }
    }
    flush();
    return activeDocument('vscode-copilot', days);
}
