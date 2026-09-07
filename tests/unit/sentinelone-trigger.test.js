const assert = require('node:assert/strict');
const { existsSync, readFileSync } = require('node:fs');
const { join, resolve } = require('node:path');
const test = require('node:test');

const packageRoot = resolve('.');
const builtHelpers = join(
	packageRoot,
	'dist/nodes/SentinelOneAlertsTrigger/SentinelOneTriggerHelpers.js',
);
const builtNode = join(
	packageRoot,
	'dist/nodes/SentinelOneAlertsTrigger/SentinelOneAlertsTrigger.node.js',
);
const sourceHelpers = join(
	packageRoot,
	'nodes/SentinelOneAlertsTrigger/SentinelOneTriggerHelpers.ts',
);

const {
	MAX_SEEN_ALERT_IDS,
	MAX_SEEN_ALERT_VERSIONS,
	MAX_SEEN_NOTE_IDS,
	MAX_SCOPE_IDS_PER_QUERY,
	fingerprintConfig,
	loadScopeOptions,
	pollSentinelOne,
} = require(existsSync(builtHelpers) ? builtHelpers : sourceHelpers);
const { SentinelOneAlertsTrigger } = existsSync(builtNode) ? require(builtNode) : {};

const NOW = Date.parse('2026-08-26T12:00:00.000Z');

function config(overrides = {}) {
	return {
		baseUrl: 'https://tenant.example',
		credentialIdentity: { type: 'sentinelOneAlertsApi', id: 'credential-1', name: 'Tenant' },
		scopeType: 'ACCOUNT',
		scopeIds: ['account-1'],
		allVisibleAccounts: false,
		events: ['alert.new'],
		severities: [],
		statuses: [],
		alertName: '',
		simplifyOutput: false,
		debug: false,
		overlapSeconds: 300,
		alertLookbackDays: 1,
		concurrentRequests: 5,
		requestTimeoutMs: 30_000,
		alertPageSize: 200,
		maxAlertPages: 25,
		timelinePageSize: 100,
		maxTimelinePages: 25,
		...overrides,
	};
}

function initializedState(triggerConfig, overrides = {}) {
	return {
		configFingerprint: fingerprintConfig(triggerConfig),
		initialized: true,
		checkpointMs: NOW - 60_000,
		seenAlertIds: [],
		seenAlertVersions: [],
		seenNoteIds: [],
		...overrides,
	};
}

function alert(id, createdAt = '2026-08-26T11:59:00.000Z', updatedAt = createdAt) {
	return {
		id,
		externalId: `external-${id}`,
		name: `Alert ${id}`,
		severity: 'HIGH',
		status: 'NEW',
		createdAt,
		updatedAt,
		detectedAt: createdAt,
		firstSeenAt: createdAt,
		lastSeenAt: updatedAt,
		noteExists: false,
		realTime: {
			scope: {
				account: { id: 'account-1', name: 'Account One' },
				site: { id: 'site-1', name: 'Site One' },
				group: { id: 'group-1', name: 'Group One' },
			},
		},
	};
}

function alertWithNotes(id, createdAt = '2026-08-26T11:59:00.000Z', updatedAt = createdAt) {
	return { ...alert(id, createdAt, updatedAt), noteExists: true };
}

function alertResponse(alerts, pageInfo = { hasNextPage: false, endCursor: null }) {
	return {
		data: {
			alerts: {
				edges: alerts.map((node) => ({ node })),
				pageInfo,
			},
		},
	};
}

function note(id, actionType = 'CREATE', createdAt = '2026-08-26T11:59:30.000Z') {
	return {
		createdAt,
		eventText: `Note ${actionType.toLowerCase()}`,
		eventType: 'NOTE',
		timelineItemData: {
			__typename: 'NoteTimelineItemData',
			id,
			actionType,
			updatedAt: createdAt,
			text: { content: `Content ${id}`, type: 'PLAIN_TEXT' },
			createdBy: {
				__typename: 'UserNoteAuthor',
				userId: 'user-1',
				fullName: 'Example Analyst',
				email: 'analyst@example.com',
			},
		},
	};
}

function timelineResponse(items, pageInfo = { hasNextPage: false, endCursor: null }) {
	return {
		data: {
			alertTimeline: {
				edges: items.map((node) => ({ node })),
				pageInfo,
			},
		},
	};
}

function queryVariables(options) {
	return options.body.variables;
}

function createNodeContext(params, request, mode = 'manual') {
	const staticData = {};
	return {
		staticData,
		logger: { debug: () => {}, warn: () => {} },
		helpers: {
			httpRequestWithAuthentication: async (_credentialName, options) => await request(options),
			returnJsonArray: (items) => items.map((json) => ({ json })),
		},
		getCredentials: async () => ({ baseUrl: 'https://tenant.example', apiToken: 'hidden' }),
		getMode: () => mode,
		getNode: () => ({
			id: 'node-1',
			credentials: { sentinelOneAlertsApi: { id: 'credential-1', name: 'Tenant' } },
		}),
		getNodeParameter: (name, fallback) => params[name] ?? fallback,
		getWorkflowStaticData: () => staticData,
		getWorkflow: () => ({ id: 'workflow-1' }),
	};
}

test('scope discovery drains REST cursors and parses each envelope', async () => {
	const accountCalls = [];
	const accountOptions = await loadScopeOptions(
		async (options) => {
			accountCalls.push(options);
			if (!options.qs.cursor) {
				return { data: [{ id: '2', name: 'Zulu' }], pagination: { nextCursor: 'account-next' } };
			}
			return { data: [{ id: '1', name: 'Alpha' }], pagination: { nextCursor: null } };
		},
		'https://tenant.example',
		'ACCOUNT',
	);
	assert.deepEqual(accountOptions, [
		{ name: 'Alpha', value: '1' },
		{ name: 'Zulu', value: '2' },
	]);
	assert.equal(accountCalls[0].qs.limit, 1000);
	assert.equal(accountCalls[0].qs.states, 'active');
	assert.equal(accountCalls[0].timeout, 30_000);
	assert.equal(accountCalls[1].qs.cursor, 'account-next');

	let siteRequest;
	const siteOptions = await loadScopeOptions(
		async (options) => {
			siteRequest = options;
			return {
				data: {
					sites: [{ id: 90071992547409931234n.toString(), name: 'Paris', accountName: 'Acme' }],
				},
				pagination: { nextCursor: null },
			};
		},
		'https://tenant.example',
		'SITE',
		{ accountIds: ['account-1', 'account-2'] },
	);
	assert.deepEqual(siteOptions, [{ name: 'Acme / Paris', value: '90071992547409931234' }]);
	assert.equal(siteRequest.qs.accountIds, 'account-1,account-2');

	let groupRequest;
	const groupOptions = await loadScopeOptions(
		async (options) => {
			groupRequest = options;
			return {
				data: [{ id: 'group-1', name: 'Servers', siteId: 'site-1' }],
				pagination: { nextCursor: null },
			};
		},
		'https://tenant.example',
		'GROUP',
		{ accountIds: ['account-1'], siteIds: ['site-1'] },
	);
	assert.deepEqual(groupOptions, [{ name: 'Site site-1 / Servers', value: 'group-1' }]);
	assert.equal(groupRequest.qs.accountIds, 'account-1');
	assert.equal(groupRequest.qs.siteIds, 'site-1');
});

test('large visible-account selections are chunked into bounded GraphQL requests', async () => {
	const scopeIds = Array.from(
		{ length: MAX_SCOPE_IDS_PER_QUERY + 1 },
		(_, index) => `account-${index}`,
	);
	const triggerConfig = config({ scopeIds });
	const observedChunkSizes = [];
	await pollSentinelOne(
		async (options) => {
			observedChunkSizes.push(queryVariables(options).scope.scopeIds.length);
			return alertResponse([]);
		},
		triggerConfig,
		initializedState(triggerConfig),
		'scheduled',
		NOW,
	);

	assert.deepEqual(
		observedChunkSizes.sort((left, right) => right - left),
		[500, 1],
	);
});

