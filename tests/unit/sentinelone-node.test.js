const assert = require('node:assert/strict');
const test = require('node:test');

const { SentinelOneAlerts } = require('../../dist/nodes/SentinelOne/SentinelOneAlerts.node.js');
const { routeSentinelOneOperation } = require('../../dist/nodes/SentinelOne/router.js');

const ACCOUNT_ID = '90071992547409930001';
const ALERT_ID = '018e1efe-6784-7c0f-893f-b8b8e740a6cd';

const workflowNode = {
	id: 'sentinel-one',
	name: 'SentinelOne',
	type: 'n8n-nodes-sentinelone-alerts.sentinelOneAlerts',
	typeVersion: 1,
	position: [0, 0],
	parameters: {},
};

function alert(id = ALERT_ID, accountId = ACCOUNT_ID) {
	return {
		id,
		status: 'NEW',
		realTime: {
			scope: {
				account: { id: accountId },
				site: { id: 'site-1' },
				group: { id: 'group-1' },
			},
		},
	};
}

function getManyEnvelope(alerts) {
	return {
		data: {
			alerts: {
				edges: alerts.map((node, index) => ({ cursor: `cursor-${index}`, node })),
				pageInfo: { hasNextPage: false, endCursor: null },
				totalCount: alerts.length,
			},
		},
	};
}

function executionContext(parametersByItem, request, { continueOnFail = false } = {}) {
	return {
		continueOnFail: () => continueOnFail,
		getCredentials: async () => ({
			baseUrl: 'https://tenant.example/',
			apiToken: 'never-return-this',
		}),
		getInputData: () => parametersByItem.map((parameters) => ({ json: parameters.input ?? {} })),
		getNode: () => workflowNode,
		getNodeParameter(name, itemIndex, fallback) {
			const parameters = parametersByItem[itemIndex] ?? {};
			return Object.prototype.hasOwnProperty.call(parameters, name) ? parameters[name] : fallback;
		},
		helpers: {
			httpRequestWithAuthentication: request,
		},
	};
}

function alertParameters(overrides = {}) {
	return {
		resource: 'alert',
		operation: 'get',
		scopeType: 'ACCOUNT',
		scopeIds: [ACCOUNT_ID],
		alertId: ALERT_ID,
		...overrides,
	};
}

function propertiesByName(description, name) {
	return description.properties.filter((property) => property.name === name);
}

