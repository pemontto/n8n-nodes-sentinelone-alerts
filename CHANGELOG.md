# Changelog

## 0.1.0 - 2026-09-07

- Add one alert polling trigger and a reusable SentinelOne credential.
- Support New, Updated, and New or Updated alert operations.
- Detect note creation through SDL ActivityFeed activity type `16007`, including notes on unchanged old alerts.
- Read note text directly from `data.payload.note_text`; return the activity ID explicitly and preserve author IDs and names from `data.user.id` and `data.user.enriched_name`, leaving unverified note IDs null.
- Replace the earlier parent-update requirement and timeline-hydration implementation with direct activity output.
- Add optional account, site, and group selections. Support accessible sites without account-list permission and retain deepest-selected-scope semantics.
- Add severity, status, alert-name, and scope-name filters. Preserve ungrouped alerts under group exclusions.
- Keep records with missing names. Support author-name exclusions using SDL enriched user names.
- Keep account, site, and group context in a nested scope object in both output formats.
- Include the complete SDL LOG activity record when note Simplify is off, preserving extra fields and large JSON integers.
- Add 16 selectable alert fields, including ticket ID and assignee, and optional native SentinelOne OCSF enrichment.
- Add overlap checkpoints and baseline changes without historical replay. Limit manual previews to ten results. Remove the note preview lookback control and search newer SDL windows first.
- Split saturated SDL windows at 1,000 rows, the local 5 MiB response budget, or a full-result URL. Fail incomplete or indivisibly saturated windows without advancing state.
- Deduplicate note activities by stable activity ID within the overlap and fail at the 40,000-identity capacity instead of unsafe eviction.
- Preserve LRQ routing headers on result polling and cancellation.
- Use Bearer authentication for management REST, GraphQL, and SDL endpoints through the shared credential.
- Use official SentinelOne light and dark marks. Place sanitized Debug logging in the node Settings tab, with a fallback for legacy Options values.
- Add a regular SentinelOne action node with scoped Alert Get, Get Many, and Update operations.
- Update alert status, analyst verdict, and ticket ID through discovered available actions, exact-ID targeting, result-union checks, and readback without retrying ambiguous mutations.
- Add Alert Note Get Many and Create with nullable user/rule authors, plain-text and Markdown input, and conservative created-note attribution.
- Add bounded SDL PowerQuery execution with routed polling, Rows and Table output modes, explicit partial/truncation metadata, cancellation, and cleanup.
- Treat GraphQL `errors` as failures even in HTTP 200 responses, while preserving valid empty lists.
- Expose the action node to n8n AI Agents as required by current strict community-node checks, while retaining exact-ID and scope safeguards for writes.
