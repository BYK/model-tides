import { setupFlowTimeline } from './flow-timeline';
import { mountIcons } from './icons';
import { renderFlowSvg } from './flow-svg/renderer';
import { getModelColor, OTHER_MODEL_COLOR } from './model-colors';
import type { ReportRange } from './report-range';
import { validWeeklyModel, weekStart } from './weekly-snapshot';

const DAY = 86_400_000;
const MAX_VISIBLE_MODELS = 6;
const formatCount = (value: number): string => new Intl.NumberFormat('en-GB').format(value);
const formatDate = (date: Date, options: Intl.DateTimeFormatOptions): string =>
    new Intl.DateTimeFormat('en-GB', { ...options, timeZone: 'UTC' }).format(date);
const titledPeriod = (period: string, time: number): string => /\b\d{4}\b/.test(period)
    ? period : `${period} ${new Date(time).getUTCFullYear()}`;

function shortModelName(model: string): string {
    const name = model.split('/').at(-1) ?? model;
    const claude = /^claude-(opus|sonnet|haiku)-(\d+)[-.](\d+)(?:-(\d{8}))?(.*)$/i.exec(name);
    if (claude) {
        const releaseTime = claude[4] ? Date.parse(`${claude[4].slice(0, 4)}-${claude[4].slice(4, 6)}-${claude[4].slice(6)}T00:00:00Z`) : NaN;
        const validDate = Number.isFinite(releaseTime) && new Date(releaseTime).toISOString().slice(0, 10).replaceAll('-', '') === claude[4];
        const date = claude[4] ? ` · ${validDate
            ? formatDate(new Date(releaseTime), { month: 'short', year: 'numeric' }) : claude[4]}` : '';
        return `${claude[1][0].toUpperCase()}${claude[1].slice(1)} ${claude[2]}.${claude[3]}${date}${claude[5]}`;
    }
    const gemini = /^gemini-(\d+(?:[.-]\d+)?)-(flash|pro)(-preview)?$/i.exec(name);
    if (gemini) return `Gemini ${gemini[1]} ${gemini[2][0].toUpperCase()}${gemini[2].slice(1)}${gemini[3] ? ' preview' : ''}`;
    if (/^gpt-/i.test(name)) return name.replace(/^gpt-/i, 'GPT-').replace(/-codex$/i, ' Codex');
    return name;
}

function shortProviderName(model: string): string {
    const provider = model.split('/')[0];
    return provider === 'github-copilot' ? 'Copilot' : provider === 'openrouter' ? 'OpenRouter'
        : `${provider[0]?.toUpperCase() ?? ''}${provider.slice(1)}`;
}

export type ChartSource = 'personal' | 'shared' | 'gist' | 'mock';

export interface WeeklyChartRow {
    readonly week: string;
    readonly model: string;
    readonly count: number;
}

export interface FlowChartData {
    readonly rows: readonly WeeklyChartRow[];
    readonly source: ChartSource;
    readonly metricVersion: 1 | 2;
    readonly detail?: string;
}

