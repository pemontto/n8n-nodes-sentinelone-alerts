import type { IDataObject, IExecuteFunctions, JsonObject } from 'n8n-workflow';
import { NodeApiError, NodeOperationError } from 'n8n-workflow';

const GRAPHQL_PATH = '/web/api/v2.1/unifiedalerts/graphql';
const MAX_PAGE_SIZE = 100;
const MAX_RETURN_ALL_ALERTS = 10_000;
const READ_ATTEMPTS = 3;

const ALERT_SUMMARY_FIELDS = /* GraphQL */ `
	fragment AlertSummaryFields on UnifiedAlert {
		id
		externalId
		name
		description
		severity
		status
		analystVerdict
		classification
		confidenceLevel
		result
		createdAt
		updatedAt
		detectedAt
		firstSeenAt
		lastSeenAt
		noteExists
		ticketId
		storylineId
		assignee {
			userId
			email
			fullName
		}
		realTime {
			scope {
				account {
					id
				}
				site {
					id
				}
				group {
					id
				}
			}
		}
	}
`;

const ALERT_DETAIL_FIELDS = /* GraphQL */ `
	fragment AlertDetailFields on UnifiedAlertDetail {
		id
		externalId
		name
		description
		severity
		status
		analystVerdict
		classification
		confidenceLevel
		result
		createdAt
		updatedAt
		detectedAt
		firstSeenAt
		lastSeenAt
		noteExists
		ticketId
		ticketIdExists
		storylineId
		selfLink
		assignee {
			userId
			email
			fullName
		}
		realTime {
			scope {
				account {
					id
				}
				site {
					id
				}
				group {
					id
				}
			}
		}
		assets {
			id
			name
			category
			osType
			osVersion
			agentUuid
			lastLoggedInUser
			connectivityToConsole
		}
		rawData
	}
`;

const ALERT_NOTE_FIELDS = /* GraphQL */ `
	fragment AlertNoteFields on AlertNote {
		id
		alertId
		text
		type
		createdAt
		updatedAt
		createdBy {
			__typename
			... on UserNoteAuthor {
				userId
				email
				fullName
			}
			... on RuleNoteAuthor {
				id
				name
				version
			}
		}
	}
`;

export const GRAPHQL_DOCUMENTS = {
	getAlert: /* GraphQL */ `
		${ALERT_DETAIL_FIELDS}
		query SentinelOneGetAlert($id: ID!, $scope: ScopeSelectorInput!) {
			alert(id: $id, scope: $scope) {
				...AlertDetailFields
			}
		}
	`,
	getManyAlerts: /* GraphQL */ `
		${ALERT_SUMMARY_FIELDS}
		query SentinelOneGetManyAlerts(
			$first: Int!
			$after: String
			$scope: ScopeSelectorInput!
			$viewType: ViewType!
			$filters: [FilterInput!]
			$sorts: [SortInput!]
		) {
			alerts(
				first: $first
				after: $after
				scope: $scope
				viewType: $viewType
				filters: $filters
				sorts: $sorts
			) {
				edges {
					cursor
					node {
						...AlertSummaryFields
					}
				}
				pageInfo {
					hasNextPage
					endCursor
				}
				totalCount
			}
		}
	`,
	availableActions: /* GraphQL */ `
		query SentinelOneAvailableAlertActions(
			$scope: ScopeSelectorInput!
			$filter: OrFilterSelectionInput!
			$viewType: ViewType!
		) {
			alertAvailableActions(scope: $scope, filter: $filter, viewType: $viewType) {
				data {
					id
					title
					isDisabled
					disabledReason
					types
					triggeredAfter
					triggersActions
				}
				errors {
					errorMessage
					errorPayload {
						__typename
						... on ActionsErrorConcurrentUserLimitPayload {
							limit
						}
						... on ActionsErrorLimitPayload {
							limit
						}
					}
				}
			}
		}
	`,
	updateAlert: /* GraphQL */ `
		mutation SentinelOneUpdateAlert(
			$scope: ScopeSelectorInput!
			$filter: OrFilterSelectionInput!
			$actions: [TriggerActionInput!]!
			$viewType: ViewType!
		) {
			alertTriggerActions(scope: $scope, filter: $filter, actions: $actions, viewType: $viewType) {
				__typename
				... on ActionsTriggered {
					actions {
						actionId
						success {
							id
						}
						skip {
							id
							skipType
							skipMessage
						}
						failure {
							id
							errorType
							errorMessage
						}
					}
				}
				... on TriggerActionsError {
					errors {
						errorMessage
						errorPayload {
							__typename
							... on ActionsErrorConcurrentUserLimitPayload {
								limit
							}
							... on ActionsErrorLimitPayload {
								limit
							}
						}
					}
				}
				... on TriggerActionsScheduled {
					executionId
					bulkActionTriggerId
				}
			}
		}
	`,
	getAlertNotes: /* GraphQL */ `
		${ALERT_NOTE_FIELDS}
		query SentinelOneGetAlertNotes($alertId: ID!) {
			alertNotes(alertId: $alertId) {
				data {
					...AlertNoteFields
				}
			}
		}
	`,
	createAlertNote: /* GraphQL */ `
		${ALERT_NOTE_FIELDS}
		mutation SentinelOneCreateAlertNote(
			$alertId: ID!
			$text: String!
			$type: ContentType!
			$plainText: String
		) {
			addAlertNote(alertId: $alertId, text: $text, type: $type, plainText: $plainText) {
				data {
					...AlertNoteFields
				}
			}
		}
	`,
} as const;

type ScopeType = 'ACCOUNT' | 'SITE' | 'GROUP';

interface ScopeSelector extends IDataObject {
	scopeType: ScopeType;
	scopeIds: string[];
}

interface GraphQlErrorShape {
	message?: unknown;
	path?: unknown;
	locations?: unknown;
	extensions?: unknown;
}

interface UpdateDefinition {
	actionType: string;
	payloadBranch: 'status' | 'analystVerdict' | 'ticketId';
}

const UPDATE_DEFINITIONS: Record<string, UpdateDefinition> = {
	status: {
		actionType: 'STATUS_UPDATE',
		payloadBranch: 'status',
	},
	analystVerdict: {
		actionType: 'ANALYST_VERDICT_UPDATE',
		payloadBranch: 'analystVerdict',
	},
	ticketId: {
		actionType: 'SET_TICKET_ID',
		payloadBranch: 'ticketId',
	},
};