test('empty scope selection discovers all accounts and the deepest selected scope wins', async () => {
	assert.equal(typeof SentinelOneAlertsTrigger, 'function');
	const node = new SentinelOneAlertsTrigger();
	const baseParams = {
		accountIds: [],
		siteIds: [],
		groupIds: [],
		resource: 'alert',
		operation: 'new',
		options: { simplifyOutput: false },
	};
	let discoveredVariables;
	const discoveryContext = createNodeContext(baseParams, async (options) => {
		if (options.method === 'GET') {
			return {
				data: [
					{ id: 'account-1', name: 'Account One' },
					{ id: 'account-2', name: 'Account Two' },
				],
				pagination: { nextCursor: null },
			};
		}
		discoveredVariables = queryVariables(options);
		return alertResponse([alert('preview-alert')]);
	});
	const discoveryResult = await node.poll.call(discoveryContext);

	assert.deepEqual(discoveredVariables.scope, {
		scopeType: 'ACCOUNT',
		scopeIds: ['account-1', 'account-2'],
	});
	assert.equal(discoveryResult[0][0].json.eventType, 'alert.new');

	let hierarchyVariables;
	const hierarchyContext = createNodeContext(
		{
			...baseParams,
			accountIds: ['account-1'],
			siteIds: ['site-1'],
			groupIds: ['group-1'],
		},
		async (options) => {
			if (options.method === 'GET') {
				if (options.url.endsWith('/accounts')) {
					return {
						data: [{ id: 'account-1', name: 'Account One' }],
						pagination: { nextCursor: null },
					};
				}
				if (options.url.endsWith('/sites')) {
					return {
						data: { sites: [{ id: 'site-1', name: 'Site One' }] },
						pagination: { nextCursor: null },
					};
				}
				return {
					data: [{ id: 'group-1', name: 'Group One', siteId: 'site-1' }],
					pagination: { nextCursor: null },
				};
			}
			hierarchyVariables = queryVariables(options);
			return alertResponse([alert('group-preview')]);
		},
	);
	await node.poll.call(hierarchyContext);
	assert.deepEqual(hierarchyVariables.scope, {
		scopeType: 'GROUP',
		scopeIds: ['group-1'],
	});
});

test('poll rejects stale descendant scopes that do not belong to the selected parent', async () => {
	const node = new SentinelOneAlertsTrigger();
	let graphQlRequests = 0;
	const context = createNodeContext(
		{
			accountIds: ['account-b'],
			siteIds: ['site-from-account-a'],
			groupIds: ['group-from-account-a'],
			resource: 'alert',
			operation: 'new',
			options: {},
		},
		async (options) => {
			if (options.method !== 'GET') {
				graphQlRequests += 1;
				return alertResponse([]);
			}
			if (options.url.endsWith('/accounts')) {
				return {
					data: [{ id: 'account-b', name: 'Account B' }],
					pagination: { nextCursor: null },
				};
			}
			if (options.url.endsWith('/sites')) {
				return { data: { sites: [] }, pagination: { nextCursor: null } };
			}
			return { data: [], pagination: { nextCursor: null } };
		},
	);

	await assert.rejects(node.poll.call(context), /no longer belongs to the selected parent scope/);
	assert.equal(graphQlRequests, 0);
});

test('overlapping polls are coalesced before they can read or overwrite the same state', async () => {
	const node = new SentinelOneAlertsTrigger();
	let releaseGraphQl;
	let markGraphQlStarted;
	const graphQlStarted = new Promise((resolve) => {
		markGraphQlStarted = resolve;
	});
	const graphQlGate = new Promise((resolve) => {
		releaseGraphQl = resolve;
	});
	let graphQlRequests = 0;
	const context = createNodeContext(
		{
			accountIds: [],
			siteIds: [],
			groupIds: [],
			resource: 'alert',
			operation: 'new',
			options: {},
		},
		async (options) => {
			if (options.method === 'GET') {
				return {
					data: [{ id: 'account-1', name: 'Account One' }],
					pagination: { nextCursor: null },
				};
			}
			graphQlRequests += 1;
			markGraphQlStarted();
			await graphQlGate;
			return alertResponse([]);
		},
		'trigger',
	);

	const firstPoll = node.poll.call(context);
	await graphQlStarted;
	const overlappingResult = await node.poll.call(context);
	assert.equal(overlappingResult, null);
	assert.equal(graphQlRequests, 1);
	releaseGraphQl();
	await firstPoll;
});

test('first scheduled poll creates a bounded baseline without output', async () => {
	const triggerConfig = config({
		severities: ['CRITICAL', 'HIGH'],
		statuses: ['NEW'],
		alertName: 'Example detection',
	});
	let observedVariables;
	const result = await pollSentinelOne(
		async (options) => {
			observedVariables = queryVariables(options);
			return alertResponse([alert('baseline-alert')]);
		},
		triggerConfig,
		{},
		'scheduled',
		NOW,
	);

	assert.deepEqual(result.items, []);
	assert.equal(result.nextState.initialized, true);
	assert.deepEqual(result.nextState.seenAlertIds, ['baseline-alert']);
	assert.equal(observedVariables.filters[0].dateTimeRange.start, NOW - 300_000);
	assert.deepEqual(observedVariables.filters.slice(1), [
		{ fieldId: 'severity', stringIn: { values: ['CRITICAL', 'HIGH'] } },
		{ fieldId: 'status', stringIn: { values: ['NEW'] } },
		{ fieldId: 'alertName', match: { values: ['Example detection'] } },
	]);
});

test('GraphQL requests use the configured finite timeout', async () => {
	const triggerConfig = config({ requestTimeoutMs: 12_345 });
	let observedTimeout;
	await pollSentinelOne(
		async (options) => {
			observedTimeout = options.timeout;
			return alertResponse([]);
		},
		triggerConfig,
		initializedState(triggerConfig),
		'scheduled',
		NOW,
	);
	assert.equal(observedTimeout, 12_345);
});

test('manual poll previews a previously seen alert without mutating durable state', async () => {
	const triggerConfig = config();
	const previous = initializedState(triggerConfig, { seenAlertIds: ['preview-alert'] });
	const snapshot = structuredClone(previous);
	const result = await pollSentinelOne(
		async () => alertResponse([alert('preview-alert')]),
		triggerConfig,
		previous,
		'manual',
		NOW,
	);

	assert.equal(result.items.length, 1);
	assert.equal(result.items[0].eventType, 'alert.new');
	assert.equal(result.nextState, undefined);
	assert.deepEqual(previous, snapshot);
});

test('manual poll ignores durable version and note dedupe state', async () => {
	const updatedConfig = config({ events: ['alert.updated'] });
	const updatedAlert = alert(
		'updated-preview',
		'2026-08-26T10:00:00.000Z',
		'2026-08-26T11:59:00.000Z',
	);
	const updatedVersion = `${updatedAlert.id}\u0000${updatedAlert.updatedAt}`;
	const updatedResult = await pollSentinelOne(
		async () => alertResponse([updatedAlert]),
		updatedConfig,
		initializedState(updatedConfig, {
			seenAlertIds: [updatedAlert.id],
			seenAlertVersions: [updatedVersion],
		}),
		'manual',
		NOW,
	);
	assert.deepEqual(
		updatedResult.items.map((item) => item.eventType),
		['alert.updated'],
	);
	assert.equal(updatedResult.nextState, undefined);

	const noteConfig = config({ events: ['alert.note.created'] });
	const noteResult = await pollSentinelOne(
		async (options) => {
			const variables = queryVariables(options);
			if (variables.sortBy) return alertResponse([alertWithNotes('note-preview-alert')]);
			return timelineResponse([note('seen-note')]);
		},
		noteConfig,
		initializedState(noteConfig, { seenNoteIds: ['seen-note'] }),
		'manual',
		NOW,
	);
	assert.deepEqual(
		noteResult.items.map((item) => item.eventType),
		['alert.note.created'],
	);
	assert.equal(noteResult.nextState, undefined);
});

test('manual poll uses the widest alert range and returns at most ten results', async () => {
	const triggerConfig = config();
	let observedVariables;
	const alerts = Array.from({ length: 15 }, (_, index) =>
		alert(`manual-${index}`, new Date(NOW - index * 60_000).toISOString()),
	);
	const result = await pollSentinelOne(
		async (options) => {
			observedVariables = queryVariables(options);
			return alertResponse(alerts);
		},
		triggerConfig,
		{},
		'manual',
		NOW,
	);

	assert.equal(observedVariables.first, 10);
	assert.equal(observedVariables.filters[0].dateTimeRange.start, 0);
	assert.equal(result.items.length, 10);
	assert.equal(result.nextState, undefined);
});

