import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'vite';

test('home distinguishes uploaded reports from opted-in reports and never calls them unique people', async () => {
    const server = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent' });
    const originalFetch = globalThis.fetch;
    try {
        const { loadGlobalView } = await server.ssrLoadModule('/src/global-view.ts');
        const chart = { data: null, message: '', setData(data) { this.data = data; }, setMessage(message) { this.message = message; } };
        globalThis.fetch = async () => Response.json({ metricVersion: 2, truncated: false,
            uploadedReports: 3, optedInReports: 1, weeks: [
                { week: '2026-09-28', model: 'openai/gpt-5', count: 2, contributors: 1 },
            ] });
        await loadGlobalView(chart, true);
        assert.equal(chart.data.source, 'shared');
        assert.deepEqual(chart.data.rows.map(({ model, count }) => ({ model, count })),
            [{ model: 'openai/gpt-5', count: 2 }]);
        assert.equal(chart.data.detail, '3 uploaded reports · 1 opted-in report');
        assert.doesNotMatch(chart.data.detail, /people|users/);
        globalThis.fetch = async () => Response.json({ metricVersion: 2, truncated: false,
            uploadedReports: 3, optedInReports: 0, weeks: [] });
        await loadGlobalView(chart, true);
        assert.equal(chart.data.source, 'mock');
        assert.match(chart.data.detail, /3 uploaded reports · 0 opted-in reports/);
        globalThis.fetch = async () => Response.json({ metricVersion: 2, truncated: false,
            uploadedReports: 3, optedInReports: 0, weeks: [
                { week: '2026-09-28', model: 'openai/gpt-5', count: 2, contributors: 1 },
            ] });
        await loadGlobalView(chart, true);
        assert.equal(chart.data.source, 'mock', 'invalid contributor totals never appear as public counts');
        assert.equal(chart.data.detail, 'Shared counts are unavailable');
        globalThis.fetch = async () => Response.json({ metricVersion: 1, truncated: false,
            uploadedReports: 3, optedInReports: 1, weeks: [
                { week: '2026-09-28', model: 'openai/gpt-5', count: 2, contributors: 1 },
            ] });
        await loadGlobalView(chart, true);
        assert.equal(chart.data.source, 'shared');
        assert.equal(chart.data.metricVersion, 1, 'legacy counts retain their separate metric');
        globalThis.fetch = async () => Response.json({ metricVersion: 2, truncated: false,
            uploadedReports: 3, optedInReports: 1, weeks: [
                { week: '2026-09-28', model: 'openai/gpt-5', count: 2, contributors: 1,
                    transcript: 'not a public aggregate field' },
            ] });
        await loadGlobalView(chart, true);
        assert.equal(chart.data.source, 'mock', 'extra private fields never enter the chart');
    } finally {
        globalThis.fetch = originalFetch;
        await server.close();
    }
});
