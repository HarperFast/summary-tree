// agent-memory's label test (any label readable, or super user); principals are plain objects here.
export function canReadLabels(principal, labels) {
	if (principal.superUser) return true;
	return Array.isArray(labels) && labels.some((label) => principal.read.includes(label));
}

export async function resolvePrincipal(context) {
	if (!context?.principal) throw Object.assign(new Error('principal required'), { statusCode: 401 });
	return context.principal;
}

export const registered = { sinks: [], sections: [], annotators: [] };
export const scanState = { rows: [] };

export function registerMemorySink(sink) {
	registered.sinks.push(sink);
	return () => registered.sinks.splice(registered.sinks.indexOf(sink), 1);
}
export function registerBootstrapSection(section) {
	registered.sections.push(section);
	return () => registered.sections.splice(registered.sections.indexOf(section), 1);
}
export function registerSearchAnnotator(annotator) {
	registered.annotators.push(annotator);
	return () => registered.annotators.splice(registered.annotators.indexOf(annotator), 1);
}

export async function* scanMemories() {
	yield* scanState.rows;
}