test('manual note preview scans the full lookback before choosing the newest ten notes', async () => {
	const triggerConfig = config({ events: ['alert.note.created'] });
	const candidates = Array.from({ length: 11 }, (_, index) => alertWithNotes(`candidate-${index}`));
	let timelineRequests = 0;
	const result = await pollSentinelOne(
		async (options) => {
			const variables = queryVariables(options);
			if (variables.sortBy === 'createdAt') return alertResponse(candidates);
			if (variables.sortBy === 'updatedAt') return alertResponse([]);
			timelineRequests += 1;
			const index = Number(String(variables.alertId).split('-').at(-1));
			return timelineResponse([
				note(`note-${index}`, 'CREATE', new Date(NOW - (10 - index) * 1000).toISOString()),
			]);
		},
		triggerConfig,
		{},
		'manual',
		NOW,
	);

	assert.equal(timelineRequests, 11);
	assert.equal(result.items.length, 10);
	assert.equal(
		result.items.some((item) => item.note.id === 'note-10'),
		true,
	);
	assert.equal(
		result.items.some((item) => item.note.id === 'note-0'),
		false,
	);
});

test('updated-only mode skips a new alert and emits its later version', async () => {
	const triggerConfig = config({ events: ['alert.updated'] });
	let state = initializedState(triggerConfig);
	let current = alert('updated-only');
	const request = async () => alertResponse([current]);

	const first = await pollSentinelOne(request, triggerConfig, state, 'scheduled', NOW);
	assert.deepEqual(first.items, []);
	assert.deepEqual(first.nextState.seenAlertIds, ['updated-only']);
	state = first.nextState;

	current = alert('updated-only', '2026-08-26T11:59:00.000Z', '2026-08-26T12:01:00.000Z');
	const second = await pollSentinelOne(request, triggerConfig, state, 'scheduled', NOW + 120_000);
	assert.deepEqual(
		second.items.map((item) => item.eventType),
		['alert.updated'],
	);
});

test('new alerts and later updated versions each emit once without same-poll double emission', async () => {
	const triggerConfig = config({ events: ['alert.new', 'alert.updated'] });
	let state = initializedState(triggerConfig);
	let current = alert('alert-1');
	const request = async () => alertResponse([current]);

	const first = await pollSentinelOne(request, triggerConfig, state, 'scheduled', NOW);
	assert.deepEqual(
		first.items.map((item) => item.eventType),
		['alert.new'],
	);
	state = first.nextState;

	current = alert('alert-1', current.createdAt, '2026-08-26T12:01:00.000Z');
	const second = await pollSentinelOne(request, triggerConfig, state, 'scheduled', NOW + 120_000);
	assert.deepEqual(
		second.items.map((item) => item.eventType),
		['alert.updated'],
	);
	state = second.nextState;

	const third = await pollSentinelOne(request, triggerConfig, state, 'scheduled', NOW + 180_000);
	assert.deepEqual(third.items, []);
});

test('concurrent new and updated snapshots emit the newest payload once', async () => {
	const triggerConfig = config({ events: ['alert.new', 'alert.updated'] });
	const createdSnapshot = alert(
		'racing-alert',
		'2026-08-26T11:59:00.000Z',
		'2026-08-26T11:59:00.000Z',
	);
	const updatedSnapshot = alert(
		'racing-alert',
		'2026-08-26T11:59:00.000Z',
		'2026-08-26T11:59:30.000Z',
	);
	const request = async (options) =>
		queryVariables(options).sortBy === 'createdAt'
			? alertResponse([createdSnapshot])
			: alertResponse([updatedSnapshot]);
	let state = initializedState(triggerConfig);
	const first = await pollSentinelOne(request, triggerConfig, state, 'scheduled', NOW);

	assert.deepEqual(
		first.items.map((item) => item.eventType),
		['alert.new'],
	);
	assert.equal(first.items[0].alert.updatedAt, '2026-08-26T11:59:30.000Z');
	state = first.nextState;
	const second = await pollSentinelOne(request, triggerConfig, state, 'scheduled', NOW + 60_000);
	assert.deepEqual(second.items, []);
});

test('simplified alert output resolves the actual scope hierarchy without configured scope lists', async () => {
	const triggerConfig = config({
		scopeType: 'GROUP',
		scopeIds: ['group-1', 'group-2'],
		simplifyOutput: true,
	});
	const result = await pollSentinelOne(
		async () => alertResponse([alert('simplified-alert')]),
		triggerConfig,
		initializedState(triggerConfig),
		'scheduled',
		NOW,
	);
	const item = result.items[0];

	assert.equal(item.scope.type, 'GROUP');
	assert.equal(item.scope.id, 'group-1');
	assert.equal(item.scope.name, 'Group One');
	assert.equal(item.scope.account.name, 'Account One');
	assert.equal(item.scope.site.name, 'Site One');
	assert.equal(item.scope.group.name, 'Group One');
	assert.equal(item.alertId, 'simplified-alert');
	assert.equal('scopeIds' in item, false);
	assert.equal('accountId' in item, false);
	assert.equal('scopeId' in item, false);
	assert.equal('alert' in item, false);
});

test('overlap query emits a late unseen alert older than the checkpoint', async () => {
	const triggerConfig = config({ overlapSeconds: 300 });
	const checkpoint = NOW - 60_000;
	const previous = initializedState(triggerConfig, { checkpointMs: checkpoint });
	let rangeStart;
	const lateAlert = alert('late-alert', new Date(checkpoint - 120_000).toISOString());
	const result = await pollSentinelOne(
		async (options) => {
			rangeStart = queryVariables(options).filters[0].dateTimeRange.start;
			return alertResponse([lateAlert]);
		},
		triggerConfig,
		previous,
		'scheduled',
		NOW,
	);

	assert.equal(rangeStart, checkpoint - 300_000);
	assert.equal(result.items[0].alert.id, 'late-alert');
});

test('configuration change fully rebaselines without historical output', async () => {
	const oldConfig = config();
	const newConfig = config({ statuses: ['RESOLVED'] });
	const previous = initializedState(oldConfig, { seenAlertIds: ['old-alert'] });
	const result = await pollSentinelOne(
		async () => alertResponse([alert('resolved-alert')]),
		newConfig,
		previous,
		'scheduled',
		NOW,
	);

	assert.deepEqual(result.items, []);
	assert.deepEqual(result.nextState.seenAlertIds, ['resolved-alert']);
	assert.equal(result.nextState.configFingerprint, fingerprintConfig(newConfig));
});

test('semantic changes rebaseline but operational tuning and display names do not', () => {
	const original = config();
	assert.notEqual(
		fingerprintConfig(original),
		fingerprintConfig(config({ baseUrl: 'https://other-tenant.example' })),
	);
	assert.equal(
		fingerprintConfig(original),
		fingerprintConfig(
			config({
				credentialIdentity: {
					...original.credentialIdentity,
					name: 'Renamed Credential',
				},
				overlapSeconds: 3600,
				alertLookbackDays: 30,
				concurrentRequests: 20,
				requestTimeoutMs: 300_000,
				alertPageSize: 1000,
				maxAlertPages: 100,
				timelinePageSize: 1000,
				maxTimelinePages: 100,
			}),
		),
	);
	assert.equal(
		fingerprintConfig(config({ allVisibleAccounts: true, scopeIds: ['account-a'] })),
		fingerprintConfig(config({ allVisibleAccounts: true, scopeIds: ['account-a', 'account-b'] })),
	);
});

test('newly visible accounts do not rebaseline an all-visible-accounts poll', async () => {
	const previousConfig = config({
		allVisibleAccounts: true,
		scopeIds: ['account-a'],
	});
	const currentConfig = config({
		allVisibleAccounts: true,
		scopeIds: ['account-a', 'account-b'],
	});
	const result = await pollSentinelOne(
		async () => alertResponse([alert('newly-visible-alert')]),
		currentConfig,
		initializedState(previousConfig),
		'scheduled',
		NOW,
	);

	assert.deepEqual(
		result.items.map((item) => item.alert.id),
		['newly-visible-alert'],
	);
});

test('alert Relay connection drains every page', async () => {
	const triggerConfig = config();
	const previous = initializedState(triggerConfig);
	const calls = [];
	const result = await pollSentinelOne(
		async (options) => {
			calls.push(queryVariables(options).after);
			if (queryVariables(options).after === null) {
				return alertResponse([alert('alert-1')], { hasNextPage: true, endCursor: 'next-page' });
			}
			return alertResponse([alert('alert-2')]);
		},
		triggerConfig,
		previous,
		'scheduled',
		NOW,
	);

	assert.deepEqual(calls, [null, 'next-page']);
	assert.deepEqual(
		result.items.map((item) => item.alert.id),
		['alert-1', 'alert-2'],
	);
});