test('action node description exposes the intended v1 resources, operations, and defaults', () => {
	const { description } = new SentinelOneAlerts();

	assert.equal(description.displayName, 'SentinelOne Alerts');
	assert.equal(description.name, 'sentinelOneAlerts');
	assert.equal(description.version, 1);
	assert.deepEqual(description.icon, {
		light: 'file:../SentinelOneAlertsTrigger/sentinelone.svg',
		dark: 'file:../SentinelOneAlertsTrigger/sentinelone.dark.svg',
	});
	assert.deepEqual(description.inputs, ['main']);
	assert.deepEqual(description.outputs, ['main']);
	assert.deepEqual(description.credentials, [{ name: 'sentinelOneAlertsApi', required: true }]);
	assert.equal(description.usableAsTool, true);

	const [resource] = propertiesByName(description, 'resource');
	assert.equal(resource.default, 'alert');
	assert.deepEqual(
		resource.options.map(({ name, value }) => ({ name, value })),
		[
			{ name: 'Alert Note', value: 'alertNote' },
			{ name: 'SDL Query', value: 'sdlQuery' },
			{ name: 'Alert', value: 'alert' },
		],
	);

	const operations = propertiesByName(description, 'operation');
	assert.deepEqual(
		operations.map((property) => ({
			resource: property.displayOptions.show.resource,
			default: property.default,
			values: property.options.map((option) => option.value),
		})),
		[
			{ resource: ['alert'], default: 'get', values: ['get', 'getAll', 'update'] },
			{ resource: ['alertNote'], default: 'getAll', values: ['create', 'getAll'] },
			{ resource: ['sdlQuery'], default: 'execute', values: ['execute'] },
		],
	);

	const [scopeType] = propertiesByName(description, 'scopeType');
	assert.equal(scopeType.default, 'ACCOUNT');
	assert.deepEqual(scopeType.displayOptions.show.resource, ['alertNote', 'alert']);
	assert.deepEqual(
		scopeType.options.map((option) => option.value),
		['ACCOUNT', 'GROUP', 'SITE'],
	);

	const scopeIds = propertiesByName(description, 'scopeIds');
	assert.equal(scopeIds.length, 3);
	assert.deepEqual(
		scopeIds.map((property) => ({
			default: property.default,
			resource: property.displayOptions.show.resource,
			scopeType: property.displayOptions.show.scopeType,
			loadOptionsMethod: property.typeOptions.loadOptionsMethod,
		})),
		[
			{
				default: [],
				resource: ['alertNote', 'alert'],
				scopeType: ['ACCOUNT'],
				loadOptionsMethod: 'getAccounts',
			},
			{
				default: [],
				resource: ['alertNote', 'alert'],
				scopeType: ['GROUP'],
				loadOptionsMethod: 'getGroups',
			},
			{
				default: [],
				resource: ['alertNote', 'alert'],
				scopeType: ['SITE'],
				loadOptionsMethod: 'getSites',
			},
		],
	);

	assert.deepEqual(
		propertiesByName(description, 'alertId').map((property) => property.displayOptions.show),
		[{ resource: ['alert'], operation: ['get', 'update'] }, { resource: ['alertNote'] }],
	);
	const [queryScope] = propertiesByName(description, 'queryScope');
	const [accountIds] = propertiesByName(description, 'accountIds');
	const [outputMode] = propertiesByName(description, 'outputMode');
	assert.equal(queryScope.default, 'tenant');
	assert.deepEqual(accountIds.default, []);
	assert.deepEqual(accountIds.displayOptions.show, {
		resource: ['sdlQuery'],
		operation: ['execute'],
		queryScope: ['accounts'],
	});
	assert.equal(outputMode.default, 'rows');
	assert.deepEqual(
		outputMode.options.map((option) => option.value),
		['rows', 'table'],
	);
});

test('router dispatches Alert Get and preserves the selected scope', async () => {
	let requestOptions;
	const context = executionContext([alertParameters()], async (_credentialName, options) => {
		requestOptions = options;
		return { data: { alert: alert() } };
	});

	const result = await routeSentinelOneOperation(context, 0);

	assert.deepEqual(result, [alert()]);
	assert.equal(requestOptions.method, 'POST');
	assert.equal(requestOptions.url, 'https://tenant.example/web/api/v2.1/unifiedalerts/graphql');
	assert.deepEqual(requestOptions.body.variables, {
		id: ALERT_ID,
		scope: { scopeType: 'ACCOUNT', scopeIds: [ACCOUNT_ID] },
	});
});

test('execute pairs every fanned-out result with its source input item', async () => {
	const accountTwo = '1926617403027401041';
	const parameters = [
		alertParameters({
			operation: 'getAll',
			returnAll: false,
			limit: 50,
			filters: {},
		}),
		alertParameters({
			operation: 'getAll',
			scopeIds: [accountTwo],
			returnAll: false,
			limit: 50,
			filters: {},
		}),
	];
	const node = new SentinelOneAlerts();
	const result = await node.execute.call(
		executionContext(parameters, async (_credentialName, options) => {
			const accountId = options.body.variables.scope.scopeIds[0];
			return accountId === ACCOUNT_ID
				? getManyEnvelope([alert('alert-1'), alert('alert-2')])
				: getManyEnvelope([alert('alert-3', accountTwo)]);
		}),
	);

	assert.deepEqual(
		result[0].map(({ json, pairedItem }) => ({ id: json.id, pairedItem })),
		[
			{ id: 'alert-1', pairedItem: { item: 0 } },
			{ id: 'alert-2', pairedItem: { item: 0 } },
			{ id: 'alert-3', pairedItem: { item: 1 } },
		],
	);
});

