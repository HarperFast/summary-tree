import { randomUUID } from 'node:crypto';
import { databases } from 'harper';
import * as agentMemory from '@harperfast/agent-memory';
import { contentHash, isEligible, partitionId, partitionLabels, revokesFrom } from './partition.ts';

export interface Tables {
	SummaryMember: any;
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
	/** startup walk */
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
	let memory = scanned;
	// Two nodes can write one revision, and the other node's write may have replicated in after the walk read this
	// row; under the member lock, the current row decides.
	if (options.onlyIfNewer && previous?.revision === scanned.revision) {
		memory = (await agentMemory.getMemories([id]))[0] ?? scanned;
	}
	const revision = typeof memory.revision === 'number' ? memory.revision : 0;
	const labels = partitionLabels(memory.scopes);
	const partition = partitionId(labels);
	const eligible = isEligible(memory, options.now);
	const status = typeof memory.status === 'string' ? memory.status : null;
	const flagged = memory.contentFlag !== undefined && memory.contentFlag !== null;
	const hash = contentHash(memory);
	if (options.onlyIfNewer && previous) {
		const stored = previous.revision ?? 0;
		// Writes on two nodes can share a revision, so an equal revision counts as recorded only in the same state.
		const validUntil = eligible && memory.validUntil ? new Date(memory.validUntil as string).getTime() : null;
		const same =
			previous.partition === partition &&
			previous.status === status &&
			Boolean(previous.flagged) === flagged &&
			Boolean(previous.eligible) === eligible &&
			previous.contentHash === hash &&
			(previous.validUntil ? new Date(previous.validUntil).getTime() : null) === validUntil;
		if (stored > revision || (stored === revision && same)) return false;
	}
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
			leafId: eligible && previous?.partition === partition ? (previous.leafId ?? null) : null,
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
