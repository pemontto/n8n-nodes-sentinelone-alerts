import type {
	IDataObject,
	ILoadOptionsFunctions,
	INodeExecutionData,
	INodePropertyOptions,
	INodeType,
	INodeTypeDescription,
	IPollFunctions,
} from 'n8n-workflow';
import { NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';

import {
	loadScopeOptions,
	discoverVisibleScopes,
	isScopePermissionError,
	pollSentinelOne,
	type AuthenticatedRequest,
	type ScopeDiscoveryFilters,
	type ScopeType,
	type TriggerConfig,
	type TriggerEvent,
	type TriggerState,
} from './SentinelOneTriggerHelpers';

import { additionalAlertFieldOptions, DEFAULT_ADDITIONAL_ALERT_FIELDS } from './AlertFields';
import { activityAccountIds } from './ActivityScope';
import { pollActivityNotes } from './ActivityNotePoll';

const activePollKeys = new Set<string>();

function normalizeBaseUrl(value: unknown): string {
	return String(value ?? '')
		.trim()
		.replace(/\/+$/, '');
}

function readStringArray(context: IPollFunctions | ILoadOptionsFunctions, name: string): string[] {
	return (context.getNodeParameter(name, []) as Array<string | number>).map(String);
}

function credentialIdentity(context: IPollFunctions): IDataObject {
	const credentials = context.getNode().credentials as IDataObject | undefined;
	const selected = credentials?.sentinelOneAlertsApi as IDataObject | undefined;
	return {
		type: 'sentinelOneAlertsApi',
		id: selected?.id ?? null,
	};
}

function authenticatedRequest(
	context: IPollFunctions | ILoadOptionsFunctions,
): AuthenticatedRequest {
	return async (options) =>
		await context.helpers.httpRequestWithAuthentication.call(
			context,
			'sentinelOneAlertsApi',
			options,
		);
}

async function scopeOptions(
	context: IPollFunctions | ILoadOptionsFunctions,
	scopeType: ScopeType,
	filters: ScopeDiscoveryFilters = {},
): Promise<INodePropertyOptions[]> {
	const credentials = await context.getCredentials('sentinelOneAlertsApi');
	const baseUrl = normalizeBaseUrl(credentials.baseUrl);
	try {
		return await loadScopeOptions(authenticatedRequest(context), baseUrl, scopeType, filters);
	} catch (error) {
		throw new NodeOperationError(
			context.getNode(),
			`Unable to load SentinelOne ${scopeType.toLowerCase()} scopes. Check the credential permissions and try again. ${(error as Error).message}`,
		);
	}
}

async function validateSelectedScopes(
	context: IPollFunctions | ILoadOptionsFunctions,
	scopeType: ScopeType,
	selectedIds: string[],
	filters: ScopeDiscoveryFilters,
): Promise<void> {
	const options = await scopeOptions(context, scopeType, filters);
	const visibleIds = new Set(options.map((option) => String(option.value)));
	const missingIds = selectedIds.filter((id) => !visibleIds.has(id));
	if (missingIds.length === 0) return;
	throw new NodeOperationError(
		context.getNode(),
		`The selected ${scopeType.toLowerCase()} scope no longer belongs to the selected parent scope or is not visible to this credential. Reload the scope fields and try again.`,
	);
}

export class SentinelOneAlertsTrigger implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'SentinelOne Alerts Trigger',
		name: 'sentinelOneAlertsTrigger',
		icon: { light: 'file:sentinelone.svg', dark: 'file:sentinelone.dark.svg' },
		group: ['trigger'],
		version: 1,
		subtitle:
			'={{$parameter["resource"] === "alertNote" ? "Alert note: Created" : "Alert: " + ({new: "New", newOrUpdated: "New or updated", updated: "Updated"}[$parameter["operation"]] || "New")}}',
		description: 'Starts the workflow when selected SentinelOne Unified Alerts events are found',
		defaults: {
			name: 'SentinelOne Alerts Trigger',
		},
		inputs: [],
		outputs: [NodeConnectionTypes.Main],
		polling: true,
		credentials: [
			{
				name: 'sentinelOneAlertsApi',
				required: true,
			},
		],
		properties: [
			{
				displayName: 'Debug',
				name: 'nodeDebug',
				type: 'boolean',
				isNodeSetting: true,
				default: false,
				noDataExpression: true,
				description: 'Whether to write sanitized request and polling details to the n8n log',
			},
			{
				displayName: 'Resource',
				name: 'resource',
				type: 'options',
				noDataExpression: true,
				default: 'alert',
				options: [
					{ name: 'Alert', value: 'alert' },
					{ name: 'Alert Note', value: 'alertNote' },
				],
			},
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				default: 'new',
				displayOptions: { show: { resource: ['alert'] } },
				options: [
					{
						name: 'New',
						value: 'new',
						description: 'Emit an alert once when its ID is first found',
						action: 'Trigger on new alerts',
					},
					{
						name: 'New or Updated',
						value: 'newOrUpdated',
						description:
							'Emit new alerts and the latest changed state observed for existing alerts',
						action: 'Trigger on new or updated alerts',
					},
					{
						name: 'Updated',
						value: 'updated',
						description:
							'Emit the latest changed state observed when an existing alert update time advances',
						action: 'Trigger on updated alerts',
					},
				],
			},
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				default: 'created',
				displayOptions: { show: { resource: ['alertNote'] } },
				options: [
					{
						name: 'Created',
						value: 'created',
						description: 'Emit newly created notes discovered through SDL ActivityFeed',
						action: 'Trigger on created alert notes',
					},
				],
			},
			{
				displayName:
					'New notes are discovered through SDL ActivityFeed. Parent alert updates are not required. The credential needs SDL query access.',
				name: 'noteActivityFeedNotice',
				type: 'notice',
				default: '',
				displayOptions: { show: { resource: ['alertNote'] } },
			},
			{
				displayName: 'Account Names or IDs',
				name: 'accountIds',
				type: 'multiOptions',
				default: [],
				hint: 'Optional. Leave empty to poll all credential-visible accounts.',
				typeOptions: {
					loadOptionsMethod: 'getAccounts',
				},
				description:
					'Choose from the list, or specify IDs using an <a href="https://docs.n8n.io/code/expressions/">expression</a>',
			},
			{
				displayName: 'Site Names or IDs',
				name: 'siteIds',
				type: 'multiOptions',
				default: [],
				hint: 'Optional. Leave empty to keep the account scope; otherwise choose accessible sites.',
				typeOptions: {
					loadOptionsMethod: 'getSites',
					loadOptionsDependsOn: ['accountIds'],
				},
				description:
					'Choose from the list, or specify IDs using an <a href="https://docs.n8n.io/code/expressions/">expression</a>',
			},
			{
				displayName: 'Group Names or IDs',
				name: 'groupIds',
				type: 'multiOptions',
				default: [],
				hint: 'Optional. Leave empty to use the selected sites.',
				typeOptions: {
					loadOptionsMethod: 'getGroups',
					loadOptionsDependsOn: ['siteIds'],
				},
				displayOptions: {
					show: {
						siteIds: [{ _cnd: { exists: true } }],
					},
				},
				description:
					'Choose from the list, or specify IDs using an <a href="https://docs.n8n.io/code/expressions/">expression</a>',
			},
			{
				displayName: 'Options',
				name: 'options',
				type: 'collection',
				placeholder: 'Add Option',
				default: {},
				displayOptions: { show: { resource: ['alert'] } },
				options: [
					{
						displayName: 'Additional Alert Fields',
						name: 'additionalAlertFields',
						type: 'multiOptions',
						default: [...DEFAULT_ADDITIONAL_ALERT_FIELDS],
						options: additionalAlertFieldOptions,
						description:
							'Extra alert fields to query and return, in addition to the standard event and scope fields',
					},
					{
						displayName: 'Advanced Filters',
						name: 'advancedFilters',
						type: 'json',
						default: '[]',
						description:
							'Add custom SentinelOne filters as JSON. Use an array to require every filter, or use or groups when any group may match. Severity, status, name, and time filters still apply.',
					},
					{
						displayName: 'Alert Name',
						name: 'alertName',
						type: 'string',
						default: '',
						placeholder: 'Suspicious process',
						description: 'Optional full-text match against the SentinelOne alert name',
					},
					{
						displayName: 'Exclude Account Name',
						name: 'excludeAccountName',
						type: 'string',
						default: '',
						placeholder: 'demo|test',
						description:
							'Case-insensitive exclusion regex. Leave empty to disable. Missing names are kept. See the README for supported syntax.',
					},
					{
						displayName: 'Exclude Group Name',
						name: 'excludeGroupName',
						type: 'string',
						default: '',
						placeholder: 'demo|test',
						description:
							'Case-insensitive exclusion regex. Leave empty to disable. Missing names are kept. See the README for supported syntax.',
					},
					{
						displayName: 'Exclude Site Name',
						name: 'excludeSiteName',
						type: 'string',
						default: '',
						placeholder: 'demo|test',
						description:
							'Case-insensitive exclusion regex. Leave empty to disable. Missing names are kept. See the README for supported syntax.',
					},
					{
						displayName: 'Include SentinelOne OCSF',
						name: 'includeOcsf',
						type: 'boolean',
						default: false,
						description:
							'Whether to add the documented SentinelOne OCSF field subset as an ocsf object. Requires an extra detail request per alert. This is not a complete standard OCSF event.',
					},
					{
						displayName: 'Severity',
						name: 'severities',
						type: 'multiOptions',
						default: [],
						options: [
							{ name: 'Critical', value: 'CRITICAL' },
							{ name: 'High', value: 'HIGH' },
							{ name: 'Informational', value: 'INFO' },
							{ name: 'Low', value: 'LOW' },
							{ name: 'Medium', value: 'MEDIUM' },
							{ name: 'Unknown', value: 'UNKNOWN' },
						],
						description: 'Limit alerts to the selected severities',
					},
					{
						displayName: 'Simplify',
						name: 'simplifyOutput',
						type: 'boolean',
						default: true,
						description:
							'Whether to return a simplified version of the response instead of the raw data',
					},
					{
						displayName: 'Status',
						name: 'statuses',
						type: 'multiOptions',
						default: [],
						options: [
							{ name: 'In Progress', value: 'IN_PROGRESS' },
							{ name: 'New', value: 'NEW' },
							{ name: 'Resolved', value: 'RESOLVED' },
						],
						description: 'Limit alerts to the selected statuses',
					},
				],
			},
			{
				displayName: 'Options',
				name: 'options',
				type: 'collection',
				placeholder: 'Add Option',
				default: {},
				displayOptions: { show: { resource: ['alertNote'] } },
				options: [
					{
						displayName: 'Alert Name',
						name: 'alertName',
						type: 'string',
						default: '',
						placeholder: 'Suspicious process',
						description: 'Optional full-text match against the SentinelOne alert name',
					},
					{
						displayName: 'Exclude Account Name',
						name: 'excludeAccountName',
						type: 'string',
						default: '',
						placeholder: 'demo|test',
						description:
							'Case-insensitive exclusion regex. Leave empty to disable. Missing names are kept. See the README for supported syntax.',
					},
					{
						displayName: 'Exclude Group Name',
						name: 'excludeGroupName',
						type: 'string',
						default: '',
						placeholder: 'demo|test',
						description:
							'Case-insensitive exclusion regex. Leave empty to disable. Missing names are kept. See the README for supported syntax.',
					},
					{
						displayName: 'Exclude Note Author Name',
						name: 'excludeNoteAuthorName',
						type: 'string',
						default: '',
						placeholder: 'automation|integration',
						description:
							'Case-insensitive exclusion regex for the SDL user name. Leave empty to disable. Missing names are kept. See the README for supported syntax.',
					},
					{
						displayName: 'Exclude Site Name',
						name: 'excludeSiteName',
						type: 'string',
						default: '',
						placeholder: 'demo|test',
						description:
							'Case-insensitive exclusion regex. Leave empty to disable. Missing names are kept. See the README for supported syntax.',
					},
					{
						displayName: 'Severity',
						name: 'severities',
						type: 'multiOptions',
						default: [],
						options: [
							{ name: 'Critical', value: 'CRITICAL' },
							{ name: 'High', value: 'HIGH' },
							{ name: 'Informational', value: 'INFO' },
							{ name: 'Low', value: 'LOW' },
							{ name: 'Medium', value: 'MEDIUM' },
							{ name: 'Unknown', value: 'UNKNOWN' },
						],
						description: 'Limit candidate alerts to the selected severities',
					},
					{
						displayName: 'Simplify',
						name: 'simplifyOutput',
						type: 'boolean',
						default: true,
						description:
							'Whether to return a simplified version of the response instead of the raw data',
					},
					{
						displayName: 'Status',
						name: 'statuses',
						type: 'multiOptions',
						default: [],
						options: [
							{ name: 'In Progress', value: 'IN_PROGRESS' },
							{ name: 'New', value: 'NEW' },
							{ name: 'Resolved', value: 'RESOLVED' },
						],
						description: 'Limit candidate alerts to the selected statuses',
					},
				],
			},
		],
	};

	methods = {
		loadOptions: {
			async getAccounts(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
				const credentials = await this.getCredentials('sentinelOneAlertsApi');
				try {
					return await loadScopeOptions(
						authenticatedRequest(this),
						normalizeBaseUrl(credentials.baseUrl),
						'ACCOUNT',
					);
				} catch (error) {
					if (isScopePermissionError(error)) return [];
					throw new NodeOperationError(
						this.getNode(),
						'Unable to load SentinelOne accounts. Check the credential and try again.',
					);
				}
			},
			async getSites(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
				const accountIds = readStringArray(this, 'accountIds');
				return await scopeOptions(this, 'SITE', { accountIds });
			},
			async getGroups(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
				const accountIds = readStringArray(this, 'accountIds');
				const siteIds = readStringArray(this, 'siteIds');
				if (siteIds.length === 0) return [];
				return await scopeOptions(this, 'GROUP', { accountIds, siteIds });
			},
		},
	};

	async poll(this: IPollFunctions): Promise<INodeExecutionData[][] | null> {
		const node = this.getNode();
		const pollKey = `${this.getWorkflow().id}:${node.id}`;
		if (activePollKeys.has(pollKey)) {
			this.logger.warn('[SentinelOne Alerts Trigger] Skipping overlapping poll');
			return null;
		}
		activePollKeys.add(pollKey);
		try {
			const credentials = await this.getCredentials('sentinelOneAlertsApi');
			const options = this.getNodeParameter('options', {}) as IDataObject;
			const nodeDebug = this.getNodeParameter('nodeDebug', options.debug === true) === true;
			const staticData = this.getWorkflowStaticData('node');
			const previousState = (staticData.sentinelOneTrigger as TriggerState | undefined) ?? {};

			try {
				const baseUrl = normalizeBaseUrl(credentials.baseUrl);
				const resource = this.getNodeParameter('resource') as 'alert' | 'alertNote';
				const operation = this.getNodeParameter('operation') as
					| 'created'
					| 'new'
					| 'newOrUpdated'
					| 'updated';
				const events: TriggerEvent[] =
					resource === 'alertNote'
						? ['alert.note.created']
						: operation === 'newOrUpdated'
							? ['alert.new', 'alert.updated']
							: operation === 'updated'
								? ['alert.updated']
								: ['alert.new'];
				const accountIds = readStringArray(this, 'accountIds');
				const siteIds = readStringArray(this, 'siteIds');
				const groupIds = siteIds.length > 0 ? readStringArray(this, 'groupIds') : [];
				const allVisibleAccounts =
					accountIds.length === 0 && siteIds.length === 0 && groupIds.length === 0;
				if (accountIds.length > 0) {
					await validateSelectedScopes(this, 'ACCOUNT', accountIds, { accountIds });
				}
				if (siteIds.length > 0) {
					await validateSelectedScopes(this, 'SITE', siteIds, { accountIds, siteIds });
				}
				if (groupIds.length > 0) {
					await validateSelectedScopes(this, 'GROUP', groupIds, {
						accountIds,
						siteIds,
						groupIds,
					});
				}
				let scopeType: ScopeType;
				let scopeIds: string[];
				if (groupIds.length > 0) {
					scopeType = 'GROUP';
					scopeIds = groupIds;
				} else if (siteIds.length > 0) {
					scopeType = 'SITE';
					scopeIds = siteIds;
				} else if (accountIds.length > 0) {
					scopeType = 'ACCOUNT';
					scopeIds = accountIds;
				} else {
					({ scopeType, scopeIds } = await discoverVisibleScopes(
						authenticatedRequest(this),
						baseUrl,
						node,
					));
				}
				if (scopeIds.length === 0) {
					throw new NodeOperationError(
						this.getNode(),
						'No credential-visible account or site scopes were found.',
					);
				}
				const config: TriggerConfig = {
					baseUrl,
					credentialIdentity: credentialIdentity(this),
					scopeType,
					scopeIds,
					noteAccountIds:
						resource === 'alertNote'
							? await activityAccountIds(authenticatedRequest(this), baseUrl, scopeType, scopeIds)
							: undefined,
					allVisibleAccounts,
					events,
					severities: (options.severities as string[] | undefined) ?? [],
					statuses: (options.statuses as string[] | undefined) ?? [],
					alertName: String(options.alertName ?? ''),
					advancedFilters: options.advancedFilters,
					additionalAlertFields:
						resource === 'alert'
							? ((options.additionalAlertFields as string[] | undefined) ??
								DEFAULT_ADDITIONAL_ALERT_FIELDS)
							: undefined,
					excludeAccountName: String(options.excludeAccountName ?? ''),
					excludeSiteName: String(options.excludeSiteName ?? ''),
					excludeGroupName: String(options.excludeGroupName ?? ''),
					excludeNoteAuthorName:
						resource === 'alertNote' ? String(options.excludeNoteAuthorName ?? '') : '',
					simplifyOutput: options.simplifyOutput !== false,
					includeOcsf: resource === 'alert' && options.includeOcsf === true,
					debug: nodeDebug,
					debugLog: nodeDebug
						? (message, details = {}) =>
								this.logger.debug(
									`[SentinelOne Alerts Trigger] ${message} ${JSON.stringify(details)}`,
								)
						: undefined,
					overlapSeconds: 300,
					alertLookbackDays: 1,
					concurrentRequests: 5,
					requestTimeoutMs: 30_000,
					alertPageSize: 200,
					maxAlertPages: 25,
					timelinePageSize: 100,
					maxTimelinePages: 100,
				};
				const result = await (resource === 'alertNote' ? pollActivityNotes : pollSentinelOne)(
					authenticatedRequest(this),
					config,
					previousState,
					this.getMode() === 'manual' ? 'manual' : 'scheduled',
					Date.now(),
				);
				if (result.nextState) staticData.sentinelOneTrigger = result.nextState;
				if (result.items.length === 0) return null;
				return [this.helpers.returnJsonArray(result.items)];
			} catch (error) {
				throw new NodeOperationError(
					this.getNode(),
					`Unable to poll SentinelOne Unified Alerts. ${(error as Error).message}`,
				);
			}
		} finally {
			activePollKeys.delete(pollKey);
		}
	}
}
