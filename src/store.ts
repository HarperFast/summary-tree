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
	/** set by the startup walk: skip a memory whose stored member is at least this revision */
	onlyIfNewer?: boolean;
}

/**
 * Records one memory change for summarization, in `context`'s transaction: updates its member row (partition, leaf,
 * revision, eligibility; never memory text) and appends work for the partitions it left or joined. Makes no model call. Shared by the sink and the startup walk; every writer of
 * a member row takes its lock first, so a walk reading an older revision cannot overwrite a sink's newer write.
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
	if (options.onlyIfNewer && previous && (previous.revision ?? 0) >= revision) return false;

	const labels = partitionLabels(memory.scopes);
	const partition = partitionId(labels);
	const eligible = isEligible(memory, options.now);
	const revoke = revokesFrom(previous ?? undefined, memory, partition);

	await SummaryMember.put(
		{
			id,
			partition,
			labels,
			revision,
			status: typeof memory.status === 'string' ? memory.status : null,
			flagged: memory.contentFlag !== undefined && memory.contentFlag !== null,
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