test('dense alert ranges split into non-overlapping time windows at the page cap', async () => {
	const triggerConfig = config({ maxAlertPages: 1 });
	const ranges = [];
	const result = await pollSentinelOne(
		async (options) => {
			const range = queryVariables(options).filters[0].dateTimeRange;
			ranges.push([range.start, range.end]);
			if (ranges.length === 1) {
				return alertResponse([], { hasNextPage: true, endCursor: 'split-required' });
			}
			return alertResponse([alert(`range-${range.start}`, new Date(range.end).toISOString())]);
		},
		triggerConfig,
		initializedState(triggerConfig),
		'scheduled',
		NOW,
	);

	assert.equal(ranges.length, 3);
	const [, newer, older] = ranges;
	assert.equal(older[1] + 1, newer[0]);
	assert.equal(result.items.length, 2);
});

test('pagination failure does not mutate or replace prior state', async () => {
	const triggerConfig = config();
	const previous = initializedState(triggerConfig, { seenAlertIds: ['safe'] });
	const snapshot = structuredClone(previous);
	await assert.rejects(
		pollSentinelOne(
			async () => alertResponse([alert('unsafe')], { hasNextPage: true, endCursor: null }),
			triggerConfig,
			previous,
			'scheduled',
			NOW,
		),
		/without a continuation cursor/,
	);
	assert.deepEqual(previous, snapshot);
});

test('increasing a page cap resumes from the existing checkpoint', async () => {
	const cappedConfig = config({ maxAlertPages: 1 });
	const resumedConfig = config({ maxAlertPages: 2 });
	const previous = initializedState(cappedConfig);
	assert.equal(fingerprintConfig(cappedConfig), fingerprintConfig(resumedConfig));

	await assert.rejects(
		pollSentinelOne(
			async () =>
				alertResponse([alert('pending-alert')], {
					hasNextPage: true,
					endCursor: 'page-2',
				}),
			cappedConfig,
			previous,
			'scheduled',
			NOW,
		),
		/exceeded the configured page limit/,
	);

	const result = await pollSentinelOne(
		async (options) =>
			queryVariables(options).after === null
				? alertResponse([alert('pending-alert')], {
						hasNextPage: true,
						endCursor: 'page-2',
					})
				: alertResponse([]),
		resumedConfig,
		previous,
		'scheduled',
		NOW,
	);
	assert.deepEqual(
		result.items.map((item) => item.alert.id),
		['pending-alert'],
	);
});

test('GraphQL errors fail the poll', async () => {
	const triggerConfig = config();
	await assert.rejects(
		pollSentinelOne(
			async () => ({ data: null, errors: [{ message: 'Unknown field' }] }),
			triggerConfig,
			initializedState(triggerConfig),
			'scheduled',
			NOW,
		),
		/SentinelOne rejected.*Unknown field.*tenant schema/,
	);
});

test('missing alert and note identities or timestamps fail visibly', async () => {
	const alertConfig = config();
	await assert.rejects(
		pollSentinelOne(
			async () => alertResponse([{ id: 'bad-alert', createdAt: null }]),
			alertConfig,
			initializedState(alertConfig),
			'scheduled',
			NOW,
		),
		/without a usable createdAt timestamp/,
	);

	const noteConfig = config({ events: ['alert.note.created'] });
	await assert.rejects(
		pollSentinelOne(
			async (options) => {
				const variables = queryVariables(options);
				if (variables.sortBy) return alertResponse([alertWithNotes('bad-note-alert')]);
				const invalidNote = note('temporary');
				invalidNote.timelineItemData.id = null;
				return timelineResponse([invalidNote]);
			},
			noteConfig,
			initializedState(noteConfig),
			'scheduled',
			NOW,
		),
		/without a stable ID or timestamp/,
	);
});

test('debug logging captures sanitized request stages without credentials or response bodies', async () => {
	const entries = [];
	const triggerConfig = config({
		debug: true,
		debugLog: (message, details) => entries.push({ message, details }),
	});
	await pollSentinelOne(
		async () => alertResponse([alert('debug-alert')]),
		triggerConfig,
		initializedState(triggerConfig),
		'scheduled',
		NOW,
	);

	assert.deepEqual(
		entries.map((entry) => entry.message),
		[
			'Starting SentinelOne poll',
			'Starting scoped alert query batches',
			'Requesting Unified Alerts page',
			'Received Unified Alerts page',
			'Completed alert candidate queries',
			'Completed scheduled SentinelOne poll',
		],
	);
	const serialized = JSON.stringify(entries);
	assert.doesNotMatch(serialized, /Authorization|ApiToken|apiToken|Content debug-alert/);
});

test('recent-note candidates union created and updated alerts by opaque alert ID', async () => {
	const triggerConfig = config({ events: ['alert.note.created'] });
	const previous = initializedState(triggerConfig);
	const timelineAlertIds = [];
	const result = await pollSentinelOne(
		async (options) => {
			const variables = queryVariables(options);
			if (variables.sortBy === 'createdAt') return alertResponse([alertWithNotes('alert-a')]);
			if (variables.sortBy === 'updatedAt')
				return alertResponse([alertWithNotes('alert-a'), alertWithNotes('alert-b')]);
			timelineAlertIds.push(variables.alertId);
			return timelineResponse([note(`note-${variables.alertId}`)]);
		},
		triggerConfig,
		previous,
		'scheduled',
		NOW,
	);

	assert.deepEqual(timelineAlertIds.sort(), ['alert-a', 'alert-b']);
	assert.deepEqual(result.items.map((item) => item.note.id).sort(), [
		'note-alert-a',
		'note-alert-b',
	]);
});

test('note mode discards timeline data when the alert leaves the selected scope', async () => {
	const triggerConfig = config({
		events: ['alert.note.created'],
		scopeType: 'GROUP',
		scopeIds: ['group-1'],
	});
	let alertQueryCount = 0;
	const result = await pollSentinelOne(
		async (options) => {
			const variables = queryVariables(options);
			if (variables.sortBy) {
				alertQueryCount += 1;
				return alertQueryCount <= 1
					? alertResponse([alertWithNotes('moved-alert')])
					: alertResponse([]);
			}
			return timelineResponse([note('out-of-scope-note')]);
		},
		triggerConfig,
		initializedState(triggerConfig),
		'scheduled',
		NOW,
	);

	assert.deepEqual(result.items, []);
});

test('note mode scans recent alerts even when noteExists is stale false', async () => {
	const triggerConfig = config({ events: ['alert.note.created'] });
	let timelineRequests = 0;
	const result = await pollSentinelOne(
		async (options) => {
			const variables = queryVariables(options);
			if (variables.sortBy) return alertResponse([alert('no-notes')]);
			timelineRequests += 1;
			return timelineResponse([note('newly-propagated-note')]);
		},
		triggerConfig,
		initializedState(triggerConfig),
		'scheduled',
		NOW,
	);

	assert.equal(timelineRequests, 1);
	assert.equal(result.items[0].note.id, 'newly-propagated-note');
});

test('note timeline requests use bounded parallel concurrency', async () => {
	const triggerConfig = config({
		events: ['alert.note.created'],
		concurrentRequests: 3,
	});
	const candidates = Array.from({ length: 6 }, (_, index) => alertWithNotes(`parallel-${index}`));
	let activeTimelineRequests = 0;
	let maxActiveTimelineRequests = 0;
	await pollSentinelOne(
		async (options) => {
			const variables = queryVariables(options);
			if (variables.sortBy === 'updatedAt') return alertResponse(candidates);
			activeTimelineRequests += 1;
			maxActiveTimelineRequests = Math.max(maxActiveTimelineRequests, activeTimelineRequests);
			await Promise.resolve();
			activeTimelineRequests -= 1;
			return timelineResponse([note(`note-${variables.alertId}`)]);
		},
		triggerConfig,
		initializedState(triggerConfig),
		'scheduled',
		NOW,
	);

	assert.equal(maxActiveTimelineRequests, 3);
});

test('note concurrency stops assigning new work after the first request failure', async () => {
	const triggerConfig = config({
		events: ['alert.note.created'],
		concurrentRequests: 3,
	});
	const candidates = Array.from({ length: 8 }, (_, index) => alertWithNotes(`failure-${index}`));
	const startedAlertIds = [];
	await assert.rejects(
		pollSentinelOne(
			async (options) => {
				const variables = queryVariables(options);
				if (variables.sortBy === 'updatedAt') return alertResponse(candidates);
				startedAlertIds.push(variables.alertId);
				await Promise.resolve();
				if (variables.alertId === 'failure-0') throw new Error('429 rate limited');
				return timelineResponse([]);
			},
			triggerConfig,
			initializedState(triggerConfig),
			'scheduled',
			NOW,
		),
		/429 rate limited/,
	);

	assert.equal(startedAlertIds.length, 3);
});

