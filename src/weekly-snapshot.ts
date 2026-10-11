import type { UsageEvent } from './usage-data.ts';
import type { DailyUsageDocument } from './daily-usage.ts';

export const WEEKLY_FORMAT = 'model-tides-weekly';
export const WEEKLY_VERSION = 2;
export const MAX_WEEKS = 520;
export const MAX_CELLS = 2048;
export const MAX_MODEL_COUNT = 10_000;
export const MAX_REVIEW_CELLS = 8192;
export const MIN_WEEK_TIME = Date.UTC(1999, 11, 27);
export const FUTURE_MARGIN_MS = 7 * 86_400_000;
const WEEK_MS = 7 * 86_400_000;
const weekPattern = /^\d{4}-\d{2}-\d{2}$/;

export interface WeeklySnapshot {
    readonly format: typeof WEEKLY_FORMAT;
    readonly version: 1 | typeof WEEKLY_VERSION;
    readonly weeks: readonly { readonly week: string; readonly models: Readonly<Record<string, number>> }[];
}

export interface OwnedReport {
    readonly id: string;
    readonly published: boolean;
    readonly inAggregate: boolean | null;
    readonly revision: number;
    readonly metricVersion: 1 | typeof WEEKLY_VERSION;
    readonly snapshot: WeeklySnapshot | null;
}

export function validWeeklyModel(model: unknown): model is string {
    return typeof model === 'string' && model.length > 0 && model.length <= 320 &&
        model === model.trim() && !/[\u0000-\u001f\u007f\ud800-\udfff]/u.test(model);
}

export function weekStart(time: number): string {
    if (!Number.isSafeInteger(time) || time < MIN_WEEK_TIME || time > Date.now() + FUTURE_MARGIN_MS) {
        throw new RangeError('The event date is outside the supported range.');
    }
    // Thursday 1970-01-01 is three days after Monday.
    return new Date(Math.floor((time + 3 * 86_400_000) / WEEK_MS) * WEEK_MS - 3 * 86_400_000)
        .toISOString().slice(0, 10);
}

function exactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value) &&
        Object.keys(value).length === keys.length && Object.keys(value).every((key) => keys.includes(key));
}

function parseSnapshotWithLimits(input: unknown, maxWeeks: number, maxCells: number): WeeklySnapshot {
    if (!exactKeys(input, ['format', 'version', 'weeks']) || input.format !== WEEKLY_FORMAT ||
        (input.version !== 1 && input.version !== WEEKLY_VERSION) || !Array.isArray(input.weeks) ||
        input.weeks.length < 1 || input.weeks.length > maxWeeks) {
        throw new TypeError('Invalid weekly snapshot.');
    }
    const seen = new Set<string>();
    const weeks: { week: string; models: Record<string, number> }[] = [];
    const latest = Date.now() + FUTURE_MARGIN_MS;
    const cells = input.weeks.reduce<number>((total, item: unknown) => {
        if (!exactKeys(item, ['week', 'models']) || typeof item.week !== 'string' ||
            !weekPattern.test(item.week) || seen.has(item.week) || !item.models ||
            typeof item.models !== 'object' || Array.isArray(item.models)) {
            throw new TypeError('Invalid weekly snapshot.');
        }
        const date = Date.parse(`${item.week}T00:00:00Z`);
        if (!Number.isFinite(date) || date < MIN_WEEK_TIME || date > latest ||
            weekStart(date) !== item.week) {
            throw new TypeError('Invalid weekly snapshot.');
        }
        const entries = Object.entries(item.models);
        if (entries.length > maxCells || entries.some(([model, count]) =>
            !validWeeklyModel(model) || !Number.isSafeInteger(count) || (count as number) < 1 || (count as number) > MAX_MODEL_COUNT)) {
            throw new TypeError('Invalid weekly snapshot.');
        }
        seen.add(item.week);
        weeks.push({ week: item.week, models: Object.fromEntries(entries) });
        return total + entries.length;
    }, 0);
    if (cells < 1 || cells > maxCells) throw new TypeError('Invalid weekly snapshot.');
    return { format: WEEKLY_FORMAT, version: input.version, weeks };
}

export function parseSnapshot(input: unknown): WeeklySnapshot {
    return parseSnapshotWithLimits(input, MAX_WEEKS, MAX_CELLS);
}

