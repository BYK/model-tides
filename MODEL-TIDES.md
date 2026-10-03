# Model Tides local daily activity (v2)

The Node CLI writes and reads this offline document with `export --output` and `upload --input`:

```json
{
  "format": "model-tides-daily",
  "version": 2,
  "source": "opencode",
  "days": [
    { "day": "2026-09-28", "models": { "anthropic/claude-sonnet-4": 2, "openai/gpt-5": 1 } }
  ]
}
```

`day` is the UTC date of an observed model choice or assistant activity. `source` identifies the local scanner; `multiple` combines scanners. Within a source, one session and model count once per day despite repeated turns. A session using one model again tomorrow counts again; two models used today count separately. Different sources count their own sessions: without shared identity across harnesses, cross-harness sessions cannot be deduplicated. Raw session/message IDs, prompts, replies, paths, and exact times never enter the file. It contains model names and daily counts, so keep it private.

The CLI rejects extra fields and permits at most 200,000 model-day cells in a JSON file under 32 MiB. `model-tides export --output model-tides.json` never uploads or overwrites. `model-tides upload --input model-tides.json` derives and previews weekly counts before asking for consent. The [weekly upload format](WEEKLY-SNAPSHOT.md) omits even the daily dates.

OpenCode databases can contain committed changes in a live `-wal` file. The Node CLI reads them through a read-only SQLite connection and holds one session's observed day/model pairs plus aggregated counts in memory. Codex `turn_context`, Claude Code main-thread assistant messages, and Pi assistant messages across session branches yield the same daily format. Pi model selections, tool results, and background usage entries never count as assistant activity; duplicate session files count once.

Optional [`scripts/export-history.py`](scripts/export-history.py) and [`scripts/export-model-tides.py`](scripts/export-model-tides.py) still produce the older exact-time `model-tides` v1 event archive. That archive and [Model Currents v1 JSON](MODEL-CURRENTS.md) cannot establish which days a session kept using one model; v2 `upload --input` and `gist --input` reject them. Keep them private for archival use and rescan the original history for new counts.