test('NOTE timelines drain all pages, keep CREATE only, and deduplicate note IDs', async () => {
	const triggerConfig = config({ events: ['alert.note.created'] });
	const previous = initializedState(triggerConfig);
	const timelineCursors = [];
	const result = await pollSentinelOne(
		async (options) => {
			const variables = queryVariables(options);
			if (variables.sortBy) {
				return variables.sortBy === 'updatedAt'
					? alertResponse([alertWithNotes('alert-a')])
					: alertResponse([]);
			}
			timelineCursors.push(variables.after);
			if (variables.after === null) {
				return timelineResponse([note('note-1'), note('note-updated', 'UPDATE')], {
					hasNextPage: true,
					endCursor: 'timeline-next',
				});
			}
			return timelineResponse([note('note-1'), note('note-2')]);
		},
		triggerConfig,
		previous,
		'scheduled',
		NOW,
	);

	assert.deepEqual(timelineCursors, [null, 'timeline-next']);
	assert.deepEqual(
		result.items.map((item) => item.note.id),
		['note-1', 'note-2'],
	);
	assert.deepEqual(result.items[0].note.text, { content: 'Content note-1', type: 'PLAIN_TEXT' });
	assert.equal(result.items[0].note.createdBy.__typename, 'UserNoteAuthor');
	assert.equal(result.items[0].scope.group.name, 'Group One');
});

test('simplified note output resolves names and flattens note content and author', async () => {
	const triggerConfig = config({
		events: ['alert.note.created'],
		scopeType: 'SITE',
		scopeIds: ['site-1', 'site-2'],
		simplifyOutput: true,
	});
	const result = await pollSentinelOne(
		async (options) => {
			const variables = queryVariables(options);
			if (variables.sortBy) return alertResponse([alertWithNotes('note-alert')]);
			return timelineResponse([note('simplified-note')]);
		},
		triggerConfig,
		initializedState(triggerConfig),
		'scheduled',
		NOW,
	);
	const item = result.items[0];

	assert.equal(item.scope.type, 'SITE');
	assert.equal(item.scope.id, 'site-1');
	assert.equal(item.scope.name, 'Site One');
	assert.equal(item.scope.account.name, 'Account One');
	assert.equal(item.scope.group.name, 'Group One');
	assert.equal(item.noteId, 'simplified-note');
	assert.equal(item.noteText, 'Content simplified-note');
	assert.equal(item.noteType, 'PLAIN_TEXT');
	assert.equal(item.authorName, 'Example Analyst');
	assert.equal('scopeIds' in item, false);
	assert.equal('accountId' in item, false);
	assert.equal('scopeId' in item, false);
	assert.equal('note' in item, false);
});

test('historical notes do not replay after dedupe eviction or alert re-entry', async () => {
	const triggerConfig = config({ events: ['alert.note.created'] });
	const previous = initializedState(triggerConfig, { seenNoteIds: [] });
	const oldNote = note('evicted-note', 'CREATE', '2026-08-25T12:00:00.000Z');
	const recentNote = note('recent-note');
	const result = await pollSentinelOne(
		async (options) => {
			const variables = queryVariables(options);
			if (variables.sortBy) return alertResponse([alertWithNotes('reentered-alert')]);
			return timelineResponse([recentNote, oldNote]);
		},
		triggerConfig,
		previous,
		'scheduled',
		NOW,
	);

	assert.deepEqual(
		result.items.map((item) => item.note.id),
		['recent-note'],
	);
	assert.deepEqual(result.nextState.seenNoteIds, ['recent-note']);
});

test('poll fails before emission when one overlap exceeds the alert state capacity', async () => {
	const triggerConfig = config();
	const alerts = Array.from({ length: MAX_SEEN_ALERT_IDS + 1 }, (_, index) =>
		alert(`alert-${index}`, new Date(NOW - index).toISOString()),
	);
	const previous = initializedState(triggerConfig);
	for (const pollStart of [NOW, NOW + 60_000]) {
		await assert.rejects(
			pollSentinelOne(
				async () => alertResponse(alerts),
				triggerConfig,
				previous,
				'scheduled',
				pollStart,
			),
			/exceeds the safe state limit.*state was not advanced/,
		);
	}
});

test('seen alert, version, and note state remains within documented limits', async () => {
	const triggerConfig = config({ events: ['alert.new', 'alert.updated', 'alert.note.created'] });
	const previous = initializedState(triggerConfig, {
		seenAlertIds: Array.from({ length: MAX_SEEN_ALERT_IDS + 5 }, (_, index) => `alert-${index}`),
		seenAlertVersions: Array.from(
			{ length: MAX_SEEN_ALERT_VERSIONS + 5 },
			(_, index) => `version-${index}`,
		),
		seenNoteIds: Array.from({ length: MAX_SEEN_NOTE_IDS + 5 }, (_, index) => `note-${index}`),
	});
	const result = await pollSentinelOne(
		async () => alertResponse([]),
		triggerConfig,
		previous,
		'scheduled',
		NOW,
	);

	assert.equal(result.nextState.seenAlertIds.length, MAX_SEEN_ALERT_IDS);
	assert.equal(result.nextState.seenAlertVersions.length, MAX_SEEN_ALERT_VERSIONS);
	assert.equal(result.nextState.seenNoteIds.length, MAX_SEEN_NOTE_IDS);
});

test('trigger UI states ActivityFeed discovery requirements', () => {
	const source = readFileSync(
		join(packageRoot, 'nodes/SentinelOneAlertsTrigger/SentinelOneAlertsTrigger.node.ts'),
		'utf8',
	);
	assert.match(source, /Parent alert updates are not required\./);
});

test('scope fields allow accessible sites without an account selection', () => {
	const properties = new SentinelOneAlertsTrigger().description.properties;
	const accounts = properties.find((property) => property.name === 'accountIds');
	const sites = properties.find((property) => property.name === 'siteIds');
	const groups = properties.find((property) => property.name === 'groupIds');
	assert.equal(accounts.required, undefined);
	assert.deepEqual(sites.typeOptions.loadOptionsDependsOn, ['accountIds']);
	assert.equal(sites.displayOptions, undefined);
	assert.deepEqual(groups.typeOptions.loadOptionsDependsOn, ['siteIds']);
});

test('trigger UI uses resource, operation, and resource-specific options', () => {
	const source = readFileSync(
		join(packageRoot, 'nodes/SentinelOneAlertsTrigger/SentinelOneAlertsTrigger.node.ts'),
		'utf8',
	);

	assert.match(source, /displayName: 'Resource'[\s\S]*?name: 'resource'/);
	assert.match(source, /resource: \['alert'\][\s\S]*?value: 'newOrUpdated'/);
	assert.match(source, /resource: \['alertNote'\][\s\S]*?value: 'created'/);
	assert.match(source, /displayName: 'Options'[\s\S]*?resource: \['alert'\]/);
	assert.match(source, /displayName: 'Options'[\s\S]*?resource: \['alertNote'\]/);
	assert.doesNotMatch(source, /previewLookbackMinutes/);
	assert.match(source, /displayName: 'Debug'[\s\S]*?default: false/);
	assert.match(source, /displayName: 'Simplify'[\s\S]*?default: true/);
	assert.doesNotMatch(
		source,
		/displayName: '(?:Alert Page Size|Concurrent Requests|Max Alert Pages|Max Timeline Pages|Overlap|Request Timeout \(Ms\)|Timeline Page Size)'/,
	);
});

const {
	compileExclusion,
	matchesExclusion,
	noteAuthorName,
} = require('../../dist/nodes/SentinelOneAlertsTrigger/Exclusions.js');
const { discoverVisibleScopes } = require(builtHelpers);
const testNode = {
	name: 'SentinelOne Alerts Trigger',
	type: 'sentinelOneAlertsTrigger',
	typeVersion: 1,
	position: [0, 0],
	parameters: {},
};

test('exclusion regex supports names, anchors, alternatives and bounded native matching', () => {
	for (const pattern of ['demo|test', '^(demo|test)', '^demo.*$', 'test-[0-9]+']) {
		assert.ok(compileExclusion(pattern, 'Account'));
	}
	assert.equal(matchesExclusion(compileExclusion('demo|test', 'Account'), 'DEMO customer'), true);
	assert.equal(matchesExclusion(compileExclusion('^demo$', 'Account'), 'demo customer'), false);
	assert.equal(matchesExclusion(compileExclusion('.*', 'Account'), undefined), false);
	assert.equal(matchesExclusion(compileExclusion('.*', 'Account'), ''), false);
	assert.equal(compileExclusion('', 'Account'), undefined);
	for (const pattern of [
		'[',
		'(a+)+$',
		'(a|aa)+$',
		'(a|aa)(a|aa)',
		'a*a*',
		'(?=test)',
		'(a)\\1',
		'a{999999}',
		'x'.repeat(257),
	]) {
		assert.throws(() => compileExclusion(pattern, 'Account'), /Account: use a valid regex/);
	}
	assert.throws(() => matchesExclusion(/a/i, 'a'.repeat(1025)), /safety limit/);
	assert.equal(
		noteAuthorName({ __typename: 'UserNoteAuthor', fullName: 'Human', name: 'Wrong' }),
		'Human',
	);
	assert.equal(
		noteAuthorName({ __typename: 'RuleNoteAuthor', name: 'Rule', fullName: 'Wrong' }),
		'Rule',
	);
	assert.equal(noteAuthorName({ __typename: 'Unknown', name: 'Unknown' }), undefined);
});