const STATUS_VALUES = new Set(['NEW', 'IN_PROGRESS', 'RESOLVED']);
const ANALYST_VERDICT_VALUES = new Set([
	'FALSE_POSITIVE_BENIGN',
	'FALSE_POSITIVE_BENIGN_BUT_SUSPICIOUS',
	'FALSE_POSITIVE_SYSTEM_ERROR',
	'FALSE_POSITIVE_UNDEFINED',
	'FALSE_POSITIVE_USER_ERROR',
	'TRUE_POSITIVE_ADVANCED_PERSISTENT_THREAT',
	'TRUE_POSITIVE_BENIGN',
	'TRUE_POSITIVE_BENIGN_BUT_SUSPICIOUS',
	'TRUE_POSITIVE_DATA_EXFILTRATION',
	'TRUE_POSITIVE_DENIAL_OF_SERVICE',
	'TRUE_POSITIVE_EXPLOITATION_TOOLS',
	'TRUE_POSITIVE_INSIDER_THREAT',
	'TRUE_POSITIVE_MALWARE',
	'TRUE_POSITIVE_PHISHING_ATTACK',
	'TRUE_POSITIVE_POLICY_VIOLATION',
	'TRUE_POSITIVE_PUA_ADWARE',
	'TRUE_POSITIVE_RANSOMWARE',
	'TRUE_POSITIVE_UNAUTHORIZED_ACCESS',
	'TRUE_POSITIVE_UNDEFINED',
	'UNDEFINED',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function localError(
	context: IExecuteFunctions,
	itemIndex: number,
	message: string,
): NodeOperationError {
	return new NodeOperationError(context.getNode(), message, { itemIndex });
}

function apiError(
	context: IExecuteFunctions,
	itemIndex: number,
	message: string,
	description?: string,
	httpCode = '400',
	mutationUnknown = false,
): NodeApiError {
	const safeResponse: JsonObject = { message, name: 'SentinelOneGraphQLError' };
	const error = new NodeApiError(context.getNode(), safeResponse, {
		itemIndex,
		message,
		description,
		httpCode,
	});
	if (mutationUnknown) Object.assign(error, { mayHaveCommitted: true, outcome: 'unknown' });
	return error;
}

function idString(value: unknown): string | null {
	if (typeof value === 'string') return value.trim() || null;
	return null;
}

function requiredId(
	context: IExecuteFunctions,
	itemIndex: number,
	parameterName: string,
	label: string,
): string {
	const value = idString(context.getNodeParameter(parameterName, itemIndex));
	if (!value) throw localError(context, itemIndex, `${label} must be a non-empty ID.`);
	return value;
}

function readScope(context: IExecuteFunctions, itemIndex: number): ScopeSelector {
	const rawType = String(context.getNodeParameter('scopeType', itemIndex) ?? '').toUpperCase();
	if (rawType !== 'ACCOUNT' && rawType !== 'SITE' && rawType !== 'GROUP') {
		throw localError(context, itemIndex, 'Scope Type must be Account, Site, or Group.');
	}
	const rawIds = context.getNodeParameter('scopeIds', itemIndex);
	if (!Array.isArray(rawIds)) {
		throw localError(context, itemIndex, 'Select at least one SentinelOne scope.');
	}
	const scopeIds = rawIds.map(idString);
	if (scopeIds.length === 0 || scopeIds.some((value) => value === null)) {
		throw localError(
			context,
			itemIndex,
			'Every selected SentinelOne scope must have a non-empty ID.',
		);
	}
	const uniqueIds = [...new Set(scopeIds as string[])];
	return { scopeType: rawType, scopeIds: uniqueIds };
}

function normalizeBaseUrl(value: unknown): string {
	return String(value ?? '')
		.trim()
		.replace(/\/+$/, '');
}

function responseStatus(error: unknown): number | null {
	if (!isRecord(error)) return null;
	const response = isRecord(error.response) ? error.response : undefined;
	const value =
		error.statusCode ?? error.httpCode ?? error.status ?? response?.statusCode ?? response?.status;
	const status = Number(value);
	return Number.isInteger(status) && status >= 100 && status <= 599 ? status : null;
}

function isRetryableReadError(error: unknown): boolean {
	const status = responseStatus(error);
	if (status !== null) return status === 429 || [502, 503, 504].includes(status);
	if (!(error instanceof Error)) return false;
	return /ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|socket hang up/i.test(error.message);
}

async function graphQlRequest(
	context: IExecuteFunctions,
	itemIndex: number,
	document: string,
	variables: IDataObject,
	rootName: string,
	mutation = false,
): Promise<unknown> {
	const credentials = await context.getCredentials('sentinelOneAlertsApi');
	const baseUrl = normalizeBaseUrl(credentials.baseUrl);
	if (!baseUrl)
		throw localError(context, itemIndex, 'The SentinelOne Management Console URL is empty.');

	const attempts = mutation ? 1 : READ_ATTEMPTS;
	const envelopeFailure = (message: string, description?: string): NodeApiError =>
		apiError(context, itemIndex, message, description, '400', mutation);
	let response: unknown;
	for (let attempt = 1; attempt <= attempts; attempt++) {
		try {
			response = await context.helpers.httpRequestWithAuthentication.call(
				context,
				'sentinelOneAlertsApi',
				{
					method: 'POST',
					url: `${baseUrl}${GRAPHQL_PATH}`,
					body: { query: document, variables },
					json: true,
					sendCredentialsOnCrossOriginRedirect: false,
				},
			);
			break;
		} catch (error) {
			if (!mutation && attempt < attempts && isRetryableReadError(error)) continue;
			const status = responseStatus(error);
			const suffix = status === null ? '' : ` (HTTP ${status})`;
			const description = mutation
				? 'The mutation was sent once and was not retried. SentinelOne may have committed it; verify the alert before trying again.'
				: 'SentinelOne did not return a usable GraphQL response.';
			const failure = apiError(
				context,
				itemIndex,
				`SentinelOne GraphQL request failed${suffix}.`,
				description,
				status === null ? '500' : String(status),
				mutation,
			);
			throw failure;
		}
	}

	if (!isRecord(response)) {
		throw envelopeFailure('SentinelOne returned a malformed GraphQL envelope.');
	}
	if (
		response.errors !== undefined &&
		response.errors !== null &&
		!Array.isArray(response.errors)
	) {
		throw envelopeFailure('SentinelOne returned a malformed GraphQL errors field.');
	}
	const errors = (response.errors ?? []) as GraphQlErrorShape[];
	if (errors.length > 0) {
		const codes = errors
			.map((entry) => {
				if (!isRecord(entry) || !isRecord(entry.extensions)) return '';
				const code = entry.extensions.code;
				const value = String(code ?? '');
				return /^[A-Z0-9_.-]{1,64}$/.test(value) ? value : '';
			})
			.filter(Boolean);
		const description =
			codes.length > 0 ? `SentinelOne error codes: ${[...new Set(codes)].join(', ')}.` : undefined;
		throw envelopeFailure('SentinelOne GraphQL operation failed.', description);
	}
	if (!isRecord(response.data)) {
		throw envelopeFailure('SentinelOne returned a GraphQL response without data.');
	}
	if (
		!(rootName in response.data) ||
		response.data[rootName] === null ||
		response.data[rootName] === undefined
	) {
		throw envelopeFailure(`SentinelOne returned a GraphQL response without ${rootName}.`);
	}
	return response.data[rootName];
}

function scopeObject(alert: Record<string, unknown>): Record<string, unknown> | null {
	const realTime = isRecord(alert.realTime) ? alert.realTime : null;
	return realTime && isRecord(realTime.scope) ? realTime.scope : null;
}

function assertAlertInScope(
	context: IExecuteFunctions,
	itemIndex: number,
	alert: unknown,
	alertId: string | null,
	scope: ScopeSelector,
): asserts alert is Record<string, unknown> {
	if (!isRecord(alert)) {
		throw apiError(context, itemIndex, 'The requested alert was not found in the selected scope.');
	}
	const returnedId = idString(alert.id);
	if (!returnedId || (alertId !== null && returnedId !== alertId)) {
		throw apiError(context, itemIndex, 'The requested alert was not found in the selected scope.');
	}
	alert.id = returnedId;
	const returnedScope = scopeObject(alert);
	const level = scope.scopeType.toLowerCase();
	const levelObject = returnedScope && isRecord(returnedScope[level]) ? returnedScope[level] : null;
	const returnedScopeId = levelObject ? idString(levelObject.id) : null;
	if (!returnedScopeId || !scope.scopeIds.includes(returnedScopeId)) {
		throw apiError(context, itemIndex, 'The requested alert was not found in the selected scope.');
	}
	if (levelObject) levelObject.id = returnedScopeId;
}

function parseStringValues(
	context: IExecuteFunctions,
	itemIndex: number,
	value: unknown,
	label: string,
): string[] {
	if (!Array.isArray(value) || value.length === 0) {
		throw localError(context, itemIndex, `${label} must contain at least one value.`);
	}
	const values = value.map((entry) => (typeof entry === 'string' ? entry.trim() : ''));
	if (values.some((entry) => !entry)) {
		throw localError(context, itemIndex, `${label} cannot contain empty values.`);
	}
	return [...new Set(values)];
}

function dateMillis(
	context: IExecuteFunctions,
	itemIndex: number,
	value: unknown,
	label: string,
): number {
	const parsed = typeof value === 'number' ? value : Date.parse(String(value));
	if (!Number.isFinite(parsed))
		throw localError(context, itemIndex, `${label} must be a valid date.`);
	return parsed;
}

function validateAdvancedFilter(
	context: IExecuteFunctions,
	itemIndex: number,
	value: unknown,
): IDataObject {
	if (!isRecord(value))
		throw localError(context, itemIndex, 'Each alert filter must be an object.');
	const keys = Object.keys(value);
	if (keys.some((key) => ['__proto__', 'prototype', 'constructor'].includes(key))) {
		throw localError(context, itemIndex, 'Alert filters cannot contain prototype keys.');
	}
	const allowedKeys = new Set(['fieldId', 'isNegated', 'stringIn', 'stringEqual', 'dateTimeRange']);
	const unknown = keys.filter((key) => !allowedKeys.has(key));
	if (unknown.length > 0) {
		throw localError(context, itemIndex, `Unknown alert filter key: ${unknown.join(', ')}.`);
	}
	const fieldId = typeof value.fieldId === 'string' ? value.fieldId.trim() : '';
	const fieldComparators: Record<string, string> = {
		severity: 'stringIn',
		status: 'stringIn',
		analystVerdict: 'stringIn',
		createdAt: 'dateTimeRange',
		externalId: 'stringEqual',
		ticketId: 'stringEqual',
	};
	const expectedComparator = fieldComparators[fieldId];
	if (!expectedComparator)
		throw localError(
			context,
			itemIndex,
			`Unsupported alert filter field: ${fieldId || '(empty)'}.`,
		);
	const comparators = ['stringIn', 'stringEqual', 'dateTimeRange'].filter(
		(key) => value[key] !== undefined,
	);
	if (comparators.length !== 1 || comparators[0] !== expectedComparator) {
		throw localError(
			context,
			itemIndex,
			`Filter ${fieldId} must use exactly one ${expectedComparator} comparator.`,
		);
	}
	if (value.isNegated !== undefined && typeof value.isNegated !== 'boolean') {
		throw localError(context, itemIndex, 'Alert filter isNegated must be true or false.');
	}
	let comparator: IDataObject;
	if (expectedComparator === 'stringIn') {
		if (!isRecord(value.stringIn) || Object.keys(value.stringIn).some((key) => key !== 'values')) {
			throw localError(
				context,
				itemIndex,
				`Filter ${fieldId} has a malformed stringIn comparator.`,
			);
		}
		comparator = {
			values: parseStringValues(context, itemIndex, value.stringIn.values, `${fieldId} filter`),
		};
	} else if (expectedComparator === 'stringEqual') {
		if (
			!isRecord(value.stringEqual) ||
			Object.keys(value.stringEqual).some((key) => key !== 'value')
		) {
			throw localError(
				context,
				itemIndex,
				`Filter ${fieldId} has a malformed stringEqual comparator.`,
			);
		}
		const equalValue =
			typeof value.stringEqual.value === 'string' ? value.stringEqual.value.trim() : '';
		if (!equalValue)
			throw localError(context, itemIndex, `Filter ${fieldId} needs a non-empty value.`);
		comparator = { value: equalValue };
	} else {
		if (!isRecord(value.dateTimeRange)) {
			throw localError(
				context,
				itemIndex,
				'The createdAt filter has a malformed dateTimeRange comparator.',
			);
		}
		const rangeKeys = Object.keys(value.dateTimeRange);
		if (rangeKeys.some((key) => key !== 'start' && key !== 'end')) {
			throw localError(context, itemIndex, 'The createdAt filter contains an unknown range key.');
		}
		if (value.dateTimeRange.start === undefined && value.dateTimeRange.end === undefined) {
			throw localError(context, itemIndex, 'The createdAt filter needs a start or end date.');
		}
		const start =
			value.dateTimeRange.start === undefined
				? undefined
				: dateMillis(context, itemIndex, value.dateTimeRange.start, 'Created After');
		const end =
			value.dateTimeRange.end === undefined
				? undefined
				: dateMillis(context, itemIndex, value.dateTimeRange.end, 'Created Before');
		if (start !== undefined && end !== undefined && start > end) {
			throw localError(context, itemIndex, 'Created After cannot be later than Created Before.');
		}
		comparator = {
			...(start === undefined ? {} : { start }),
			...(end === undefined ? {} : { end }),
		};
	}
	return {
		fieldId,
		...(value.isNegated === undefined ? {} : { isNegated: value.isNegated }),
		[expectedComparator]: comparator,
	};
}

function buildFilters(
	context: IExecuteFunctions,
	itemIndex: number,
	input: unknown,
): IDataObject[] {
	if (input === undefined || input === null || input === '') return [];
	let value: unknown = input;
	if (typeof value === 'string') {
		try {
			value = JSON.parse(value) as unknown;
		} catch {
			throw localError(context, itemIndex, 'Filters must contain valid JSON.');
		}
	}
	if (Array.isArray(value))
		return value.map((filter) => validateAdvancedFilter(context, itemIndex, filter));
	if (!isRecord(value))
		throw localError(context, itemIndex, 'Filters must be a collection or an array.');
	const knownKeys = new Set([
		'severities',
		'statuses',
		'analystVerdicts',
		'createdAfter',
		'createdBefore',
		'externalId',
		'ticketId',
	]);
	const unknown = Object.keys(value).filter((key) => !knownKeys.has(key));
	if (unknown.length > 0)
		throw localError(context, itemIndex, `Unknown alert filter: ${unknown.join(', ')}.`);
	const result: IDataObject[] = [];
	for (const [parameterKey, fieldId] of [
		['severities', 'severity'],
		['statuses', 'status'],
		['analystVerdicts', 'analystVerdict'],
	] as const) {
		if (value[parameterKey] !== undefined) {
			result.push({
				fieldId,
				stringIn: {
					values: parseStringValues(context, itemIndex, value[parameterKey], parameterKey),
				},
			});
		}
	}
	if (value.createdAfter !== undefined || value.createdBefore !== undefined) {
		const start =
			value.createdAfter === undefined
				? undefined
				: dateMillis(context, itemIndex, value.createdAfter, 'Created After');
		const end =
			value.createdBefore === undefined
				? undefined
				: dateMillis(context, itemIndex, value.createdBefore, 'Created Before');
		if (start !== undefined && end !== undefined && start > end) {
			throw localError(context, itemIndex, 'Created After cannot be later than Created Before.');
		}
		result.push({
			fieldId: 'createdAt',
			dateTimeRange: {
				...(start === undefined ? {} : { start }),
				...(end === undefined ? {} : { end }),
			},
		});
	}
	for (const key of ['externalId', 'ticketId'] as const) {
		if (value[key] !== undefined) {
			const equalValue = typeof value[key] === 'string' ? value[key].trim() : '';
			if (!equalValue)
				throw localError(context, itemIndex, `${key} filter needs a non-empty value.`);
			result.push({ fieldId: key, stringEqual: { value: equalValue } });
		}
	}
	return result;
}

function assertConnection(
	context: IExecuteFunctions,
	itemIndex: number,
	root: unknown,
): { edges: unknown[]; hasNextPage: boolean; endCursor: unknown } {
	if (!isRecord(root) || !Array.isArray(root.edges) || !isRecord(root.pageInfo)) {
		throw apiError(context, itemIndex, 'SentinelOne returned a malformed alerts connection.');
	}
	if (typeof root.pageInfo.hasNextPage !== 'boolean') {
		throw apiError(context, itemIndex, 'SentinelOne returned malformed alert pagination data.');
	}
	return {
		edges: root.edges,
		hasNextPage: root.pageInfo.hasNextPage,
		endCursor: root.pageInfo.endCursor,
	};
}

export async function getUnifiedAlert(
	context: IExecuteFunctions,
	itemIndex: number,
): Promise<IDataObject[]> {
	const scope = readScope(context, itemIndex);
	const alertId = requiredId(context, itemIndex, 'alertId', 'Alert ID');
	const alert = await graphQlRequest(
		context,
		itemIndex,
		GRAPHQL_DOCUMENTS.getAlert,
		{ id: alertId, scope },
		'alert',
	);
	assertAlertInScope(context, itemIndex, alert, alertId, scope);
	return [alert as IDataObject];
}

export async function getManyUnifiedAlerts(
	context: IExecuteFunctions,
	itemIndex: number,
): Promise<IDataObject[]> {
	const scope = readScope(context, itemIndex);
	const returnAll = Boolean(context.getNodeParameter('returnAll', itemIndex));
	const rawLimit = returnAll
		? Number.POSITIVE_INFINITY
		: Number(context.getNodeParameter('limit', itemIndex));
	if (!returnAll && (!Number.isSafeInteger(rawLimit) || rawLimit < 1)) {
		throw localError(context, itemIndex, 'Limit must be a positive integer.');
	}
	const filters = buildFilters(
		context,
		itemIndex,
		context.getNodeParameter('filters', itemIndex, {}),
	);
	const alerts: IDataObject[] = [];
	const seenCursors = new Set<string>();
	let after: string | undefined;
	while (alerts.length < rawLimit) {
		const first = returnAll ? MAX_PAGE_SIZE : Math.min(MAX_PAGE_SIZE, rawLimit - alerts.length);
		const root = await graphQlRequest(
			context,
			itemIndex,
			GRAPHQL_DOCUMENTS.getManyAlerts,
			{
				first,
				...(after === undefined ? {} : { after }),
				scope,
				viewType: 'ALL',
				filters,
				sorts: [{ by: 'createdAt', order: 'DESC' }],
			},
			'alerts',
		);
		const page = assertConnection(context, itemIndex, root);
		if (
			returnAll &&
			(alerts.length + page.edges.length > MAX_RETURN_ALL_ALERTS ||
				(alerts.length + page.edges.length === MAX_RETURN_ALL_ALERTS && page.hasNextPage))
		) {
			throw localError(
				context,
				itemIndex,
				`Return All is limited to ${MAX_RETURN_ALL_ALERTS.toLocaleString('en-US')} alerts. Add filters or use a bounded Limit.`,
			);
		}
		if (page.edges.length === 0 && page.hasNextPage) {
			throw apiError(
				context,
				itemIndex,
				'SentinelOne returned an empty alert page that claims another page exists.',
			);
		}
		for (const edge of page.edges) {
			if (!isRecord(edge) || typeof edge.cursor !== 'string' || !edge.cursor.trim()) {
				throw apiError(context, itemIndex, 'SentinelOne returned a malformed alert edge.');
			}
			assertAlertInScope(context, itemIndex, edge.node, null, scope);
			alerts.push(edge.node as IDataObject);
			if (alerts.length >= rawLimit) break;
		}
		if (!page.hasNextPage || alerts.length >= rawLimit) break;
		const next = typeof page.endCursor === 'string' ? page.endCursor.trim() : '';
		if (!next)
			throw apiError(context, itemIndex, 'SentinelOne omitted the cursor for the next alert page.');
		if (seenCursors.has(next))
			throw apiError(context, itemIndex, 'SentinelOne repeated an alert pagination cursor.');
		seenCursors.add(next);
		after = next;
	}
	return alerts;
}

function scanTopLevelJsonKeys(json: string): string[] {
	const keys: string[] = [];
	let depth = 0;
	let inString = false;
	let escaped = false;
	let start = -1;
	for (let index = 0; index < json.length; index++) {
		const character = json[index];
		if (inString) {
			if (escaped) escaped = false;
			else if (character === '\\') escaped = true;
			else if (character === '"') {
				inString = false;
				if (depth === 1 && start >= 0) {
					let next = index + 1;
					while (/\s/.test(json[next] ?? '')) next++;
					if (json[next] === ':') {
						try {
							keys.push(JSON.parse(json.slice(start, index + 1)) as string);
						} catch {
							return [];
						}
					}
				}
			}
			continue;
		}
		if (character === '"') {
			inString = true;
			start = index;
		} else if (character === '{' || character === '[') depth++;
		else if (character === '}' || character === ']') depth--;
	}
	return keys;
}

function parseUpdateObject(
	context: IExecuteFunctions,
	itemIndex: number,
	value: unknown,
	label: string,
): Record<string, unknown> {
	if (value === undefined || value === null || value === '') return {};
	let parsed: unknown = value;
	if (typeof value === 'string') {
		const keys = scanTopLevelJsonKeys(value);
		if (new Set(keys).size !== keys.length) {
			throw localError(context, itemIndex, `${label} contains a duplicate key.`);
		}
		try {
			parsed = JSON.parse(value) as unknown;
		} catch {
			throw localError(context, itemIndex, `${label} must contain valid JSON.`);
		}
	}
	if (!isRecord(parsed)) throw localError(context, itemIndex, `${label} must be a JSON object.`);
	const keys = Object.keys(parsed);
	if (keys.some((key) => ['__proto__', 'prototype', 'constructor'].includes(key))) {
		throw localError(context, itemIndex, `${label} cannot contain prototype keys.`);
	}
	const unknown = keys.filter(
		(key) => !Object.prototype.hasOwnProperty.call(UPDATE_DEFINITIONS, key),
	);
	if (unknown.length > 0)
		throw localError(context, itemIndex, `Unknown alert update field: ${unknown.join(', ')}.`);
	return parsed;
}

function validateUpdateValues(
	context: IExecuteFunctions,
	itemIndex: number,
	guided: Record<string, unknown>,
	advanced: Record<string, unknown>,
): Record<string, string> {
	const collisions = Object.keys(guided).filter(
		(key) => guided[key] !== undefined && advanced[key] !== undefined,
	);
	if (collisions.length > 0) {
		throw localError(
			context,
			itemIndex,
			`Alert update fields are duplicated: ${collisions.join(', ')}.`,
		);
	}
	const combined = { ...guided, ...advanced };
	const result: Record<string, string> = {};
	for (const [key, rawValue] of Object.entries(combined)) {
		if (rawValue === undefined || rawValue === null) {
			throw localError(context, itemIndex, `${key} cannot be cleared.`);
		}
		if (typeof rawValue !== 'string')
			throw localError(context, itemIndex, `${key} must be a string.`);
		const value = rawValue.trim();
		if (!value) throw localError(context, itemIndex, `${key} cannot be empty or cleared.`);
		if (key === 'status' && !STATUS_VALUES.has(value)) {
			throw localError(context, itemIndex, `Unsupported alert status: ${value}.`);
		}
		if (key === 'analystVerdict' && !ANALYST_VERDICT_VALUES.has(value)) {
			throw localError(context, itemIndex, `Unsupported analyst verdict: ${value}.`);
		}
		result[key] = value;
	}
	if (Object.keys(result).length === 0)
		throw localError(context, itemIndex, 'Select at least one alert field to update.');
	return result;
}

function exactAlertFilter(alertId: string): IDataObject {
	return { or: [{ and: [{ fieldId: 'id', stringIn: { values: [alertId] } }] }] };
}

interface DiscoveredAction {
	id: string;
	isDisabled: boolean;
	types: string[];
	triggeredAfter: string[];
	triggersActions: string[];
	field: string;
}

function responseStringArray(
	context: IExecuteFunctions,
	itemIndex: number,
	value: unknown,
	label: string,
	allowNull = false,
): string[] {
	if (allowNull && (value === null || value === undefined)) return [];
	if (!Array.isArray(value))
		throw apiError(context, itemIndex, `SentinelOne returned malformed ${label}.`);
	const result = value.map(idString);
	if (result.some((entry) => entry === null)) {
		throw apiError(context, itemIndex, `SentinelOne returned malformed ${label}.`);
	}
	return result as string[];
}

function parseDiscoveredActions(
	context: IExecuteFunctions,
	itemIndex: number,
	root: unknown,
	requested: Record<string, string>,
): DiscoveredAction[] {
	if (!isRecord(root) || !Array.isArray(root.data)) {
		throw apiError(context, itemIndex, 'SentinelOne returned malformed available actions.');
	}
	if (root.errors !== undefined && root.errors !== null && !Array.isArray(root.errors)) {
		throw apiError(context, itemIndex, 'SentinelOne returned malformed available-action errors.');
	}
	if (Array.isArray(root.errors) && root.errors.length > 0) {
		throw apiError(context, itemIndex, 'SentinelOne rejected available-action discovery.');
	}
	const available: DiscoveredAction[] = [];
	const availableIds = new Set<string>();
	for (const value of root.data) {
		if (!isRecord(value))
			throw apiError(context, itemIndex, 'SentinelOne returned a malformed available action.');
		const id = idString(value.id);
		if (!id || typeof value.isDisabled !== 'boolean' || !Array.isArray(value.types)) {
			throw apiError(context, itemIndex, 'SentinelOne returned a malformed available action.');
		}
		if (availableIds.has(id))
			throw apiError(context, itemIndex, 'SentinelOne returned duplicate available actions.');
		availableIds.add(id);
		available.push({
			id,
			isDisabled: value.isDisabled,
			types: responseStringArray(context, itemIndex, value.types, 'available-action types'),
			triggeredAfter: responseStringArray(
				context,
				itemIndex,
				value.triggeredAfter,
				'available-action dependencies',
				true,
			),
			triggersActions: responseStringArray(
				context,
				itemIndex,
				value.triggersActions,
				'available-action transitive actions',
			),
			field: '',
		});
	}
	const selected: DiscoveredAction[] = [];
	for (const field of Object.keys(requested)) {
		const definition = UPDATE_DEFINITIONS[field];
		const matching = available.filter((action) => action.types.includes(definition.actionType));
		const enabled = matching.filter((action) => !action.isDisabled);
		if (enabled.length === 0)
			throw localError(
				context,
				itemIndex,
				`SentinelOne does not offer an enabled ${field} action for this alert.`,
			);
		if (enabled.length > 1) {
			throw localError(
				context,
				itemIndex,
				`SentinelOne returned more than one enabled ${field} action. Refusing an ambiguous update.`,
			);
		}
		const action = enabled[0];
		if (selected.some((entry) => entry.id === action.id)) {
			throw localError(
				context,
				itemIndex,
				'SentinelOne mapped several requested fields to the same runtime action. Refusing an ambiguous update.',
			);
		}
		selected.push({ ...action, field });
	}
	const selectedIds = new Set(selected.map((action) => action.id));
	for (const action of selected) {
		const transitiveCollision = action.triggersActions.find((id) => selectedIds.has(id));
		if (transitiveCollision) {
			throw localError(
				context,
				itemIndex,
				`SentinelOne action ${action.id} also triggers requested action ${transitiveCollision}; the update is ambiguous.`,
			);
		}
	}
	return selected;
}

function orderActions(
	context: IExecuteFunctions,
	itemIndex: number,
	actions: DiscoveredAction[],
): DiscoveredAction[] {
	const byId = new Map(actions.map((action) => [action.id, action]));
	const visiting = new Set<string>();
	const visited = new Set<string>();
	const ordered: DiscoveredAction[] = [];
	const visit = (action: DiscoveredAction): void => {
		if (visited.has(action.id)) return;
		if (visiting.has(action.id))
			throw localError(context, itemIndex, 'SentinelOne action dependencies contain a cycle.');
		visiting.add(action.id);
		for (const dependencyId of action.triggeredAfter) {
			const dependency = byId.get(dependencyId);
			if (dependency) visit(dependency);
		}
		visiting.delete(action.id);
		visited.add(action.id);
		ordered.push(action);
	};
	for (const action of actions) visit(action);
	return ordered;
}

function validateActionResultId(
	context: IExecuteFunctions,
	itemIndex: number,
	value: unknown,
	alertId: string,
): void {
	if (!isRecord(value) || idString(value.id) !== alertId) {
		throw apiError(
			context,
			itemIndex,
			'SentinelOne returned an action result for an unexpected alert.',
		);
	}
	value.id = alertId;
}

function parseImmediateActions(
	context: IExecuteFunctions,
	itemIndex: number,
	root: Record<string, unknown>,
	selected: DiscoveredAction[],
	alertId: string,
): IDataObject[] {
	if (!Array.isArray(root.actions))
		throw apiError(context, itemIndex, 'SentinelOne omitted immediate action results.');
	const byId = new Map<string, Record<string, unknown>>();
	for (const value of root.actions) {
		if (!isRecord(value))
			throw apiError(context, itemIndex, 'SentinelOne returned a malformed action result.');
		const actionId = idString(value.actionId);
		if (!actionId || byId.has(actionId))
			throw apiError(
				context,
				itemIndex,
				'SentinelOne returned duplicate or malformed action results.',
			);
		byId.set(actionId, value);
	}
	const expectedIds = new Set(selected.map((action) => action.id));
	if ([...byId.keys()].some((id) => !expectedIds.has(id))) {
		throw apiError(
			context,
			itemIndex,
			'SentinelOne returned a result for an action that was not requested.',
		);
	}
	return selected.map((action) => {
		const value = byId.get(action.id);
		if (!value)
			throw apiError(context, itemIndex, `SentinelOne omitted the result for action ${action.id}.`);
		for (const key of ['success', 'skip', 'failure']) {
			if (!Array.isArray(value[key]))
				throw apiError(context, itemIndex, `SentinelOne returned malformed ${key} results.`);
			for (const detail of value[key] as unknown[])
				validateActionResultId(context, itemIndex, detail, alertId);
		}
		const success = value.success as unknown[];
		const skip = value.skip as unknown[];
		const failure = value.failure as unknown[];
		if (success.length + skip.length + failure.length !== 1) {
			throw apiError(
				context,
				itemIndex,
				`SentinelOne returned conflicting or missing results for action ${action.id}.`,
			);
		}
		return {
			actionId: action.id,
			...(success.length === 1 ? { status: 'success', detail: success[0] as IDataObject } : {}),
			...(skip.length === 1 ? { status: 'skipped', detail: skip[0] as IDataObject } : {}),
			...(failure.length === 1 ? { status: 'failed', detail: failure[0] as IDataObject } : {}),
		};
	});
}

function readbackVerification(alert: IDataObject, requested: Record<string, string>): IDataObject {
	const verification: IDataObject = {};
	for (const [field, value] of Object.entries(requested)) {
		const observed = alert[field];
		verification[field] = {
			requested: value,
			observed: observed ?? null,
			verified: observed === value,
		};
	}
	return verification;
}

function allVerified(verification: IDataObject): boolean {
	return Object.values(verification).every((value) => isRecord(value) && value.verified === true);
}

function rethrowUnknownMutation(
	context: IExecuteFunctions,
	itemIndex: number,
	error: unknown,
): never {
	if (error instanceof NodeApiError || error instanceof NodeOperationError) {
		Object.assign(error, { mayHaveCommitted: true, outcome: 'unknown' });
		throw error;
	}
	throw apiError(
		context,
		itemIndex,
		'SentinelOne returned an unusable mutation response.',
		'The mutation was sent once and was not retried. SentinelOne may have committed it; verify the resource before trying again.',
		'500',
		true,
	);
}

export async function updateUnifiedAlert(
	context: IExecuteFunctions,
	itemIndex: number,
): Promise<IDataObject[]> {
	const scope = readScope(context, itemIndex);
	const alertId = requiredId(context, itemIndex, 'alertId', 'Alert ID');
	await getUnifiedAlert(context, itemIndex);
	const guided = parseUpdateObject(
		context,
		itemIndex,
		context.getNodeParameter('updateFields', itemIndex, {}),
		'Update Fields',
	);
	const advanced = parseUpdateObject(
		context,
		itemIndex,
		context.getNodeParameter('advancedUpdatePayload', itemIndex, {}),
		'Advanced Update Payload',
	);
	const requested = validateUpdateValues(context, itemIndex, guided, advanced);
	const filter = exactAlertFilter(alertId);
	const discoveryRoot = await graphQlRequest(
		context,
		itemIndex,
		GRAPHQL_DOCUMENTS.availableActions,
		{ scope, filter, viewType: 'ALL' },
		'alertAvailableActions',
	);
	const selected = orderActions(
		context,
		itemIndex,
		parseDiscoveredActions(context, itemIndex, discoveryRoot, requested),
	);
	const fieldByActionId = new Map(selected.map((action) => [action.id, action.field]));
	const actions = selected.map((action) => {
		const field = fieldByActionId.get(action.id);
		if (!field)
			throw localError(context, itemIndex, `No update field maps to action ${action.id}.`);
		const branch = UPDATE_DEFINITIONS[field].payloadBranch;
		return { id: action.id, payload: { [branch]: { value: requested[field] } } };
	});
	const mutationRoot = await graphQlRequest(
		context,
		itemIndex,
		GRAPHQL_DOCUMENTS.updateAlert,
		{ scope, filter, actions, viewType: 'ALL' },
		'alertTriggerActions',
		true,
	);
	try {
		if (!isRecord(mutationRoot) || typeof mutationRoot.__typename !== 'string') {
			throw apiError(context, itemIndex, 'SentinelOne returned a malformed update result.');
		}
		const reread = (await getUnifiedAlert(context, itemIndex))[0];
		const verification = readbackVerification(reread, requested);
		if (mutationRoot.__typename === 'TriggerActionsScheduled') {
			const executionId = idString(mutationRoot.executionId);
			const bulkActionTriggerId = idString(mutationRoot.bulkActionTriggerId);
			if (!executionId && !bulkActionTriggerId) {
				throw apiError(
					context,
					itemIndex,
					'SentinelOne scheduled the update without an execution ID.',
				);
			}
			return [
				{
					outcome: 'scheduled',
					alertId,
					executionId: executionId ?? null,
					bulkActionTriggerId: bulkActionTriggerId ?? null,
					requested,
					verification,
				},
			];
		}
		if (mutationRoot.__typename === 'TriggerActionsError') {
			if (!Array.isArray(mutationRoot.errors) || mutationRoot.errors.length === 0) {
				throw apiError(context, itemIndex, 'SentinelOne returned a malformed update rejection.');
			}
			return [
				{
					outcome: 'rejected',
					alertId,
					requested,
					errors: mutationRoot.errors as IDataObject[],
					verification,
				},
			];
		}
		if (mutationRoot.__typename !== 'ActionsTriggered') {
			throw apiError(
				context,
				itemIndex,
				`SentinelOne returned an unknown update result type: ${mutationRoot.__typename}.`,
			);
		}
		const results = parseImmediateActions(context, itemIndex, mutationRoot, selected, alertId);
		let complete = allVerified(verification);
		for (const result of results) {
			if (result.status === 'failed') complete = false;
			if (result.status === 'skipped') {
				const detail = isRecord(result.detail) ? result.detail : {};
				const field = fieldByActionId.get(String(result.actionId));
				const fieldVerification =
					field && isRecord(verification[field]) ? verification[field] : null;
				if (detail.skipType !== 'NO_CHANGE' || fieldVerification?.verified !== true)
					complete = false;
			}
		}
		return [
			{
				outcome: complete ? 'complete' : 'partial',
				alertId,
				requested,
				results,
				verification,
				alert: reread,
			},
		];
	} catch (error) {
		rethrowUnknownMutation(context, itemIndex, error);
	}
}

function parseNote(
	context: IExecuteFunctions,
	itemIndex: number,
	value: unknown,
	alertId: string,
): IDataObject {
	if (!isRecord(value))
		throw apiError(context, itemIndex, 'SentinelOne returned a malformed alert note.');
	const id = idString(value.id);
	const returnedAlertId = idString(value.alertId);
	if (!id || returnedAlertId !== alertId || typeof value.text !== 'string') {
		throw apiError(context, itemIndex, 'SentinelOne returned a malformed alert note.');
	}
	if (typeof value.createdAt !== 'string' || typeof value.updatedAt !== 'string') {
		throw apiError(context, itemIndex, 'SentinelOne returned malformed alert note timestamps.');
	}
	if (
		value.type !== null &&
		value.type !== 'PLAIN_TEXT' &&
		value.type !== 'MARKDOWN' &&
		value.type !== 'HTML'
	) {
		throw apiError(context, itemIndex, 'SentinelOne returned an unknown alert note content type.');
	}
	let createdBy: IDataObject | null = null;
	if (value.createdBy !== null && value.createdBy !== undefined) {
		if (!isRecord(value.createdBy) || typeof value.createdBy.__typename !== 'string') {
			throw apiError(context, itemIndex, 'SentinelOne returned a malformed alert note author.');
		}
		if (value.createdBy.__typename === 'UserNoteAuthor') {
			const userId = idString(value.createdBy.userId);
			if (
				!userId ||
				typeof value.createdBy.email !== 'string' ||
				typeof value.createdBy.fullName !== 'string'
			) {
				throw apiError(context, itemIndex, 'SentinelOne returned a malformed user note author.');
			}
			createdBy = {
				__typename: 'UserNoteAuthor',
				userId,
				email: value.createdBy.email,
				fullName: value.createdBy.fullName,
			};
		} else if (value.createdBy.__typename === 'RuleNoteAuthor') {
			const ruleId = idString(value.createdBy.id);
			const version = value.createdBy.version;
			if (
				!ruleId ||
				typeof value.createdBy.name !== 'string' ||
				typeof version !== 'number' ||
				!Number.isInteger(version)
			) {
				throw apiError(context, itemIndex, 'SentinelOne returned a malformed rule note author.');
			}
			createdBy = { __typename: 'RuleNoteAuthor', id: ruleId, name: value.createdBy.name, version };
		} else {
			throw apiError(
				context,
				itemIndex,
				`SentinelOne returned an unsupported note author type: ${value.createdBy.__typename}.`,
			);
		}
	}
	return { ...value, id, alertId: returnedAlertId, createdBy } as IDataObject;
}

async function readAlertNotes(
	context: IExecuteFunctions,
	itemIndex: number,
	alertId: string,
): Promise<IDataObject[]> {
	const root = await graphQlRequest(
		context,
		itemIndex,
		GRAPHQL_DOCUMENTS.getAlertNotes,
		{ alertId },
		'alertNotes',
	);
	if (!isRecord(root) || !Array.isArray(root.data)) {
		throw apiError(context, itemIndex, 'SentinelOne returned malformed alert note data.');
	}
	return root.data.map((note) => parseNote(context, itemIndex, note, alertId));
}

export async function getManyAlertNotes(
	context: IExecuteFunctions,
	itemIndex: number,
): Promise<IDataObject[]> {
	const alertId = requiredId(context, itemIndex, 'alertId', 'Alert ID');
	await getUnifiedAlert(context, itemIndex);
	const notes = await readAlertNotes(context, itemIndex, alertId);
	const returnAll = Boolean(context.getNodeParameter('returnAll', itemIndex, false));
	if (returnAll) return notes;
	const limit = Number(context.getNodeParameter('limit', itemIndex, 50));
	if (!Number.isSafeInteger(limit) || limit < 1) {
		throw localError(context, itemIndex, 'Limit must be a positive integer.');
	}
	return notes.slice(0, limit);
}

function readContentType(context: IExecuteFunctions, itemIndex: number): 'PLAIN_TEXT' | 'MARKDOWN' {
	const value = String(context.getNodeParameter('contentType', itemIndex) ?? '').toUpperCase();
	if (value === 'PLAIN_TEXT' || value === 'PLAINTEXT' || value === 'PLAIN TEXT')
		return 'PLAIN_TEXT';
	if (value === 'MARKDOWN') return 'MARKDOWN';
	throw localError(context, itemIndex, 'Content Type must be Plain Text or Markdown.');
}

export async function createAlertNote(
	context: IExecuteFunctions,
	itemIndex: number,
): Promise<IDataObject[]> {
	const alertId = requiredId(context, itemIndex, 'alertId', 'Alert ID');
	const text = context.getNodeParameter('text', itemIndex);
	if (typeof text !== 'string' || text.length === 0 || text.length > 20_000) {
		throw localError(context, itemIndex, 'Note text must contain between 1 and 20,000 characters.');
	}
	const type = readContentType(context, itemIndex);
	await getUnifiedAlert(context, itemIndex);
	const before = await readAlertNotes(context, itemIndex, alertId);
	const root = await graphQlRequest(
		context,
		itemIndex,
		GRAPHQL_DOCUMENTS.createAlertNote,
		{ alertId, text, type },
		'addAlertNote',
		true,
	);
	try {
		if (!isRecord(root) || !Array.isArray(root.data)) {
			throw apiError(context, itemIndex, 'SentinelOne returned malformed created-note data.');
		}
		const after = root.data.map((note) => parseNote(context, itemIndex, note, alertId));
		const beforeIds = new Set(before.map((note) => String(note.id)));
		const afterIds = new Set(after.map((note) => String(note.id)));
		const completeSnapshot = [...beforeIds].every((id) => afterIds.has(id));
		const candidates = after.filter(
			(note) =>
				!beforeIds.has(String(note.id)) &&
				note.alertId === alertId &&
				note.text === text &&
				note.type === type,
		);
		let identification: IDataObject;
		if (completeSnapshot && candidates.length === 1) {
			identification = {
				status: 'inferred',
				evidence: 'single_new_id_matching_alert_text_and_type',
				note: candidates[0],
			};
		} else {
			identification = {
				status: 'ambiguous',
				reason: !completeSnapshot
					? 'after_snapshot_incomplete'
					: candidates.length === 0
						? 'no_new_candidate'
						: 'multiple_new_candidates',
				candidates,
			};
		}
		return [
			{
				outcome: 'acknowledged',
				mutationAcknowledged: true,
				alertId,
				contentType: type,
				identification,
				notes: after,
			},
		];
	} catch (error) {
		rethrowUnknownMutation(context, itemIndex, error);
	}
}
