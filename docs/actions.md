# SentinelOne actions

The **SentinelOne** node supports alerts, alert notes, and SDL queries. Alert and note operations require an explicit account, site, or group scope.

## Alert

### Get

Returns one alert by ID within the selected scope.

### Get Many

Returns alerts within the selected scope. Available filters include severity, status, analyst verdict, creation time, external ID, and ticket ID. Use **Return All** or set a limit.

### Update

Updates the status, analyst verdict, or non-empty ticket ID of one alert. Ticket ID clearing and assignee changes are not supported.

**Advanced Update Payload** accepts only `status`, `analystVerdict`, and `ticketId`. Do not set the same field in both the guided inputs and the JSON payload.

SentinelOne may accept an update for later processing. The node reports the returned state and reads the alert again when possible. It does not retry an update after the request may have reached SentinelOne.

## Alert Note

### Get Many

Returns notes for one alert. Set a limit to keep only the first results returned by SentinelOne.

### Create

Creates a plain-text or Markdown note. Markdown is sent unchanged. To reference an image, use a hosted image URL:

```markdown
![Diagram](https://example.com/diagram.png)
```

The node does not upload or host images, convert binary data, or accept HTML notes.

SentinelOne does not return a dedicated created-note ID from this operation. The node reports whether it could identify one new note, several possible notes, or none. It does not retry after the request may have reached SentinelOne.

## SDL Query

### Execute

Runs a PowerQuery across the tenant or selected accounts.

Choose an output mode:

- **Rows** returns one n8n item per result row.
- **Table** returns the original column descriptors and row arrays in one item.

Rows is the default. Duplicate or empty column names receive unique keys. Large integer values are returned as strings rather than rounded JavaScript numbers.

Default limits:

- Lifecycle timeout: 100 seconds
- Poll interval: 1.5 seconds
- Maximum rows: 5,000
- Maximum response size: 10 MiB

The output metadata identifies server partial results, local truncation, omitted events, discarded values, and external results that were not fetched.

## Errors

GraphQL errors fail the current input item even when SentinelOne responds with HTTP 200. Empty alert or note lists remain successful results.

Mutations are sent once. If the response is lost after submission, **Continue On Fail** returns `outcome: unknown` and `mayHaveCommitted: true` without including the submitted note or ticket ID.

## AI Agent use

The node can be connected to an n8n AI Agent as a tool. Alert updates and note creation still require an explicit scope and alert ID. Add n8n human review before the tool if the workflow requires approval for write operations.