test('scope exclusions cascade without changing query scope or dropping ungrouped alerts', async () => {
	const excludedAccount = alert('account');
	excludedAccount.realTime.scope.account.name = 'Demo customer';
	const excludedSite = alert('site');
	excludedSite.realTime.scope.site.name = 'TEST site';
	const excludedGroup = alert('group');
	excludedGroup.realTime.scope.group.name = 'Test group';
	const ungrouped = alert('ungrouped');
	ungrouped.realTime.scope.group = null;
	const cfg = config({
		excludeAccountName: 'demo',
		excludeSiteName: 'test',
		excludeGroupName: 'test',
	});
	const result = await pollSentinelOne(
		async (request) => {
			assert.equal(request.body.variables.scope.scopeType, 'ACCOUNT');
			return alertResponse([excludedAccount, excludedSite, excludedGroup, ungrouped]);
		},
		cfg,
		initializedState(cfg),
		'scheduled',
		NOW,
	);
	assert.deepEqual(
		result.items.map((item) => item.alert.id),
		['ungrouped'],
	);
});

test('manual preview paginates past excluded alerts without changing state', async () => {
	const cfg = config({ excludeAccountName: 'demo' });
	const excluded = alert('excluded');
	excluded.realTime.scope.account.name = 'Demo';
	let calls = 0;
	const result = await pollSentinelOne(
		async (request) => {
			calls++;
			return request.body.variables.after
				? alertResponse([alert('included')])
				: alertResponse([excluded], { hasNextPage: true, endCursor: 'next' });
		},
		cfg,
		initializedState(cfg),
		'manual',
		NOW,
	);
	assert.equal(calls, 2);
	assert.deepEqual(
		result.items.map((item) => item.alert.id),
		['included'],
	);
	assert.equal(result.nextState, undefined);
});

test('scope exclusions precede timelines and author exclusions cover users and rules', async () => {
	const cfg = config({
		events: ['alert.note.created'],
		excludeGroupName: 'demo',
		excludeNoteAuthorName: 'robot',
	});
	const excluded = alertWithNotes('excluded');
	excluded.realTime.scope.group.name = 'Demo';
	const user = note('user');
	user.timelineItemData.createdBy.fullName = 'Robot';
	const rule = note('rule');
	rule.timelineItemData.createdBy = { __typename: 'RuleNoteAuthor', name: 'ROBOT rule' };
	const unknown = note('unknown');
	unknown.timelineItemData.createdBy = null;
	const result = await pollSentinelOne(
		async (request) => {
			if (request.body.query.includes('PollAlertNotes')) {
				assert.equal(request.body.variables.alertId, 'included');
				return timelineResponse([user, rule, unknown]);
			}
			return alertResponse([excluded, alertWithNotes('included')]);
		},
		cfg,
		initializedState(cfg),
		'scheduled',
		NOW,
	);
	assert.deepEqual(
		result.items.map((item) => item.note.id),
		['unknown'],
	);
	const repeated = await pollSentinelOne(
		async (request) =>
			request.body.query.includes('PollAlertNotes')
				? timelineResponse([unknown])
				: alertResponse([alertWithNotes('included')]),
		cfg,
		result.nextState,
		'scheduled',
		NOW + 1000,
	);
	assert.equal(repeated.items.length, 0);
});

test('exclusion changes baseline and invalid patterns fail before any requests', async () => {
	const original = config();
	const changed = config({ excludeAccountName: 'demo' });
	const result = await pollSentinelOne(
		async () => alertResponse([alert('existing')]),
		changed,
		initializedState(original),
		'scheduled',
		NOW,
	);
	assert.equal(result.items.length, 0);
	assert.notEqual(result.nextState.configFingerprint, fingerprintConfig(original));
	await assert.rejects(
		() =>
			pollSentinelOne(
				async () => assert.fail('must not request'),
				config({ excludeSiteName: '[' }),
				{},
				'scheduled',
				NOW,
			),
		/Exclude Site Name/,
	);
});

test('visible scope discovery falls back to sites only for permission denial or no accounts', async () => {
	for (const status of [403, '403']) {
		const requests = [];
		const scopes = await discoverVisibleScopes(
			async (request) => {
				requests.push(request.url);
				if (request.url.endsWith('/accounts')) throw { statusCode: status };
				return { data: { sites: [{ id: 'site-1', name: 'Site' }] } };
			},
			'https://tenant.example',
			testNode,
		);
		assert.deepEqual(scopes, { scopeType: 'SITE', scopeIds: ['site-1'] });
		assert.equal(requests.length, 2);
	}
	for (const statusCode of [401, 429, 500]) {
		let calls = 0;
		await assert.rejects(() =>
			discoverVisibleScopes(
				async () => {
					calls++;
					throw { statusCode };
				},
				'https://tenant.example',
				testNode,
			),
		);
		assert.equal(calls, 1);
	}
});

test('manual Updated preview continues past never-updated alerts', async () => {
	const cfg = config({ events: ['alert.updated'] });
	const neverUpdated = Array.from({ length: 10 }, (_, index) => alert(`new-${index}`));
	const genuineUpdate = alert('updated', '2026-08-20T00:00:00Z', '2026-08-26T11:58:00Z');
	const result = await pollSentinelOne(
		async (request) => {
			const vars = request.body.variables;
			if (vars.sortBy === 'createdAt') return alertResponse(neverUpdated);
			return vars.after
				? alertResponse([genuineUpdate])
				: alertResponse(neverUpdated, { hasNextPage: true, endCursor: 'next' });
		},
		cfg,
		{},
		'manual',
		NOW,
	);
	assert.deepEqual(
		result.items.map((item) => item.alert.id),
		['updated'],
	);
});

test('malformed connections and note timestamps fail without a successful result', async () => {
	const cfg = config({ events: ['alert.note.created'] });
	for (const bad of [undefined, null, {}]) {
		await assert.rejects(
			() =>
				pollSentinelOne(
					async () => ({ data: { alerts: { edges: bad, pageInfo: { hasNextPage: false } } } }),
					cfg,
					initializedState(cfg),
					'scheduled',
					NOW,
				),
			/incomplete/,
		);
		await assert.rejects(
			() =>
				pollSentinelOne(
					async (request) =>
						request.body.query.includes('PollAlertNotes')
							? { data: { alertTimeline: { edges: bad, pageInfo: { hasNextPage: false } } } }
							: alertResponse([alertWithNotes('a')]),
					cfg,
					initializedState(cfg),
					'scheduled',
					NOW,
				),
			/incomplete/,
		);
	}
	for (const field of ['createdAt', 'updatedAt']) {
		const badNote = note('bad');
		if (field === 'createdAt') badNote.createdAt = 'invalid';
		else badNote.timelineItemData.updatedAt = 'invalid';
		await assert.rejects(
			() =>
				pollSentinelOne(
					async (request) =>
						request.body.query.includes('PollAlertNotes')
							? timelineResponse([badNote])
							: alertResponse([alertWithNotes('a')]),
					cfg,
					initializedState(cfg),
					'scheduled',
					NOW,
				),
			/timestamp/,
		);
	}
});

test('site-scoped node polls accessible sites without account-list permission', async () => {
	const node = new SentinelOneAlertsTrigger();
	const calls = [];
	const request = async (options) => {
		calls.push(options.url);
		if (options.url.endsWith('/accounts')) throw { statusCode: 403 };
		if (options.url.endsWith('/sites'))
			return { data: { sites: [{ id: 'site-1', name: 'Site' }] } };
		assert.deepEqual(options.body.variables.scope, { scopeType: 'SITE', scopeIds: ['site-1'] });
		return alertResponse([alert('accessible')]);
	};
	const context = createNodeContext(
		{ resource: 'alert', operation: 'new', accountIds: [], siteIds: [] },
		request,
	);
	assert.deepEqual(await node.methods.loadOptions.getAccounts.call(context), []);
	assert.equal((await node.methods.loadOptions.getSites.call(context)).length, 1);
	assert.equal((await node.poll.call(context))[0][0].json.alertId, 'accessible');
	calls.length = 0;
	const selected = createNodeContext(
		{ resource: 'alert', operation: 'new', accountIds: [], siteIds: ['site-1'] },
		request,
	);
	assert.equal((await node.poll.call(selected))[0][0].json.alertId, 'accessible');
	assert.equal(
		calls.some((url) => url.endsWith('/accounts')),
		false,
	);
});

