import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { initWasm, Resvg } from '@resvg/resvg-wasm';
import { getModelColor } from '../src/model-colors.ts';
import { imageSvg, pageForReport, summarize } from '../worker/public-pages.ts';

const shell = '<!doctype html><html><head><title>Model Tides</title></head><body><div id="app"></div><script type="module" src="/assets/index-hashed.js"></script></body></html>';

test('shared HTML and SVG have matching counts, exact OG links, and escaped model labels', async () => {
    const id = '019ff796-7912-7786-a7bf-a964d071294a';
    const report = summarize(id, [
        { week: '2026-09-28', model: '<script>alert(1)</script>', count: 2 },
        { week: '2026-10-05', model: '<script>alert(1)</script>', count: 3 },
        { week: '2026-10-05', model: 'openai/gpt-5', count: 1 },
    ]);
    assert.equal(report.total, 6);
    assert.equal(report.weeks, 2);
    assert.deepEqual(report.models[0], { model: '<script>alert(1)</script>', count: 5 });
    const page = await pageForReport(report, 'https://example.test', shell).text();
    assert.match(page, /https:\/\/example\.test\/og\/019ff796-7912-7786-a7bf-a964d071294a\.png/);
    assert.match(page, /6 model uses over 2 weeks/);
    assert.equal(page.includes('<script>alert(1)</script>'), false);
    assert.doesNotMatch(page, /alert\(1\)/, 'the HTML shell never embeds untrusted model names');
    const image = imageSvg(report);
    assert.match(image, /6 model uses/);
    assert.match(image, /5<\/text>/);
    assert.equal(image.includes('<script>'), false);
    const oneWeek = summarize(id, [{ week: '2026-09-28', model: 'openai/gpt-5', count: 2 }]);
    assert.match(await pageForReport(oneWeek, 'https://example.test', shell).text(), /2 model uses over 1 week · Model Tides/);
});

