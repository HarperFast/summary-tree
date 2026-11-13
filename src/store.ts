import { randomUUID } from 'node:crypto';
import { databases } from 'harper';
import { isEligible, partitionId, partitionLabels, revokesFrom } from './partition.ts';

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

/** A node-scoped lock on `id` in `context`'s transaction; LMDB has no record locks, so it is skipped there (501). */
export async function lockRow(table: any, id: string, context: object): Promise<void> {
	try {
		await table.lock(id, { scope: 'node' }, context);
	} catch (error: any) {
		if (error?.statusCode !== 501) throw error;
	}
}

export interface RecordOptions {
	now: number;
	/** the startup walk: skip a memory already recorded at a later revision, or at this one in the same state */
	onlyIfNewer?: boolean;
}

/**
 * Records one memory change in `context`'s transaction: its member row (partition, leaf, revision, eligibility; never
 * memory text) and work for the partitions it left or joined. Makes no model call. Shared by the sink and the startup
 * walk.
 */
export async function recordMemory(
	memory: Record<string, unknown>,
	context: object,
	options: RecordOptions,
): Promise<boolean> {
	const id = memory.id;
	if (typeof id !== 'string') return false;
	const { SummaryMember, SummaryChange } = summaryTables();
	await lockRow(SummaryMember, id, context);
	const previous = await SummaryMember.get(id, context);
	const revision = typeof memory.revision === 'number' ? memory.revision : 0;
	const labels = partitionLabels(memory.scopes);
	const partition = partitionId(labels);
	const eligible = isEligible(memory, options.now);
	const status = typeof memory.status === 'string' ? memory.status : null;
	const flagged = memory.contentFlag !== undefined && memory.contentFlag !== null;
	if (options.onlyIfNewer && previous) {
		const stored = previous.revision ?? 0;
		// Writes on two nodes can share a revision, so an equal revision counts as recorded only in the same state.
		const same =
			previous.partition === partition &&
			previous.status === status &&
			Boolean(previous.flagged) === flagged &&
			Boolean(previous.eligible) === eligible;
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
