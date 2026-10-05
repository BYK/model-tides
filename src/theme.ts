import { mountIcons } from './icons';

export function setupTheme(root: HTMLElement): void {
    const themeToggle = root.querySelector<HTMLButtonElement>('#theme-toggle')!;
    const systemTheme = window.matchMedia('(prefers-color-scheme: dark)');
    function updateTheme(): void {
        const dark = document.documentElement.dataset.theme === 'dark' ||
            (document.documentElement.dataset.theme !== 'light' && systemTheme.matches);
        const nextTheme = dark ? 'Light theme' : 'Dark theme';
        themeToggle.innerHTML = `<i data-lucide="${dark ? 'sun' : 'moon'}"></i><span>${nextTheme}</span>`;
        mountIcons(themeToggle);
        themeToggle.setAttribute('aria-label', `Switch to ${dark ? 'light' : 'dark'} theme`);
        const themeMeta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
        if (themeMeta) themeMeta.content = dark ? '#102832' : '#eef6f5';
    }
    themeToggle.addEventListener('click', () => {
        document.documentElement.dataset.theme = document.documentElement.dataset.theme === 'dark' ||
            (!document.documentElement.dataset.theme && systemTheme.matches) ? 'light' : 'dark';
        updateTheme();
    });
    systemTheme.addEventListener('change', updateTheme);
    updateTheme();
}
