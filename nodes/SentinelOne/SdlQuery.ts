import {
	sleep as workflowSleep,
	type IDataObject,
	type IExecuteFunctions,
	type IHttpRequestOptions,
} from 'n8n-workflow';

const CREDENTIAL_TYPE = 'sentinelOneAlertsApi';
const FORWARD_HEADER = 'x-dataset-query-forward-tag';
const MAX_FORWARD_HEADER_LENGTH = 1024;
const REQUEST_TIMEOUT_MS = 30_000;
const CLEANUP_TIMEOUT_MS = 1_000;
const MAX_RETRY_DELAY_MS = 10_000;

type CleanupStatus = 'request_accepted' | 'failed' | 'timed_out';
type PartialReason =
	| 'server_time_limit'
	| 'omitted_events'
	| 'discarded_array_items'
	| 'external_result_unfetched'
	| 'row_limit'
	| 'output_size_limit';

interface FullResponse {
	body: unknown;
	headers: IDataObject;
	statusCode: number;
}

interface TableResult {
	columns: IDataObject[];
	values: unknown[][];
	metadata: IDataObject;
}

interface ResultQuality {
	warnings: string[];
	omittedEvents: number;
	discardedArrayItems: number;
	partialDueToTimeLimit: boolean;
	externalResult: boolean;
}

interface LifecycleAbort {
	signal: AbortSignal;
	deadlineExpired: () => boolean;
}

class ResponseProtocolError extends Error {
	constructor(readonly safeReason: string) {
		super(`SentinelOne SDL query ${safeReason}`);
	}
}

function asRecord(value: unknown): IDataObject | undefined {
	return value !== null && typeof value === 'object' && !Array.isArray(value)
		? (value as IDataObject)
		: undefined;
}

function safeError(message: string): Error {
	return new Error(`SentinelOne SDL query ${message}`);
}

function responseProtocolError(message: string): ResponseProtocolError {
	return new ResponseProtocolError(message);
}

function requireString(value: unknown, label: string): string {
	if (typeof value !== 'string' || !value.trim()) throw safeError(`requires ${label}`);
	return value.trim();
}

function requireQueryId(value: unknown): string {
	const queryId = requireString(value, 'a query ID in the launch response');
	if (queryId.length > 256 || !/^[A-Za-z0-9._:-]+$/.test(queryId))
		throw safeError('launch returned an invalid query ID');
	return queryId;
}

function requireInteger(
	value: unknown,
	defaultValue: number,
	minimum: number,
	maximum: number,
	label: string,
): number {
	const resolved =
		value === undefined || value === null || value === '' ? defaultValue : Number(value);
	if (!Number.isSafeInteger(resolved) || resolved < minimum || resolved > maximum)
		throw safeError(`${label} must be an integer from ${minimum} to ${maximum}`);
	return resolved;
}

function parseDate(value: unknown, label: string): Date {
	const input = requireString(value, label);
	const date = new Date(input);
	if (!Number.isFinite(date.getTime())) throw safeError(`requires a valid ${label}`);
	return date;
}

function quoteUnsafeIntegers(json: string): string {
	let output = '';
	let index = 0;
	let inString = false;
	let escaped = false;
	while (index < json.length) {
		const character = json[index];
		if (inString) {
			output += character;
			if (escaped) escaped = false;
			else if (character === '\\') escaped = true;
			else if (character === '"') inString = false;
			index++;
			continue;
		}
		if (character === '"') {
			inString = true;
			output += character;
			index++;
			continue;
		}
		if (character === '-' || (character >= '0' && character <= '9')) {
			const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(json.slice(index));
			if (match) {
				const token = match[0];
				const numericValue = Number(token);
				if (!Number.isFinite(numericValue) || Math.abs(numericValue) > Number.MAX_SAFE_INTEGER) {
					output += JSON.stringify(token);
					index += token.length;
					continue;
				}
				output += token;
				index += token.length;
				continue;
			}
		}
		output += character;
		index++;
	}
	return output;
}

function validateAlreadyParsedNumbers(value: unknown): void {
	if (typeof value === 'number' && Number.isInteger(value) && !Number.isSafeInteger(value))
		throw responseProtocolError(
			'received already-parsed unsafe integers; a text response is required',
		);
	if (Array.isArray(value)) {
		for (const item of value) validateAlreadyParsedNumbers(item);
	} else {
		const record = asRecord(value);
		if (record) for (const item of Object.values(record)) validateAlreadyParsedNumbers(item);
	}
}