test('combined manual preview continues after updates already classified as new', async () => {
	const cfg = config({ events: ['alert.new', 'alert.updated'] });
	const recent = Array.from({ length: 10 }, (_, index) =>
		alert(`new-${index}`, '2026-08-26T11:00:00Z', '2026-08-26T11:59:00Z'),
	);
	const older = alert('older-update', '2026-08-20T00:00:00Z', '2026-08-26T11:30:00Z');
	let nextPageRead = false;
	const result = await pollSentinelOne(
		async (request) => {
			const vars = request.body.variables;
			if (vars.sortBy === 'createdAt') return alertResponse(recent);
			if (vars.after) {
				nextPageRead = true;
				return alertResponse([older]);
			}
			return alertResponse(recent, { hasNextPage: true, endCursor: 'next' });
		},
		cfg,
		{},
		'manual',
		NOW,
	);
	assert.equal(nextPageRead, true);
	assert.equal(result.items.length, 10);
	assert.equal(result.items.at(-1).alert.id, 'older-update');
	assert.equal(result.items.at(-1).eventType, 'alert.updated');
});

test('note preview validates minutes within the supported range', async () => {
	for (const alertLookbackMinutes of [0, 43201, 1.5, NaN]) {
		await assert.rejects(
			() =>
				pollSentinelOne(
					async () => assert.fail('must not request'),
					config({ events: ['alert.note.created'], alertLookbackMinutes }),
					{},
					'manual',
					NOW,
				),
			/whole number from 1 to 43200/,
		);
	}
});

test('selected additional alert fields are queried and returned in simplified and raw outputs', async () => {
	for (const simplifyOutput of [true, false]) {
		const cfg = config({
			simplifyOutput,
			additionalAlertFields: ['ticketId', 'assignee', 'description'],
		});
		const item = {
			...alert('enriched'),
			ticketId: 'CASE-42',
			assignee: { userId: 'u', fullName: 'Analyst', email: 'a@example.com' },
			description: null,
		};
		const result = await pollSentinelOne(
			async (request) => {
				assert.match(request.body.query, /ticketId/);
				assert.match(request.body.query, /assignee \{ userId fullName email \}/);
				assert.doesNotMatch(request.body.query, /storylineId/);
				return alertResponse([item]);
			},
			cfg,
			{},
			'manual',
			NOW,
		);
		const output = simplifyOutput ? result.items[0] : result.items[0].alert;
		assert.equal(output.ticketId, 'CASE-42');
		assert.equal(output.assignee.fullName, 'Analyst');
		assert.equal(output.description, null);
	}
});

test('unknown field expressions cannot become GraphQL source and output selection keeps the baseline', async () => {
	for (const value of [['ticketId } mutation { delete'], ['__proto__'], 'ticketId']) {
		await assert.rejects(
			() =>
				pollSentinelOne(
					async () => assert.fail('must not request'),
					config({ additionalAlertFields: value }),
					{},
					'manual',
					NOW,
				),
			/unsupported field/,
		);
	}
	assert.equal(
		fingerprintConfig(config()),
		fingerprintConfig(config({ additionalAlertFields: ['ticketId'] })),
	);
});

test('OCSF enrichment runs only for emitted previews and is bounded to five requests', async () => {
	const cfg = config({ includeOcsf: true });
	let details = 0,
		active = 0,
		maxActive = 0;
	const request = async (options) => {
		if (!options.body.query.includes('AlertOcsf'))
			return alertResponse(Array.from({ length: 25 }, (_, i) => alert(`a${i}`)));
		details++;
		active++;
		maxActive = Math.max(active, maxActive);
		assert.deepEqual(options.body.variables.scope, {
			scopeType: 'ACCOUNT',
			scopeIds: ['account-1'],
		});
		await new Promise((resolve) => setTimeout(resolve, 2));
		active--;
		return {
			data: {
				alert: { ...alert(options.body.variables.id), ocsf: { action: 'Observed', actionId: 3 } },
			},
		};
	};
	const baseline = await pollSentinelOne(request, cfg, {}, 'scheduled', NOW);
	assert.equal(baseline.items.length, 0);
	assert.equal(details, 0);
	const preview = await pollSentinelOne(request, cfg, {}, 'manual', NOW);
	assert.equal(details, 10);
	assert.equal(preview.items.length, 10);
	assert.equal(maxActive, 5);
	assert.equal(preview.items[0].ocsf.actionId, 3);
	assert.equal(preview.nextState, undefined);
	assert.equal(fingerprintConfig(cfg), fingerprintConfig(config()));
});

test('OCSF preserves null and native fields with either output shape', async () => {
	for (const simplifyOutput of [true, false]) {
		for (const ocsf of [null, { startTimeDt: '2026-08-26T00:00:00Z', evidences: [] }]) {
			const cfg = config({ includeOcsf: true, simplifyOutput });
			const result = await pollSentinelOne(
				async (r) =>
					r.body.query.includes('AlertOcsf')
						? { data: { alert: { ...alert('a'), ocsf } } }
						: alertResponse([alert('a')]),
				cfg,
				{},
				'manual',
				NOW,
			);
			assert.deepEqual(result.items[0].ocsf, ocsf);
			assert.equal(result.items[0].eventType, 'alert.new');
		}
	}
});

test('OCSF errors or missing identity and scope reject without changing scheduled state', async () => {
	const cfg = config({ includeOcsf: true });
	const state = initializedState(cfg);
	const before = JSON.stringify(state);
	for (const detailResponse of [
		{ errors: [{ message: 'sensitive upstream details' }] },
		{ data: { alert: { ...alert('a') } } },
		{ data: { alert: { ...alert('wrong'), ocsf: {} } } },
		{ data: { alert: { ...alert('a'), ocsf: 'invalid' } } },
		{ data: { alert: { id: 'a', ocsf: {} } } },
	]) {
		await assert.rejects(
			() =>
				pollSentinelOne(
					async (r) =>
						r.body.query.includes('AlertOcsf') ? detailResponse : alertResponse([alert('a')]),
					cfg,
					state,
					'scheduled',
					NOW,
				),
			(error) => {
				assert.doesNotMatch(error.message, /sensitive upstream details/);
				return true;
			},
		);
		assert.equal(JSON.stringify(state), before);
	}
});

test('OCSF scope and name exclusions are rechecked on detail retrieval', async () => {
	for (const moved of [true, false]) {
		const cfg = config({ includeOcsf: true, excludeSiteName: 'demo' });
		const detail = { ...alert('a'), ocsf: {} };
		if (moved) detail.realTime.scope.account.id = 'another-account';
		else detail.realTime.scope.site.name = 'DEMO';
		const result = await pollSentinelOne(
			async (r) =>
				r.body.query.includes('AlertOcsf')
					? { data: { alert: detail } }
					: alertResponse([alert('a')]),
			cfg,
			{},
			'manual',
			NOW,
		);
		assert.deepEqual(result.items, []);
	}
});

test('OCSF failures do not log a completed poll or advanced checkpoint', async () => {
	const logs = [];
	const cfg = config({
		includeOcsf: true,
		debug: true,
		debugLog: (message, details) => logs.push({ message, details }),
	});
	await assert.rejects(() =>
		pollSentinelOne(
			async (r) => {
				if (r.body.query.includes('AlertOcsf')) throw new Error('detail unavailable');
				return alertResponse([alert('a')]);
			},
			cfg,
			initializedState(cfg),
			'scheduled',
			NOW,
		),
	);
	assert.equal(
		logs.some((entry) => entry.details.checkpointAdvanced === true),
		false,
	);
	assert.equal(
		logs.some((entry) => entry.message === 'Completed scheduled SentinelOne poll'),
		false,
	);
});

test('scheduled note polling avoids timelines for alerts outside the checkpoint overlap', async () => {
	const cfg = config({ events: ['alert.note.created'], alertLookbackMinutes: 15 });
	const recent = alertWithNotes('recent', new Date(NOW - 5 * 60_000).toISOString());
	const old = alertWithNotes('old', new Date(NOW - 12 * 60 * 60_000).toISOString());
	const timelines = [];
	const result = await pollSentinelOne(
		async (r) => {
			const vars = r.body.variables;
			if (r.body.query.includes('PollAlertNotes')) {
				timelines.push(vars.alertId);
				return timelineResponse([]);
			}
			const range = vars.filters.find((filter) => filter.fieldId === vars.sortBy).dateTimeRange;
			return alertResponse(
				[recent, old].filter((item) => Date.parse(item[vars.sortBy]) >= range.start),
			);
		},
		cfg,
		initializedState(cfg),
		'scheduled',
		NOW,
	);
	assert.deepEqual(timelines, ['recent']);
	assert.equal(result.nextState.checkpointMs, NOW);
});

