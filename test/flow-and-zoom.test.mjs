import assert from 'node:assert/strict';
import test from 'node:test';
import { renderFlowSvg } from '../src/flow-svg/renderer.ts';
import { getModelColor, OTHER_MODEL_COLOR } from '../src/model-colors.ts';
import { clampEndDay, clampStartDay, panDateRange, zoomDateRange } from '../src/timeline-zoom.ts';

const january = Date.UTC(2025, 0, 1);
const february = Date.UTC(2025, 1, 1);
const august = Date.UTC(2025, 7, 1);
const chartOptions = { start: january, end: august, width: 1200, height: 640 };

const render = (data, options = {}) => renderFlowSvg(data, { ...chartOptions, ...options });

function continuityBand(svg) {
    const path = svg.match(/<path class="continuity-ribbon" d="([^"]+)"/);
    assert.ok(path, 'expected a real same-model continuity stream');
    const coordinates = path[1].match(/-?\d+(?:\.\d+)?/g).map(Number);
    return coordinates[15] - coordinates[1];
}

function continuityEndBand(svg) {
    const path = svg.match(/<path class="continuity-ribbon" d="([^"]+)"/);
    assert.ok(path, 'expected a real same-model continuity stream');
    const coordinates = path[1].match(/-?\d+(?:\.\d+)?/g).map(Number);
    return coordinates[9] - coordinates[5];
}

function continuityBands(svg) {
    return [...svg.matchAll(/<path class="continuity-ribbon" d="([^"]+)"/g)].map((path) => {
        const coordinates = path[1].match(/-?\d+(?:\.\d+)?/g).map(Number);
        return [coordinates[15] - coordinates[1], coordinates[9] - coordinates[5]];
    });
}

function inferredBands(svg) {
    return [...svg.matchAll(/<path class="flow-ribbon flow-inferred" d="([^"]+)"/g)].map((path) => {
        const coordinates = path[1].match(/-?\d+(?:\.\d+)?/g).map(Number);
        return [coordinates[15] - coordinates[1], coordinates[9] - coordinates[5]];
    });
}

function assertBandsClose(actual, expected) {
    assert.equal(actual.length, expected.length);
    for (const [index, bands] of actual.entries()) {
        assert.equal(bands.length, expected[index].length);
        for (const [side, width] of bands.entries()) assert.ok(Math.abs(width - expected[index][side]) < 0.000001);
    }
}

function ribbonEdges(svg, from, to) {
    const path = [...svg.matchAll(/<path class="flow-ribbon flow-inferred" d="([^"]+)"[^>]*data-flow-pairs="\[\[&quot;([^&]+)&quot;,&quot;([^&]+)&quot;\]\]"/g)]
        .find(([, , source, target]) => source === from && target === to);
    assert.ok(path, `expected an inferred ${from} → ${to} ribbon`);
    const coordinates = path[1].match(/-?\d+(?:\.\d+)?/g).map(Number);
    return { fromTop: coordinates[1], fromBottom: coordinates[15], toTop: coordinates[5], toBottom: coordinates[9] };
}

function continuityEdges(svg, key) {
    const path = [...svg.matchAll(/<path class="continuity-ribbon" d="([^"]+)"[^>]*data-flow-pairs="\[\[null,&quot;([^&]+)&quot;\]\]"/g)]
        .find(([, , model]) => model === key);
    assert.ok(path, `expected ${key} continuity`);
    const coordinates = path[1].match(/-?\d+(?:\.\d+)?/g).map(Number);
    return { fromTop: coordinates[1], fromBottom: coordinates[15], toTop: coordinates[5], toBottom: coordinates[9] };
}

