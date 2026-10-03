import './model-usage.css';
import './flow-svg/flow-svg.css';
import { mountFlowChart } from './flow-chart';
import { downloadBlob } from './download-image';
import { loadOwnedForDonation, donateOwnedReport } from './donation';
import { setupTheme } from './theme';
import { parsePublicReport } from './weekly-snapshot';

const root = document.querySelector<HTMLElement>('#app');
if (!root) throw new Error('The shared report needs a root element.');
const id = window.location.pathname.slice('/u/'.length);
root.innerHTML = `
    <main class="usage-app shared-report-app">
        <header class="masthead">
            <a class="wordmark" href="/" aria-label="Model Tides home">
                <svg class="wordmark-mark" viewBox="0 0 32 24" fill="none" aria-hidden="true"><path d="M1 7c4-4 8-4 12 0s8 4 12 0 6-3 7-2M1 16c4-4 8-4 12 0s8 4 12 0 6-3 7-2" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" /></svg>
                <span>MODEL TIDES<span class="wordmark-dot">.</span></span>
            </a>
            <button class="theme-toggle" id="theme-toggle" type="button" aria-label="Switch to dark theme">Dark theme</button>
        </header>
        <div id="report-chart"></div>
        <div class="report-share" role="group" aria-label="Share this model tide">
            <label class="share-nickname" for="share-nickname">Name for your post (optional)
                <input id="share-nickname" type="text" maxlength="32" autocomplete="off" placeholder="e.g. BYK" /></label>
            <button class="text-button" id="copy-report-image" type="button">Copy image</button>
            <button class="text-button" id="download-report-image" type="button">Download PNG</button>
            <button class="text-button" id="native-share-image" type="button" hidden>Share image…</button>
            <a id="share-x" target="_blank" rel="noopener noreferrer">Post on X ↗</a>
            <a id="share-bluesky" target="_blank" rel="noopener noreferrer">Post on Bluesky ↗</a>
            <span id="share-status" role="status" aria-live="polite"></span>
        </div>
        <section class="donation-card" aria-labelledby="donation-heading" hidden>
            <h2 id="donation-heading">Donate your data</h2>
            <p>Only the report owner can add these counts to the community chart. Run <code>npx model-tides@latest key</code> locally to reveal your saved owner key after confirmation, then enter it below to review every stored week. Or run <code>npx model-tides@latest contribute</code> locally to review and donate from the CLI. The key stays in this tab and never appears in the URL.</p>
            <p>If you are not the owner of this data, why not <a href="/#home-cta-heading">try yours</a>?</p>
            <p id="donate-legacy" hidden>This older report counts starts and switches. Rescan local history with the current CLI to replace it with active session-days before donating.</p>
            <form id="donate-owner-form"><label for="donate-owner-key">Private owner key</label>
                <input id="donate-owner-key" type="password" autocomplete="off" spellcheck="false" required />
                <button id="donate-review" type="submit">Review counts</button></form>
            <div id="donate-confirm" hidden><p>These exact self-reported counts will appear on the community chart, even if yours is the only contribution. Anyone can see the model and week totals.</p>
                <pre id="donate-counts"></pre><button id="donate-submit" type="button">Donate your data</button></div>
            <p id="donate-status" role="status" aria-live="polite"></p>
        </section>
        <p id="donation-result" class="donation-result" role="status" aria-live="polite" hidden></p>
        <footer class="report-footer"><p>Self-reported weekly model counts; no exact times or tracked switches. Crossing streams pair declines with rises in adjacent weeks (or months when zoomed out). They suggest apparent shifts, not a person's migration. Anyone with this link can view these counts.</p>
            <a href="/">Model Tides home</a> · <a href="https://github.com/BYK/model-tides" target="_blank" rel="noopener noreferrer">Source on GitHub ↗</a></footer>
    </main>`;
setupTheme(root);
const element = <T extends HTMLElement>(selector: string): T => root.querySelector<T>(selector)!;
const chart = mountFlowChart(element<HTMLElement>('#report-chart'), {
    title: 'Your model tide', headingLevel: 1, initialStatus: 'Loading shared weekly counts…',
});

const reportUrl = `${window.location.origin}/u/${id}`;
const nickname = element<HTMLInputElement>('#share-nickname');
const shareTitle = (): string => {
    const name = nickname.value.trim().replace(/\s+/g, ' ');
    return name && name.length <= 32 && !/[\p{C}]/u.test(name) ? `${name}'s model tide` : 'My model tide';
};
const shareText = (): string => `${shareTitle()} · ${reportUrl}`;
function updateShareLinks(): void {
    element<HTMLAnchorElement>('#share-x').href = `https://twitter.com/intent/tweet?${new URLSearchParams({ text: shareTitle(), url: reportUrl })}`;
    element<HTMLAnchorElement>('#share-bluesky').href = `https://bsky.app/intent/compose?${new URLSearchParams({ text: shareText() })}`;
}
nickname.addEventListener('input', updateShareLinks);
updateShareLinks();
const shareStatus = element<HTMLElement>('#share-status');
const ownerForm = element<HTMLFormElement>('#donate-owner-form');
const ownerInput = element<HTMLInputElement>('#donate-owner-key');
const reviewButton = element<HTMLButtonElement>('#donate-review');
const donateButton = element<HTMLButtonElement>('#donate-submit');
const donationStatus = element<HTMLElement>('#donate-status');
const confirmation = element<HTMLElement>('#donate-confirm');
const donationCard = element<HTMLElement>('.donation-card');
const donationResult = element<HTMLElement>('#donation-result');
const donation = { generation: 0, confirmed: false,
    reviewed: null as null | { token: string; report: Awaited<ReturnType<typeof loadOwnedForDonation>> } };
