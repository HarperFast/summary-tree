import { createHash } from 'node:crypto';

export const GLOBAL_LABEL = 'global';

/**
 * A memory's partition labels: its scopes sorted and deduplicated, or just `global` when it carries `global`. A
 * reader sees a memory when any label is readable, so one carrying `global` is readable by every reader.
 */
export function partitionLabels(scopes: unknown): string[] {
	const labels = Array.isArray(scopes) ? scopes.filter((label): label is string => typeof label === 'string') : [];
	if (labels.includes(GLOBAL_LABEL)) return [GLOBAL_LABEL];
	return [...new Set(labels)].sort();
}

export function partitionId(labels: readonly string[]): string {
	return createHash('sha256').update(labels.join('\n')).digest('hex').slice(0, 24);
}

function isSet(value: unknown): boolean {
	return value !== undefined && value !== null && value !== false;
}

export function isExpired(validUntil: unknown, now: number): boolean {
	if (!isSet(validUntil)) return false;
	const time = new Date(validUntil as string).getTime();
	return !Number.isNaN(time) && time <= now;
}

export function isEligible(memory: Record<string, unknown>, now: number): boolean {
	return (
		memory.status === 'active' &&
		!isExpired(memory.validUntil, now) &&
		!isSet(memory.needsReview) &&
		!isSet(memory.contentFlag)
	);
}

export interface MemberState {
	readonly partition: string;
	readonly status?: string | null;
	readonly flagged?: boolean | null;
}

/**
 * Whether a change can take a memory away from readers of its previous partition: a withdrawal, a new content flag,
 * or a move to another label set. Judged against the stored member, not its eligibility, since summaries may still
 * carry text from a member that became ineligible for another reason.
 */
export function revokesFrom(previous: MemberState | undefined, memory: Record<string, unknown>, partition: string) {
	const withdrawn = memory.status === 'withdrawn';
	const flagged = isSet(memory.contentFlag);
	if (!previous) return withdrawn || flagged;
	return (
		previous.partition !== partition || (withdrawn && previous.status !== 'withdrawn') || (flagged && !previous.flagged)
	);
}

export function memberText(memory: Record<string, unknown>, maxChars: number): string {
	const title = typeof memory.title === 'string' ? memory.title.trim() : '';
	const content = typeof memory.content === 'string' ? memory.content.trim() : '';
	const text = title ? `${title}: ${content}` : content;
	if (text.length <= maxChars) return text;
	const end = /[\uD800-\uDBFF]/.test(text[maxChars - 1]) ? maxChars - 1 : maxChars;
	return text.slice(0, end);
}

/** Fingerprint of the text a summary would read, so equal revisions written on two nodes can be told apart. */
export function contentHash(memory: Record<string, unknown>): string {
	return createHash('sha256')
		.update(`${memory.title ?? ''}\0${memory.content ?? ''}`)
		.digest('hex')
		.slice(0, 16);
}
