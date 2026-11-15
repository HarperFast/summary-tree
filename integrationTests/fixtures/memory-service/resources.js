// Deterministic models so the tree's shape and text depend only on the seeded memories.
const STOP = new Set(['the', 'a', 'an', 'and', 'of', 'to', 'in', 'on', 'for', 'is', 'with', 'about', 'note']);

function tokens(text) {
	return (
		String(text)
			.toLowerCase()
			.match(/[a-z0-9]+/g) ?? []
	).filter((token) => !STOP.has(token));
}

// Hashed bag of words: two texts are close exactly when they share words.
function embedText(text, dimensions = 64) {
	const vector = new Array(dimensions).fill(0);
	vector[0] = 0.01;
	for (const token of tokens(text)) {
		let hash = 0;
		for (let i = 0; i < token.length; i++) hash = (hash * 31 + token.charCodeAt(i)) >>> 0;
		vector[1 + (hash % (dimensions - 1))] += 1;
	}
	return Float32Array.from(vector);
}

models.registerBackend(
	'embedding',
	'default',
	models.defineBackend({
		name: 'test-bag-of-words',
		async embed(input) {
			const texts = Array.isArray(input) ? input : [input];
			return { status: 'completed', output: texts.map((text) => embedText(text)) };
		},
	}),
);

// Generate calls since this process started, in total and per trigger word below; read through GET /GenerateCalls.
const calls = { total: 0, okapi: 0, quagga: 0 };

// A model that answers with only its title: the first time for okapi memories, the first two times for quagga ones.
const TITLE_ONLY_CALLS = { okapi: 1, quagga: 2 };

export class GenerateCalls extends Resource {
	static loadAsInstance = false;

	static get() {
		return { ...calls };
	}
}

// "Summarizes" by listing the most frequent words of the quoted items, so a summary reveals exactly which memories
// it was built from.
models.registerBackend(
	'generative',
	'default',
	models.defineBackend({
		name: 'test-word-count-summarizer',
		async generate(input) {
			const user = typeof input === 'string' ? input : (input.messages ?? input).at(-1).content;
			const data = user.slice(user.indexOf('<data>'), user.lastIndexOf('</data>'));
			const counts = new Map();
			for (const line of data.split('\n')) {
				const literal = line.replace(/^\d+\.\s*/, '');
				if (!literal.startsWith('"')) continue;
				for (const token of new Set(tokens(JSON.parse(literal)))) counts.set(token, (counts.get(token) ?? 0) + 1);
			}
			calls.total++;
			for (const [word, titleOnly] of Object.entries(TITLE_ONLY_CALLS)) {
				if (counts.has(word) && ++calls[word] <= titleOnly) {
					return { status: 'completed', output: { content: `TITLE: ${word} herd notes`, finishReason: 'stop' } };
				}
			}
			// a model that ran into its token cap mid-sentence
			if (counts.has('zebra')) {
				const content = 'TITLE: zebra herds\n\nCovers zebra stripes and herds. Grazing patt';
				return { status: 'completed', output: { content, finishReason: 'length' } };
			}
			const top = [...counts].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map(([token]) => token);
			const content = `TITLE: ${top.slice(0, 3).join(' ')}\n\nCovers ${top.slice(0, 40).join(' ')}.`;
			return { status: 'completed', output: { content, finishReason: 'stop' } };
		},
	}),
);
