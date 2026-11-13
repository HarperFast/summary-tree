// In-memory tables with buffered transactions: writes made with a transaction context are visible to reads in that
// context and commit only when the transaction's callback resolves.

const committed = new Map();
const subscribers = new Set();

function store(name) {
	if (!committed.has(name)) committed.set(name, new Map());
	return committed.get(name);
}

function clone(value) {
	return value === undefined || value === null ? value : structuredClone(value);
}

function freeze(record) {
	return record ? Object.freeze(clone(record)) : record;
}

function pendingOf(context) {
	return context && context.__pending instanceof Map ? context.__pending : undefined;
}

function matches(record, condition) {
	const value = record[condition.attribute];
	const target = condition.value;
	const comparator = condition.comparator ?? 'equals';
	const compare = (a) => {
		if (comparator === 'equals') return a === target || (a instanceof Date && +a === +target);
		if (a === null || a === undefined) return false;
		if (comparator === 'less_than_equal') return +new Date(a) <= +new Date(target);
		if (comparator === 'greater_than') return +new Date(a) > +new Date(target);
		throw new Error(`stub: unsupported comparator ${comparator}`);
	};
	return Array.isArray(value) ? value.some(compare) : compare(value);
}

class Table {
	constructor(name) {
		this.name = name;
	}
	async get(id, context) {
		const pending = pendingOf(context)?.get(`${this.name}\0${id}`);
		if (pending !== undefined) return freeze(pending.record);
		return freeze(store(this.name).get(id));
	}
	async put(record, context) {
		const pending = pendingOf(context);
		if (pending) pending.set(`${this.name}\0${record.id}`, { table: this.name, id: record.id, record: clone(record) });
		else commitOne(this.name, record.id, clone(record));
	}
	async delete(id, context) {
		const pending = pendingOf(context);
		if (pending) pending.set(`${this.name}\0${id}`, { table: this.name, id, record: null });
		else commitOne(this.name, id, null);
	}
	async lock(id, options, context) {
		lockCalls.push({ table: this.name, id, options, inTransaction: Boolean(pendingOf(context)) });
	}
	search({ conditions = [], limit, sort } = {}) {
		let rows = [...store(this.name).values()].filter((record) => conditions.every((c) => matches(record, c)));
		if (sort) rows.sort((a, b) => +new Date(a[sort.attribute]) - +new Date(b[sort.attribute]));
		if (limit !== undefined) rows = rows.slice(0, limit);
		return (async function* () {
			for (const row of rows) yield freeze(row);
		})();
	}
	async subscribe() {
		const queue = [];
		let wake;
		const subscriber = (event) => {
			queue.push(event);
			wake?.();
		};
		subscribers.add(subscriber);
		return {
			[Symbol.asyncIterator]() {
				return {
					async next() {
						while (!queue.length) await new Promise((resolve) => (wake = resolve));
						return { value: queue.shift(), done: false };
					},
					async return() {
						subscribers.delete(subscriber);
						return { done: true };
					},
				};
			},
		};
	}
}

function commitOne(table, id, record) {
	if (record === null) store(table).delete(id);
	else store(table).set(id, record);
	if (table === 'SummaryChange' && record) for (const subscriber of subscribers) subscriber({ type: 'put', id });
}

export const lockCalls = [];

export const databases = {
	memory: Object.fromEntries(
		['SummaryMember', 'SummaryNode', 'SummaryChange', 'SummaryPartition', 'SummaryState'].map((name) => [
			name,
			new Table(name),
		]),
	),
};

export async function transaction(contextOrCallback, maybeCallback) {
	const callback = maybeCallback ?? contextOrCallback;
	const context = { __pending: new Map() };
	const result = await callback(context);
	for (const { table, id, record } of context.__pending.values()) commitOne(table, id, record);
	return result;
}

export function resetTables() {
	committed.clear();
	lockCalls.length = 0;
}

export function rows(table) {
	return [...store(table).values()].map(clone);
}

export const modelState = { generateCalls: 0, onGenerate: undefined, generate: undefined, embed: undefined };

export const models = {
	async embed(texts) {
		if (modelState.embed) return modelState.embed(texts);
		return texts.map((text) => Float32Array.from(String(text), (c) => c.charCodeAt(0) % 7));
	},
	async generate(input, opts) {
		modelState.generateCalls++;
		await modelState.onGenerate?.(input, opts);
		if (modelState.generate) return modelState.generate(input, opts);
		const data = input.messages.at(-1).content;
		return { content: `TITLE: Topic ${modelState.generateCalls}\n\nSummary of ${data.length} chars.` };
	},
};

export const logger = { error() {}, warn() {}, info() {}, debug() {}, trace() {} };

export class Resource {}
