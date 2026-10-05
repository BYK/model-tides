import type { Database } from './contributions';
import { renderFlowSvg } from '../src/flow-svg/renderer.ts';
import { getModelColor, OTHER_MODEL_COLOR } from '../src/model-colors.ts';
import { filterReportCounts, reportRangeSearch, type ReportRange } from '../src/report-range.ts';

const MAX_VISIBLE_MODELS = 6;

export interface CountRow {
    readonly week: string;
    readonly model: string;
    readonly count: number;
}

export interface PublicReport {
    readonly id: string | null;
    readonly counts: readonly CountRow[];
    readonly total: number;
    readonly weeks: number;
    readonly models: readonly { model: string; count: number }[];
    readonly metricVersion: 1 | 2;
}

export function summarize(id: string | null, counts: readonly CountRow[], metricVersion: 1 | 2 = 1,
    range?: ReportRange): PublicReport {
    const filteredCounts = range ? filterReportCounts(counts, range) : counts;
    const totals = new Map<string, number>();
    for (const { model, count } of filteredCounts) totals.set(model, (totals.get(model) ?? 0) + count);
    return {
        id,
        metricVersion,
        counts: filteredCounts,
        total: filteredCounts.reduce((sum, row) => sum + row.count, 0),
        weeks: new Set(filteredCounts.map((row) => row.week)).size,
        models: [...totals].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
            .map(([model, count]) => ({ model, count })),
    };
}

export async function getReport(db: Database, id: string): Promise<PublicReport | null> {
    const { results } = await db.prepare(`SELECT w.week, w.model, w.count, c.metric_version FROM contributors c
        JOIN weekly_counts w ON w.contributor_id = c.id
        WHERE c.id = ? AND c.published = 1 ORDER BY w.week, w.model`)
        .bind(id).all<CountRow & { metric_version: number }>();
    if (results.length && results[0].metric_version !== 1 && results[0].metric_version !== 2) throw new TypeError('Unknown report metric.');
    return results.length ? summarize(id, results, results[0].metric_version as 1 | 2) : null;
}