function boundResponseBody(value: unknown, maximumBytes: number): unknown {
	if (value === undefined || value === null || value === '') return null;
	if (typeof value === 'string' || Buffer.isBuffer(value)) {
		const text = typeof value === 'string' ? value : value.toString('utf8');
		if (Buffer.byteLength(text, 'utf8') > maximumBytes)
			throw responseProtocolError('response exceeded the configured response-size limit');
		return value;
	}
	if (jsonBytes(value) > maximumBytes)
		throw responseProtocolError('response exceeded the configured response-size limit');
	return value;
}

function decodeResponseBody(value: unknown): unknown {
	if (value === undefined || value === null || value === '') return null;
	if (typeof value === 'string' || Buffer.isBuffer(value)) {
		const text = typeof value === 'string' ? value : value.toString('utf8');
		try {
			return JSON.parse(quoteUnsafeIntegers(text));
		} catch {
			throw responseProtocolError('received an invalid JSON response');
		}
	}
	validateAlreadyParsedNumbers(value);
	return value;
}

function fullResponse(value: unknown, maximumBytes: number): FullResponse {
	const wrapper = asRecord(value);
	if (!wrapper) throw safeError('received an invalid HTTP response');
	const statusCode = wrapper.statusCode === undefined ? 200 : Number(wrapper.statusCode);
	if (!Number.isInteger(statusCode) || statusCode < 100 || statusCode > 599)
		throw safeError('received an invalid HTTP status');
	return {
		body: boundResponseBody(
			Object.prototype.hasOwnProperty.call(wrapper, 'body') ? wrapper.body : wrapper,
			maximumBytes,
		),
		headers: asRecord(wrapper.headers) ?? {},
		statusCode,
	};
}

function readForwardTag(headers: IDataObject): string | undefined {
	const entry = Object.entries(headers).find(([name]) => name.toLowerCase() === FORWARD_HEADER);
	if (!entry) return undefined;
	const value = entry[1];
	if (
		typeof value !== 'string' ||
		!value ||
		value.length > MAX_FORWARD_HEADER_LENGTH ||
		!/^[\x20-\x7e]+$/.test(value)
	)
		throw safeError('received an invalid query routing header');
	return value;
}

function createLifecycleAbort(parent: AbortSignal | undefined, timeoutMs: number): LifecycleAbort {
	const deadlineSignal = AbortSignal.timeout(timeoutMs);
	return {
		signal: parent ? AbortSignal.any([parent, deadlineSignal]) : deadlineSignal,
		deadlineExpired: () => deadlineSignal.aborted,
	};
}

function remainingMilliseconds(deadline: number): number {
	const remaining = deadline - Date.now();
	if (remaining <= 0) throw safeError('exceeded its execution deadline');
	return Math.max(1, Math.min(REQUEST_TIMEOUT_MS, remaining));
}

async function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
	if (signal.aborted) throw safeError('was cancelled');
	let onAbort: (() => void) | undefined;
	try {
		await Promise.race([
			workflowSleep(milliseconds),
			new Promise<never>((_resolve, reject) => {
				onAbort = () => reject(safeError('was cancelled'));
				signal.addEventListener('abort', onAbort, { once: true });
			}),
		]);
	} finally {
		if (onAbort) signal.removeEventListener('abort', onAbort);
	}
}

function isComplete(payload: IDataObject): boolean {
	return (
		typeof payload.stepsTotal === 'number' &&
		Number.isFinite(payload.stepsTotal) &&
		payload.stepsTotal > 0 &&
		typeof payload.stepsCompleted === 'number' &&
		Number.isFinite(payload.stepsCompleted) &&
		payload.stepsCompleted >= payload.stepsTotal &&
		asRecord(payload.data) !== undefined
	);
}

function updateLastStepSeen(payload: IDataObject, current: number): number {
	const value = payload.stepsCompleted;
	if (value === undefined || value === null) return current;
	if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
		throw safeError('received invalid query progress');
	return Math.max(current, value);
}

function validateQueryId(payload: IDataObject, queryId: string): void {
	if (payload.id !== undefined && payload.id !== queryId)
		throw safeError('received a mismatched query ID');
}

function validateNoQueryErrors(payload: IDataObject): void {
	for (const source of [payload, asRecord(payload.data)]) {
		if (!source) continue;
		const errors = source.errors;
		if (errors !== undefined && errors !== null && (!Array.isArray(errors) || errors.length > 0))
			throw safeError('received query errors');
	}
}

