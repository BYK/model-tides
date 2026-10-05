import './model-usage.css';
import './flow-svg/flow-svg.css';
import { mountFlowChart } from './flow-chart';
import { loadGlobalView } from './global-view';
import { mountIcons } from './icons';
import { setupTheme } from './theme';

const root = document.querySelector<HTMLElement>('#app');
if (!root) throw new Error('The Model Tides home page needs a root element.');

root.innerHTML = `
    <main class="usage-app home-app">
        <header class="masthead">
            <a class="wordmark" href="/" aria-label="Model Tides home">
                <svg class="wordmark-mark" viewBox="0 0 32 24" fill="none" aria-hidden="true"><path d="M1 7c4-4 8-4 12 0s8 4 12 0 6-3 7-2M1 16c4-4 8-4 12 0s8 4 12 0 6-3 7-2" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" /></svg>
                <span>MODEL TIDES<span class="wordmark-dot">.</span></span>
            </a>
            <button class="theme-toggle" id="theme-toggle" type="button" aria-label="Switch to dark theme">Dark theme</button>
        </header>

        <div class="home-intro"><h1><span class="title-wave" aria-hidden="true">~</span><span>Your models, over time</span><span class="title-wave" aria-hidden="true">~</span></h1></div>

        <div id="global-chart" class="home-graph"></div>
        <p class="global-note">Self-reported activity · uploaded reports are not verified people. Only explicitly opted-in counts appear; earlier counts stay separate from active session-days.</p>

        <section class="home-cta" aria-labelledby="home-cta-heading">
            <h2 id="home-cta-heading">See yours</h2>
            <div class="command-strip">
                <label class="visually-hidden" for="command-manager">Choose an installation method</label>
                <select class="command-kind" id="command-manager" aria-label="Choose an installation method">
                    <option value="npx">npx</option>
                    <option value="pnpx">pnpx</option>
                    <option value="yarn">yarn dlx</option>
                    <option value="curl">curl</option>
                </select>
                <code id="upload-command">npx model-tides@latest upload</code>
                <button class="copy-command" id="copy-command" type="button" aria-label="Copy command" title="Copy command"><i data-lucide="copy"></i></button>
            </div>
            <p class="command-help">Review counts locally, then choose a personal link or an unlisted gist.</p>
            <p class="visually-hidden" id="command-status" role="status" aria-live="polite"></p>
        </section>

        <footer class="home-footer"><a href="https://github.com/BYK/model-tides" target="_blank" rel="noopener noreferrer">see the code ↗</a></footer>
    </main>
`;

mountIcons(root);

const chart = mountFlowChart(root.querySelector<HTMLElement>('#global-chart')!, {
    title: 'Community model use', headingLevel: 2, initialStatus: 'Loading shared model counts…',
});
void loadGlobalView(chart, true);

const commands = {
    npx: 'npx model-tides@latest upload',
    pnpx: 'pnpx model-tides@latest upload',
    yarn: 'yarn dlx model-tides@latest upload',
    curl: 'curl -fsSL https://modeltides.dev/install.sh | bash',
} as const;
const manager = root.querySelector<HTMLSelectElement>('#command-manager')!;
const commandText = root.querySelector<HTMLElement>('#upload-command')!;
const commandHelp = root.querySelector<HTMLElement>('.command-help')!;
const commandStatus = root.querySelector<HTMLElement>('#command-status')!;
manager.addEventListener('change', () => {
    if (!(manager.value in commands)) throw new RangeError('Unknown installation method.');
    commandText.textContent = commands[manager.value as keyof typeof commands];
    commandHelp.textContent = manager.value === 'curl'
        ? 'Installs the latest release on Linux and macOS, then opens the upload flow.'
        : 'Review counts locally, then choose a personal link or an unlisted gist.';
    commandStatus.textContent = '';
});
root.querySelector<HTMLButtonElement>('#copy-command')!.addEventListener('click', async () => {
    try {
        await navigator.clipboard.writeText(commandText.textContent ?? '');
        commandStatus.textContent = 'Command copied.';
    } catch {
        commandStatus.textContent = 'Copy failed. Select the command to copy it.';
    }
});

setupTheme(root);
