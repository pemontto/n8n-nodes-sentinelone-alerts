# SentinelOne Alerts Trigger

The **SentinelOne Alerts Trigger** polls SentinelOne and starts a workflow when a matching alert or alert note event appears.

## Operations

The **Alert** resource supports:

- **New**
- **Updated**
- **New or Updated**

The **Alert Note** resource supports **Created**.

## Scope and filters

Leave **Account Names or IDs** empty to use every account visible to the credential. If account discovery is unavailable, the trigger uses accessible sites.

Select accounts to narrow the site list. Select sites to narrow the group list. The deepest selected level becomes the query scope.

Use **Options** to filter alerts by severity, status, and alert-name text.

### Advanced filters

**Advanced Filters** accepts raw JSON for SentinelOne's GraphQL filter inputs. SentinelOne validates whether a field supports the selected comparator.

An array appends filters to the guided filters. Every item is joined with AND:

```json
[
	{ "fieldId": "detectionProduct", "stringEqual": { "value": "STAR" } },
	{
		"fieldId": "ticketId",
		"match": { "operator": "contains", "values": ["\"OrroCyberID\":\""] }
	}
]
```

Use SentinelOne's `orFilter` shape for grouped logic. Items within each `and` array are joined with AND; the outer groups are joined with OR:

```json
{
	"or": [
		{
			"and": [
				{ "fieldId": "detectionProduct", "stringEqual": { "value": "STAR" } },
				{
					"fieldId": "ticketId",
					"match": { "operator": "contains", "values": ["\"OrroCyberID\":\""] }
				}
			]
		},
		{
			"and": [
				{ "fieldId": "detectionProduct", "stringIn": { "values": ["CLOUD", "IDENTITY"] } },
				{ "fieldId": "severity", "stringIn": { "values": ["HIGH", "CRITICAL"] } }
			]
		}
	]
}
```

Guided filters, including the polling time window, are added to every OR group. Set `"isNegated": true` on an individual filter to negate it.

### Name exclusions

You can exclude account, site, and group names with case-insensitive regular expressions. Alert Note also supports excluding note author names. Do not include `/` delimiters or flags.

Examples:

- `demo|test` matches names containing either word.
- `^(demo|test)$` matches either complete name.
- `^demo.*` matches names beginning with `demo`.

The supported subset includes literals, anchors, character classes, alternatives, one unquantified group, and one single-character quantifier. Lookarounds, backreferences, counted repetitions, repeated groups, and multiple groups are rejected. Patterns are limited to 256 characters.

Changing a scope, resource, operation, or filter creates a new baseline. The trigger does not replay events that existed before that baseline.

## Polling behaviour

The first scheduled poll creates a baseline and returns no historical events. Later polls overlap the previous checkpoint, sort events by time and ID, emit unseen events, and save a new checkpoint only after all required requests succeed.

Manual alert previews return up to ten recent matching events without changing scheduled state. Manual note previews search backwards and return up to ten matching notes.

An event can be missed if SentinelOne indexes it only after its timestamp has left the overlap window. The trigger does not promise exactly-once delivery across workflow failures or crashes.

### Alert Note events

Alert Note polling reads note-creation events from SDL ActivityFeed. It uses activity type `16007` and takes note text from `data.payload.note_text`. A parent alert update is not required.

The trigger checks the current parent alert to apply scope and alert filters. An alert that moved scope or changed state can therefore be evaluated differently from when the note was created.

SDL windows use half-open `[start, end)` boundaries. Saturated or oversized windows are split into smaller ranges. Partial, omitted, malformed, or incomplete results fail the poll without advancing its checkpoint.

## Output

**Simplify** is enabled by default. Simplified items contain event fields and a nested `scope` object with the resolved account, site, and group.

Disable **Simplify** to return the event envelope with a nested alert or note payload.

For Alert Note events:

- `activityId` identifies the SDL activity.
- `noteText` contains the note text.
- `authorId` and `authorName` identify the ActivityFeed user when present.
- `noteId` remains `null` because ActivityFeed does not expose a verified note ID mapping.

An activity ID is not a SentinelOne note ID.

## Additional alert fields

Open **Options > Additional Alert Fields** to add supported fields such as ticket ID, analyst verdict, assignee, classification, confidence level, storyline ID, and labels.

Ticket ID, result, storyline ID, data sources, confidence level, classification, description, detection source, analyst verdict, analytics, assignee, attack path existence, attack surfaces, and available action IDs are selected by default. Clear fields you do not need.

Enable **Include SentinelOne OCSF** to add selected fields from SentinelOne's native OCSF representation. See [OCSF fields](ocsf-fields.md).

## Debug logging

Enable **Debug** in the node's **Settings** tab to log request stages, page counts, candidate counts, concurrency, and checkpoint decisions.

Debug logging excludes authorization headers, API tokens, note text, and response bodies.

## Example

1. Add **SentinelOne Alerts Trigger** to a workflow.
2. Select a SentinelOne credential.
3. Select **Alert** and **New or Updated**.
4. Select a scope, or leave accounts empty to use all visible accounts.