function retryableStatus(status: number): boolean {
	return status === 404 || status === 429 || status >= 500;
}

function statusFailure(stage: 'launch' | 'poll', status: number): Error {
	return safeError(`${stage} failed with HTTP ${status}`);
}

function jsonBytes(value: unknown): number {
	let encoded: string | undefined;
	try {
		encoded = JSON.stringify(value);
	} catch {
		throw safeError('received data that cannot be represented as JSON');
	}
	if (encoded === undefined) throw safeError('received data that cannot be represented as JSON');
	return Buffer.byteLength(encoded, 'utf8');
}

function nonNegativeInteger(value: unknown, label: string): number {
	if (value === undefined || value === null) return 0;
	if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
		throw safeError(`received an invalid ${label}`);
	return value;
}

function stringWarnings(value: unknown): string[] {
	if (value === undefined || value === null) return [];
	if (!Array.isArray(value) || value.some((warning) => typeof warning !== 'string'))
		throw safeError('received invalid query warnings');
	return [...value];
}

function resolveIntegerField(
	payload: IDataObject,
	data: IDataObject,
	field: string,
	label: string,
): number {
	const values = [payload[field], data[field]]
		.filter((value) => value !== undefined && value !== null)
		.map((value) => nonNegativeInteger(value, label));
	if (values.length > 1 && values[0] !== values[1])
		throw safeError(`received conflicting ${label} values`);
	return values[0] ?? 0;
}

function resolvePartialFlag(payload: IDataObject, data: IDataObject): boolean {
	const values = [payload.partialResultsDueToTimeLimit, data.partialResultsDueToTimeLimit].filter(
		(value) => value !== undefined && value !== null,
	);
	if (values.some((value) => typeof value !== 'boolean'))
		throw safeError('received an invalid partial-result flag');
	if (values.length > 1 && values[0] !== values[1])
		throw safeError('received conflicting partial-result flags');
	return values[0] === true;
}

function resolveExternalResult(payload: IDataObject, data: IDataObject): boolean {
	const values = [payload.fullResultUrl, data.fullResultUrl].filter(
		(value) => value !== undefined && value !== null && value !== '',
	);
	if (values.some((value) => typeof value !== 'string'))
		throw safeError('received an invalid external result URL');
	if (values.length > 1 && values[0] !== values[1])
		throw safeError('received conflicting external result URLs');
	return values.length > 0;
}

function collectQuality(payload: IDataObject, data: IDataObject): ResultQuality {
	validateNoQueryErrors(payload);
	const warnings = [...stringWarnings(payload.warnings), ...stringWarnings(data.warnings)].filter(
		(warning, index, all) => all.indexOf(warning) === index,
	);
	return {
		warnings,
		omittedEvents: resolveIntegerField(payload, data, 'omittedEvents', 'omitted event count'),
		discardedArrayItems: resolveIntegerField(
			payload,
			data,
			'discardedArrayItems',
			'discarded array item count',
		),
		partialDueToTimeLimit: resolvePartialFlag(payload, data),
		externalResult: resolveExternalResult(payload, data),
	};
}

function collectTable(payload: IDataObject, queryId: string): TableResult {
	const data = asRecord(payload.data);
	if (!data) throw safeError('completed without result data');
	const quality = collectQuality(payload, data);
	const columnsValue = data.columns;
	const valuesValue = data.values;
	if (quality.externalResult && columnsValue === undefined && valuesValue === undefined) {
		return {
			columns: [],
			values: [],
			metadata: buildMetadata(payload, data, quality, queryId, ['external_result_unfetched'], 0),
		};
	}
	if (!Array.isArray(columnsValue) || !Array.isArray(valuesValue))
		throw safeError('returned an invalid result table');
	const columns = columnsValue.map((column) => {
		const descriptor = asRecord(column);
		if (!descriptor || typeof descriptor.name !== 'string')
			throw safeError('returned an invalid result column');
		return descriptor;
	});
	const values = valuesValue.map((row) => {
		if (!Array.isArray(row) || row.length !== columns.length)
			throw safeError('returned a result row with the wrong number of columns');
		return row;
	});
	const reasons: PartialReason[] = [];
	if (quality.partialDueToTimeLimit) reasons.push('server_time_limit');
	if (quality.omittedEvents > 0) reasons.push('omitted_events');
	if (quality.discardedArrayItems > 0) reasons.push('discarded_array_items');
	if (quality.externalResult) reasons.push('external_result_unfetched');
	return {
		columns,
		values,
		metadata: buildMetadata(payload, data, quality, queryId, reasons, values.length),
	};
}