function nodeEdges(svg, period, key) {
    const node = [...svg.matchAll(/<rect class="usage-node" x="[^"]+" y="([^"]+)" width="[^"]+" height="([^"]+)"[^>]*><title>([^<]+)<\/title>/g)]
        .find(([, , , title]) => title.startsWith(`${period} · ${key} ·`));
    assert.ok(node, `expected ${key} node in ${period}`);
    return { top: Number(node[1]), bottom: Number(node[1]) + Number(node[2]) };
}

function assertNear(actual, expected) {
    assert.ok(Math.abs(actual - expected) < 0.000001, `expected ${actual} near ${expected}`);
}

test('same-model continuity resizes to activity in each adjacent period', () => {
    const svg = render([
        { time: january + 86_400_000, to: 'model-a', weight: 4 },
        { time: february + 86_400_000, to: 'model-a', weight: 10 },
    ]);

    assert.match(svg, /data-flow-plot-start-x=/);
    assert.ok(Math.abs(continuityBand(svg) - (4 * (chartOptions.height - 96)) / 10) < 0.001);
    assert.ok(Math.abs(continuityEndBand(svg) - (10 * (chartOptions.height - 96)) / 10) < 0.001);
});

test('grouped categories connect only the underlying models present in both periods', () => {
    const grouped = { displayKey: () => 'Other models' };
    const differentModels = render([
        { time: january + 86_400_000, to: 'model-a' },
        { time: february + 86_400_000, to: 'model-b' },
    ], grouped);
    assert.doesNotMatch(differentModels, /class="continuity-ribbon"/);

    const sharedModels = render([
        { time: january + 86_400_000, to: 'model-a', weight: 3 },
        { time: january + 86_400_000, to: 'model-b', weight: 1 },
        { time: february + 86_400_000, to: 'model-a', weight: 1 },
        { time: february + 86_400_000, to: 'model-b', weight: 3 },
    ], grouped);
    const scale = (chartOptions.height - 96) / 4;
    assert.deepEqual(continuityBands(sharedModels), [[3 * scale, scale], [scale, 3 * scale]]);
});

test('entry marks and hover data move onto a matching continuity stream', () => {
    const svg = render([
        { time: january + 86_400_000, to: 'model-a', weight: 4 },
        { time: february + 86_400_000, to: 'model-a', weight: 10 },
    ]);

    assert.equal((svg.match(/class="flow-entry-block"/g) ?? []).length, 1);
    assert.equal((svg.match(/class="flow-ribbon flow-entry"/g) ?? []).length, 1);
    assert.match(svg, /class="continuity-ribbon"[^>]*data-flow-pairs="[^\"]*\[null,&quot;model-a&quot;\][^\"]*"[^>]*><title>[^<]*10 into model-a/);
});

test('entry marks move onto an observed incoming stream, while unmatched grouped models keep theirs', () => {
    const switchSvg = render([
        { time: january + 86_400_000, to: 'model-a' },
        { time: february + 86_400_000, to: 'model-a' },
        { time: february + 2 * 86_400_000, to: 'model-b', from: 'model-a', fromTime: february + 86_400_000 },
        { time: february + 3 * 86_400_000, to: 'model-b' },
    ]);
    assert.match(switchSvg, /flow-intra[^>]*data-flow-pairs="[^\"]*\[null,&quot;model-b&quot;\][^\"]*"[^>]*><title>[^<]*into model-b/);
    assert.equal((switchSvg.match(/class="flow-entry-block"/g) ?? []).length, 1);

    const groupedSvg = render([
        { time: january + 86_400_000, to: 'model-a' },
        { time: february + 86_400_000, to: 'model-b' },
    ], { displayKey: () => 'Other models' });
    assert.doesNotMatch(groupedSvg, /class="continuity-ribbon"/);
    assert.equal((groupedSvg.match(/class="flow-entry-block"/g) ?? []).length, 2);
});

test('grouped hidden-model switches do not become self-loops, while their continuity stays model-specific', () => {
    const svg = render([
        { time: january + 86_400_000, to: 'model-a' },
        { time: january + 2 * 86_400_000, to: 'model-b', from: 'model-a', fromTime: january + 86_400_000 },
        { time: february + 86_400_000, to: 'model-a' },
        { time: february + 2 * 86_400_000, to: 'model-b', from: 'model-a', fromTime: february + 86_400_000 },
    ], { displayKey: () => 'Other models' });

    assert.equal((svg.match(/class="usage-node"/g) ?? []).length, 2);
    assert.equal((svg.match(/class="flow-ribbon flow-intra"/g) ?? []).length, 0);
    assert.equal(continuityBands(svg).length, 2);
    assert.match(svg, /Visual continuity: model-a/);
    assert.match(svg, /Visual continuity: model-b/);
});

test('weekly count charts infer a bounded shift from declining to rising models, without duplicating continuity', () => {
    const svg = render([
        { time: january + 86_400_000, to: 'model-a', weight: 10 },
        { time: february + 86_400_000, to: 'model-a', weight: 6 },
        { time: january + 86_400_000, to: 'model-b', weight: 2 },
        { time: february + 86_400_000, to: 'model-b', weight: 6 },
    ], { inferMigrations: true });
    const scale = (chartOptions.height - 96 - 15) / 12;
    assertBandsClose(continuityBands(svg), [[6 * scale, 6 * scale], [2 * scale, 2 * scale]]);
    assertBandsClose(inferredBands(svg), [[4 * scale, 4 * scale]]);
    assert.match(svg, /class="flow-ribbon flow-inferred"[^>]*data-flow-pairs="\[\[&quot;model-a&quot;,&quot;model-b&quot;\]\]"[^>]*><title>Apparent shift:.*not a tracked switch/);
    assert.doesNotMatch(svg, /class="flow-ribbon flow-inferred"[^>]*model-b&quot;,&quot;model-a/);
    assert.equal((svg.match(/class="flow-entry-block"/g) ?? []).length, 2);
});

test('inferred shifts use the nearest edge above and below, without crossing either continuity ribbon', () => {
    const data = [
        { time: january + 86_400_000, to: 'old', weight: 10 },
        { time: february + 86_400_000, to: 'old', weight: 6 },
        { time: january + 86_400_000, to: 'new', weight: 2 },
        { time: february + 86_400_000, to: 'new', weight: 6 },
    ];
    const downward = render(data, { order: ['old', 'new'], inferMigrations: true });
    const down = ribbonEdges(downward, 'old', 'new');
    assertNear(down.fromBottom, nodeEdges(downward, 'Jan 25', 'old').bottom);
    assertNear(down.toTop, nodeEdges(downward, 'Feb 25', 'new').top);
    assert.ok(down.fromTop >= continuityEdges(downward, 'old').fromBottom - 0.000001);
    assert.ok(down.toBottom <= continuityEdges(downward, 'new').toTop + 0.000001);

    const upward = render(data, { order: ['new', 'old'], inferMigrations: true });
    const up = ribbonEdges(upward, 'old', 'new');
    assertNear(up.fromTop, nodeEdges(upward, 'Jan 25', 'old').top);
    assertNear(up.toBottom, nodeEdges(upward, 'Feb 25', 'new').bottom);
    assert.ok(up.fromBottom <= continuityEdges(upward, 'old').fromTop + 0.000001);
    assert.ok(up.toTop >= continuityEdges(upward, 'new').toBottom - 0.000001);
});

test('branches to models on both sides attach in vertical order around retained usage', () => {
    const svg = render([
        { time: january + 86_400_000, to: 'middle', weight: 10 },
        { time: february + 86_400_000, to: 'middle', weight: 2 },
        { time: february + 86_400_000, to: 'above', weight: 4 },
        { time: february + 86_400_000, to: 'below', weight: 4 },
    ], { order: ['above', 'middle', 'below'], inferMigrations: true });
    const above = ribbonEdges(svg, 'middle', 'above');
    const below = ribbonEdges(svg, 'middle', 'below');
    const retained = continuityEdges(svg, 'middle');
    assertNear(above.fromTop, nodeEdges(svg, 'Jan 25', 'middle').top);
    assertNear(below.fromBottom, nodeEdges(svg, 'Jan 25', 'middle').bottom);
    assert.ok(above.fromBottom <= retained.fromTop + 0.000001);
    assert.ok(retained.fromBottom <= below.fromTop + 0.000001);
    assertNear(above.toBottom, nodeEdges(svg, 'Feb 25', 'above').bottom);
    assertNear(below.toTop, nodeEdges(svg, 'Feb 25', 'below').top);
});

test('incoming shifts from both sides leave room for the target model’s continuity', () => {
    const svg = render([
        { time: january + 86_400_000, to: 'above', weight: 4 },
        { time: january + 86_400_000, to: 'middle', weight: 2 },
        { time: january + 86_400_000, to: 'below', weight: 4 },
        { time: february + 86_400_000, to: 'middle', weight: 10 },
    ], { order: ['above', 'middle', 'below'], inferMigrations: true });
    const above = ribbonEdges(svg, 'above', 'middle');
    const below = ribbonEdges(svg, 'below', 'middle');
    const retained = continuityEdges(svg, 'middle');
    assertNear(above.toTop, nodeEdges(svg, 'Feb 25', 'middle').top);
    assertNear(below.toBottom, nodeEdges(svg, 'Feb 25', 'middle').bottom);
    assert.ok(above.toBottom <= retained.toTop + 0.000001);
    assert.ok(retained.toBottom <= below.toTop + 0.000001);
});

test('multiple shifts on one side stack by the other model’s height, not by change size', () => {
    const departing = render([
        { time: january + 86_400_000, to: 'old', weight: 8 },
        { time: february + 86_400_000, to: 'near', weight: 3 },
        { time: february + 86_400_000, to: 'far', weight: 5 },
    ], { order: ['old', 'near', 'far'], inferMigrations: true });
    const near = ribbonEdges(departing, 'old', 'near');
    const far = ribbonEdges(departing, 'old', 'far');
    assertNear(near.fromTop, nodeEdges(departing, 'Jan 25', 'old').top);
    assertNear(far.fromBottom, nodeEdges(departing, 'Jan 25', 'old').bottom);
    assertNear(near.fromBottom, far.fromTop);

    const arriving = render([
        { time: january + 86_400_000, to: 'far', weight: 3 },
        { time: january + 86_400_000, to: 'near', weight: 5 },
        { time: february + 86_400_000, to: 'new', weight: 8 },
    ], { order: ['far', 'near', 'new'], inferMigrations: true });
    const upper = ribbonEdges(arriving, 'far', 'new');
    const lower = ribbonEdges(arriving, 'near', 'new');
    assertNear(upper.toTop, nodeEdges(arriving, 'Feb 25', 'new').top);
    assertNear(lower.toBottom, nodeEdges(arriving, 'Feb 25', 'new').bottom);
    assertNear(upper.toBottom, lower.toTop);
});

test('unmatched new uses stay between retained usage and a shift arriving from below', () => {
    const svg = render([
        { time: january + 86_400_000, to: 'new', weight: 2 },
        { time: january + 86_400_000, to: 'old', weight: 4 },
        { time: february + 86_400_000, to: 'new', weight: 8 },
    ], { order: ['new', 'old'], inferMigrations: true });
    const migration = ribbonEdges(svg, 'old', 'new');
    const retained = continuityEdges(svg, 'new');
    const entry = svg.match(/<path class="flow-ribbon flow-entry" d="([^"]+)"[^>]*><title>2 into new \(Feb 25\)/);
    assert.ok(entry);
    const coordinates = entry[1].match(/-?\d+(?:\.\d+)?/g).map(Number);
    assertNear(retained.toBottom, coordinates[5]);
    assertNear(coordinates[9], migration.toTop);
    assertNear(migration.toBottom, nodeEdges(svg, 'Feb 25', 'new').bottom);
});

test('a new model receives only the unmatched increase as an entry, and losses never exceed gains', () => {
    const svg = render([
        { time: january + 86_400_000, to: 'model-a', weight: 4 },
        { time: february + 86_400_000, to: 'model-b', weight: 6 },
    ], { inferMigrations: true });
    const scale = (chartOptions.height - 96) / 6;
    assertBandsClose(inferredBands(svg), [[4 * scale, 4 * scale]]);
    assert.match(svg, /class="flow-ribbon flow-entry"[^>]*><title>2 into model-b/);
    assert.doesNotMatch(svg, /class="flow-ribbon flow-entry"[^>]*><title>6 into model-b/);
    assert.equal((svg.match(/class="flow-entry-block"/g) ?? []).length, 2);
});

test('inferred shifts pair only unaccounted adjacent-period changes, in a stable order', () => {
    const svg = render([
        { time: january + 86_400_000, to: 'a', weight: 9 },
        { time: january + 86_400_000, to: 'c', weight: 5 },
        { time: february + 86_400_000, to: 'a', weight: 2 },
        { time: february + 86_400_000, to: 'c', weight: 3 },
        { time: february + 86_400_000, to: 'b', weight: 4 },
        { time: february + 86_400_000, to: 'd', weight: 1 },
    ], { inferMigrations: true });
    const scale = (chartOptions.height - 96 - 15 * 3) / 14;
    assertBandsClose(inferredBands(svg), [[4 * scale, 4 * scale], [scale, scale]]);
    assert.match(svg, /data-flow-pairs="\[\[&quot;a&quot;,&quot;b&quot;\]\]"/);
    assert.match(svg, /data-flow-pairs="\[\[&quot;a&quot;,&quot;d&quot;\]\]"/);
    assert.doesNotMatch(svg, /class="flow-ribbon flow-inferred"[^>]*&quot;c&quot;/);
    assert.equal(render([
        { time: january + 86_400_000, to: 'a', weight: 2 },
        { time: february + 86_400_000, to: 'a', weight: 3 },
    ], { inferMigrations: true }).includes('flow-inferred'), false);
});

test('weekly buckets link consecutive weeks but never jump an absent week or invent hidden self-loops', () => {
    const monday = Date.UTC(2026, 8, 7);
    const weekly = { start: monday, end: monday + 14 * 86_400_000, weeklyBuckets: true, inferMigrations: true };
    const adjacent = render([
        { time: monday, to: 'a', weight: 2 },
        { time: monday + 7 * 86_400_000, to: 'b', weight: 2 },
    ], weekly);
    assert.deepEqual(inferredBands(adjacent).length, 1);
    assert.match(adjacent, /7 Sept/);
    assert.match(adjacent, /14 Sept/);
    const missing = render([
        { time: monday, to: 'a', weight: 2 },
        { time: monday + 14 * 86_400_000, to: 'b', weight: 2 },
    ], weekly);
    assert.deepEqual(inferredBands(missing), []);
    const grouped = render([
        { time: monday, to: 'a', weight: 2 },
        { time: monday + 7 * 86_400_000, to: 'b', weight: 2 },
    ], { ...weekly, displayKey: () => 'Other models' });
    assert.deepEqual(inferredBands(grouped), []);
});

test('inferred ribbon and entry amounts balance every target across varied count changes', () => {
    const seed = { value: 0x23456789 };
    const count = () => {
        seed.value = (Math.imul(seed.value, 1_664_525) + 1_013_904_223) >>> 0;
        return (seed.value >>> 16) % 8;
    };
    const names = ['m0', 'm1', 'm2', 'm3'];
    for (const _sample of Array.from({ length: 30 })) {
        const before = names.map(count);
        const after = names.map(count);
        const data = names.flatMap((name, index) => [
            ...(before[index] ? [{ time: january + 86_400_000, to: name, weight: before[index] }] : []),
            ...(after[index] ? [{ time: february + 86_400_000, to: name, weight: after[index] }] : []),
        ]);
        const svg = render(data, { inferMigrations: true });
        const outbound = new Map(names.map((name) => [name, 0]));
        const inbound = new Map(names.map((name) => [name, 0]));
        for (const [, source, target, amount] of svg.matchAll(/class="flow-ribbon flow-inferred"[^>]*data-flow-pairs="\[\[&quot;(m\d)&quot;,&quot;(m\d)&quot;\]\]"[^>]*><title>[^<]*Up to (\d+) line up/g)) {
            assert.notEqual(source, target);
            outbound.set(source, outbound.get(source) + Number(amount));
            inbound.set(target, inbound.get(target) + Number(amount));
        }
        const entries = new Map(names.map((name) => [name, 0]));
        for (const [, amount, name] of svg.matchAll(/class="flow-ribbon flow-entry"[^>]*><title>(\d+) into (m\d) \(Feb 25\)/g)) {
            entries.set(name, entries.get(name) + Number(amount));
        }
        for (const [index, name] of names.entries()) {
            const retained = Math.min(before[index], after[index]);
            assert.ok(outbound.get(name) <= before[index] - retained);
            assert.equal(retained + inbound.get(name) + entries.get(name), after[index]);
        }
        const totalDrop = before.reduce((sum, value, index) => sum + Math.max(0, value - after[index]), 0);
        const totalRise = after.reduce((sum, value, index) => sum + Math.max(0, value - before[index]), 0);
        assert.equal([...inbound.values()].reduce((sum, value) => sum + value, 0), Math.min(totalDrop, totalRise));
    }
    assert.throws(() => render([{ time: february, to: 'm1', from: 'm0', fromTime: january }],
        { inferMigrations: true }), /count-only data/);
});

test('known providers and model families keep stable colors across model versions and routes', () => {
    const opus = getModelColor('anthropic/claude-opus-4');
    const sonnet = getModelColor('anthropic/claude-3-7-sonnet');
    const haiku = getModelColor('anthropic/claude-3-5-haiku');
    assert.equal(getModelColor('openrouter/anthropic/claude-opus-4-1'), opus);
    assert.notEqual(opus, sonnet);
    assert.notEqual(sonnet, haiku);
    assert.equal(getModelColor('openai/gpt-4o'), getModelColor('openai/gpt-5'));
    assert.equal(getModelColor('openai/gpt-4o'), getModelColor('openrouter/openai/gpt-4o'));
    assert.notEqual(getModelColor('openai/gpt-5'), opus);
    assert.notEqual(getModelColor('openai/gpt-5'), getModelColor('openai/gpt-5-codex'));
    assert.notEqual(getModelColor('openai/gpt-5'), getModelColor('openai/o3'));
    assert.notEqual(getModelColor('google/gemini-2.5-pro'), getModelColor('google/gemini-2.5-flash'));
    assert.notEqual(getModelColor('mistral/large'), getModelColor('mistral/codestral'));
    assert.equal(getModelColor('other-provider/model-1'), getModelColor('other-provider/model-2'));
    assert.equal(getModelColor('Other models'), OTHER_MODEL_COLOR);
});

test('adjacent model families use separated colors on a light chart', () => {
    const distance = (first, second) => {
        const channels = (color) => [1, 3, 5].map((index) => parseInt(color.slice(index, index + 2), 16));
        const a = channels(getModelColor(first));
        const b = channels(getModelColor(second));
        return Math.hypot(...a.map((value, index) => value - b[index]));
    };
    for (const [first, second] of [
        ['anthropic/claude-opus-4', 'anthropic/claude-sonnet-4'],
        ['anthropic/claude-sonnet-4', 'anthropic/claude-haiku-4'],
        ['anthropic/claude-opus-4', 'anthropic/claude-haiku-4'],
        ['openai/gpt-5', 'openai/gpt-5-codex'],
        ['openai/gpt-5', 'openai/o3'],
    ]) assert.ok(distance(first, second) > 60, `${first} and ${second} need visibly distinct colors`);
});

test('grouped model streams keep their family colors while the aggregate node stays neutral', () => {
    const svg = render([
        { time: january + 86_400_000, to: 'anthropic/claude-opus-4' },
        { time: february + 86_400_000, to: 'anthropic/claude-opus-4' },
        { time: january + 2 * 86_400_000, to: 'anthropic/claude-3-7-sonnet' },
        { time: february + 2 * 86_400_000, to: 'anthropic/claude-3-7-sonnet' },
    ], {
        displayKey: () => 'Other models',
        colorFor: () => OTHER_MODEL_COLOR,
        streamColorFor: (model) => getModelColor(model),
    });

    assert.equal((svg.match(/class="usage-node"[^>]*fill="#728b93"/g) ?? []).length, 2);
    const continuityColors = [...svg.matchAll(/class="continuity-ribbon"[^>]*fill="([^"]+)"/g)].map((match) => match[1]).sort();
    assert.deepEqual(continuityColors, [
        getModelColor('anthropic/claude-opus-4'),
        getModelColor('anthropic/claude-3-7-sonnet'),
    ].sort());
});

test('wheel zoom preserves its date under the pointer and reverses to zoom out', () => {
    const range = { minDay: 0, maxDay: 99, startDay: 10, endDay: 89 };
    const anchor = { day: 50, position: 0.75 };
    const zoomed = zoomDateRange(range, 0.5, anchor);

    assert.ok(zoomed);
    assert.ok(Math.abs((anchor.day - zoomed.startDay) / (zoomed.endDay - zoomed.startDay) - anchor.position) < 0.02);

    const widened = zoomDateRange({ ...range, ...zoomed }, 2, anchor);
    assert.ok(widened);
    assert.ok(widened.endDay - widened.startDay > zoomed.endDay - zoomed.startDay);
    assert.deepEqual(zoomDateRange(range, 100), { startDay: range.minDay, endDay: range.maxDay });
    assert.deepEqual(
        zoomDateRange({ ...range, startDay: 0, endDay: 39 }, 0.5, { day: 0, position: 0 }),
        { startDay: 0, endDay: 19 },
    );
    assert.equal(zoomDateRange({ ...range, startDay: 10, endDay: 11 }, 0.5), null);
});

test('drag panning shifts the window without changing its duration or crossing data bounds', () => {
    const range = { minDay: 0, maxDay: 99, startDay: 20, endDay: 59 };

    assert.deepEqual(panDateRange(range, 10), { startDay: 30, endDay: 69 });
    assert.deepEqual(panDateRange(range, -50), { startDay: 0, endDay: 39 });
    assert.deepEqual(panDateRange(range, 50), { startDay: 60, endDay: 99 });
    assert.equal(panDateRange(range, 0), null);
    assert.equal(panDateRange(range, Number.NaN), null);
});

test('timeline slider values clamp at the other handle without changing the shared scale', () => {
    assert.equal(clampStartDay(100, 0, 50), 49);
    assert.equal(clampStartDay(-10, 0, 50), 0);
    assert.equal(clampEndDay(-10, 20, 50), 21);
    assert.equal(clampEndDay(100, 20, 50), 50);
});
