import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'vite';

test('one chart component renders public weekly data with model, zoom, pan, and range controls', async () => {
    const server = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent' });
    const oldDocument = globalThis.document;
    const oldWindow = globalThis.window;
    const oldResizeObserver = globalThis.ResizeObserver;
    const oldWheelEvent = globalThis.WheelEvent;
    try {
        const element = () => ({ hidden: false, textContent: '', innerHTML: '', value: '', disabled: false,
            clientWidth: 1100, clientHeight: 520, handlers: new Map(), children: [],
            classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } }, style: { setProperty() {} },
            addEventListener(type, handler) {
                const previous = this.handlers.get(type);
                this.handlers.set(type, previous ? (event) => { previous(event); handler(event); } : handler);
            },
            setAttribute() {}, append(...children) { this.children.push(...children); },
            replaceChildren(...children) { this.children = children; }, contains() { return true; },
            getBoundingClientRect() { return { width: 1100, left: 0 }; },
            setPointerCapture() {}, hasPointerCapture() { return true; }, releasePointerCapture() {},
        });
        const ids = ['chart-heading', 'chart-description', 'chart-tooltip', 'chart-key-copy', 'chart-detail', 'chart-canvas', 'chart-scroll', 'chart-message', 'timeline-controls', 'range-start', 'range-end',
            'range-selection', 'from-date', 'to-date', 'range-min-label', 'range-max-label', 'zoom-in', 'zoom-out',
            'zoom-reset', 'model-visibility', 'model-legend', 'show-models', 'chart-status'];
        const items = Object.fromEntries(ids.map((id) => [id, element()]));
        const host = element();
        host.querySelector = (selector) => items[selector.slice(1)];
        items['chart-canvas'].querySelector = () => ({ getBoundingClientRect: () => ({ width: 1100, left: 0 }),
            viewBox: { baseVal: { width: 1100 } }, dataset: { flowPlotStartX: '100', flowPlotEndX: '1000',
                flowPlotStartTime: String(Date.parse('2026-09-07T00:00:00Z')),
                flowPlotEndTime: String(Date.parse('2026-09-28T00:00:00Z')) } });
        globalThis.document = { createElement: element };
        globalThis.window = { innerWidth: 1100, innerHeight: 800, addEventListener() {} };
        globalThis.ResizeObserver = class { observe() {} };
        globalThis.WheelEvent = { DOM_DELTA_LINE: 1, DOM_DELTA_PAGE: 2 };
        const { mountFlowChart } = await server.ssrLoadModule('/src/flow-chart.ts');
        const chart = mountFlowChart(host, { title: 'Community model tides', headingLevel: 2, initialStatus: 'Loading…' });
        assert.doesNotMatch(host.innerHTML, /THE FLOW OF ATTENTION|Bright marks =|Faint streams =|ADJUST THE WINDOW/);
        assert.match(host.innerHTML, /How to read this chart/);
        assert.match(host.innerHTML, /Timeline start date/);
        assert.match(host.innerHTML, /Show all|id="show-models"/);
        const weeks = ['2026-09-07', '2026-09-14', '2026-09-21', '2026-09-28'];
        const models = ['anthropic/claude-opus-4', 'anthropic/claude-sonnet-4', 'anthropic/claude-haiku-4',
            'openai/gpt-5', 'openai/gpt-5-codex', 'openai/o3', 'gemini/flash'];
        const rows = weeks.flatMap((week) => models.map((model, index) => ({ week, model, count: index + 1 })));
        chart.setData({ rows, source: 'shared', metricVersion: 2, detail: '7 uploaded reports · 3 opted-in reports' });
        assert.match(items['chart-description'].textContent, /model use.*Hover/i);
        assert.match(items['chart-status'].textContent, /Showing .*2026/);
        assert.match(items['chart-canvas'].innerHTML, /<svg/);
        assert.doesNotMatch(items['chart-canvas'].innerHTML, /<title\b|\stitle="/,
            'browser-native SVG titles must not compete with the live tooltip');
        assert.match(items['chart-canvas'].innerHTML, /data-flow-tooltip="[^"]+" aria-label="[^"]+"/);
        const mark = { closest() { return this; }, getAttribute(name) {
            return name === 'data-flow-tooltip' ? '28 active session-days · Opus 4.6 · 14 Sep 2026' : '#9d4262';
        } };
        items['chart-scroll'].handlers.get('pointermove')({ target: mark, pointerType: 'mouse', clientX: 400, clientY: 200 });
        assert.equal(items['chart-tooltip'].hidden, false);
        assert.match(items['chart-tooltip'].textContent, /Opus 4\.6 · 14 Sep 2026/);
        items['chart-scroll'].handlers.get('pointerleave')();
        assert.equal(items['chart-tooltip'].hidden, true);
        assert.match(items['chart-detail'].textContent, /7 uploaded reports · 3 opted-in reports/);
        assert.equal(items['timeline-controls'].hidden, false);
        assert.equal(items['show-models'].textContent, 'Show all 7');
        items['show-models'].handlers.get('click')();
        assert.equal(items['show-models'].textContent, 'Show top models');
        const wheel = { deltaY: -240, deltaX: 0, deltaMode: 0, clientX: 500, ctrlKey: false, metaKey: false,
            prevented: false, preventDefault() { this.prevented = true; } };
        items['chart-scroll'].handlers.get('wheel')(wheel);
        assert.equal(wheel.prevented, true);
        const start = Number(items['range-start'].value);
        const end = Number(items['range-end'].value);
        assert.ok(end - start < 21);
        const pan = { button: 0, pointerId: 1, clientX: 600, clientY: 200, preventDefault() {} };
        items['chart-scroll'].handlers.get('pointerdown')(pan);
        items['chart-scroll'].handlers.get('pointermove')({ ...pan, clientX: 800 });
        assert.equal(Number(items['range-end'].value) - Number(items['range-start'].value), end - start);
        items['chart-scroll'].handlers.get('pointerup')(pan);
        items['range-start'].value = String(Number(items['range-end'].value) + 4);
        items['range-start'].handlers.get('input')();
        assert.equal(Number(items['range-start'].value), Number(items['range-end'].value) - 1);
        const shiftingRows = [
            { week: '2026-09-07', model: 'old', count: 6 },
            { week: '2026-09-14', model: 'new', count: 5 },
        ];
        chart.setData({ rows: shiftingRows, source: 'shared', metricVersion: 2 });
        assert.doesNotMatch(items['chart-canvas'].innerHTML, /flow-inferred/);
        chart.setData({ rows: shiftingRows, source: 'shared', metricVersion: 1 });
        assert.doesNotMatch(items['chart-canvas'].innerHTML, /flow-inferred/);
        chart.setData({ rows: shiftingRows, source: 'gist', metricVersion: 1 });
        assert.doesNotMatch(items['chart-canvas'].innerHTML, /flow-inferred/);
        chart.setData({ rows: shiftingRows, source: 'gist', metricVersion: 2 });
        assert.match(items['chart-canvas'].innerHTML, /flow-inferred/);
        chart.setData({ rows: shiftingRows, source: 'mock', metricVersion: 2 });
        assert.match(items['chart-canvas'].innerHTML, /flow-inferred/);
        assert.match(items['chart-description'].textContent, /mock/i);
        chart.setMessage('Unavailable.');
        assert.equal(items['timeline-controls'].hidden, true);
        assert.equal(items['chart-status'].textContent, 'Unavailable.');
    } finally {
        globalThis.document = oldDocument;
        globalThis.window = oldWindow;
        globalThis.ResizeObserver = oldResizeObserver;
        globalThis.WheelEvent = oldWheelEvent;
        await server.close();
    }
});