function buildMetadata(
	payload: IDataObject,
	data: IDataObject,
	quality: ResultQuality,
	queryId: string,
	reasons: PartialReason[],
	resultRows: number,
): IDataObject {
	return {
		queryId,
		partial: reasons.length > 0,
		partialReasons: reasons,
		warnings: quality.warnings,
		matchingEvents: data.matchCount ?? payload.matchCount ?? null,
		omittedEvents: quality.omittedEvents,
		discardedArrayItems: quality.discardedArrayItems,
		cpuUsage: payload.cpuUsage ?? null,
		resultRows,
		returnedRows: resultRows,
		truncatedRows: 0,
	};
}

function addPartialReason(metadata: IDataObject, reason: PartialReason): void {
	const reasons = metadata.partialReasons as PartialReason[];
	if (!reasons.includes(reason)) reasons.push(reason);
	metadata.partial = true;
}

function safeColumnKeys(columns: IDataObject[]): string[] {
	const used = new Set<string>(['_query']);
	return columns.map((column, index) => {
		const base = (column.name as string) || `column_${index + 1}`;
		let candidate = base;
		let suffix = 2;
		while (used.has(candidate)) candidate = `${base}__${suffix++}`;
		used.add(candidate);
		return candidate;
	});
}

function rowObject(keys: string[], row: unknown[], metadata: IDataObject): IDataObject {
	const output = Object.create(null) as IDataObject;
	for (let index = 0; index < keys.length; index++) output[keys[index]] = row[index] as never;
	output._query = metadata;
	return output;
}

function outputForRows(
	columns: IDataObject[],
	values: unknown[][],
	metadata: IDataObject,
	count: number,
): IDataObject[] {
	metadata.returnedRows = count;
	metadata.truncatedRows = values.length - count;
	const keys = safeColumnKeys(columns);
	if (count === 0) return [{ _query: metadata }];
	return values.slice(0, count).map((row) => rowObject(keys, row, metadata));
}

function outputForTable(
	columns: IDataObject[],
	values: unknown[][],
	metadata: IDataObject,
	count: number,
): IDataObject[] {
	metadata.returnedRows = count;
	metadata.truncatedRows = values.length - count;
	return [{ queryId: metadata.queryId, columns, values: values.slice(0, count), metadata }];
}

function boundOutput(
	mode: 'rows' | 'table',
	table: TableResult,
	maxRows: number,
	maxBytes: number,
	itemIndex: number,
): IDataObject[] {
	let count = Math.min(table.values.length, maxRows);
	if (count < table.values.length) addPartialReason(table.metadata, 'row_limit');
	const create = (rowCount: number) =>
		mode === 'rows'
			? outputForRows(table.columns, table.values, table.metadata, rowCount)
			: outputForTable(table.columns, table.values, table.metadata, rowCount);
	const wrappedBytes = (output: IDataObject[]) =>
		jsonBytes(output.map((json) => ({ json, pairedItem: { item: itemIndex } })));
	let output = create(count);
	if (wrappedBytes(output) <= maxBytes) return output;
	addPartialReason(table.metadata, 'output_size_limit');
	let low = 0;
	let high = count;
	while (low < high) {
		const middle = Math.ceil((low + high) / 2);
		if (wrappedBytes(create(middle)) <= maxBytes) low = middle;
		else high = middle - 1;
	}
	count = low;
	output = create(count);
	if (wrappedBytes(output) > maxBytes)
		throw safeError('metadata exceeds the configured output-size limit');
	return output;
}

async function cleanupQuery(
	context: IExecuteFunctions,
	url: string,
	headers: IDataObject,
): Promise<CleanupStatus> {
	const cleanupSignal = AbortSignal.timeout(CLEANUP_TIMEOUT_MS);
	try {
		const response = fullResponse(
			await context.helpers.httpRequest({
				url,
				method: 'DELETE',
				headers,
				json: false,
				encoding: 'text',
				returnFullResponse: true,
				ignoreHttpStatusErrors: true,
				sendCredentialsOnCrossOriginRedirect: false,
				timeout: CLEANUP_TIMEOUT_MS,
				abortSignal: cleanupSignal,
			}),
			1024 * 1024,
		);
		return response.statusCode >= 200 && response.statusCode < 300 ? 'request_accepted' : 'failed';
	} catch {
		return cleanupSignal.aborted ? 'timed_out' : 'failed';
	}
}

