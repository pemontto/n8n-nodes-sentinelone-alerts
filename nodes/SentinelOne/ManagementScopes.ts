import type {
	IDataObject,
	IHttpRequestOptions,
	ILoadOptionsFunctions,
	INodePropertyOptions,
} from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';

export type ManagementScopeType = 'ACCOUNT' | 'SITE' | 'GROUP';

export const MAX_MANAGEMENT_SCOPE_PAGES = 100;
export const MAX_MANAGEMENT_SCOPE_OPTIONS = 25_000;
export const MAX_MANAGEMENT_SCOPE_LOAD_MS = 120_000;

type AuthenticatedRequest = (options: IHttpRequestOptions) => Promise<unknown>;

interface ManagementScopeItem extends IDataObject {
	id: string;
	name?: string;
	accountName?: string;
	siteName?: string;
	siteId?: string;
}

class ManagementScopeResponseError extends Error {}

export function normalizeBaseUrl(value: unknown): string {
	return String(value ?? '')
		.trim()
		.replace(/\/+$/, '');
}

export function authenticatedRequest(context: ILoadOptionsFunctions): AuthenticatedRequest {
	return async (options) =>
		await context.helpers.httpRequestWithAuthentication.call(
			context,
			'sentinelOneAlertsApi',
			options,
		);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function statusCode(error: unknown): number | undefined {
	if (!isRecord(error)) return undefined;
	const response = isRecord(error.response) ? error.response : undefined;
	const value =
		error.statusCode ?? error.httpCode ?? error.status ?? response?.statusCode ?? response?.status;
	const parsed = typeof value === 'number' ? value : Number(value);
	return Number.isFinite(parsed) ? parsed : undefined;
}

function scopePath(scopeType: ManagementScopeType): 'accounts' | 'sites' | 'groups' {
	if (scopeType === 'ACCOUNT') return 'accounts';
	if (scopeType === 'SITE') return 'sites';
	return 'groups';
}

function parseItem(value: unknown, path: string, index: number): ManagementScopeItem {
	if (!isRecord(value)) {
		throw new ManagementScopeResponseError(
			`The ${path} response contains an invalid item at position ${index + 1}.`,
		);
	}
	if (
		typeof value.id !== 'string' &&
		(typeof value.id !== 'number' || !Number.isSafeInteger(value.id))
	) {
		throw new ManagementScopeResponseError(
			`The ${path} response contains an item without a valid ID at position ${index + 1}.`,
		);
	}
	const id = String(value.id).trim();
	if (!id) {
		throw new ManagementScopeResponseError(
			`The ${path} response contains an empty ID at position ${index + 1}.`,
		);
	}

	const item: ManagementScopeItem = { id };
	for (const field of ['name', 'accountName', 'siteName', 'siteId'] as const) {
		const fieldValue = value[field];
		if (fieldValue !== undefined && fieldValue !== null) item[field] = String(fieldValue);
	}
	return item;
}

function parseItems(
	response: Record<string, unknown>,
	scopeType: ManagementScopeType,
	path: string,
): ManagementScopeItem[] {
	const data = response.data;
	let values: unknown;
	if (scopeType === 'SITE') values = isRecord(data) ? data.sites : undefined;
	else values = data;

	if (!Array.isArray(values)) {
		throw new ManagementScopeResponseError(
			`The ${path} response is missing its expected data list.`,
		);
	}
	return values.map((value, index) => parseItem(value, path, index));
}

function parseNextCursor(response: Record<string, unknown>, path: string): string | undefined {
	if (!Object.prototype.hasOwnProperty.call(response, 'pagination')) {
		return undefined;
	}
	if (!isRecord(response.pagination)) {
		throw new ManagementScopeResponseError(`The ${path} response has invalid pagination data.`);
	}
	if (!Object.prototype.hasOwnProperty.call(response.pagination, 'nextCursor')) {
		return undefined;
	}

	const nextCursor = response.pagination.nextCursor;
	if (nextCursor === null) return undefined;
	if (typeof nextCursor !== 'string' || !nextCursor.trim()) {
		throw new ManagementScopeResponseError(
			`The ${path} response has an invalid pagination.nextCursor.`,
		);
	}
	return nextCursor.trim();
}

function scopeLabel(scopeType: ManagementScopeType, item: ManagementScopeItem): string {
	const name = item.name?.trim() || item.id;
	if (scopeType === 'SITE' && item.accountName?.trim()) {
		return `${item.accountName.trim()} / ${name}`;
	}
	if (scopeType === 'GROUP' && item.siteName?.trim()) {
		return `${item.siteName.trim()} / ${name}`;
	}
	if (scopeType === 'GROUP' && item.siteId?.trim()) {
		return `Site ${item.siteId.trim()} / ${name}`;
	}
	return name;
}

function requestFailureMessage(scopeType: ManagementScopeType, error: unknown): string {
	const label = scopeType.toLowerCase();
	const status = statusCode(error);
	if (status === 401) {
		return `Unable to load SentinelOne ${label} scopes because authentication failed. Check the credential.`;
	}
	if (status === 403) {
		return `Unable to load SentinelOne ${label} scopes because this credential does not have permission.`;
	}
	if (status === 429) {
		return `Unable to load SentinelOne ${label} scopes because the service rate limit was reached. Try again later.`;
	}
	if (status !== undefined && status >= 500) {
		return `Unable to load SentinelOne ${label} scopes because the service is unavailable. Try again later.`;
	}
	return `Unable to load SentinelOne ${label} scopes. Check the credential and service availability.`;
}

export async function loadManagementScopeOptions(
	context: ILoadOptionsFunctions,
	scopeType: ManagementScopeType,
): Promise<INodePropertyOptions[]> {
	const startedAt = Date.now();
	const path = scopePath(scopeType);
	const credentials = await context.getCredentials('sentinelOneAlertsApi');
	const baseUrl = normalizeBaseUrl(credentials.baseUrl);
	if (!baseUrl) {
		throw new NodeOperationError(
			context.getNode(),
			'The SentinelOne credential is missing its Management Console URL.',
		);
	}

	const request = authenticatedRequest(context);
	const optionsById = new Map<string, INodePropertyOptions>();
	const seenCursors = new Set<string>();
	let pageCount = 0;
	let cursor: string | undefined;

	do {
		if (Date.now() - startedAt >= MAX_MANAGEMENT_SCOPE_LOAD_MS) {
			throw new NodeOperationError(
				context.getNode(),
				`SentinelOne ${path} scope loading exceeded ${MAX_MANAGEMENT_SCOPE_LOAD_MS / 1000} seconds. Narrow the accessible management scope or try again later.`,
			);
		}
		if (pageCount >= MAX_MANAGEMENT_SCOPE_PAGES) {
			throw new NodeOperationError(
				context.getNode(),
				`SentinelOne ${path} scope loading exceeded ${MAX_MANAGEMENT_SCOPE_PAGES} pages. Narrow the accessible management scope or contact SentinelOne support.`,
			);
		}
		pageCount++;
		const remainingMs = MAX_MANAGEMENT_SCOPE_LOAD_MS - (Date.now() - startedAt);

		const qs: IDataObject = { limit: 1000 };
		if (scopeType !== 'GROUP') qs.states = 'active';
		if (cursor) qs.cursor = cursor;

		let response: unknown;
		try {
			response = await request({
				method: 'GET',
				url: `${baseUrl}/web/api/v2.1/${path}`,
				timeout: Math.min(30_000, remainingMs),
				qs,
				json: true,
				sendCredentialsOnCrossOriginRedirect: false,
			});
		} catch (error) {
			if (Date.now() - startedAt >= MAX_MANAGEMENT_SCOPE_LOAD_MS) {
				throw new NodeOperationError(
					context.getNode(),
					`SentinelOne ${path} scope loading exceeded ${MAX_MANAGEMENT_SCOPE_LOAD_MS / 1000} seconds. Narrow the accessible management scope or try again later.`,
				);
			}
			if (scopeType === 'ACCOUNT' && statusCode(error) === 403) return [];
			throw new NodeOperationError(context.getNode(), requestFailureMessage(scopeType, error));
		}

		try {
			if (Date.now() - startedAt >= MAX_MANAGEMENT_SCOPE_LOAD_MS) {
				throw new ManagementScopeResponseError(
					`SentinelOne ${path} scope loading exceeded ${MAX_MANAGEMENT_SCOPE_LOAD_MS / 1000} seconds. Narrow the accessible management scope or try again later.`,
				);
			}
			if (!isRecord(response)) {
				throw new ManagementScopeResponseError(`The ${path} response is not an object.`);
			}
			for (const item of parseItems(response, scopeType, path)) {
				if (!optionsById.has(item.id)) {
					if (optionsById.size >= MAX_MANAGEMENT_SCOPE_OPTIONS) {
						throw new ManagementScopeResponseError(
							`SentinelOne returned more than ${MAX_MANAGEMENT_SCOPE_OPTIONS} ${path} scopes. Narrow the accessible management scope before loading options.`,
						);
					}
					optionsById.set(item.id, { name: scopeLabel(scopeType, item), value: item.id });
				}
			}

			const nextCursor = parseNextCursor(response, path);
			if (!nextCursor) break;
			if (seenCursors.has(nextCursor)) {
				throw new ManagementScopeResponseError(
					`SentinelOne repeated the ${path} cursor while loading management scopes.`,
				);
			}
			seenCursors.add(nextCursor);
			cursor = nextCursor;
		} catch (error) {
			const detail =
				error instanceof ManagementScopeResponseError
					? error.message
					: `The ${path} response could not be read.`;
			throw new NodeOperationError(context.getNode(), detail);
		}
	} while (cursor);

	return [...optionsById.values()].sort((left, right) => {
		const byName = left.name.localeCompare(right.name);
		return byName || String(left.value).localeCompare(String(right.value));
	});
}