test('execute emits no item when an operation returns no values', async () => {
	const node = new SentinelOneAlerts();
	const result = await node.execute.call(
		executionContext(
			[
				alertParameters({
					operation: 'getAll',
					returnAll: false,
					limit: 50,
					filters: {},
				}),
			],
			async () => getManyEnvelope([]),
		),
	);

	assert.deepEqual(result, [[]]);
});

test('Continue On Fail links an HTTP-200 GraphQL error to its input and continues', async () => {
	const secondAlertId = '018e1efe-6784-7c0f-893f-b8b8e740a6ce';
	const node = new SentinelOneAlerts();
	const result = await node.execute.call(
		executionContext(
			[alertParameters(), alertParameters({ alertId: secondAlertId })],
			async (_credentialName, options) => {
				if (options.body.variables.id === ALERT_ID) {
					return {
						data: { alert: alert() },
						errors: [
							{ message: `Access denied for ${ALERT_ID}`, extensions: { code: 'FORBIDDEN' } },
						],
					};
				}
				return { data: { alert: alert(secondAlertId) } };
			},
			{ continueOnFail: true },
		),
	);

	assert.equal(result[0].length, 2);
	assert.deepEqual(result[0][0].pairedItem, { item: 0 });
	assert.match(result[0][0].json.error, /GraphQL operation failed/);
	assert.doesNotMatch(result[0][0].json.error, new RegExp(ALERT_ID));
	assert.equal(result[0][0].error.context.itemIndex, 0);
	assert.equal(result[0][1].json.id, secondAlertId);
	assert.deepEqual(result[0][1].pairedItem, { item: 1 });
});

test('router rejects unsupported resource and operation pairs with the item index', async () => {
	const context = executionContext(
		[{}, {}, {}, {}, { resource: 'alert', operation: 'delete' }],
		async () => {
			throw new Error('request should not run');
		},
	);

	await assert.rejects(routeSentinelOneOperation(context, 4), (error) => {
		assert.match(error.message, /Unsupported SentinelOne operation: alert\.delete/);
		assert.equal(error.context.itemIndex, 4);
		return true;
	});
});

test('router rejects prototype property names as unsupported operations', async () => {
	for (const parameters of [
		{ resource: '__proto__', operation: 'toString' },
		{ resource: 'alert', operation: '__proto__' },
	]) {
		const context = executionContext([parameters], async () => {
			throw new Error('request should not run');
		});
		await assert.rejects(
			routeSentinelOneOperation(context, 0),
			/Unsupported SentinelOne operation/,
		);
	}
});

test('Continue On Fail preserves an indeterminate note mutation outcome', async () => {
	const submittedText = 'secret note with "quotes" and \\slashes';
	const parameters = {
		resource: 'alertNote',
		operation: 'create',
		scopeType: 'ACCOUNT',
		scopeIds: [ACCOUNT_ID],
		alertId: ALERT_ID,
		text: submittedText,
		contentType: 'MARKDOWN',
	};
	const node = new SentinelOneAlerts();
	const result = await node.execute.call(
		executionContext(
			[parameters],
			async (_credentialName, options) => {
				const query = options.body.query;
				if (query.includes('SentinelOneGetAlertNotes')) {
					return { data: { alertNotes: { data: [] } } };
				}
				if (query.includes('SentinelOneGetAlert')) return { data: { alert: alert() } };
				if (query.includes('SentinelOneCreateAlertNote')) {
					return {
						data: { addAlertNote: { data: [] } },
						errors: [
							{
								message: `Mutation failed for ${JSON.stringify(submittedText)}`,
								extensions: { code: 'INTERNAL_SERVER_ERROR' },
							},
						],
					};
				}
				throw new Error('unexpected request');
			},
			{ continueOnFail: true },
		),
	);

	assert.equal(result[0].length, 1);
	assert.equal(result[0][0].json.outcome, 'unknown');
	assert.equal(result[0][0].json.mayHaveCommitted, true);
	assert.deepEqual(result[0][0].pairedItem, { item: 0 });
	assert.doesNotMatch(JSON.stringify(result[0][0].json), /secret note|quotes|slashes/);
});
