# n8n-nodes-sentinelone

This community package adds a SentinelOne polling trigger and a regular SentinelOne action node to n8n.

The trigger polls credential-visible account, site, or group scopes. It emits new alerts, updated alerts, and note-creation activities from SDL ActivityFeed. The action node reads and updates alerts, reads and creates alert notes, and runs bounded SDL PowerQueries.

## Installation

Install the package with the [n8n community node installation guide](https://docs.n8n.io/integrations/community-nodes/installation/).

## Credentials

Create a SentinelOne API token that can read Unified Alerts. The token must also read the management scopes that the workflow uses. Alert Note polling and SDL Query Execute require SDL access. Alert updates and note creation require the corresponding Unified Alerts write permissions.

Enter these credential fields:

- **Management Console URL**: The tenant URL, such as `https://your-tenant.sentinelone.net`.
- **API Token**: The SentinelOne API token.

The credential sends `Authorization: Bearer <token>` to management REST, Unified Alerts GraphQL, and SDL query endpoints. These endpoint families were checked live with the saved credential. Use HTTP Request with the predefined SentinelOne credential to reuse it for REST, SDL, or GraphQL POST requests. The built-in GraphQL node supports generic authentication and does not offer this predefined credential.

The credential check reads one active site. It does not require account-list permission.

Scope option loading requires these permissions:

- Account options require `Accounts.view`.
- Group options require `Groups.view`.
- Site options require `Sites.view`.

## Trigger resources and operations

The **Alert** resource supports these operations:

- **New** emits an alert once by its alert ID.
- **New or Updated** emits new alerts and the latest changed state observed for existing alerts.
- **Updated** emits the latest changed state observed when `updatedAt` advances.

The **Alert Note** resource supports the **Created** operation. It emits SDL ActivityFeed records for activity type `16007`, deduplicated by their stable activity IDs. Note text comes from `data.payload.note_text`. A parent alert update is not required.

The trigger prevents a new alert from also emitting as an update in the same poll. Intermediate changes between polls can collapse into the latest observed state.

## Action resources and operations

The regular **SentinelOne** node has these resources:

| Resource   | Operation | Behaviour                                                                                                                                                                   |
| ---------- | --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Alert      | Get       | Reads one alert by ID within an explicit account, site, or group scope.                                                                                                     |
| Alert      | Get Many  | Reads scoped alerts with guarded Relay pagination, Return All or Limit, and fixed filters for severity, status, analyst verdict, creation time, external ID, and ticket ID. |
| Alert      | Update    | Sets status, analyst verdict, or a non-empty ticket ID after discovering the actions available for that alert.                                                              |
| Alert Note | Get Many  | Reads all notes for one scoped parent alert and optionally applies a local Limit.                                                                                           |
| Alert Note | Create    | Creates one plain-text or Markdown note without retrying an ambiguous mutation.                                                                                             |
| SDL Query  | Execute   | Submits one PowerQuery, waits within a finite deadline, returns rows or the original table, and releases the server query.                                                  |

Get, Update, and both Alert Note operations require an explicit management scope. The node verifies the returned alert identity and scope. Alert Note operations check the parent alert first because the note resolvers accept an alert ID but no scope.

Alert Update targets one exact alert ID. It uses the same scope and filter for action discovery and execution, rejects disabled or conflicting actions, sends the mutation once, interprets immediate, rejected, and scheduled result variants, and reads the alert again when possible. A successful HTTP response alone does not mean every requested field changed. Ticket-ID clearing and assignee changes are not supported in version 1 because their live payload semantics are not settled.

**Advanced Update Payload** accepts only `status`, `analystVerdict`, and `ticketId`. It cannot set an alert ID, scope, filter, action ID, or any other SentinelOne action. A field cannot appear in both the guided inputs and the JSON object.

All GraphQL calls inspect the response envelope. A non-empty top-level `errors` array fails the current input item even when SentinelOne returns HTTP 200 or partial `data`. A present empty alert connection or note list remains a successful empty result; a missing or malformed response root is an error.

### Alert-note formatting

Alert Note Create supports Plain Text and Markdown. Markdown passes to SentinelOne unchanged with `type: MARKDOWN`. To refer to an image, supply normal Markdown such as `![diagram](https://example.test/diagram.png)`. The node does not upload images, host files, fetch image URLs, or convert n8n binary data. SentinelOne console rendering of remote images depends on the target tenant and was not verified here. HTML note creation is not exposed in version 1.

The add-note mutation returns a note list rather than a dedicated created-note ID. The node reports the mutation acknowledgement separately from note identification. It marks a single compatible new ID as inferred and reports zero or several candidates as unresolved or ambiguous. It never retries note creation after a response may have been lost.

### SDL Query output and limits

SDL Query Execute supports PowerQuery only. Choose the whole tenant or one or more accounts, then choose an output mode:

- **Rows** emits one n8n item per returned row. Duplicate, empty, reserved, and suffix-colliding column names receive deterministic unique keys. A zero-row result still emits query metadata.
- **Table** emits one item containing the original column descriptors, row arrays, and query metadata.

The default lifecycle timeout is 100 seconds, the poll interval is 1.5 seconds, Maximum Rows is 5,000, and Maximum Response Size is 10 MiB. The node receives SDL as text, checks its UTF-8 size before JSON parsing, and preserves unsafe integer tokens as strings. The HTTP helper still receives the complete response before that check, so this is not a streaming network or peak-response-memory limit. Truncation, time-limit partial results, omitted events, discarded values, and an unfetched external-result URL remain visible in metadata.

The node preserves `X-Dataset-Query-Forward-Tag` across polling and cleanup and sends `lastStepSeen` on polls. It never resubmits a query after launch. A cleanup failure does not discard a completed result, but it appears as an unconfirmed cleanup warning.

The action node is available as an n8n AI Agent tool, as required by the current strict community-node checks. Write operations still require an explicit management scope and alert ID, and Update cannot accept bulk or user-supplied action filters. Use n8n's human-review controls when an agent workflow needs approval before mutations.

## Filters

Leave **Account Names or IDs** empty to poll all credential-visible accounts. If account discovery is forbidden or returns no accounts, the trigger uses the accessible sites. Authentication failures, rate limits, and service errors stop the poll rather than changing its scope.

Select accounts to restrict the site list to those accounts. Sites can also be selected with the account field empty, which supports site-scoped credentials without `Accounts.view`.

Select sites to show only their groups. Empty sites retain the account scope; empty groups retain the site scope. The deepest selected level applies to the whole poll. Selecting groups does not also poll other selected sites or accounts.

Open **Options** to filter alerts by severity, status, and alert-name text. Alert-note filters apply to the candidate alerts.

**Options** also contains simplified output. **Settings → Debug** enables sanitized debug logging.

### Name exclusions

Options includes **Exclude Account Name**, **Exclude Site Name**, and **Exclude Group Name**. Alert Note also offers **Exclude Note Author Name**. Each accepts a case-insensitive regular expression without `/` delimiters or flags. An empty field disables that exclusion.

For example, set **Exclude Account Name** to `demo|test` to exclude names containing either word while keeping all other accessible accounts. Set **Exclude Site Name** instead to apply the same rule to sites. Use `^(demo|test)$` for exact names or `^demo.*` for a prefix. Whitespace in a pattern is significant.

Exclusions match the names on each alert's `realTime.scope`. An account or site match excludes its alerts and notes. A group match never changes the query to group scope, so ungrouped alerts remain eligible. Note polling checks the affected alerts through scoped GraphQL queries and applies the account, site, and group exclusions before returning activity records.

Author exclusions match `data.user.enriched_name` from SDL, including person and service-user names. Missing or empty names remain included. Author IDs come from `data.user.id` and are projected as strings to preserve large identifiers.

The supported regex subset allows literals, anchors, character classes, alternatives, at most one unquantified group, and at most one single-character quantifier (`*`, `+`, or `?`). Counted repetitions, lookarounds, backreferences, repeated groups, and multiple groups are rejected. Patterns are limited to 256 characters. An invalid pattern stops the poll with the field name in the error. Names longer than 1,024 characters also stop an enabled exclusion check. These limits bound native regex work without adding runtime dependencies.

Changing an exclusion creates a new scheduled baseline. Removing an exclusion does not replay historical events. Manual preview applies the same exclusions and leaves scheduled state unchanged.

Pagination, overlap, request timeout, time-window splitting, and request concurrency are internal safeguards. The node manages them automatically.

## Polling behavior

The first scheduled poll reads the overlap window and creates a baseline. It emits no historical events.

A change to the selected credential, scope selection, resource, operation, or filters creates a new baseline. Debug and output formatting changes keep the current checkpoint. Discovery refreshes under an unchanged all-visible selection do not reset the checkpoint unless the query level changes.

Each scheduled poll follows these rules:

1. Query the overlap before the last successful checkpoint.
2. Read every required alert page or complete SDL query window.
3. Sort events by the event time and stable ID.
4. Emit unseen events.
5. Save the poll-start time only after all requests succeed.

SentinelOne cursors apply only to the current page sequence. Dense alert ranges split into smaller time windows automatically.

A missing or repeated cursor stops the poll without a state update. Operational safeguards do not reset the saved checkpoint.

Alert manual previews search from the earliest available timestamp and return up to 10 newest matching events. Alert Note previews start with the last day of ActivityFeed, expand backwards automatically as needed to a fixed 2020 API boundary, and stop after finding 10 eligible activity records. Preview pagination continues past excluded rows.

Manual polls ignore saved deduplication state and do not update that state.

Alert polling retains up to 20,000 alert IDs and 40,000 alert versions. If one poll alone exceeds a limit, it fails without advancing state. Saved alert identities can eventually be evicted; an evicted identity can be emitted again if the API returns it later.

### Note detection through ActivityFeed

Scheduled note polls query SDL ActivityFeed from the last successful checkpoint minus a five-minute overlap to the current poll start. They select activity type `16007` and read note text directly from `data.payload.note_text`. Simplify on uses a focused PowerQuery projection; Simplify off uses LOG search to retain every returned activity field. They do not fetch note timelines or `alertNotes`, and they do not require a ticket ID or parent timestamp change.

The node checks each affected alert through GraphQL to apply the selected account, site, or group scope, severity, status, alert-name filter, and scope-name exclusions. GraphQL lookups use at most five concurrent requests. This eligibility check reads the alert's current state.

SDL windows are half-open: `[start, end)`. The node retains nanosecond timestamps as strings and compares them without floating-point conversion. Requests use millisecond boundaries. A window that returns 1,000 rows, exceeds the local 5 MiB response budget, or returns `fullResultUrl` is split into smaller time windows. If the smallest supported one-millisecond window is still saturated, the poll fails without advancing its checkpoint. Partial, omitted, malformed, or incomplete results also fail the poll.

The 5 MiB threshold is a local conservative budget, not a verified SentinelOne server limit. A read-only probe returned 8,218,300 bytes inline without omissions or a partial-result flag.

The first scheduled poll establishes a baseline and emits no historical records. Activity IDs and their timestamps are retained for overlap deduplication. State is limited to 40,000 activity identities; exceeding capacity fails instead of discarding identities still needed for the overlap. No per-alert timestamp map or pending timeline-reconciliation state is required.

An activity that becomes searchable only after its timestamp has left the overlap can be missed. Scope eligibility can also change between activity creation and polling. The trigger does not promise exactly-once downstream effects across workflow failures or crashes.

## Output

**Simplify** is enabled by default. Simplified items contain flat event fields and a nested `scope` object.

Scope IDs and names appear only under `scope`: `type`, `id`, `name`, and the resolved `account`, `site`, and `group` objects. Each entity contains `id` and `name`; an unavailable entity is null. The output never returns the full configured scope list.

Disable **Simplify** to return the event envelope with a nested alert or note payload and resolved scope object.

For Alert Note, `activityId` identifies the SDL record and `noteText` contains its supplied text. `authorId` and `authorName` come from `data.user.id` and `data.user.enriched_name`. Raw output keeps them under `note.createdBy.userId` and `note.createdBy.fullName`. Missing author values remain null. `noteId` and `authorType` remain null because their mappings are unverified. The focused `authorEmail` field is not populated; full activity output preserves `data.user.email` when the source supplies it. An activity ID is not a SentinelOne note ID. Event timestamps describe the activity record; no timestamp-based pairing with a timeline note is performed.

### Choose additional fields

For Alert operations, open **Options → Additional Alert Fields** and select **Ticket ID** or any other supported field. These selections add to the standard event and scope fields. With Simplify enabled, `ticketId` and the other selected fields appear at the top level. With Simplify disabled, they appear under `alert`. Missing values remain `null`.

The selector supports analyst verdict, analytics, assignee, attack-path existence, attack surfaces, available action IDs, classification, confidence level, data sources, description, detection source, labels, primary indicator type, result, storyline ID, and ticket ID. Assignee includes user ID, full name, and email. Analytics and detection source return their documented nested fields. This is a fixed supported field list, not an arbitrary GraphQL editor.

### SentinelOne OCSF

For Alert operations, enable **Options → Include SentinelOne OCSF** to add an `ocsf` object to either output shape. The node queries SentinelOne's native representation using the [documented field selection](docs/ocsf-fields.md). It preserves native field names, values, and `null` when no OCSF representation is available. This is a selected subset of SentinelOne's representation, not a complete standard OCSF event or a format conversion.

OCSF enrichment makes one extra detail request per returned alert, with at most five requests in parallel. Baseline polls do not fetch OCSF. Manual previews select up to ten events before fetching details. The node rechecks scope and exclusions against each detail response, discarding alerts that moved outside the requested scope or now match an exclusion. A failed or malformed detail response stops the poll without advancing state.

The detail request can observe a later alert version than the list query. `ocsfAlertUpdatedAt` records the detail response's alert update timestamp; the outer event timestamp still identifies the polled event. Do not assume both payloads describe an atomic snapshot.

Changing additional fields, OCSF inclusion, or output formatting does not reset the scheduled baseline or replay old events. Alert Note outputs do not support parent-alert OCSF enrichment.

Enable **Debug** in the node's **Settings** tab to write sanitized request stages, page counts, candidate counts, concurrency, and checkpoint decisions to the n8n log.

Debug logging never writes authorization headers, API tokens, note text, or full response bodies.

## Example workflow

1. Add **SentinelOne Trigger** to a workflow.
2. Select a SentinelOne credential.
3. Select the **Alert** resource.
4. Select the **New or Updated** operation.
5. Select one or more accounts, or leave the account field empty to use all visible accounts.
6. Select a site or group if the workflow requires a narrower scope.
7. Add severity or status filters in **Options** if required.
8. Activate the workflow.

The first scheduled poll creates the baseline. A later matching event produces a focused envelope:

```json
{
	"eventType": "alert.updated",
	"eventTimestamp": "2026-08-26T12:01:00.000Z",
	"scope": {
		"type": "ACCOUNT",
		"id": "<account-id>",
		"name": "Example Account",
		"account": { "id": "<account-id>", "name": "Example Account" },
		"site": { "id": "<site-id>", "name": "Default site" },
		"group": { "id": "<group-id>", "name": "Default Group" }
	},
	"alertId": "<unified-alert-id>",
	"severity": "HIGH",
	"status": "NEW"
}
```

## Compatibility

The package uses SentinelOne Management API v2.1 and Unified Alerts GraphQL.

The development checks use these versions:

- n8n 2.37.10 (isolated development server).
- `@n8n/node-cli` 0.46.4.
- Node.js 24.20.0 and 26.8.1 for the unit tests.

The package has no runtime dependencies. It uses the request and workflow-state helpers supplied by n8n.

## Development

Install the development packages:

```bash
pnpm install
```

Run the package checks:

```bash
pnpm test
pnpm run lint
```

Start the local n8n environment:

```bash
pnpm run dev
```

## Resources

- [n8n community node documentation](https://docs.n8n.io/integrations/#community-nodes)
- [n8n verified-node guidelines](https://docs.n8n.io/connect/create-nodes/build-your-node/reference/verification-guidelines)
- [SentinelOne documentation](https://docs.sentinelone.com/)
- [Source repository](https://github.com/pemontto/n8n-nodes-sentinelone)

## License

The package code uses the MIT License. SentinelOne retains ownership of its logo and trademarks; see [icon provenance](docs/brand-assets.md).
