# Model Tides weekly snapshot (v2)

Personal reports and opt-in aggregate contributions use this JSON, compressed with Brotli in transit:

```json
{
  "format": "model-tides-weekly",
  "version": 2,
  "weeks": [
    { "week": "2026-09-28", "models": { "anthropic/claude-sonnet-4": 2, "openai/gpt-5": 1 } }
  ]
}
```

`week` is the Monday UTC date. Each v2 count is the sum of distinct **session–model–UTC-day** observations in that week. A session using one model on three days adds three; ten turns on one day add one. Two models observed in one session on the same day each add one. A day with no dated model observation adds nothing. These are not unique people, total turns, tokens, or inferred background activity. The weekly format carries **no** daily dates, exact times, prompts, replies, paths, source names, session IDs, or message IDs. Uploads require `Content-Type: application/vnd.model-tides.weekly+json`, `Content-Encoding: br`, and `X-Model-Tides-Schema: weekly-v2`; new personal reports use `POST /api/contributions/personal-v2` and `X-Model-Tides-Report: personal-v2`. An older Worker rejects this path without creating a report.

The Worker rejects extra fields, invalid weeks, oversized uploads (64 KiB compressed, 512 KiB expanded), more than 520 weeks, 2,048 model-week cells, or 10,000 session-days in a cell. The stored report also has these limits after a replacement. Older oversized reports keep their counts and can still be hidden or deleted. The CLI shows every exact model name and count before consent. Names and counts are self-reported.

New personal reports have a public `/u/:id` link and start outside the aggregate. A separate 256-bit private owner token authorizes changes; the Worker stores only its SHA-256 hash. Public `GET /api/contributions/:id/aggregate-status` returns only the ID and donation state for visible reports, so the page can hide the donation form after opt-in. The existing public report response remains unchanged for older cached clients. `POST /api/contributions/:id/contribute` adds all stored counts to the aggregate after the owner reviews all weeks and supplies `X-Model-Tides-Reviewed-Revision`; `/withdraw` removes them without deleting the personal link. `share` and `unshare` control the link independently. `PUT /api/contributions/:id` replaces named weeks without double-counting and preserves visibility and aggregate choice, guarded by expected-state headers. `DELETE` removes the report; `/rotate` rotates its private key. Hidden `/u/:id` and `/og/:id.png` return 404. The community chart and `/og/global.png` show **every** opted-in model-week cell, even when only one contributor has opted in. IDs do not prove distinct people.

`GET /api/aggregate` also reports `uploadedReports` (all report IDs, including reports outside the community chart) and `optedInReports` (IDs opted into the displayed metric). Neither number counts verified unique people. The homepage uses the same chart and timeline controls as personal reports and unlisted gists.

Migration `0005_active_session_days.sql` marks earlier v1 rows as legacy. V1 counts represent session starts/model switches and remain readable under existing links with an explicit legacy label. An aggregate without opted-in v2 reports shows v1 counts with that label; once any v2 report opts in, the aggregate shows only v2. It **never adds v1 and v2**. Older clients can create v1 personal reports until v2 contributions begin; then new v1 creation or renewed v1 aggregate opt-in returns 426 with an upgrade prompt. A v2 CLI owner of a v1 report reviews new active-day counts and uses `PUT /api/contributions/:id/migrate-v2` to replace **all** old weeks atomically while preserving link, key, visibility, and aggregate choice. The Worker requires a matching owner key, reviewed revision, and expected visibility/aggregate state; stale consent returns 409 and leaves the old rows intact. A v1 event-only export cannot recover daily activity and cannot be uploaded as v2.

The [local daily format](MODEL-TIDES.md) holds model/day counts for private offline transfer; it is never an upload format. `model-tides gist` sends only the separately reviewed v2 weekly JSON to an unlisted GitHub gist. Gists are readable by anyone with the URL and retain revisions. V1 gists remain viewable with their legacy label but are never reinterpreted as v2 activity.