export function mountFlowChart(host: HTMLElement, options: {
    readonly title: string;
    readonly headingLevel: 1 | 2;
    readonly initialStatus: string;
    readonly initialRange?: ReportRange | null;
    readonly onRangeChange?: (range: ReportRange) => void;
}): { setData: (data: FlowChartData) => void; setMessage: (message: string) => void } {
    host.innerHTML = `
        <section class="chart-card flow-chart" aria-labelledby="chart-heading">
            <div class="chart-heading-row">
                <div><h${options.headingLevel} id="chart-heading"></h${options.headingLevel}>
                    <p id="chart-description" class="chart-description"></p></div>
                <div class="chart-actions"><span class="model-visibility" id="model-visibility"></span>
                    <button class="text-button" id="show-models" type="button" hidden></button></div>
            </div>
            <p id="chart-status" class="chart-status" role="status" aria-live="polite"></p>
            <div class="model-legend" id="model-legend" role="group" aria-label="Model colors"></div>
            <div class="chart-frame">
                <div class="chart-scroll" id="chart-scroll"><div class="chart-canvas" id="chart-canvas" role="img"></div></div>
                <div class="chart-tooltip" id="chart-tooltip" role="tooltip" hidden></div>
                <div class="chart-empty" id="chart-message" hidden></div>
            </div>
            <div class="timeline-controls" id="timeline-controls" hidden>
                <div class="timeline-head">
                    <div><p class="timeline-label">Date range</p>
                        <p class="timeline-instruction">Scroll or pinch to zoom. Drag the chart or the handles below to change dates.</p></div>
                    <div class="timeline-head-actions">
                        <div class="date-pair"><span id="from-date">—</span><span class="date-arrow">→</span><span id="to-date">—</span></div>
                        <div class="zoom-actions" role="group" aria-label="Timeline zoom controls">
                            <button class="zoom-button" id="zoom-out" type="button" aria-label="Zoom out" title="Zoom out"><i data-lucide="zoom-out"></i></button>
                            <button class="zoom-button" id="zoom-in" type="button" aria-label="Zoom in" title="Zoom in"><i data-lucide="zoom-in"></i></button>
                            <button class="text-button" id="zoom-reset" type="button"><i data-lucide="rotate-ccw"></i><span>Reset</span></button>
                        </div>
                    </div>
                </div>
                <div class="range-track"><span class="range-selection" id="range-selection"></span>
                    <input id="range-start" type="range" aria-label="Timeline start date" />
                    <input id="range-end" type="range" aria-label="Timeline end date" /></div>
                <div class="range-labels"><span id="range-min-label">—</span><span id="range-max-label">—</span></div>
            </div>
            <p class="chart-detail" id="chart-detail" hidden></p>
            <details class="chart-key"><summary>How to read this chart</summary>
                <p id="chart-key-copy"></p></details>
        </section>`;
    mountIcons(host);
    const element = <T extends HTMLElement>(selector: string): T => host.querySelector<T>(selector)!;
    element<HTMLElement>('#chart-heading').textContent = options.title;
    const status = element<HTMLElement>('#chart-status');
    const detail = element<HTMLElement>('#chart-detail');
    const description = element<HTMLElement>('#chart-description');
    const canvas = element<HTMLElement>('#chart-canvas');
    const scroll = element<HTMLElement>('#chart-scroll');
    const tooltip = element<HTMLElement>('#chart-tooltip');
    const keyCopy = element<HTMLElement>('#chart-key-copy');
    const message = element<HTMLElement>('#chart-message');
    const controls = element<HTMLElement>('#timeline-controls');
    const visibility = element<HTMLElement>('#model-visibility');
    const modelLegend = element<HTMLElement>('#model-legend');
    const showModels = element<HTMLButtonElement>('#show-models');
    const state = { rows: [] as { time: number; model: string; count: number }[],
        source: 'shared' as ChartSource, metricVersion: 2 as 1 | 2, detail: '', minDay: 0, maxDay: 1, startDay: 0, endDay: 1,
        showAll: false, width: 0, height: 0 };
    status.textContent = options.initialStatus;

    const hideTooltip = (): void => { tooltip.hidden = true; };
    scroll.addEventListener('pointermove', (event: PointerEvent) => {
        if (event.pointerType === 'touch' || scroll.classList.contains('is-panning')) { hideTooltip(); return; }
        const target = event.target as Element | null;
        const mark = target?.closest?.('[data-flow-action]');
        const title = mark && canvas.contains(mark) ? mark.querySelector('title')?.textContent : null;
        if (!mark || !title) { hideTooltip(); return; }
        tooltip.textContent = title;
        tooltip.style.setProperty('--hover-color', mark.getAttribute('fill') ?? 'var(--accent)');
        const bounds = scroll.getBoundingClientRect();
        tooltip.style.left = `${Math.max(10, Math.min(event.clientX - bounds.left + 14, bounds.width - 290))}px`;
        tooltip.style.top = `${Math.max(10, Math.min(event.clientY - bounds.top + 14, bounds.height - 95))}px`;
        tooltip.hidden = false;
    });
    scroll.addEventListener('pointerleave', hideTooltip);
    scroll.addEventListener('pointerdown', hideTooltip);

    function render(): void {
        hideTooltip();
        if (!state.rows.length) return;
        const start = state.startDay * DAY;
        const end = (state.endDay + 1) * DAY - 1;
        const rows = state.rows.filter(({ time }) => time >= start && time <= end);
        const counts = new Map<string, number>();
        for (const { model, count } of rows) counts.set(model, (counts.get(model) ?? 0) + count);
        const ranked = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
        const showAll = state.showAll || ranked.length <= MAX_VISIBLE_MODELS;
        const visible = showAll ? ranked.map(([model]) => model)
            : [...ranked.slice(0, MAX_VISIBLE_MODELS).map(([model]) => model), 'Other models'];
        const visibleSet = new Set(visible);
        const displayModel = (model: string): string => visibleSet.has(model) ? model : 'Other models';
        const label = state.metricVersion === 1 ? 'earlier model-use events' : 'active session-days';
        const total = rows.reduce((sum, row) => sum + row.count, 0);
        const displayDate = (day: number): string =>
            formatDate(new Date(day * DAY), { day: 'numeric', month: 'short', year: 'numeric' });
        status.textContent = `Showing ${displayDate(state.startDay)} – ${displayDate(state.endDay)} · ` +
            `${formatCount(total)} ${state.source === 'mock' ? 'mock ' : state.source === 'gist' ? 'self-reported ' : ''}${label}`;
        detail.hidden = !state.detail;
        detail.textContent = state.detail;
        visibility.textContent = ranked.length > MAX_VISIBLE_MODELS && !showAll
            ? `Top ${MAX_VISIBLE_MODELS} models` : `${formatCount(ranked.length)} ${ranked.length === 1 ? 'model' : 'models'}`;
        showModels.hidden = ranked.length <= MAX_VISIBLE_MODELS;
        showModels.textContent = showAll ? 'Show top models' : `Show all ${formatCount(ranked.length)}`;
        showModels.setAttribute('aria-expanded', String(showAll));
        modelLegend.replaceChildren();
        const names = visible.map((model) => model === 'Other models' ? model : shortModelName(model));
        for (const model of visible) {
            const item = document.createElement('span');
            item.className = 'model-legend-item';
            item.title = model;
            const swatch = document.createElement('i');
            swatch.className = 'model-legend-swatch';
            swatch.style.backgroundColor = model === 'Other models' ? OTHER_MODEL_COLOR : getModelColor(model);
            const name = document.createElement('span');
            const short = model === 'Other models' ? model : shortModelName(model);
            name.textContent = names.filter((label) => label === short).length > 1
                ? `${short} · ${shortProviderName(model)}` : short;
            item.append(swatch, name);
            modelLegend.append(item);
        }
        if (!rows.length) {
            canvas.replaceChildren();
            scroll.hidden = true;
            message.hidden = false;
            message.textContent = 'No model activity in this window. Widen the timeline to see more.';
            return;
        }
        scroll.hidden = false;
        message.hidden = true;
        const example = state.source === 'mock';
        const infer = state.metricVersion === 2 && (example || state.source === 'gist' || state.source === 'personal');
        const adjective = example ? 'mock' : 'self-reported';
        const ariaLabel = example ? 'Mock example of weekly model counts with inferred shifts'
            : state.source === 'gist' ? state.metricVersion === 1 ? 'Unlisted gist of earlier model-use events over time'
                : 'Unlisted gist model counts with inferred shifts over time'
                : state.source === 'personal' ? state.metricVersion === 1 ? 'Your earlier model-use events over time'
                    : 'Your self-reported model tide over time'
                    : state.metricVersion === 1 ? 'Earlier shared model-use events over time'
                        : 'Shared active session-days over time';
        canvas.setAttribute('aria-label', ariaLabel);
        canvas.innerHTML = renderFlowSvg(rows.map(({ time, model, count }) => ({ time, to: model, weight: count })), {
            start, end, width: state.width || scroll.clientWidth || 900, height: state.height || 520,
            weeklyBuckets: true, inferMigrations: infer,
            order: visible, displayKey: displayModel,
            displayName: (model) => model === 'Other models' ? model : model.replace('/', ' / '),
            colorFor: (model) => model === 'Other models' ? OTHER_MODEL_COLOR : getModelColor(model),
            streamColorFor: (model) => getModelColor(model), formatValue: formatCount,
            formatPeriod: (time, intervalDays) => formatDate(new Date(time), intervalDays === 30
                ? { month: 'short', year: 'numeric' } : { day: 'numeric', month: 'short' }),
            formatNodeTitle: ({ period, time, label: model, value }) =>
                `${titledPeriod(period, time)} · ${model} · ${formatCount(value)} ${adjective} ${label}`,
            formatLinkTitle: ({ toLabel, toPeriod, time, value }) =>
                `${formatCount(value)} ${adjective} ${label} of ${toLabel} in ${titledPeriod(toPeriod, time)}`,
            formatContinuityTitle: ({ label: model, fromPeriod, fromTime, toPeriod, time }) =>
                `${model} appears in both ${titledPeriod(fromPeriod, fromTime)} and ${titledPeriod(toPeriod, time)}. This does not track individual sessions.`,
            formatMigrationTitle: ({ fromLabel, toLabel, fromPeriod, toPeriod, value }) =>
                `Possible shift: ${fromLabel} → ${toLabel}, ${fromPeriod} – ${toPeriod}. Up to ${formatCount(value)} ${label} line up; this is inferred, not tracked.`,
            axisCaption: 'Time →',
            ariaLabel,
        });
    }

    const timeline = setupFlowTimeline({ canvas, scroll,
        start: element<HTMLInputElement>('#range-start'), end: element<HTMLInputElement>('#range-end'),
        selection: element<HTMLElement>('#range-selection'),
        fromDate: element<HTMLElement>('#from-date'), toDate: element<HTMLElement>('#to-date'),
        minLabel: element<HTMLElement>('#range-min-label'), maxLabel: element<HTMLElement>('#range-max-label'),
        zoomIn: element<HTMLButtonElement>('#zoom-in'), zoomOut: element<HTMLButtonElement>('#zoom-out'),
        zoomReset: element<HTMLButtonElement>('#zoom-reset'),
    }, () => ({ minDay: state.minDay, maxDay: state.maxDay, startDay: state.startDay, endDay: state.endDay }),
    (startDay, endDay) => {
        state.startDay = startDay;
        state.endDay = endDay;
        render();
        options.onRangeChange?.({ from: new Date(startDay * DAY).toISOString().slice(0, 10),
            to: new Date(endDay * DAY).toISOString().slice(0, 10) });
    });
    showModels.addEventListener('click', () => { state.showAll = !state.showAll; render(); });

    function resize(): void {
        const bounds = scroll.getBoundingClientRect();
        if (bounds.width <= 0) return;
        const viewportWidth = Math.max(1, window.visualViewport?.width ?? window.innerWidth);
        const viewportHeight = Math.max(1, window.visualViewport?.height ?? window.innerHeight);
        const width = Math.round(bounds.width);
        const height = Math.max(320, Math.round(Math.min(width * viewportHeight / viewportWidth * 0.66, viewportHeight * 0.78)));
        if (state.width === width && state.height === height) return;
        state.width = width;
        state.height = height;
        scroll.style.setProperty('--flow-chart-height', `${height}px`);
        render();
    }
    new ResizeObserver(resize).observe(scroll);
    window.addEventListener('resize', resize);
    window.visualViewport?.addEventListener('resize', resize);
    resize();

    return {
        setData(data): void {
            if (!Array.isArray(data.rows) || !['personal', 'shared', 'gist', 'mock'].includes(data.source) ||
                (data.metricVersion !== 1 && data.metricVersion !== 2) ||
                (data.detail !== undefined && typeof data.detail !== 'string')) throw new TypeError('Invalid weekly chart data.');
            const rows = data.rows.map(({ week, model, count }) => {
                const time = typeof week === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(week)
                    ? Date.parse(`${week}T00:00:00Z`) : NaN;
                if (!Number.isFinite(time) || weekStart(time) !== week || !validWeeklyModel(model) ||
                    !Number.isSafeInteger(count) || count <= 0) throw new TypeError('Invalid weekly chart data.');
                return { time, model, count };
            });
            if (!rows.length) { this.setMessage('No weekly model counts are available.'); return; }
            const days = rows.map(({ time }) => Math.floor(time / DAY));
            state.rows = rows;
            state.source = data.source;
            state.metricVersion = data.metricVersion;
            state.detail = data.detail ?? '';
            state.minDay = Math.min(...days);
            state.maxDay = Math.max(state.minDay + 1, ...days);
            state.startDay = state.minDay;
            state.endDay = state.maxDay;
            const initialRange = options.initialRange;
            if (initialRange) {
                const start = Date.parse(`${initialRange.from}T00:00:00Z`) / DAY;
                const end = Date.parse(`${initialRange.to}T00:00:00Z`) / DAY;
                if (Number.isFinite(start) && Number.isFinite(end)) {
                    state.startDay = Math.min(state.maxDay, Math.max(state.minDay, start));
                    state.endDay = Math.min(state.maxDay, Math.max(state.minDay, end));
                    if (state.startDay > state.endDay) {
                        state.startDay = state.minDay;
                        state.endDay = state.maxDay;
                    }
                }
            }
            state.showAll = false;
            description.textContent = `Model use over time${data.source === 'mock' ? ' (mock example)' : ''}. ` +
                'Taller bars mean more activity in that period. Hover over a bar for its model and count.';
            keyCopy.textContent = data.source === 'mock'
                ? 'Bars show mock activity, not uploaded history. Faint lines join models that appear in adjacent periods; crossing lines suggest possible shifts, not tracked switches.'
                : 'Bars show reported activity. Faint lines join models that appear in adjacent periods. ' +
                  'Crossing lines, when shown, suggest possible shifts; weekly totals cannot track individual switches or reveal exact times. ' +
                  'Other models groups the remaining bars; hover over a stream to see its model.';
            controls.hidden = false;
            timeline.update();
            render();
        },
        setMessage(text): void {
            if (typeof text !== 'string') throw new TypeError('Invalid chart message.');
            state.rows = [];
            hideTooltip();
            status.textContent = text;
            detail.hidden = true;
            visibility.textContent = '';
            showModels.hidden = true;
            modelLegend.replaceChildren();
            canvas.replaceChildren();
            scroll.hidden = true;
            message.hidden = false;
            message.textContent = text;
            controls.hidden = true;
        },
    };
}
