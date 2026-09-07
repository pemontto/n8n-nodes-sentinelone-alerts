# Credentials

Create a SentinelOne API token, then add a **SentinelOne API** credential in n8n.

Enter:

- **Management Console URL:** Your tenant URL, such as `https://your-tenant.sentinelone.net`.
- **API Token:** Your SentinelOne API token.

The credential check reads one active site. It does not require permission to list accounts.

## Permissions

The token needs access to every management scope used by the workflow.

- Account selection requires `Accounts.view`.
- Site selection requires `Sites.view`.
- Group selection requires `Groups.view`.
- Alert Note polling and SDL Query Execute require SDL access.
- Alert updates and note creation require the matching SentinelOne write permissions.

The same credential works with the n8n HTTP Request node for SentinelOne Management REST, Unified Alerts GraphQL, and SDL requests.
