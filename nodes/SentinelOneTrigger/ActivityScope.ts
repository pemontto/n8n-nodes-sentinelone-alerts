import type { IDataObject } from 'n8n-workflow';
import type { AuthenticatedRequest, ScopeType } from './SentinelOneTriggerHelpers';

export async function activityAccountIds(
	request: AuthenticatedRequest,
	baseUrl: string,
	scopeType: ScopeType,
	scopeIds: string[],
): Promise<string[]> {
	if (scopeType === 'ACCOUNT') return [...new Set(scopeIds)];
	async function parents(
		kind: 'sites' | 'groups',
		ids: string[],
		parent: 'accountId' | 'siteId',
	): Promise<string[]> {
		const output = new Set<string>();
		const found = new Set<string>();
		for (let offset = 0; offset < ids.length; offset += 500) {
			const selected = ids.slice(offset, offset + 500);
			const cursors = new Set<string>();
			let cursor: string | undefined;
			do {
				const response = (await request({
					method: 'GET',
					url: `${baseUrl}/web/api/v2.1/${kind}`,
					timeout: 30_000,
					json: true,
					qs: {
						limit: 1000,
						[kind === 'sites' ? 'siteIds' : 'groupIds']: selected.join(','),
						...(cursor ? { cursor } : {}),
					},
				})) as {
					data?: IDataObject[] | { sites?: IDataObject[] };
					pagination?: { nextCursor?: string | null };
				};
				const rows =
					kind === 'sites' && !Array.isArray(response.data) ? response.data?.sites : response.data;
				if (!Array.isArray(rows))
					throw new Error('SentinelOne returned incomplete scope lineage for ActivityFeed.');
				for (const row of rows) {
					const id = String(row.id ?? '');
					if (!selected.includes(id)) continue;
					const value = row[parent];
					if (typeof value !== 'string' || !value)
						throw new Error(
							'SentinelOne did not expose the parent account/site ID required for ActivityFeed.',
						);
					found.add(id);
					output.add(value);
				}
				cursor = response.pagination?.nextCursor?.trim() || undefined;
				if (cursor && cursors.has(cursor))
					throw new Error('SentinelOne repeated an ActivityFeed scope-discovery cursor.');
				if (cursor) cursors.add(cursor);
			} while (cursor);
		}
		if (ids.some((id) => !found.has(id)))
			throw new Error(
				'A selected ActivityFeed scope is no longer visible. Reload the scope selection.',
			);
		return [...output];
	}
	const sites = scopeType === 'GROUP' ? await parents('groups', scopeIds, 'siteId') : scopeIds;
	return await parents('sites', sites, 'accountId');
}
