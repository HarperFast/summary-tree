import type { Scope } from 'harper';
import * as agentMemory from '@harperfast/agent-memory';
import { setServingState, SummaryTreeMcpResource, SummaryTreeResource } from './resource.ts';
import { Runner } from './runner.ts';
import { annotateHits, orientation } from './serve.ts';
import { parseSettings } from './settings.ts';
import { recordMemory } from './store.ts';

export { parseSettings, type Settings } from './settings.ts';

const REQUIRED_EXPORTS = [
	'registerMemorySink',
	'registerBootstrapSection',
	'registerSearchAnnotator',
	'scanMemories',
	'resolvePrincipal',
	'canReadLabels',
] as const;

export const ORIENTATION_SECTION = 'orientation';
export const SEARCH_ANNOTATION = 'summaryTree';

export async function handleApplication(scope: Scope): Promise<void> {
	const missing = REQUIRED_EXPORTS.filter((name) => typeof (agentMemory as any)[name] !== 'function');
	if (missing.length) {
		throw new Error(
			`@harperfast/summary-tree: needs @harperfast/agent-memory 0.1.5 or later (missing ${missing.join(', ')})`,
		);
	}
	const settings = parseSettings((scope.options.getAll() ?? {}) as Record<string, unknown>);
	const resources = scope.resources;
	if (!resources) throw new Error('@harperfast/summary-tree: scope.resources is unavailable');
	resources.set(`/${settings.urlPath}`, SummaryTreeResource as any);
	if (settings.mcp) resources.set(`/${settings.urlPath}Mcp`, SummaryTreeMcpResource as any);
	if ((scope as any).isTransientValidation) return;

	const runner = new Runner(settings, scope.logger);
	setServingState(runner);
	const record = (memory: Record<string, unknown>, context: object) =>
		recordMemory(memory, context, { now: Date.now() });
	const unregister = [
		agentMemory.registerMemorySink({ write: record, withdraw: record }),
		agentMemory.registerBootstrapSection({
			name: ORIENTATION_SECTION,
			render: ({ principal, budgetChars }) => (runner.ready ? orientation(principal, budgetChars) : null),
		}),
		agentMemory.registerSearchAnnotator({
			name: SEARCH_ANNOTATION,
			annotate: ({ principal, hits }) => (runner.ready ? annotateHits(principal, hits) : null),
		}),
	];
	runner.start();

	scope.options.on('change', () => {
		try {
			const next = parseSettings((scope.options.getAll() ?? {}) as Record<string, unknown>);
			if (next.urlPath !== settings.urlPath || next.mcp !== settings.mcp) {
				scope.logger.warn?.('@harperfast/summary-tree: urlPath and mcp changes take effect on restart');
			}
			runner.settings = next;
		} catch (error) {
			scope.logger.error?.('@harperfast/summary-tree: configuration change rejected; keeping the previous one', error);
		}
	});
	scope.on('close', () => {
		runner.stop();
		for (const fn of unregister) fn();
	});
}
