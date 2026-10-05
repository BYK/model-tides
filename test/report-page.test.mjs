import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'vite';

test('a shared report renders an explorable flow chart from public weekly counts, never raw history', async () => {
    const server = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent' });
    const originalDocument = globalThis.document;
    const originalWindow = globalThis.window;
    const originalFetch = globalThis.fetch;
    const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    const originalClipboardItem = globalThis.ClipboardItem;
    const originalResizeObserver = globalThis.ResizeObserver;
    const originalWheelEvent = globalThis.WheelEvent;
    try {
        const id = '0199abcf-22aa-7333-8abc-0123456789ab';
        const element = () => ({ hidden: false, textContent: '', innerHTML: '', value: '', children: [], handlers: new Map(),
            clientWidth: 1200, clientHeight: 600, disabled: false,
            classList: { add() {}, remove() {}, toggle() {} },
            style: { setProperty() {} },
            append(child) { this.children.push(child); },
            replaceChildren(...children) { this.children = children; },
            setAttribute() {},
            addEventListener(type, handler) { this.handlers.set(type, handler); },
            getBoundingClientRect() { return { width: 1200, left: 0 }; },
            setPointerCapture() {}, hasPointerCapture() { return true; }, releasePointerCapture() {},
        });
        const items = Object.fromEntries(['app', 'theme-toggle', 'report-chart', 'chart-heading', 'chart-activity-legend', 'chart-legend-note',
            'chart-status', 'chart-canvas', 'chart-scroll',
            'chart-message', 'timeline-controls', 'range-start', 'range-end', 'range-selection',
            'from-date', 'to-date', 'range-min-label', 'range-max-label', 'zoom-in', 'zoom-out', 'zoom-reset',
            'model-visibility', 'model-legend', 'show-models', 'report-share', 'share-x', 'share-bluesky',
            'copy-report-image', 'download-report-image', 'native-share-image', 'share-status', 'share-nickname',
            'donate-owner-form', 'donate-owner-key', 'donate-review', 'donate-confirm', 'donate-counts',
            'donate-submit', 'donate-status', 'donate-legacy', 'donation-card', 'donation-result'].map((name) => [name, element()]));
        items.app.querySelector = (selector) => items[selector.slice(1)];
        items['report-chart'].querySelector = items.app.querySelector;
        items['chart-canvas'].querySelector = (selector) => selector === 'svg.flow-svg' ? {
            getBoundingClientRect: () => ({ width: 1200, left: 0 }),
            viewBox: { baseVal: { width: 1200 } },
            dataset: { flowPlotStartX: '100', flowPlotEndX: '1100',
                flowPlotStartTime: String(Date.parse('2026-09-21T00:00:00Z')),
                flowPlotEndTime: String(Date.parse('2026-09-28T00:00:00Z')) },
        } : null;
        globalThis.document = {
            documentElement: { dataset: {} },
            querySelector: (selector) => selector === '#app' ? items.app : { content: '' },
            createDocumentFragment: element,
            createElement: element,
        };
        const replacedUrls = [];
        globalThis.window = {
            location: { pathname: `/u/${id}`, search: '?from=2026-09-28&to=2026-09-28', origin: 'https://modeltides.dev' },
            history: { replaceState(_state, _title, next) {
                replacedUrls.push(next);
                globalThis.window.location.search = new URL(next, globalThis.window.location.origin).search;
            } },
            matchMedia: () => ({ matches: false, addEventListener() {} }),
            innerWidth: 1200, innerHeight: 800, addEventListener() {},
        };
        globalThis.ResizeObserver = class { observe() {} };
        globalThis.WheelEvent = { DOM_DELTA_LINE: 1, DOM_DELTA_PAGE: 2 };
        const copied = [];
        Object.defineProperty(globalThis, 'navigator', { configurable: true, value: {
            clipboard: { async write(items) { copied.push(...items); } },
        } });
        globalThis.ClipboardItem = class { constructor(contents) { this.contents = contents; } };
        const calls = [];
        let donated = false;
        globalThis.fetch = async (url, options) => {
            calls.push({ url, options });
            if (String(url).includes(`/og/${id}.png`)) return new Response(new Uint8Array([137, 80, 78, 71]),
                { headers: { 'Content-Type': 'image/png' } });
            if (url === `/api/contributions/${id}/aggregate-status`) return Response.json({ id, inAggregate: donated });
            if (options?.method === 'POST') { donated = true; return Response.json({ id, inAggregate: true }); }
            if (options?.headers?.Authorization) return Response.json({ id, published: true, inAggregate: false,
                metricVersion: 2, revision: 0, counts: [
                    { week: '2026-09-21', model: 'openai/gpt-5', count: 2 },
                    { week: '2026-09-28', model: 'openai/gpt-5', count: 3 },
                ] });
            return Response.json({ id, published: true, metricVersion: 2, counts: [
                { week: '2026-09-21', model: '<img src=x onerror=alert(1)>', count: 2 },
                { week: '2026-09-28', model: 'openai/gpt-5', count: 1 },
                ...Array.from({ length: 6 }, (_, index) => ({ week: '2026-09-28', model: `example/model-${index}`, count: 1 })),
            ] });
        };
        await server.ssrLoadModule('/src/report-page.ts');
        await new Promise(setImmediate);
        assert.deepEqual(calls.map(({ url }) => url), [`/api/contributions/${id}`, `/api/contributions/${id}/aggregate-status`]);
        assert.equal(calls[0].options.cache, 'no-store');
        assert.match(items['report-chart'].innerHTML, /class="chart-card flow-chart"/);
        assert.match(items['report-chart'].innerHTML, /class="range-track"/);
        assert.match(items.app.innerHTML, /class="report-intro"/,
            'the public report has a dedicated, human-readable introduction');
        assert.match(items.app.innerHTML, /data-lucide="copy"/,
            'share actions use the shared icon treatment');
        assert.match(items.app.innerHTML, /<details class="donation-card"/,
            'owner-only contribution controls stay out of the reading flow until requested');
        assert.doesNotMatch(items.app.innerHTML, /View exact weekly counts|<table/);
        assert.match(items['chart-canvas'].innerHTML, /<svg/);
        assert.doesNotMatch(items['chart-canvas'].innerHTML, /<img src=x/);
        assert.match(items['chart-status'].textContent, /7 active session-days/);
        assert.equal(items['donate-owner-form'].hidden, false);
        assert.match(items.app.innerHTML, /npx model-tides@latest key/);
        assert.match(items.app.innerHTML, /npx model-tides@latest contribute/);
        assert.match(items.app.innerHTML, /If you are not the owner.*try yours/i);
        assert.match(items['report-chart'].innerHTML, /inferred shifts/i);
        assert.equal(items['timeline-controls'].hidden, false);
        assert.equal(items['range-start'].value, String(Date.parse('2026-09-28T00:00:00Z') / 86_400_000),
            'a valid range in the shared link restores the selected start');
        assert.equal(items['range-end'].value, String(Date.parse('2026-09-28T00:00:00Z') / 86_400_000),
            'a valid range in the shared link restores the selected end');
        items['range-start'].value = String(Date.parse('2026-09-21T00:00:00Z') / 86_400_000);
        items['range-start'].handlers.get('input')();
        assert.equal(replacedUrls.at(-1), `/u/${id}?from=2026-09-21&to=2026-09-28`);
        assert.match(items['chart-canvas'].innerHTML, /&lt;img src=x/);
        assert.match(items['chart-canvas'].innerHTML, /class="flow-ribbon flow-inferred"/);
        assert.doesNotMatch(items.app.innerHTML, /href="\/local\/"/);
        assert.equal(new URL(items['share-x'].href).searchParams.get('url'),
            `https://modeltides.dev/u/${id}?from=2026-09-21&to=2026-09-28`);
        assert.match(new URL(items['share-bluesky'].href).searchParams.get('text'), /My model tide.*https:\/\/modeltides\.dev\/u\//);
        assert.equal(new URL(items['share-x'].href).searchParams.get('text'), 'My model tide');
        items['share-nickname'].value = 'BYK';
        items['share-nickname'].handlers.get('input')();
        assert.equal(new URL(items['share-x'].href).searchParams.get('text'), "BYK's model tide");
        assert.equal(items['show-models'].textContent, 'Show all 8');
        items['show-models'].handlers.get('click')();
        assert.equal(items['show-models'].textContent, 'Show top models');
        const wheel = { deltaY: -200, deltaX: 0, deltaMode: 0, clientX: 750,
            ctrlKey: false, metaKey: false, prevented: false, preventDefault() { this.prevented = true; } };
        items['chart-scroll'].handlers.get('wheel')(wheel);
        assert.equal(wheel.prevented, true);
        const zoomedStart = Number(items['range-start'].value);
        const zoomedEnd = Number(items['range-end'].value);
        assert.ok(zoomedEnd - zoomedStart < 7);
        const pan = { button: 0, pointerId: 1, clientX: 600, clientY: 200, preventDefault() {} };
        items['chart-scroll'].handlers.get('pointerdown')(pan);
        items['chart-scroll'].handlers.get('pointermove')({ ...pan, clientX: 800 });
        assert.equal(Number(items['range-end'].value) - Number(items['range-start'].value), zoomedEnd - zoomedStart);
        items['chart-scroll'].handlers.get('pointerup')(pan);
        const beforePinch = Number(items['range-end'].value) - Number(items['range-start'].value);
        const touch = (pointerId, clientX) => ({ pointerType: 'touch', button: 0, pointerId, clientX,
            clientY: 200, preventDefault() {} });
        items['chart-scroll'].handlers.get('pointerdown')(touch(11, 450));
        items['chart-scroll'].handlers.get('pointerdown')(touch(12, 750));
        items['chart-scroll'].handlers.get('pointermove')(touch(11, 350));
        items['chart-scroll'].handlers.get('pointermove')(touch(12, 850));
        assert.ok(Number(items['range-end'].value) - Number(items['range-start'].value) < beforePinch,
            'spreading two fingers zooms into the shared report');
        items['chart-scroll'].handlers.get('pointerup')(touch(11, 350));
        items['chart-scroll'].handlers.get('pointerup')(touch(12, 850));
        const beforeTouchPan = Number(items['range-start'].value);
        items['chart-scroll'].handlers.get('pointerdown')(touch(13, 650));
        items['chart-scroll'].handlers.get('pointermove')(touch(13, 1050));
        assert.notEqual(Number(items['range-start'].value), beforeTouchPan,
            'one horizontal finger drag pans the zoomed chart');
        items['chart-scroll'].handlers.get('pointerup')(touch(13, 1050));
        items['range-start'].value = String(Number(items['range-end'].value) + 4);
        items['range-start'].handlers.get('input')();
        assert.equal(Number(items['range-start'].value), Number(items['range-end'].value) - 1);
        items['copy-report-image'].handlers.get('click')();
        await new Promise(setImmediate);
        assert.equal(copied.length, 1);
        assert.equal((await copied[0].contents['image/png']).type, 'image/png');
        assert.match(items['share-status'].textContent, /Image copied/);
        assert.deepEqual(calls.slice(0, 2).map(({ url }) => url),
            [`/api/contributions/${id}`, `/api/contributions/${id}/aggregate-status`]);
        const imageSearch = new URL(calls[2].url, 'https://modeltides.dev').searchParams;
        assert.match(calls[2].url, new RegExp(`^/og/${id}\\.png\\?`));
        assert.ok(imageSearch.has('from') && imageSearch.has('to'), 'the copied image keeps the selected range');
        items['donate-owner-key'].value = 'public-link-is-not-a-key';
        items['donate-owner-form'].handlers.get('submit')({ preventDefault() {} });
        await new Promise(setImmediate);
        assert.equal(calls.length, 3, 'a public link cannot donate without a private key');
        assert.equal(items['donate-confirm'].hidden, true);
        items['donate-owner-key'].value = 's'.repeat(43);
        items['donate-owner-form'].handlers.get('submit')({ preventDefault() {} });
        await new Promise(setImmediate);
        assert.equal(items['donate-confirm'].hidden, false);
        assert.match(items['donate-counts'].textContent, /2026-09-21 · openai\/gpt-5: 2/);
        assert.equal(calls[3].options.headers.Authorization, `Bearer ${'s'.repeat(43)}`);
        assert.equal(items['donate-owner-key'].value, '', 'owner key is cleared from the form');
        items['donate-submit'].handlers.get('click')();
        await new Promise(setImmediate);
        assert.equal(calls[4].url, `/api/contributions/${id}/contribute`);
        assert.equal(calls[4].options.body, undefined);
        assert.equal(calls[4].options.headers['X-Model-Tides-Reviewed-Revision'], '0');
        assert.equal(items['donation-card'].hidden, true, 'the donation form disappears after confirmation');
        assert.match(items['donation-result'].textContent, /Donated/);
        items['donation-card'].hidden = false;
        await server.ssrLoadModule('/src/report-page.ts?refreshed');
        await new Promise(setImmediate);
        assert.equal(items['donation-card'].hidden, true, 'the donation form stays gone after a reload');
        assert.equal(calls.at(-1).options?.headers?.Authorization, undefined, 'a visitor needs no owner key to see donated status');
    } finally {
        globalThis.fetch = originalFetch;
        globalThis.window = originalWindow;
        globalThis.document = originalDocument;
        globalThis.ResizeObserver = originalResizeObserver;
        globalThis.WheelEvent = originalWheelEvent;
        if (originalNavigator) Object.defineProperty(globalThis, 'navigator', originalNavigator);
        else delete globalThis.navigator;
        globalThis.ClipboardItem = originalClipboardItem;
        await server.close();
    }
});
