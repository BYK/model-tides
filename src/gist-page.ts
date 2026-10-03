import './model-usage.css';
import './flow-svg/flow-svg.css';
import { mountFlowChart } from './flow-chart';
import { loadGistSnapshot } from './gist-view';
import { setupTheme } from './theme';
import { donateGistSnapshot } from './donation';
import { downloadBlob } from './download-image';
import type { WeeklySnapshot } from './weekly-snapshot';

const root = document.querySelector<HTMLElement>('#app');
if (!root) throw new Error('The Model Tides gist page needs a root element.');
const app = root;

root.innerHTML = `
    <main class="usage-app home-app">
        <header class="masthead">
            <a class="wordmark" href="/" aria-label="Model Tides home">
                <svg class="wordmark-mark" viewBox="0 0 32 24" fill="none" aria-hidden="true"><path d="M1 7c4-4 8-4 12 0s8 4 12 0 6-3 7-2M1 16c4-4 8-4 12 0s8 4 12 0 6-3 7-2" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" /></svg>
                <span>MODEL TIDES<span class="wordmark-dot">.</span></span>
            </a>
            <button class="theme-toggle" id="theme-toggle" type="button" aria-label="Switch to dark theme">Dark theme</button>
        </header>

        <div class="home-intro"><h1>Unlisted weekly counts</h1></div>
        <div id="gist-chart" class="home-graph"></div>
        <p class="global-note">Your browser reads this unlisted gist directly from GitHub. Model Tides receives no gist address or counts unless you choose to donate the reviewed counts. Anyone with the link can read the gist, and GitHub retains revisions.</p>
        <section class="donation-card" id="gist-donate" aria-labelledby="gist-donate-heading" hidden>
            <h2 id="gist-donate-heading">Donate your data</h2>
            <p>Having a gist link does not prove who owns it. Donate only counts from your own history. This creates a new, public personal chart and adds the exact model-week totals below to the community chart; one contribution is enough to make a model-week visible.</p>
            <pre id="gist-donate-counts"></pre>
            <label><input id="gist-donate-consent" type="checkbox" /> I own these counts and want to add them to the public community chart.</label>
            <button id="gist-donate-submit" type="button" disabled>Donate your data</button>
            <p id="gist-donate-status" role="status" aria-live="polite"></p>
            <div id="gist-donate-result" hidden><a id="gist-personal-link" rel="noopener noreferrer">My personal chart ↗</a>
                <button id="gist-key-download" type="button">Download private owner key again</button>
                <p>Save this key. It lets you hide, withdraw, or delete this report; it never appears in the public link.</p></div>
        </section>
        <p id="gist-legacy-note" class="global-note" hidden>These are earlier start/switch counts, not active session-days. Rescan original history with the current CLI to donate the new metric.</p>
        <footer class="home-footer"><a id="gist-source" href="https://gist.github.com/" target="_blank" rel="noopener noreferrer">View gist on GitHub ↗</a> · <a href="/">Model Tides home</a></footer>
    </main>
`;

setupTheme(root);
const chart = mountFlowChart(root.querySelector<HTMLElement>('#gist-chart')!, {
    title: 'Model use over time', headingLevel: 2, initialStatus: 'Loading weekly counts from GitHub…',
});
const source = root.querySelector<HTMLAnchorElement>('#gist-source')!;
const donationCard = root.querySelector<HTMLElement>('#gist-donate')!;
const donateConsent = root.querySelector<HTMLInputElement>('#gist-donate-consent')!;
const donateButton = root.querySelector<HTMLButtonElement>('#gist-donate-submit')!;
const donateStatus = root.querySelector<HTMLElement>('#gist-donate-status')!;
const donatedResult = root.querySelector<HTMLElement>('#gist-donate-result')!;
const current = { version: 0, donated: false, snapshot: null as WeeklySnapshot | null,
    key: null as { id: string; token: string } | null };
const downloadKey = (): void => {
    if (!current.key) return;
    downloadBlob(new Blob([JSON.stringify(current.key)], { type: 'application/json' }), 'model-tides-private-key.json');
};
root.querySelector<HTMLButtonElement>('#gist-key-download')!.addEventListener('click', () => {
    try { downloadKey(); }
    catch { donateStatus.textContent = 'Could not download the key. Keep this tab open and try again.'; }
});
donateConsent.addEventListener('change', () => {
    donateButton.disabled = current.donated || !donateConsent.checked || current.snapshot?.version !== 2;
});
donateButton.addEventListener('click', () => {
    const snapshot = current.snapshot;
    if (!snapshot || snapshot.version !== 2 || !donateConsent.checked || donateButton.disabled) return;
    donateButton.disabled = true;
    donateStatus.textContent = 'Donating the reviewed counts…';
    void donateGistSnapshot(snapshot).then(({ id, token, url }) => {
        current.donated = true;
        current.key = { id, token };
        app.querySelector<HTMLAnchorElement>('#gist-personal-link')!.href = url;
        donatedResult.hidden = false;
        donateStatus.textContent = 'Donated. Download and protect your private owner key.';
        try { downloadKey(); }
        catch { donateStatus.textContent = 'Donated, but the key download was blocked. Keep this tab open and download it below.'; }
    }).catch(() => { donateStatus.textContent = 'Could not confirm donation. Check the community chart before retrying.'; })
        .finally(() => { donateButton.disabled = current.donated || !donateConsent.checked; });
});

function showGist(): void {
    const version = ++current.version;
    current.snapshot = null;
    current.donated = false;
    donationCard.hidden = true;
    donateConsent.checked = false;
    donateButton.disabled = true;
    app.querySelector<HTMLElement>('#gist-legacy-note')!.hidden = true;
    chart.setMessage('Loading weekly counts from GitHub…');
    const match = /^#([A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?)\/([0-9a-f]{32})$/.exec(window.location.hash);
    if (!match) {
        chart.setMessage('Invalid gist address.');
        source.hidden = true;
        return;
    }
    const [, owner, id] = match;
    source.hidden = true;
    void loadGistSnapshot(owner, id).then(({ snapshot, owner: currentOwner }) => {
        if (version !== current.version) return;
        if (currentOwner !== owner) window.history.replaceState(null, '', `/gist#${currentOwner}/${id}`);
        source.href = `https://gist.github.com/${currentOwner}/${id}`;
        source.hidden = false;
        const rows = snapshot.weeks.flatMap(({ week, models }) =>
            Object.entries(models).map(([model, count]) => ({ week, model, count })))
            .sort((a, b) => a.week.localeCompare(b.week) || a.model.localeCompare(b.model));
        chart.setData({ rows, source: 'gist', metricVersion: snapshot.version,
            detail: `across ${snapshot.weeks.length} ${snapshot.weeks.length === 1 ? 'week' : 'weeks'} · unlisted gist by ${currentOwner}` });
        // The chart summarizes the selected dates. The donation preview always lists all weeks below.
        if (snapshot.version === 2) {
            current.snapshot = snapshot;
            donationCard.hidden = false;
            app.querySelector<HTMLElement>('#gist-donate-counts')!.textContent = rows
                .map(({ week, model, count }) => `${week} · ${model}: ${count}`).join('\n');
        } else app.querySelector<HTMLElement>('#gist-legacy-note')!.hidden = false;
    }).catch(() => {
        if (version === current.version) {
            chart.setMessage('Could not load this weekly-count gist from GitHub. Check the link and connection.');
        }
    });
}

window.addEventListener('hashchange', showGist);
showGist();
