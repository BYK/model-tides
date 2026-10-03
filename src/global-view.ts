import type { FlowChartData } from './flow-chart';
import { validWeeklyModel, weekStart } from './weekly-snapshot';

interface AggregateRow {
    readonly week: string;
    readonly model: string;
    readonly count: number;
    readonly contributors: number;
}

const exampleRows: AggregateRow[] = [
    { week: '2026-02-02', model: 'openai/gpt-5', count: 8, contributors: 5 },
    { week: '2026-02-09', model: 'openai/gpt-5', count: 5, contributors: 5 },
    { week: '2026-02-09', model: 'anthropic/claude-sonnet-4-5', count: 3, contributors: 5 },
    { week: '2026-02-16', model: 'openai/gpt-5', count: 4, contributors: 5 },
    { week: '2026-02-16', model: 'anthropic/claude-sonnet-4-5', count: 6, contributors: 5 },
    { week: '2026-02-23', model: 'anthropic/claude-sonnet-4-5', count: 9, contributors: 5 },
    { week: '2026-03-02', model: 'openai/gpt-5', count: 6, contributors: 5 },
    { week: '2026-03-02', model: 'anthropic/claude-sonnet-4-5', count: 5, contributors: 5 },
    { week: '2026-03-09', model: 'openai/gpt-5', count: 10, contributors: 5 },
    { week: '2026-03-09', model: 'anthropic/claude-sonnet-4-5', count: 4, contributors: 5 },
];

interface ChartDisplay {
    setData(data: FlowChartData): void;
    setMessage(message: string): void;
}

interface AggregateResponse {
    weeks: AggregateRow[];
    truncated: boolean;
    metricVersion: 1 | 2;
    uploadedReports: number;
    optedInReports: number;
}

function parseAggregate(input: unknown): AggregateResponse {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('Invalid aggregate.');
    const data = input as Record<string, unknown>;
    if (!Array.isArray(data.weeks) || data.weeks.length > 3000 || typeof data.truncated !== 'boolean' ||
        (data.metricVersion !== 1 && data.metricVersion !== 2) ||
        !Number.isSafeInteger(data.uploadedReports) || (data.uploadedReports as number) < 0 ||
        !Number.isSafeInteger(data.optedInReports) || (data.optedInReports as number) < 0 ||
        (data.optedInReports as number) > (data.uploadedReports as number)) throw new TypeError('Invalid aggregate.');
    const seen = new Set<string>();
    const weeks: AggregateRow[] = data.weeks.map((item: unknown) => {
        if (!item || typeof item !== 'object' || Array.isArray(item)) throw new TypeError('Invalid aggregate.');
        const row = item as Record<string, unknown>;
        if (Object.keys(row).length !== 4 ||
            !['week', 'model', 'count', 'contributors'].every((key) => Object.hasOwn(row, key))) {
            throw new TypeError('Invalid aggregate.');
        }
        const time = typeof row.week === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(row.week)
            ? Date.parse(`${row.week}T00:00:00Z`) : NaN;
        if (!Number.isFinite(time) || weekStart(time) !== row.week || !validWeeklyModel(row.model) ||
            !Number.isSafeInteger(row.count) || (row.count as number) < 1 ||
            !Number.isSafeInteger(row.contributors) || (row.contributors as number) < 1 ||
            (row.contributors as number) > (data.optedInReports as number)) throw new TypeError('Invalid aggregate.');
        const key = `${row.week}\0${row.model}`;
        if (seen.has(key)) throw new TypeError('Invalid aggregate.');
        seen.add(key);
        return row as unknown as AggregateRow;
    });
    return { weeks, truncated: data.truncated as boolean, metricVersion: data.metricVersion as 1 | 2,
        uploadedReports: data.uploadedReports as number, optedInReports: data.optedInReports as number };
}

export async function loadGlobalView(chart: ChartDisplay, showExample = false): Promise<void> {
    try {
        const response = await fetch('/api/aggregate', { cache: 'no-store' });
        if (!response.ok) throw new Error('Shared timeline is unavailable.');
        const data = parseAggregate(await response.json());
        const format = (value: number): string => value.toLocaleString('en-GB');
        const detail = `${format(data.uploadedReports)} uploaded ${data.uploadedReports === 1 ? 'report' : 'reports'} · ` +
            `${format(data.optedInReports)} opted-in ${data.optedInReports === 1 ? 'report' : 'reports'}`;
        if (!data.weeks.length) {
            if (showExample) chart.setData({ rows: exampleRows, source: 'mock', metricVersion: 2, detail });
            else chart.setMessage(`No weekly counts have been contributed yet. ${detail}.`);
            return;
        }
        chart.setData({ rows: data.weeks, source: 'shared', metricVersion: data.metricVersion,
            detail: `${detail}${data.truncated ? ' · first 3,000 model-week cells shown' : ''}` });
    } catch {
        if (showExample) chart.setData({ rows: exampleRows, source: 'mock', metricVersion: 2,
            detail: 'Shared counts are unavailable' });
        else chart.setMessage('The shared timeline is unavailable.');
    }
}