export function parseOwnedReport(input: unknown, id: string): OwnedReport {
    const hasAggregate = input !== null && typeof input === 'object' && 'inAggregate' in input;
    const hasMetric = input !== null && typeof input === 'object' && 'metricVersion' in input;
    const fields = [...(hasAggregate ? ['inAggregate'] : []), ...(hasMetric ? ['metricVersion'] : [])];
    const oversized = exactKeys(input, ['id', 'published', 'revision', 'tooLarge', ...fields]) && input.tooLarge === true;
    if ((!oversized && !exactKeys(input, ['id', 'counts', 'published', 'revision', ...fields])) || input.id !== id ||
        typeof input.published !== 'boolean' || !Number.isSafeInteger(input.revision) ||
        (input.revision as number) < 0 || (hasAggregate && typeof input.inAggregate !== 'boolean')) {
        throw new TypeError('Invalid personal report.');
    }
    const inAggregate = hasAggregate ? input.inAggregate as boolean : null;
    const version = hasMetric ? input.metricVersion : 1;
    if (version !== 1 && version !== WEEKLY_VERSION) throw new TypeError('Invalid report metric.');
    if (oversized) return { id, published: input.published as boolean, inAggregate, revision: input.revision as number,
        metricVersion: version, snapshot: null };
    if (!Array.isArray(input.counts) || input.counts.length < 1 || input.counts.length > MAX_REVIEW_CELLS) {
        throw new TypeError('Invalid personal report.');
    }
    const weeks = new Map<string, Map<string, number>>();
    for (const row of input.counts) {
        if (!exactKeys(row, ['week', 'model', 'count']) || typeof row.week !== 'string' ||
            !validWeeklyModel(row.model) || !Number.isSafeInteger(row.count) ||
            (row.count as number) < 1 || (row.count as number) > MAX_MODEL_COUNT) {
            throw new TypeError('Invalid personal report.');
        }
        const models = weeks.get(row.week) ?? new Map<string, number>();
        if (models.has(row.model)) throw new TypeError('Invalid personal report.');
        models.set(row.model, row.count as number);
        weeks.set(row.week, models);
    }
    const snapshot = parseSnapshotWithLimits({ format: WEEKLY_FORMAT, version,
        weeks: [...weeks].sort(([a], [b]) => a.localeCompare(b)).map(([week, models]) => ({
            week, models: Object.fromEntries([...models].sort(([a], [b]) => a.localeCompare(b))),
        })) }, 2048, MAX_REVIEW_CELLS);
    return { id, published: input.published, inAggregate, revision: input.revision as number,
        metricVersion: version, snapshot };
}

export function parsePublicReport(input: unknown, id: string): WeeklySnapshot {
    const hasMetric = input !== null && typeof input === 'object' && 'metricVersion' in input;
    if (!exactKeys(input, ['id', 'counts', 'published', ...(hasMetric ? ['metricVersion'] : [])]) ||
        input.id !== id || input.published !== true) {
        throw new TypeError('Invalid public report.');
    }
    const report = parseOwnedReport({ ...input, revision: 0 }, id);
    if (!report.snapshot) throw new TypeError('Public report is too large to explore.');
    return report.snapshot;
}

export function buildWeeklySnapshot(events: Iterable<Pick<UsageEvent, 'time' | 'model'>>): WeeklySnapshot {
    const weeks = new Map<string, Map<string, number>>();
    for (const event of events) {
        if (!validWeeklyModel(event.model)) throw new TypeError('The model name cannot be shared.');
        const week = weekStart(event.time);
        const models = weeks.get(week) ?? new Map<string, number>();
        models.set(event.model, (models.get(event.model) ?? 0) + 1);
        weeks.set(week, models);
    }
    const result = [...weeks].sort(([a], [b]) => a.localeCompare(b)).map(([week, models]) => ({
        week,
        models: Object.fromEntries([...models].sort(([a], [b]) => a.localeCompare(b))),
    }));
    if (result.length > MAX_WEEKS || result.reduce((sum, item) => sum + Object.keys(item.models).length, 0) > MAX_CELLS ||
        result.some((item) => Object.values(item.models).some((count) => count > MAX_MODEL_COUNT))) {
        throw new RangeError('The weekly snapshot exceeds the upload limits.');
    }
    return { format: WEEKLY_FORMAT, version: 1, weeks: result };
}

export function buildActiveWeeklySnapshot(documents: Iterable<DailyUsageDocument>): WeeklySnapshot {
    const weeks = new Map<string, Map<string, number>>();
    for (const document of documents) for (const { day, models: daily } of document.days) {
        const week = weekStart(Date.parse(`${day}T00:00:00Z`));
        const models = weeks.get(week) ?? new Map<string, number>();
        for (const [model, count] of Object.entries(daily)) models.set(model, (models.get(model) ?? 0) + count);
        weeks.set(week, models);
    }
    return parseSnapshot({ format: WEEKLY_FORMAT, version: WEEKLY_VERSION,
        weeks: [...weeks].sort(([a], [b]) => a.localeCompare(b)).map(([week, models]) => ({
            week, models: Object.fromEntries([...models].sort(([a], [b]) => a.localeCompare(b))),
        })) });
}
