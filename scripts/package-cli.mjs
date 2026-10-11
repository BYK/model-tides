import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = fileURLToPath(new URL('../cli/dist/', import.meta.url));
rmSync(output, { recursive: true, force: true });
for (const name of ['scripts', 'src', 'src/flow-svg']) mkdirSync(join(output, name), { recursive: true });
const scanner = readFileSync(`${root}scripts/history-scanner.mjs`, 'utf8');
for (const name of ['usage-data', 'daily-usage']) {
    if (!scanner.includes(`'../src/${name}.ts'`)) throw new Error(`Missing scanner ${name} import.`);
}
writeFileSync(`${output}scripts/history-scanner.mjs`, ['usage-data', 'daily-usage'].reduce((text, name) =>
    text.replace(`'../src/${name}.ts'`, `'../src/${name}.js'`), scanner));
const source = readFileSync(`${root}scripts/contribute.mjs`, 'utf8');
const imports = ['usage-data', 'weekly-snapshot', 'daily-usage', 'client'];
for (const name of imports) {
    if (!source.includes(`'../src/${name}.ts'`)) throw new Error(`Missing ${name} CLI import.`);
}
writeFileSync(`${output}scripts/contribute.mjs`, imports.reduce((text, name) =>
    text.replaceAll(`'../src/${name}.ts'`, `'../src/${name}.js'`), source));

// Library modules: src file -> the relative `.ts` specifiers it must contain.
const modules = {
    'usage-data': [],
    'daily-usage': ['./weekly-snapshot.ts'],
    'weekly-snapshot': [],
    'model-colors': [],
    'client': ['./weekly-snapshot.ts'],
    'index': ['./usage-data.ts', './daily-usage.ts', './weekly-snapshot.ts', './model-colors.ts',
        './flow-svg/renderer.ts', './client.ts'],
    'flow-svg/renderer': [],
};
for (const [name, specifiers] of Object.entries(modules)) {
    let javascript = stripTypeScriptTypes(readFileSync(`${root}src/${name}.ts`, 'utf8'));
    for (const specifier of specifiers) {
        if (!javascript.includes(`'${specifier}'`)) throw new Error(`Missing ${specifier} import in src/${name}.ts.`);
        javascript = javascript.replaceAll(`'${specifier}'`, `'${specifier.replace(/\.ts$/, '.js')}'`);
    }
    writeFileSync(`${output}src/${name}.js`, javascript);
}
copyFileSync(`${root}src/flow-svg/flow-svg.css`, `${output}src/flow-svg/flow-svg.css`);
execFileSync(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '-p', join(root, 'cli/tsconfig.lib.json')], { stdio: 'inherit' });
