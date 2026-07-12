/**
 * Cluster summarization for the summary tree. Pure prompt-building + response
 * parsing; the actual call goes through Harper's models facade
 * (`models.generate`), so any configured generative backend works.
 */

const LEVEL1_INSTRUCTIONS =
	'Write a summary of the following document chunks: 120-180 words of standalone, ' +
	'informative prose that synthesizes them — the concrete capabilities, operations, ' +
	'parameters, behaviors, and facts they describe. It will be embedded and returned ' +
	'as a SEARCH RESULT, so it must read like a documentation overview paragraph, not ' +
	'a meta-description. Never write "these chunks/documents describe" — state the ' +
	'content directly. Cover the breadth of the chunks rather than deep-diving one.';

const HIGHER_LEVEL_INSTRUCTIONS =
	'Write a HIGHER-LEVEL summary of the following summaries (each already a synthesis ' +
	'of many documents): 150-200 words of standalone informative prose covering the ' +
	'whole area — the broad capability domain, its major subsystems, and how they ' +
	'relate. It will be embedded and returned as a SEARCH RESULT for very broad ' +
	'questions, so write it like the opening overview of a documentation area. No ' +
	'meta-language — state the content directly.';

// Title comes FIRST — small models reliably follow leading format instructions
// but often drop trailing ones.
const TITLE_INSTRUCTIONS =
	'Start your response with exactly one line "TITLE: <3-8 words naming the theme>", then a blank line, then the summary prose.';

// Bound the summarization context; members are ordered most-central-first by the
// caller, so truncation drops the least representative members.
const MAX_INPUT_CHARS = 24_000;

export function buildPrompt(memberTexts, level) {
	const instructions = level > 1 ? HIGHER_LEVEL_INSTRUCTIONS : LEVEL1_INSTRUCTIONS;
	let body = '';
	let included = 0;
	for (const text of memberTexts) {
		if (body.length + text.length > MAX_INPUT_CHARS && included > 0) break;
		body += `\n--- ${level > 1 ? 'summary' : 'chunk'} ${++included} ---\n${text}\n`;
	}
	return `${instructions}\n${TITLE_INSTRUCTIONS}\n${body}\nTITLE:`;
}

export function parseResponse(text) {
	// The prompt ends with "TITLE:", so the completion's first line IS the title
	// (models sometimes repeat the label — strip it either way).
	const trimmed = text.trim();
	const nl = trimmed.indexOf('\n');
	let firstLine = (nl < 0 ? trimmed : trimmed.slice(0, nl)).trim();
	let rest = nl < 0 ? '' : trimmed.slice(nl + 1).trim();
	firstLine = firstLine.replace(/^\**TITLE\**:?\s*/i, '').replace(/^["'*_#]+|["'*_]+$/g, '');
	let title = firstLine;
	let summary = rest.replace(/^\s*Summary:\s*/i, '').trim();
	if (title.length > 100 || !summary) {
		// model skipped the title line and went straight to prose
		summary = trimmed.replace(/^\**TITLE\**:?\s*/i, '');
		title = summary.split(/\s+/).slice(0, 6).join(' ').replace(/[.,;:]+$/, '');
	}
	return { title, summary };
}

/**
 * Summarize one cluster via the models facade.
 * @param models       Harper models facade (scope.models or `import { models } from 'harperdb'`)
 * @param memberTexts  member texts, most-central-first
 * @param level        1 = summarizes chunks, >1 = summarizes summaries
 * @param opts         { model } logical generative model name from config
 */
export async function summarizeCluster(models, memberTexts, level, opts = {}) {
	const result = await models.generate(buildPrompt(memberTexts, level), {
		model: opts.model,
		maxTokens: 400,
		temperature: 0.2,
	});
	const text = typeof result === 'string' ? result : (result?.content ?? '');
	const { title, summary } = parseResponse(text);
	if (!summary) throw new Error('summarizeCluster: empty summary from model');
	return { title, summary };
}