function cleanupWarning(status: CleanupStatus): string | undefined {
	if (status === 'failed') return 'SentinelOne did not confirm query cleanup.';
	if (status === 'timed_out') return 'SentinelOne query cleanup timed out before confirmation.';
	return undefined;
}

export async function executeSdlQuery(
	context: IExecuteFunctions,
	itemIndex: number,
): Promise<IDataObject[]> {
	const query = requireString(context.getNodeParameter('query', itemIndex), 'a query');
	const start = parseDate(context.getNodeParameter('startTime', itemIndex), 'start time');
	const end = parseDate(context.getNodeParameter('endTime', itemIndex), 'end time');
	if (end.getTime() <= start.getTime())
		throw safeError('requires an end time after its start time');
	const queryScope = context.getNodeParameter('queryScope', itemIndex) as string;
	if (queryScope !== 'tenant' && queryScope !== 'accounts')
		throw safeError('requires a valid query scope');
	const accountIdsValue = context.getNodeParameter('accountIds', itemIndex, []) as unknown;
	const accountIds = Array.isArray(accountIdsValue)
		? accountIdsValue.map((value) => requireString(value, 'valid account IDs'))
		: [];
	if (queryScope === 'accounts' && accountIds.length === 0)
		throw safeError('requires at least one account ID for account scope');
	const outputMode = context.getNodeParameter('outputMode', itemIndex, 'rows') as string;
	if (outputMode !== 'rows' && outputMode !== 'table')
		throw safeError('requires a valid output mode');
	const options = asRecord(context.getNodeParameter('options', itemIndex, {})) ?? {};
	const timeoutSeconds = requireInteger(options.timeoutSeconds, 100, 10, 300, 'timeoutSeconds');
	const pollIntervalMs = requireInteger(
		options.pollIntervalMs,
		1500,
		1000,
		10_000,
		'pollIntervalMs',
	);
	const maxRows = requireInteger(options.maxRows, 5000, 1, 100_000, 'maxRows');
	const maxResponseSizeMiB = requireInteger(
		options.maxResponseSizeMiB,
		10,
		1,
		50,
		'maxResponseSizeMiB',
	);
	const maxResponseBytes = maxResponseSizeMiB * 1024 * 1024;
	const credentials = await context.getCredentials<{ baseUrl?: unknown; apiToken?: unknown }>(
		CREDENTIAL_TYPE,
		itemIndex,
	);
	const baseUrl = requireString(credentials.baseUrl, 'a configured console URL').replace(
		/\/+$/,
		'',
	);
	const apiToken = requireString(credentials.apiToken, 'a configured API token');
	const endpoint = `${baseUrl}/sdl/v2/api/queries`;
	const commonHeaders: IDataObject = {
		Authorization: `Bearer ${apiToken}`,
		'Content-Type': 'application/json',
	};
	const parentSignal = context.getExecutionCancelSignal();
	const lifecycle = createLifecycleAbort(parentSignal, timeoutSeconds * 1000);
	const deadline = Date.now() + timeoutSeconds * 1000;
	let queryId: string | undefined;
	let forwardTag: string | undefined;
	let completedPayload: IDataObject | undefined;
	let primaryFailure: unknown;
	let cleanupStatus: CleanupStatus | undefined;
	const routedHeaders = () => ({
		...commonHeaders,
		...(forwardTag ? { [FORWARD_HEADER]: forwardTag } : {}),
	});
	const request = async (requestOptions: IHttpRequestOptions): Promise<FullResponse> =>
		fullResponse(
			await context.helpers.httpRequest({
				...requestOptions,
				returnFullResponse: true,
				ignoreHttpStatusErrors: true,
				json: false,
				encoding: 'text',
				sendCredentialsOnCrossOriginRedirect: false,
				abortSignal: lifecycle.signal,
			}),
			maxResponseBytes,
		);
	try {
		let response: FullResponse;
		try {
			response = await request({
				url: endpoint,
				method: 'POST',
				headers: commonHeaders,
				timeout: remainingMilliseconds(deadline),
				body: {
					queryType: 'PQ',
					startTime: start.toISOString(),
					endTime: end.toISOString(),
					pq: { query, resultType: 'TABLE' },
					...(queryScope === 'tenant' ? { tenant: true } : { tenant: false, accountIds }),
				},
			});
		} catch {
			if (parentSignal?.aborted) throw safeError('was cancelled during launch');
			if (lifecycle.deadlineExpired())
				throw safeError('exceeded its execution deadline during launch');
			throw safeError('launch request failed');
		}
		if (response.statusCode < 200 || response.statusCode >= 300)
			throw statusFailure('launch', response.statusCode);
		const launchPayload = asRecord(decodeResponseBody(response.body));
		if (!launchPayload) throw safeError('launch returned an invalid response body');
		queryId = requireQueryId(launchPayload.id);
		forwardTag = readForwardTag(response.headers);
		if (!forwardTag) throw safeError('launch response omitted its query routing header');
		validateQueryId(launchPayload, queryId);
		validateNoQueryErrors(launchPayload);
		let payload = launchPayload;
		let lastStepSeen = updateLastStepSeen(payload, 0);
		let retryCount = 0;
		let nextDelayMs = pollIntervalMs;
		while (!isComplete(payload)) {
			if (parentSignal?.aborted) throw safeError('was cancelled');
			if (lifecycle.deadlineExpired() || Date.now() >= deadline)
				throw safeError('exceeded its execution deadline');
			await delay(Math.min(nextDelayMs, remainingMilliseconds(deadline)), lifecycle.signal).catch(
				() => {
					if (parentSignal?.aborted) throw safeError('was cancelled');
					throw safeError('exceeded its execution deadline');
				},
			);
			let pollResponse: FullResponse;
			try {
				pollResponse = await request({
					url: `${endpoint}/${encodeURIComponent(queryId)}`,
					method: 'GET',
					headers: routedHeaders(),
					qs: { lastStepSeen },
					timeout: remainingMilliseconds(deadline),
				});
			} catch (error) {
				if (error instanceof ResponseProtocolError) throw safeError(error.safeReason);
				if (parentSignal?.aborted) throw safeError('was cancelled during polling');
				if (lifecycle.deadlineExpired() || Date.now() >= deadline)
					throw safeError('exceeded its execution deadline during polling');
				retryCount++;
				nextDelayMs = Math.min(
					MAX_RETRY_DELAY_MS,
					pollIntervalMs * 2 ** Math.min(retryCount - 1, 10),
				);
				continue;
			}
			const replacementTag = readForwardTag(pollResponse.headers);
			if (replacementTag) forwardTag = replacementTag;
			if (pollResponse.statusCode < 200 || pollResponse.statusCode >= 300) {
				if (!retryableStatus(pollResponse.statusCode))
					throw statusFailure('poll', pollResponse.statusCode);
				retryCount++;
				nextDelayMs = Math.min(
					MAX_RETRY_DELAY_MS,
					pollIntervalMs * 2 ** Math.min(retryCount - 1, 10),
				);
				continue;
			}
			retryCount = 0;
			nextDelayMs = pollIntervalMs;
			const pollPayload = asRecord(decodeResponseBody(pollResponse.body));
			if (!pollPayload) throw safeError('poll returned an invalid response body');
			validateQueryId(pollPayload, queryId);
			validateNoQueryErrors(pollPayload);
			lastStepSeen = updateLastStepSeen(pollPayload, lastStepSeen);
			payload = pollPayload;
		}
		completedPayload = payload;
	} catch (error) {
		primaryFailure = error;
	} finally {
		if (queryId) {
			cleanupStatus = await cleanupQuery(
				context,
				`${endpoint}/${encodeURIComponent(queryId)}`,
				routedHeaders(),
			);
		}
	}
	if (primaryFailure !== undefined) {
		if (queryId && cleanupStatus) {
			const message =
				primaryFailure instanceof Error &&
				primaryFailure.message.startsWith('SentinelOne SDL query ')
					? primaryFailure.message
					: 'SentinelOne SDL query failed';
			throw new Error(`${message}; queryId=${queryId}; cleanupStatus=${cleanupStatus}`);
		}
		throw primaryFailure;
	}
	if (!completedPayload || !queryId || !cleanupStatus)
		throw safeError('ended without a completed query result');
	const table = collectTable(completedPayload, queryId);
	table.metadata.cleanupStatus = cleanupStatus;
	const warning = cleanupWarning(cleanupStatus);
	if (warning) (table.metadata.warnings as string[]).push(warning);
	return boundOutput(outputMode, table, maxRows, maxResponseBytes, itemIndex);
}
