import { getAggregate, handleContributions, type Database, type UploadLimit } from './contributions.ts';
import { escapeHtml, getReport, pageForReport, summarize } from './public-pages.ts';
import { parseReportRange } from '../src/report-range.ts';

interface Env {
    ASSETS: { fetch(request: Request): Promise<Response> };
    DB: Database;
    UPLOAD_LIMIT: UploadLimit;
}

const reservedPaths = ['/api', '/u', '/og'];
const idPattern = '[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const publicPath = new RegExp(`^/u/(${idPattern})$`);
const imagePath = new RegExp(`^/og/(${idPattern})\\.png$`);

async function home(request: Request, env: Env): Promise<Response> {
    const asset = await env.ASSETS.fetch(request);
    if (!asset.ok || !env.DB) return asset;
    try {
        const aggregate = await getAggregate(env.DB);
        const total = aggregate.weeks.reduce((sum, row) => sum + row.count, 0);
        const title = total ? `${total.toLocaleString('en-GB')} shared ${aggregate.metricVersion === 2 ? 'active session-days' : 'model uses'} · Model Tides` : 'Model Tides — Your models, over time.';
        const description = 'Explore shared weekly model counts and learn how to share your own.';
        const origin = new URL(request.url).origin;
        const meta = `<meta property="og:type" content="website"><meta property="og:title" content="${escapeHtml(title)}">
<meta property="og:description" content="${escapeHtml(description)}"><meta property="og:url" content="${origin}/">
<meta property="og:image" content="${origin}/og/global.png"><meta name="twitter:card" content="summary_large_image">`;
        return new Response((await asset.clone().text()).replace('</head>', `${meta}</head>`), {
            headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
        });
    } catch {
        return asset;
    }
}

export default {
    async fetch(request: Request, env: Env): Promise<Response> {
        const url = new URL(request.url);
        if (url.hostname === 'www.modeltides.dev' || url.protocol !== 'https:') {
            url.hostname = 'modeltides.dev';
            url.protocol = 'https:';
            return Response.redirect(url, 308);
        }

        if (reservedPaths.some((path) => url.pathname === path || url.pathname.startsWith(`${path}/`))) {
            if (url.pathname.startsWith('/api/') &&
                (url.pathname === '/api/aggregate' || url.pathname === '/api/contributions' ||
                    url.pathname.startsWith('/api/contributions/'))) {
                if (!env.DB || !env.UPLOAD_LIMIT) {
                    return new Response('Service unavailable', { status: 503, headers: { 'Cache-Control': 'no-store' } });
                }
                try {
                    return await handleContributions(request, env.DB, env.UPLOAD_LIMIT, url.pathname);
                } catch {
                    return new Response('Service unavailable', { status: 503, headers: { 'Cache-Control': 'no-store' } });
                }
            }
            const id = publicPath.exec(url.pathname)?.[1] ?? imagePath.exec(url.pathname)?.[1];
            const globalImage = url.pathname === '/og/global.png';
            if ((id || globalImage) && (request.method === 'GET' || request.method === 'HEAD')) {
                if (!env.DB) return new Response('Service unavailable', { status: 503, headers: { 'Cache-Control': 'no-store' } });
                try {
                    const range = id ? parseReportRange(url.searchParams) : null;
                    const report = globalImage
                        ? await (async () => { const aggregate = await getAggregate(env.DB);
                            return summarize(null, aggregate.weeks, aggregate.metricVersion); })()
                        : await (async () => {
                            const report = await getReport(env.DB, id!);
                            return report && range ? summarize(report.id, report.counts, report.metricVersion, range) : report;
                        })();
                    if (!report) return new Response('Not found', { status: 404, headers: { 'Cache-Control': 'no-store' } });
                    if (publicPath.test(url.pathname)) {
                        if (request.method === 'HEAD') return new Response(null, {
                            headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
                        });
                        const asset = await env.ASSETS.fetch(new Request(new URL('/', url)));
                        if (!asset.ok) return new Response('Service unavailable', { status: 503 });
                        return pageForReport(report, url.origin, await asset.text(), range ?? undefined);
                    }
                    if (request.method === 'HEAD') return new Response(null, { headers: { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' } });
                    const { renderImage } = await import('./og.ts');
                    return await renderImage(report);
                } catch {
                    return new Response('Service unavailable', { status: 503, headers: { 'Cache-Control': 'no-store' } });
                }
            }
            return new Response('Not found', { status: 404, headers: { 'Cache-Control': 'no-store' } });
        }

        if (request.method !== 'GET' && request.method !== 'HEAD') {
            return new Response('Method not allowed', { status: 405, headers: { Allow: 'GET, HEAD' } });
        }

        if (url.pathname === '/local' || url.pathname === '/local/') {
            return new Response(null, { status: 308, headers: { Location: `${url.origin}/`, 'Cache-Control': 'no-store' } });
        }
        if (url.pathname === '/gist' || url.pathname === '/gist/') {
            return env.ASSETS.fetch(new Request(new URL('/', url), request));
        }
        return url.pathname === '/' && request.method === 'GET' ? home(request, env) : env.ASSETS.fetch(request);
    },
};
