// Resolves `harper` and `@harperfast/agent-memory` to in-memory stand-ins: the real harper opens a database at
// module load, and the plugin's contract with agent-memory is its exported functions.
import { register } from 'node:module';

const harperUrl = new URL('./harper-stub.mjs', import.meta.url).href;
const agentMemoryUrl = new URL('./agent-memory-stub.mjs', import.meta.url).href;
const loaderSource = `
export async function resolve(specifier, context, nextResolve) {
	if (specifier === 'harper') return { url: ${JSON.stringify(harperUrl)}, format: 'module', shortCircuit: true };
	if (specifier === '@harperfast/agent-memory') {
		return { url: ${JSON.stringify(agentMemoryUrl)}, format: 'module', shortCircuit: true };
	}
	return nextResolve(specifier, context);
}
`;

register(`data:text/javascript,${encodeURIComponent(loaderSource)}`, import.meta.url);
