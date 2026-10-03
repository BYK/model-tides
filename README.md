# Model Tides

[Model Tides](https://modeltides.dev/) shows self-reported weekly active session–model–day counts. Every explicitly donated model-week appears in the community chart; before the first donation, the chart labels its mock data. There is no account or analytics.

## Share weekly counts

The local CLI reads OpenCode, Codex, Claude Code, and Pi history, shows every week, model, and count, and asks you to type `YES` before publishing. The npm package needs Node.js 24 or newer; the standalone Linux/macOS binary needs neither Node nor Python. Only the reviewed week/model/count pairs leave your device. No prompts, replies, exact event times, paths, session IDs, or imported files are uploaded. Model names, including older versions and provider-specific aliases, are shared exactly as shown.

To install the latest checksum-verified standalone binary:

```sh
curl -fsSL https://modeltides.dev/install.sh | bash
```

The installer defaults to `~/.local/bin` and prints a PATH hint if needed. It opens the upload flow on an interactive terminal; set `MODEL_TIDES_INSTALL_ONLY=1` to install without launching upload. You review exact weekly counts before confirming. The [homepage](https://modeltides.dev/) also offers npx, pnpx, and yarn dlx commands. The site bundles Iosevka, Iosevka Aile, and Iosevka Etoile fonts under the [SIL Open Font License](public/fonts/LICENSE).

From a repository checkout:

```sh
npm ci
npm run contribute -- upload
# Or use private metadata exported earlier:
npm run contribute -- upload --input model-tides.json
# Review and opt in to the community chart, or withdraw without losing your link:
npm run contribute -- contribute
npm run contribute -- withdraw
# Hide or show the personal chart; print its link offline:
npm run contribute -- unshare
npm run contribute -- share
npm run contribute -- link
# Create an unlisted gist of reviewed weekly counts (requires gh):
npm run contribute -- gist --input model-tides.json
```

The published CLI provides the same commands through `model-tides`. A new upload creates a personal weekly chart link but **does not** enter the community aggregate. Opt in separately with `contribute`; `withdraw` removes your counts from the aggregate without removing the chart. Reports created before this change remain in the aggregate until their owners withdraw. The Worker stores a hash of the private replacement key; the CLI saves the key under `~/.config/model-tides/contribution.json` (or `XDG_CONFIG_HOME`) with owner-only permissions. Run `model-tides key` on an interactive terminal and confirm with `YES` to copy the key into the **Donate your data** form on your personal link. You can also open the local JSON file in a private editor and copy its `token` field. Never put the key in a URL or share it with anyone. Run `share` or `unshare` to show or hide the chart, `upload --rotate` to rotate the key, and `upload --delete` to remove your report. Before `share` or `contribute`, the CLI shows **all** stored weeks, including weeks retained from earlier uploads; the Worker rejects a changed report after review.

The personal link shows an interactive weekly model-flow chart with zoom, pan, and a two-ended date slider. Faint ribbons link recurring model names. Brighter crossing ribbons pair a drop in one model's count with a rise in another's, up to the smaller change, in adjacent displayed periods. When zoomed out, those periods are months. These are inferred shifts: weekly totals cannot prove that a person or session switched models. If you have `gh`, `gist` (or the `GIST` choice during upload) sends reviewed weekly counts to an **unlisted** GitHub gist. Anyone with the link can read them, and GitHub retains revisions. The `modeltides.dev/gist#<owner>/<id>` viewer fetches the JSON directly from GitHub; Model Tides receives neither the gist address nor its contents.

## Export daily activity privately

Use `npm run contribute -- export --output model-tides.json` to export model names and session counts by UTC day without contacting the site. It never overwrites an existing file or includes session IDs or exact times. Keep the daily counts private. The CLI reads this v2 file with `--input` and derives weekly active session-days for a consented upload or gist. The website never imports local databases.

The repository also includes optional Python converters: [`scripts/export-model-tides.py`](scripts/export-model-tides.py) for OpenCode databases and [`scripts/export-history.py`](scripts/export-history.py) for Codex and Claude Code history. They use Python's standard library, except that the Python converter needs the local `zstd` command for older `.jsonl.zst` Codex rollouts. The CLI reads these formats directly without Python or `zstd`. For example:

```sh
python3 scripts/export-model-tides.py > model-tides.json
python3 scripts/export-history.py codex > model-tides.json
python3 scripts/export-history.py claude-code > model-tides.json
```

Run one command at a time. These optional Python tools still write the older **v1 event archive** with exact event times. V1 events cannot recover session activity on days without a switch and cannot be uploaded as active-day counts. The Node CLI scans original history directly for v2. The OpenCode reader uses a read-only SQLite snapshot including committed changes in a live `-wal`; Codex and Claude Code readers skip repeated records and subagent histories. The Pi reader scans `~/.pi/agent/sessions/` JSONL and counts assistant messages across session branches, not model selections or background usage. [Local v2 daily format](MODEL-TIDES.md) and [weekly upload format](WEEKLY-SNAPSHOT.md) describe the new metric.

## Develop

Requires Node.js 24 or newer.

```sh
npm ci
npm test
npm run dev
npm run build
npm run build:standalone -- linux-x64
```

The site build emits `dist/`, including a service worker for the weekly home and gist viewer. Fossilize builds Node 24 standalone binaries in `dist-bin/` for Linux/macOS x64/arm64; release CI tests them with synthetic history and publishes SHA-256 checksums. A Cloudflare Worker serves static assets, validates weekly uploads, stores public counts in D1, and renders personal pages and Open Graph images. It never receives a database or event metadata JSON. The timeline renderer lives under `src/flow-svg/`. The repository-root npm package is private; only the separate `cli/` package is published to npm through [Craft releases](RELEASING.md).

GitHub Actions tests each push and pull request; passing pushes to protected `main` apply D1 migrations before deploying through the `production` environment. Set `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_D1_DATABASE_ID` as environment variables, and `CLOUDFLARE_API_TOKEN` (Workers editing) and `CLOUDFLARE_D1_TOKEN` (D1 editing) as separate environment secrets. With an authenticated Cloudflare CLI, apply `migrations/` before running `npm run deploy` manually. `cloudflare.config.ts` configures the production and staging D1 databases, rate limiting, and the apex and `www` domains; the Worker redirects HTTP and `www` to the HTTPS apex.

Model Tides grew out of the [AG Studio × Information is Beautiful workshop starter](https://github.com/ag-grid/ag-studio-iib-workshop). This repository contains a standalone visualization with no AG Studio or AG Charts dependency.
