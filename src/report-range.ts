const DAY = 86_400_000;

export interface ReportRange {
    readonly from: string;
    readonly to: string;
}

function dayForDate(value: string): number | null {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
    const time = Date.parse(`${value}T00:00:00Z`);
    return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value ? Math.floor(time / DAY) : null;
}

export function parseReportRange(params: URLSearchParams): ReportRange | null {
    const from = params.get('from');
    const to = params.get('to');
    if (from === null || to === null) return null;
    const fromDay = dayForDate(from);
    const toDay = dayForDate(to);
    return fromDay !== null && toDay !== null && fromDay <= toDay ? { from, to } : null;
}

export function reportRangeSearch(range: ReportRange | null): string {
    return range ? `?${new URLSearchParams([['from', range.from], ['to', range.to]]).toString()}` : '';
}

export function filterReportCounts<T extends { readonly week: string }>(counts: readonly T[], range: ReportRange): readonly T[] {
    return counts.filter(({ week }) => week >= range.from && week <= range.to);
}