test('an old alert with a new update marker emits its new note from the checkpoint window', async () => {
	const cfg = config({ events: ['alert.note.created'], alertLookbackMinutes: 15 });
	const marked = alertWithNotes(
		'old-alert',
		'2026-07-01T00:00:00Z',
		new Date(NOW - 30_000).toISOString(),
	);
	const state = initializedState(cfg);
	const queries = [];
	const result = await pollSentinelOne(
		async (r) => {
			const vars = r.body.variables;
			if (r.body.query.includes('PollAlertNotes'))
				return timelineResponse([
					note('fresh', 'CREATE', new Date(NOW - 35_000).toISOString()),
					note('historic', 'CREATE', '2026-07-01T00:00:00Z'),
				]);
			queries.push(vars);
			return alertResponse([marked]);
		},
		cfg,
		state,
		'scheduled',
		NOW,
	);
	assert.equal(queries.length, 2);
	assert.ok(queries.every((vars) => vars.sortBy === 'updatedAt'));
	assert.ok(
		queries.every(
			(vars) =>
				vars.filters.find((f) => f.fieldId === 'updatedAt').dateTimeRange.start ===
				state.checkpointMs - 300_000,
		),
	);
	assert.deepEqual(
		result.items.map((item) => item.note.id),
		['fresh'],
	);
	assert.deepEqual(result.nextState.seenNoteIds, ['fresh']);
});

test('manual note preview uses minutes and leaves scheduled state unchanged', async () => {
	const cfg = config({ events: ['alert.note.created'], alertLookbackMinutes: 15 });
	const previous = initializedState(cfg);
	const snapshot = structuredClone(previous);
	const result = await pollSentinelOne(
		async (r) => {
			const vars = r.body.variables;
			if (r.body.query.includes('PollAlertNotes')) return timelineResponse([]);
			assert.equal(
				vars.filters.find((f) => f.fieldId === vars.sortBy).dateTimeRange.start,
				NOW - 15 * 60_000,
			);
			return alertResponse([]);
		},
		cfg,
		previous,
		'manual',
		NOW,
	);
	assert.deepEqual(previous, snapshot);
	assert.equal(result.nextState, undefined);
	assert.equal(fingerprintConfig(cfg), fingerprintConfig({ ...cfg, alertLookbackMinutes: 60 }));
});

test('scheduled note retry covers downtime rather than limiting to preview lookback', async () => {
	const cfg = config({ events: ['alert.note.created'], alertLookbackMinutes: 1 });
	const state = initializedState(cfg, { checkpointMs: NOW - 6 * 60 * 60_000 });
	const changed = alertWithNotes(
		'changed-during-downtime',
		'2026-07-01T00:00:00Z',
		new Date(NOW - 3 * 60 * 60_000).toISOString(),
	);
	const result = await pollSentinelOne(
		async (r) => {
			if (r.body.query.includes('PollAlertNotes'))
				return timelineResponse([
					note('downtime-note', 'CREATE', new Date(NOW - 3 * 60 * 60_000).toISOString()),
				]);
			assert.equal(r.body.variables.filters[0].dateTimeRange.start, state.checkpointMs - 300_000);
			return alertResponse([changed]);
		},
		cfg,
		state,
		'scheduled',
		NOW,
	);
	assert.equal(result.items[0].note.id, 'downtime-note');
});

test('note polling scales with changed alerts instead of daily alert volume', async () => {
	const cfg = config({ events: ['alert.note.created'], alertLookbackMinutes: 15 });
	const dailyAlerts = Array.from({ length: 1000 }, (_, index) =>
		alertWithNotes(`daily-${index}`, new Date(NOW - (index + 0.5) * 86_400).toISOString()),
	);
	let alertRequests = 0,
		timelineRequests = 0;
	const result = await pollSentinelOne(
		async (r) => {
			const vars = r.body.variables;
			if (r.body.query.includes('PollAlertNotes')) {
				timelineRequests++;
				return timelineResponse([]);
			}
			alertRequests++;
			const range = vars.filters.find((filter) => filter.fieldId === vars.sortBy).dateTimeRange;
			const matching = dailyAlerts.filter(
				(item) =>
					Date.parse(item[vars.sortBy]) >= range.start &&
					Date.parse(item[vars.sortBy]) <= range.end,
			);
			const start = Number(vars.after ?? 0),
				end = start + vars.first;
			return alertResponse(matching.slice(start, end), {
				hasNextPage: end < matching.length,
				endCursor: end < matching.length ? String(end) : null,
			});
		},
		cfg,
		initializedState(cfg),
		'scheduled',
		NOW,
	);
	assert.equal(alertRequests, 2);
	assert.equal(timelineRequests, 4);
	assert.deepEqual(result.nextState.seenNoteIds, []);
	assert.ok(Buffer.byteLength(JSON.stringify(result.nextState)) < 256);
});

test('credential uses the same Bearer token for SDL, GraphQL, and management REST', async () => {
	const {
		SentinelOneAlertsApi,
	} = require('../../dist/credentials/SentinelOneAlertsApi.credentials.js');
	const credential = new SentinelOneAlertsApi();
	const data = { baseUrl: 'https://tenant.example', apiToken: 'test-token' };
	for (const path of ['/sdl/v2/api/queries', '/sdl/v2/api/queries/query-id']) {
		for (const key of ['url', 'uri']) {
			const options = await credential.authenticate(data, {
				[key]: `https://tenant.example${path}`,
				headers: { 'X-Test': 'kept' },
			});
			assert.equal(options.headers.Authorization, 'Bearer test-token');
			assert.equal(options.headers['X-Test'], 'kept');
		}
	}
	const options = await credential.authenticate(data, {
		url: 'https://tenant.example/web/api/v2.1/unifiedalerts/graphql',
	});
	assert.equal(options.headers.Authorization, 'Bearer test-token');
	const rest = await credential.authenticate(data, {
		url: 'https://tenant.example/web/api/v2.1/sites',
	});
	assert.equal(rest.headers.Authorization, 'Bearer test-token');
});

test('the actual note node dispatches through SDL and returns SDL note text without note hydration', async () => {
	const now = Date.now();
	const params = {
		resource: 'alertNote',
		operation: 'created',
		accountIds: ['account-1'],
		options: { previewLookbackMinutes: 15 },
	};
	let sdlCalls = 0;
	const request = async (r) => {
		if (r.method === 'GET') return { data: [{ id: 'account-1', name: 'Account One' }] };
		if (r.url.includes('/sdl/v2/api/queries')) {
			sdlCalls++;
			assert.deepEqual(r.body.accountIds, ['account-1']);
			assert.equal(r.body.tenant, false);
			return {
				id: 'job',
				stepsCompleted: 1,
				stepsTotal: 1,
				data: {
					columns: [
						'activity_id',
						'created_at',
						'data.alert.id',
						'timestampNs',
						'noteText',
						'authorId',
						'authorName',
					].map((name) => ({
						name,
					})),
					values: [
						[
							'event',
							new Date(now - 1000).toISOString(),
							'live-note-alert',
							String(BigInt(now - 1000) * 1000000n),
							'Content from SDL',
							null,
							null,
						],
					],
					omittedEvents: 0,
					partialResultsDueToTimeLimit: false,
					warnings: [],
				},
			};
		}
		if (r.body.query.includes('ActivityNoteAlerts'))
			return alertResponse([alertWithNotes('live-note-alert')]);
		assert.fail('Unexpected request path: ' + r.url);
	};
	const node = new SentinelOneAlertsTrigger();
	const manual = createNodeContext(params, request);
	const result = await node.poll.call(manual);
	assert.equal(result[0][0].json.noteId, null);
	assert.equal(result[0][0].json.activityId, 'event');
	assert.equal(result[0][0].json.noteText, 'Content from SDL');
	assert.equal(manual.staticData.sentinelOneTrigger, undefined);
	const scheduled = createNodeContext(params, request, 'trigger');
	assert.equal(await node.poll.call(scheduled), null);
	assert.match(scheduled.staticData.sentinelOneTrigger.configFingerprint, /:sdl-notes-v2$/);
	assert.ok(sdlCalls > 2);
});
