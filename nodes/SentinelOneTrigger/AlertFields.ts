import type { IDataObject, INodePropertyOptions } from 'n8n-workflow';

const fields: Record<string, { name: string; selection: string }> = {
	analystVerdict: { name: 'Analyst Verdict', selection: 'analystVerdict' },
	analytics: { name: 'Analytics', selection: 'analytics { category name typeValue uid }' },
	assignee: { name: 'Assignee', selection: 'assignee { userId fullName email }' },
	attackPathExists: { name: 'Attack Path Exists', selection: 'attackPathExists' },
	attackSurfaces: { name: 'Attack Surfaces', selection: 'attackSurfaces' },
	availableActionIds: { name: 'Available Action IDs', selection: 'availableActionIds' },
	classification: { name: 'Classification', selection: 'classification' },
	confidenceLevel: { name: 'Confidence Level', selection: 'confidenceLevel' },
	dataSources: { name: 'Data Sources', selection: 'dataSources' },
	description: { name: 'Description', selection: 'description' },
	detectionSource: { name: 'Detection Source', selection: 'detectionSource { product vendor }' },
	labels: { name: 'Labels', selection: 'labels' },
	primaryIndicatorType: { name: 'Primary Indicator Type', selection: 'primaryIndicatorType' },
	result: { name: 'Result', selection: 'result' },
	storylineId: { name: 'Storyline ID', selection: 'storylineId' },
	ticketId: { name: 'Ticket ID', selection: 'ticketId' },
};

export const additionalAlertFieldOptions: INodePropertyOptions[] = Object.entries(fields).map(
	([value, field]) => ({ name: field.name, value }),
);

export function selectedAlertFields(selected: unknown): string[] {
	if (selected === undefined) return [];
	if (
		!Array.isArray(selected) ||
		selected.some(
			(field) => typeof field !== 'string' || !Object.prototype.hasOwnProperty.call(fields, field),
		)
	) {
		throw new Error(
			'Additional Alert Fields contains an unsupported field. Choose fields from the list.',
		);
	}
	return [...new Set(selected as string[])];
}

export function alertFieldSelection(selected: unknown): string {
	return selectedAlertFields(selected)
		.map((field) => fields[field].selection)
		.join('\n');
}

export function additionalAlertOutput(selected: unknown, alert: IDataObject): IDataObject {
	return Object.fromEntries(
		selectedAlertFields(selected).map((field) => [field, alert[field] ?? null]),
	);
}
