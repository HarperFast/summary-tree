import { randomUUID } from 'node:crypto';
import { databases } from 'harper';
import * as agentMemory from '@harperfast/agent-memory';
import { contentHash, isEligible, partitionId, partitionLabels, revokesFrom } from './partition.ts';

export interface Tables {
	SummaryMember: any;
	SummaryAssignment: any;
	SummaryNode: any;
	SummaryChange: any;
	SummaryPartition: any;
	SummaryState: any;
}

export function summaryTables(): Tables {
	const memory = (databases as any)?.memory;
	if (!memory?.SummaryMember)
		throw new Error('@harperfast/summary-tree: its tables are not loaded in the memory database');
	return memory as Tables;
}

export async function lockRow(table: any, id: string, context: object): Promise<void> {
	await table.lock(id, { scope: 'node' }, context);
}

export interface RecordOptions {
	now: number;
	onlyIfNewer?: boolean;
}

/** Makes no model call: the sink runs it inside agent-memory's lifecycle transaction. */
export async function recordMemory(
	scanned: Record<string, unknown>,
	context: object,
	options: RecordOptions,
): Promise<boolean> {
	const id = scanned.id;
	if (typeof id !== 'string') return false;
	const { SummaryMember, SummaryChange } = summaryTables();
	await lockRow(SummaryMember, id, context);
	const previous = await SummaryMember.get(id, context);
	if (options.onlyIfNewer && previous) {
		const stored = previous.revision ?? 0;
		const revision = typeof scanned.revision === 'number' ? scanned.revision : 0;
		if (stored > revision || (stored === revision && sameState(previous, scanned, options.now))) return false;
	}
	// Two nodes can write one revision, and the other's write may have replicated in after the walk read this row:
	// under the member lock, the current row decides.
	const memory =
		options.onlyIfNewer && previous?.revision === scanned.revision
			? ((await agentMemory.getMemories([id]))[0] ?? scanned)
			: scanned;
	if (memory !== scanned && previous?.revision === memory.revision && sameState(previous, memory, options.now)) {
		return false;
	}
	const revision = typeof memory.revision === 'number' ? memory.revision : 0;
	const labels = partitionLabels(memory.scopes);
	const partition = partitionId(labels);
	const eligible = isEligible(memory, options.now);
	const status = typeof memory.status === 'string' ? memory.status : null;
	const flagged = memory.contentFlag !== undefined && memory.contentFlag !== null;
	const hash = contentHash(memory);
	const revoke = revokesFrom(previous ?? undefined, memory, partition);

	await SummaryMember.put(
		{
			id,
			partition,
			labels,
			revision,
			status,
			flagged,
			eligible,
			contentHash: hash,
			validUntil: eligible && memory.validUntil ? new Date(memory.validUntil as string) : null,
		},
		context,
	);

	const append = (rowPartition: string, rowLabels: readonly string[], rowRevoke: boolean) =>
		SummaryChange.put(
			{
				id: randomUUID(),
				partition: rowPartition,
				labels: rowLabels,
				memoryId: id,
				revision,
				revoke: rowRevoke,
				createdAt: new Date(options.now),
			},
			context,
		);
	if (previous && previous.partition !== partition) {
		await append(previous.partition, previous.labels ?? [], true);
		if (eligible) await append(partition, labels, false);
	} else if (eligible || previous?.eligible || revoke) {
		await append(partition, labels, revoke);
	}
	return true;
}

function sameState(previous: any, memory: Record<string, unknown>, now: number): boolean {
	const eligible = isEligible(memory, now);
	const validUntil = eligible && memory.validUntil ? new Date(memory.validUntil as string).getTime() : null;
	return (
		previous.partition === partitionId(partitionLabels(memory.scopes)) &&
		previous.status === (typeof memory.status === 'string' ? memory.status : null) &&
		Boolean(previous.flagged) === (memory.contentFlag !== undefined && memory.contentFlag !== null) &&
		Boolean(previous.eligible) === eligible &&
		previous.contentHash === contentHash(memory) &&
		(previous.validUntil ? new Date(previous.validUntil).getTime() : null) === validUntil
	);
}
