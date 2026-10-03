import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

test('home leads with weekly counts and does not advertise the removed browser import', () => {
    const home = readFileSync(new URL('../src/home.ts', import.meta.url), 'utf8');
    assert.ok(home.indexOf('id="global-chart"') < home.indexOf('home-cta'));
    assert.match(home, /mountFlowChart/);
    assert.match(home, /id="theme-toggle"/);
    assert.match(home, /id="command-manager"/);
    assert.match(home, /<h2 id="home-cta-heading">See yours<\/h2>/);
    assert.match(home, /pnpx model-tides@latest upload/);
    assert.match(home, /yarn dlx model-tides@latest upload/);
    assert.match(home, /<option value="curl">curl<\/option>/);
    assert.match(home, /curl: 'curl -fsSL https:\/\/modeltides\.dev\/install\.sh \| bash'/);
    assert.doesNotMatch(home, /MODEL_TIDES_VERSION=/);
    assert.match(home, /navigator\.clipboard\.writeText\(commandText\.textContent/);
    assert.doesNotMatch(home, /\/local\/|Choose a file|personal chart in your browser/);
});

test('site typography uses bundled Iosevka variants', () => {
    const styles = readFileSync(new URL('../src/model-usage.css', import.meta.url), 'utf8');
    const license = readFileSync(new URL('../public/fonts/LICENSE', import.meta.url), 'utf8');
    assert.match(license, /SIL Open Font License, Version 1\.1/);
    for (const variant of ['iosevka-aile', 'iosevka-etoile', 'iosevka']) {
        const font = readFileSync(new URL(`../src/fonts/${variant}-site-400.woff2`, import.meta.url));
        assert.equal(font.toString('ascii', 0, 4), 'wOF2');
    }
    assert.match(styles, /font-family: 'Iosevka Aile'/);
    assert.match(styles, /font-family: 'Iosevka Etoile'/);
    assert.match(styles, /font-family: 'Iosevka',/);
});