async function loadDonationStatus(): Promise<void> {
    try {
        const response = await fetch(`/api/contributions/${id}/aggregate-status`, { cache: 'no-store', credentials: 'omit' });
        if (!response.ok) throw new Error('Donation status unavailable.');
        const result: unknown = await response.json();
        if (result === null || typeof result !== 'object' || Array.isArray(result) ||
            Object.keys(result).length !== 2 || !('id' in result) || result.id !== id ||
            !('inAggregate' in result) || typeof result.inAggregate !== 'boolean') {
            throw new TypeError('Invalid donation status.');
        }
        if (result.inAggregate) { donation.generation++; donation.reviewed = null; confirmation.hidden = true; ownerInput.value = ''; }
        donationCard.hidden = donation.confirmed || result.inAggregate;
    } catch { donationCard.hidden = donation.confirmed; }
}
ownerInput.addEventListener('input', () => { donation.generation++; donation.reviewed = null;
    confirmation.hidden = true; reviewButton.disabled = false; });
ownerForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const generation = ++donation.generation;
    const token = ownerInput.value.trim();
    ownerInput.value = '';
    reviewButton.disabled = true;
    donation.reviewed = null;
    confirmation.hidden = true;
    donationStatus.textContent = 'Checking the owner key…';
    void loadOwnedForDonation(id, token).then((report) => {
        if (generation !== donation.generation) return;
        donation.reviewed = { token, report };
        element<HTMLElement>('#donate-counts').textContent = report.snapshot!.weeks.flatMap(({ week, models }) =>
            Object.entries(models).map(([model, count]) => `${week} · ${model}: ${count}`)).join('\n');
        confirmation.hidden = false;
        donationStatus.textContent = 'Review every count before donating.';
    }).catch(() => { if (generation === donation.generation) donationStatus.textContent = 'Could not verify ownership or review this report. Nothing was donated.'; })
        .finally(() => { if (generation === donation.generation) reviewButton.disabled = false; });
});
donateButton.addEventListener('click', () => {
    const reviewed = donation.reviewed;
    if (!reviewed || donateButton.disabled) return;
    donateButton.disabled = true;
    void donateOwnedReport(id, reviewed.token, reviewed.report).then(() => {
        donation.confirmed = true;
        donation.generation++;
        donation.reviewed = null;
        confirmation.hidden = true;
        element<HTMLElement>('#donate-counts').textContent = '';
        ownerInput.value = '';
        donationCard.hidden = true;
        donationResult.textContent = 'Donated. Your model-week counts now appear on the community chart.';
        donationResult.hidden = false;
    }).catch(() => {
        donation.reviewed = null;
        confirmation.hidden = true;
        donationStatus.textContent = 'Could not confirm donation. Review the current counts again before retrying.';
    }).finally(() => { donateButton.disabled = false; });
});
const imageUrl = `/og/${id}.png`;
async function imageBlob(): Promise<Blob> {
    const response = await fetch(imageUrl, { cache: 'no-store' });
    if (!response.ok || !response.headers.get('content-type')?.startsWith('image/png')) throw new Error('Image unavailable.');
    return response.blob();
}
const copyImage = element<HTMLButtonElement>('#copy-report-image');
copyImage.addEventListener('click', () => {
    copyImage.disabled = true;
    void (async () => {
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': imageBlob() })]);
        shareStatus.textContent = 'Image copied. Paste it into your post.';
    })().catch(() => { shareStatus.textContent = 'Could not copy the image in this browser. Download the PNG instead.'; })
        .finally(() => { copyImage.disabled = false; });
});
const downloadImage = element<HTMLButtonElement>('#download-report-image');
downloadImage.addEventListener('click', () => {
    downloadImage.disabled = true;
    void imageBlob().then((blob) => downloadBlob(blob, 'model-tides.png'))
        .catch(() => { shareStatus.textContent = 'Could not download the image.'; })
        .finally(() => { downloadImage.disabled = false; });
});
const nativeShare = element<HTMLButtonElement>('#native-share-image');
if (typeof navigator !== 'undefined' && typeof navigator.share === 'function') {
    nativeShare.hidden = false;
    nativeShare.addEventListener('click', () => {
        nativeShare.disabled = true;
        void (async () => {
            const file = new File([await imageBlob()], 'model-tides.png', { type: 'image/png' });
            if (navigator.canShare?.({ files: [file] })) await navigator.share({ title: shareTitle(), text: shareText(), files: [file] });
            else await navigator.share({ title: shareTitle(), text: shareText(), url: reportUrl });
        })().catch(() => { shareStatus.textContent = 'Use Copy image or Download PNG to share the chart.'; })
            .finally(() => { nativeShare.disabled = false; });
    });
}

void (async () => {
    const response = await fetch(`/api/contributions/${id}`, { cache: 'no-store' });
    if (!response.ok) throw new Error('Report unavailable.');
    const snapshot = parsePublicReport(await response.json(), id);
    ownerForm.hidden = snapshot.version !== 2;
    element<HTMLElement>('#donate-legacy').hidden = snapshot.version === 2;
    chart.setData({ rows: snapshot.weeks.flatMap(({ week, models }) =>
        Object.entries(models).map(([model, count]) => ({ week, model, count }))),
    source: 'personal', metricVersion: snapshot.version });
    void loadDonationStatus();
})().catch(() => {
    chart.setMessage('This report is hidden or unavailable.');
    element<HTMLElement>('.report-share').hidden = true;
    donationCard.hidden = true;
});
