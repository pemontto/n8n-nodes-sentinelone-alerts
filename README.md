# n8n-nodes-sentinelone-alerts

Use SentinelOne alerts and SDL in n8n workflows.

This package includes two nodes:

- **SentinelOne Alerts** reads and updates alerts, reads and creates alert notes, and runs SDL PowerQueries.
- **SentinelOne Alerts Trigger** starts workflows when alerts are created or updated, or when alert notes are created.

## Installation

In n8n, open **Settings > Community Nodes**, select **Install**, and enter:

```text
n8n-nodes-sentinelone-alerts
```

See the [n8n community node installation guide](https://docs.n8n.io/integrations/community-nodes/installation/) for other installation methods.

## Credentials

Create a SentinelOne credential with your Management Console URL and API token. The token needs access to the accounts, sites, or groups used by the workflow. Write operations also need the matching SentinelOne permissions.

See [Credentials](https://github.com/pemontto/n8n-nodes-sentinelone-alerts/blob/main/docs/credentials.md) for setup and permissions.

## Operations

### SentinelOne Alerts

- **Alert:** Get, Get Many, Update
- **Alert Note:** Get Many, Create
- **SDL Query:** Execute

The node can be connected to an n8n AI Agent as a tool.

See [SentinelOne actions](https://github.com/pemontto/n8n-nodes-sentinelone-alerts/blob/main/docs/actions.md) for fields, limits, and output.

### SentinelOne Alerts Trigger

- **Alert:** New, Updated, New or Updated
- **Alert Note:** Created

See [SentinelOne Alerts Trigger](https://github.com/pemontto/n8n-nodes-sentinelone-alerts/blob/main/docs/trigger.md) for scope selection, filters, output, and polling behaviour.

## Compatibility

Tested with n8n 2.37.10 against SentinelOne Management API v2.1, Unified Alerts GraphQL, and SDL. The package has no runtime dependencies.

## Development

```bash
pnpm install
pnpm test
pnpm run lint
```

Run `pnpm run dev` to open the node in a local n8n instance.

## Resources

- [SentinelOne documentation](https://docs.sentinelone.com/)
- [n8n community node documentation](https://docs.n8n.io/integrations/community-nodes/)
- [Report an issue](https://github.com/pemontto/n8n-nodes-sentinelone-alerts/issues)

## License

[MIT](https://github.com/pemontto/n8n-nodes-sentinelone-alerts/blob/main/LICENSE.md). SentinelOne owns its logo and trademarks. See [icon provenance](https://github.com/pemontto/n8n-nodes-sentinelone-alerts/blob/main/docs/brand-assets.md).
