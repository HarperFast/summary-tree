export interface Settings {
	readonly urlPath: string;
	readonly mcp: boolean;
	readonly runner: boolean;
	readonly generativeModel: string;
	readonly embeddingModel: string;
	readonly contextTokens: number;
	readonly charsPerToken: number;
	readonly maxSummaryTokens: number;
	readonly memberChars: number;
	readonly leafClusterSize: number;
	readonly fanout: number;
	readonly topFloor: number;
	readonly treeMinMembers: number;
	readonly flatMinMembers: number;
	readonly dirtyMin: number;
	readonly dirtyFraction: number;
	readonly rebuildGrowth: number;
	readonly debounceMs: number;
	readonly leaseMs: number;
}

export const DEFAULT_SETTINGS: Settings = Object.freeze({
	urlPath: 'SummaryTree',
	mcp: false,
	runner: true,
	generativeModel: 'default',
	embeddingModel: 'default',
	contextTokens: 8192,
	charsPerToken: 3,
	maxSummaryTokens: 400,
	memberChars: 2000,
	leafClusterSize: 15,
	fanout: 10,
	topFloor: 6,
	treeMinMembers: 40,
	flatMinMembers: 3,
	dirtyMin: 2,
	dirtyFraction: 0.15,
	rebuildGrowth: 2,
	debounceMs: 30_000,
	leaseMs: 300_000,
});

const INTEGER_RANGES: Partial<Record<keyof Settings, [number, number]>> = {
	contextTokens: [1024, 10_000_000],
	maxSummaryTokens: [64, 8192],
	memberChars: [200, 100_000],
	leafClusterSize: [3, 1000],
	fanout: [2, 1000],
	topFloor: [1, 1000],
	treeMinMembers: [4, 1_000_000],
	flatMinMembers: [1, 1_000_000],
	dirtyMin: [1, 1000],
	debounceMs: [0, 86_400_000],
	leaseMs: [10_000, 3_600_000],
};

const NUMBER_RANGES: Partial<Record<keyof Settings, [number, number]>> = {
	charsPerToken: [1, 10],
	dirtyFraction: [0, 1],
	rebuildGrowth: [1.1, 100],
};

/** Plugin options under the `@harperfast/summary-tree` key; throws a TypeError naming the first malformed one. */
export function parseSettings(options: Record<string, unknown>): Settings {
	const settings: Record<string, unknown> = { ...DEFAULT_SETTINGS };
	for (const key of Object.keys(DEFAULT_SETTINGS) as (keyof Settings)[]) {
		const value = options[key];
		if (value === undefined || value === null) continue;
		const expected = typeof DEFAULT_SETTINGS[key];
		if (typeof value !== expected) throw new TypeError(`@harperfast/summary-tree: ${key} must be a ${expected}`);
		const integerRange = INTEGER_RANGES[key];
		const numberRange = NUMBER_RANGES[key];
		const range = integerRange ?? numberRange;
		if (range) {
			const number = value as number;
			if ((integerRange && !Number.isInteger(number)) || number < range[0] || number > range[1]) {
				throw new TypeError(`@harperfast/summary-tree: ${key} must be between ${range[0]} and ${range[1]}`);
			}
		}
		if (expected === 'string' && !/^[A-Za-z0-9_.-]{1,128}$/.test(value as string)) {
			throw new TypeError(`@harperfast/summary-tree: ${key} must be 1-128 letters, digits, '_', '.' or '-'`);
		}
		settings[key] = value;
	}
	if ((settings.flatMinMembers as number) >= (settings.treeMinMembers as number)) {
		throw new TypeError('@harperfast/summary-tree: flatMinMembers must be below treeMinMembers');
	}
	return Object.freeze(settings) as unknown as Settings;
}

export function promptInputChars(settings: Settings): number {
	const overheadTokens = 400;
	return Math.max(
		settings.memberChars,
		(settings.contextTokens - settings.maxSummaryTokens - overheadTokens) * settings.charsPerToken,
	);
}