test('personal OG image is a weighted, full-width weekly flow with safe labels and model colors', () => {
    const report = summarize('019ff796-7912-7786-a7bf-a964d071294a', [
        { week: '2026-09-07', model: 'openai/gpt-5', count: 2 },
        { week: '2026-09-14', model: 'openai/gpt-5', count: 8 },
        { week: '2026-09-07', model: 'claude/sonnet', count: 3 },
        { week: '2026-09-14', model: 'claude/sonnet', count: 1 },
        ...['mistral/large', 'gemini/flash', 'qwen/3', 'deepseek/r1', 'xai/grok', '<&"\' model'].map((model) =>
            ({ week: '2026-09-14', model, count: 1 })),
    ]);
    const svg = imageSvg(report);
    assert.match(svg, /width="1200" height="630" viewBox="0 0 1200 630"/);
    assert.match(svg, /My model tide/);
    assert.match(svg, /font-family="Iosevka Etoile, serif"/);
    assert.match(svg, /font-family="Iosevka, monospace"/);
    assert.match(svg, /\.flow-svg \{ font-family: 'Iosevka Aile', sans-serif;/);
    assert.match(svg, /role="img" aria-label="[^"]*self-reported[^"]*"/);
    assert.match(svg, /class="usage-chart flow-svg"[^>]*width="1[01]\d\d" height="3\d\d"/);
    assert.match(svg, /class="continuity-ribbon"/);
    assert.match(svg, /class="usage-node"[^>]*height="[\d.]+"[^>]*><title>.*8 self-reported model uses<\/title>/);
    assert.match(svg, /<text[^>]*>7 Sept<\/text>/);
    assert.match(svg, /<text[^>]*>14 Sept<\/text>/);
    assert.match(svg, /Other models/);
    assert.match(svg, /#728b93/);
    assert.match(svg, new RegExp(`class="usage-node"[^>]*fill="${getModelColor('openai/gpt-5')}"`));
    assert.match(svg, /class="usage-node"[^>]*fill="#728b93"[^>]*><title>14 Sept · Other models · 2 self-reported model uses<\/title>/);
    assert.match(svg, /class="flow-ribbon flow-entry"[^>]*fill="#b65f89"/);
    assert.match(svg, /class="flow-ribbon flow-entry"[^>]*fill="#5e7293"/);
    assert.match(svg, /&lt;&amp;&quot;&#39; model/);
    assert.doesNotMatch(svg, /<&"' model|<script|flow-transition/);
    assert.match(svg, /weekly counts · crossed ribbons = inferred shifts, no tracked switches/i);
    assert.doesNotMatch(svg, /<rect x="80" y="\d+" width="\d+" height="17"/);
});

test('a missing week never creates a continuity ribbon or an inferred switch', () => {
    const svg = imageSvg(summarize('019ff796-7912-7786-a7bf-a964d071294a', [
        { week: '2026-09-07', model: 'openai/gpt-5', count: 3 },
        { week: '2026-09-21', model: 'openai/gpt-5', count: 2 },
    ]));
    assert.match(svg, /7 Sept/);
    assert.match(svg, /21 Sept/);
    assert.doesNotMatch(svg, /class="continuity-ribbon"|class="flow-ribbon flow-inferred"/);
});

test('personal OG image shows an apparent shift, not an observed switch, between adjacent weeks', () => {
    const svg = imageSvg(summarize('019ff796-7912-7786-a7bf-a964d071294a', [
        { week: '2026-09-07', model: 'anthropic/old', count: 6 },
        { week: '2026-09-14', model: 'anthropic/old', count: 2 },
        { week: '2026-09-14', model: 'openai/new', count: 5 },
    ]));
    assert.match(svg, /class="flow-ribbon flow-inferred"[^>]*><title>Apparent shift:.*not a tracked switch/);
    assert.match(svg, /class="flow-ribbon flow-entry"[^>]*><title>1 self-reported model uses of openai \/ new in 14 Sept/);
    assert.match(svg, /inferred shifts/i);
    assert.match(svg, /no tracked switches/i);
});

test('the community OG image retains its current card', () => {
    const svg = imageSvg(summarize(null, [{ week: '2026-09-07', model: 'openai/gpt-5', count: 2 }]));
    assert.match(svg, /COMMUNITY SNAPSHOT/);
    assert.match(svg, /font-family="Iosevka Etoile, serif"/);
    assert.match(svg, /font-family="Iosevka, monospace"/);
    assert.match(svg, /<rect x="80" y="338" width="580" height="17"/);
    assert.doesNotMatch(svg, /Your model tide|usage-chart flow-svg/);
    const active = imageSvg(summarize(null, [{ week: '2026-09-07', model: 'openai/gpt-5', count: 2 }], 2));
    assert.match(active, /font-size="48">2 active session-days/);
});

test('Resvg renders the personal SVG and heading with the site fonts', async () => {
    const wasm = await readFile(new URL('../node_modules/@resvg/resvg-wasm/index_bg.wasm', import.meta.url));
    const fonts = await Promise.all(['iosevka-aile', 'iosevka-etoile', 'iosevka'].map((family) =>
        readFile(new URL(`../src/fonts/${family}-site-400.woff2`, import.meta.url))));
    await initWasm(wasm);
    const source = imageSvg(summarize('019ff796-7912-7786-a7bf-a964d071294a', [
        { week: '2026-09-07', model: '<model & me>', count: 3 },
        { week: '2026-09-14', model: '<model & me>', count: 9 },
    ]));
    const svg = new Resvg(source, { font: { fontBuffers: fonts, loadSystemFonts: false, defaultFontFamily: 'Iosevka Aile' } });
    try {
        const image = svg.render();
        try {
            const png = Buffer.from(image.asPng());
            assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
            assert.equal(png.readUInt32BE(16), 1200);
            assert.equal(png.readUInt32BE(20), 630);
            const titlePixels = image.pixels;
            const paintedTitlePixels = Array.from({ length: 45 * 660 }, (_, index) => {
                const x = 60 + index % 660;
                const y = 58 + Math.floor(index / 660);
                const offset = (y * 1200 + x) * 4;
                return titlePixels[offset] !== 16 || titlePixels[offset + 1] !== 40 || titlePixels[offset + 2] !== 50;
            }).filter(Boolean).length;
            assert.ok(paintedTitlePixels > 100, 'the title must use a bundled font and render visibly');
            const node = source.match(/<rect class="usage-node" x="([\d.]+)" y="([\d.]+)" width="([\d.]+)" height="([\d.]+)"/);
            assert.ok(node);
            const x = Math.floor(60 + Number(node[1]) + Number(node[3]) / 2);
            const y = Math.floor(166 + Number(node[2]) + Number(node[4]) / 2);
            assert.notDeepEqual([...image.pixels.slice((y * 1200 + x) * 4, (y * 1200 + x) * 4 + 3)],
                [16, 40, 50], 'the chart node must be visible against the ocean background');
        } finally { image.free(); }
    } finally { svg.free(); }
});

test('report metadata names the chart; hidden reports cannot be read for images or pages', async () => {
    const { getReport } = await import('../worker/public-pages.ts');
    const report = summarize('019ff796-7912-7786-a7bf-a964d071294a', [
        { week: '2026-09-14', model: 'openai/gpt-5', count: 2 },
    ]);
    const page = await pageForReport(report, 'https://example.test', shell).text();
    assert.match(page, /<meta property="og:title" content="My model tide[^\"]*"/);
    assert.match(page, /<meta property="og:image" content="https:\/\/example\.test\/og\/019ff796-7912-7786-a7bf-a964d071294a\.png"/);
    assert.match(page, /no exact times or session IDs/i);
    const queries = [];
    const db = { prepare(sql) {
        queries.push(sql);
        return { bind(id) {
            assert.equal(id, report.id);
            return { async all() { return { results: [] }; } };
        } };
    } };
    assert.equal(await getReport(db, report.id), null);
    assert.match(queries[0], /c\.id = \? AND c\.published = 1/);
});

test('active-day reports label their metric in both social metadata and the share image', async () => {
    const report = summarize('019ff796-7912-7786-a7bf-a964d071294a', [
        { week: '2026-09-28', model: 'openai/gpt-5', count: 6 },
    ], 2);
    assert.match(await pageForReport(report, 'https://example.test', shell).text(), /My model tide · 6 active session-days/);
    const svg = imageSvg(report);
    assert.match(svg, /My model tide/);
    assert.match(svg, /6 active session-days/);
    assert.doesNotMatch(svg, /6 model uses/);
});

test('public report serves the interactive app shell with accurate per-link metadata', async () => {
    const id = '019ff796-7912-7786-a7bf-a964d071294a';
    const report = summarize(id, [{ week: '2026-09-28', model: 'openai/gpt-5', count: 2 }]);
    const page = await pageForReport(report, 'https://example.test', shell).text();
    assert.match(page, /<div id="app"><\/div><script type="module" src="\/assets\/index-hashed\.js"><\/script>/);
    assert.match(page, /<meta property="og:url" content="https:\/\/example\.test\/u\/019ff796-7912-7786-a7bf-a964d071294a">/);
    assert.match(page, /2 model uses over 1 week/);
    assert.doesNotMatch(page, /<table>/);
});