export function escapeHtml(text: string | number): string {
    return String(text).replaceAll('&', '&amp;').replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

export function pageForReport(report: PublicReport, origin: string, shell: string, range?: ReportRange): Response {
    const countLabel = report.metricVersion === 2 ? 'active session-days' : 'model uses';
    const title = `My model tide · ${report.total.toLocaleString('en-GB')} ${countLabel} over ${report.weeks} ${report.weeks === 1 ? 'week' : 'weeks'} · Model Tides`;
    const description = report.metricVersion === 2
        ? 'A public chart of self-reported session–model–days with observed activity; no exact times or session IDs are shared.'
        : 'A public chart of earlier session-start and model-switch counts; no exact times or session IDs are shared.';
    const search = reportRangeSearch(range ?? null);
    const url = `${origin}/u/${report.id}${search}`;
    const image = `${origin}/og/${report.id}.png${search}`;
    if (!shell.includes('</head>') || !shell.includes('id="app"')) throw new Error('Missing report app shell.');
    const meta = `<meta property="og:type" content="website"><meta property="og:title" content="${escapeHtml(title)}">
<meta property="og:description" content="${escapeHtml(description)}"><meta property="og:url" content="${escapeHtml(url)}">
<meta property="og:image" content="${escapeHtml(image)}"><meta property="og:image:alt" content="${escapeHtml(description)}"><meta name="twitter:card" content="summary_large_image">`;
    const html = shell.replace(/<title>[^<]*<\/title>/, `<title>${escapeHtml(title)}</title>`)
        .replace('</head>', `${meta}</head>`);
    return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
}

function personalImageSvg(report: PublicReport): string {
    const countLabel = report.metricVersion === 2 ? 'active session-days' : 'model uses';
    const rows = report.counts.map(({ week, model, count }) => ({ time: Date.parse(`${week}T00:00:00Z`), model, count }));
    if (!rows.length) return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630" font-family="Iosevka Aile, sans-serif" role="img" aria-label="My model tide: no activity in this selected window">
<title>My model tide</title><desc>No self-reported weekly ${countLabel} in this selected window.</desc>
<rect width="1200" height="630" fill="#102832"/><path d="M0 48Q300 10 600 48T1200 48" fill="none" stroke="#2b6e76" stroke-width="2"/>
<text x="60" y="37" fill="#82d6ca" font-family="Iosevka, monospace" font-size="17" letter-spacing="3">MODEL TIDES · SHARED MODEL HISTORY</text>
<text x="60" y="94" fill="#eaf7f6" font-family="Iosevka Etoile, serif" font-size="48">My model tide</text>
<text x="60" y="280" fill="#eaf7f6" font-size="28">No activity in this selected window</text>
<text x="60" y="320" fill="#adc6c9" font-size="19">Try widening the date range to include weekly counts.</text>
<text x="60" y="607" fill="#adc6c9" font-size="15">Weekly counts · crossed ribbons = inferred shifts, no tracked switches</text></svg>`;
    if (rows.some(({ time }) => !Number.isFinite(time))) throw new RangeError('Invalid report weeks.');
    const first = Math.min(...rows.map(({ time }) => time));
    const last = Math.max(...rows.map(({ time }) => time));
    const visible = report.models.slice(0, MAX_VISIBLE_MODELS).map(({ model }) => model);
    if (report.models.length > MAX_VISIBLE_MODELS) visible.push('Other models');
    const visibleSet = new Set(visible);
    const formatCount = (value: number): string => value.toLocaleString('en-GB');
    const chart = renderFlowSvg(rows.map(({ time, model, count }) => ({ time, to: model, weight: count })), {
        start: first, end: last, width: 1080, height: 350, weeklyBuckets: true, inferMigrations: true,
        order: visible, displayKey: (model) => visibleSet.has(model) ? model : 'Other models',
        displayName: (model) => model === 'Other models' ? model : model.replace('/', ' / '),
        colorFor: (model) => model === 'Other models' ? OTHER_MODEL_COLOR : getModelColor(model),
        streamColorFor: (model) => getModelColor(model), formatValue: formatCount,
        formatPeriod: (time, intervalDays) => new Date(time).toLocaleDateString('en-GB', intervalDays === 30
            ? { month: 'short', year: '2-digit', timeZone: 'UTC' }
            : { day: 'numeric', month: 'short', timeZone: 'UTC' }),
        formatNodeTitle: ({ period, label, value }) => `${period} · ${label} · ${formatCount(value)} self-reported ${countLabel}`,
        formatLinkTitle: ({ toLabel, toPeriod, value }) => `${formatCount(value)} self-reported ${countLabel} of ${toLabel} in ${toPeriod}`,
        formatContinuityTitle: ({ label, fromPeriod, toPeriod }) =>
            `Visual continuity: ${label} has reported uses in ${fromPeriod} and ${toPeriod}. Weekly counts do not track sessions between periods.`,
        axisCaption: 'EARLIER ← WEEK → LATER', ariaLabel: 'Your self-reported model tide over time',
    }).replace('<svg ', '<svg x="60" y="166" ');
    const legend = visible.map((model, index) => {
        const x = 70 + (index % 4) * 275;
        const y = 544 + Math.floor(index / 4) * 27;
        const label = model === 'Other models' ? model : model.replace('/', ' / ');
        const shortLabel = [...label].length > 23 ? `${[...label].slice(0, 22).join('')}…` : label;
        const color = model === 'Other models' ? OTHER_MODEL_COLOR : getModelColor(model);
        return `<rect x="${x}" y="${y - 12}" width="12" height="12" rx="2" fill="${color}"/><text x="${x + 20}" y="${y}" fill="#eaf7f6" font-size="15">${escapeHtml(shortLabel)}</text>`;
    }).join('');
    return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630" font-family="Iosevka Aile, sans-serif" role="img" aria-label="My model tide: ${formatCount(report.total)} self-reported ${countLabel} over ${report.weeks} weeks">
<title>My model tide</title><desc>Self-reported weekly ${countLabel}. Crossing ribbons show inferred shifts, not tracked switches or sessions.</desc>
<style>.flow-svg { font-family: 'Iosevka Aile', sans-serif; }
.flow-svg .chart-gridline { stroke: #31515a; stroke-width: 1; stroke-dasharray: 2 6; }
.flow-svg .date-axis, .flow-svg .date-tick { stroke: #647e86; stroke-width: 1; }
.flow-svg .date-label { fill: #adc6c9; font-size: 13px; }
.flow-svg .axis-caption { fill: #adc6c9; font-size: 11px; letter-spacing: 1px; }
.flow-svg .usage-node { stroke: #d4e9e5; stroke-width: .7; }</style>
<rect width="1200" height="630" fill="#102832"/><path d="M0 48Q300 10 600 48T1200 48" fill="none" stroke="#2b6e76" stroke-width="2"/>
<text x="60" y="37" fill="#82d6ca" font-family="Iosevka, monospace" font-size="17" letter-spacing="3">MODEL TIDES · SHARED MODEL HISTORY</text>
<text x="60" y="94" fill="#eaf7f6" font-family="Iosevka Etoile, serif" font-size="48">My model tide</text>
<text x="60" y="132" fill="#adc6c9" font-size="19">${formatCount(report.total)} ${countLabel} · ${report.weeks} ${report.weeks === 1 ? 'week' : 'weeks'} · self-reported weekly counts</text>
${chart}<g>${legend}
<text x="60" y="607" fill="#adc6c9" font-size="15">Weekly counts · crossed ribbons = inferred shifts, no tracked switches</text></g></svg>`;
}

export function imageSvg(report: PublicReport): string {
    if (report.id !== null) return personalImageSvg(report);
    const bars = report.models.slice(0, 5).map(({ model, count }, index) => {
        const y = 322 + index * 60;
        const width = Math.max(6, Math.round(580 * count / Math.max(1, report.models[0].count)));
        const label = [...model].slice(0, 39).join('');
        return `<text x="80" y="${y}" fill="#eaf7f6" font-size="28">${escapeHtml(label)}</text>
<rect x="80" y="${y + 16}" width="${width}" height="17" rx="8" fill="#82d6ca"/>
<text x="1110" y="${y + 1}" fill="#eaf7f6" font-size="28" text-anchor="end">${escapeHtml(count.toLocaleString('en-GB'))}</text>`;
    }).join('');
    const label = report.id === null ? 'COMMUNITY SNAPSHOT' : 'SHARED MODEL HISTORY';
    const countLabel = report.metricVersion === 2 ? 'active session-days' : 'model uses';
    return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630" font-family="Iosevka Aile, sans-serif">
<rect width="1200" height="630" fill="#102832"/><path d="M0 135Q300 65 600 135T1200 135" fill="none" stroke="#2b6e76" stroke-width="4"/>
<text x="80" y="92" fill="#82d6ca" font-family="Iosevka, monospace" font-size="28" letter-spacing="4">MODEL TIDES  ·  ${label}</text>
<text x="80" y="207" fill="#eaf7f6" font-family="Iosevka Etoile, serif" font-size="${report.metricVersion === 2 ? 48 : 72}">${escapeHtml(report.total.toLocaleString('en-GB'))} ${countLabel}</text>
<text x="80" y="265" fill="#adc6c9" font-size="30">${report.weeks} ${report.weeks === 1 ? 'week' : 'weeks'} · self-reported weekly counts</text>
${bars}<text x="80" y="600" fill="#adc6c9" font-size="22">modeltides.dev · models and weekly counts only</text></svg>`;
}
