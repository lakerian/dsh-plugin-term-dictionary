"use strict";

/**
 * The term detector: decides which words in a message are terminology and how
 * sure it is.
 *
 * It combines four evidence sources, strongest first:
 *   1. the user's own dictionary (an explicit entry is never questioned);
 *   2. the built-in glossary, which also supplies a ready-made explanation, so
 *      the plugin works with no model call and no network;
 *   3. the spelling of the word itself (`camelCase`, `ALL_CAPS`, `snake_case`),
 *      which is how a term nobody has ever catalogued still gets noticed;
 *   4. technical morphology (`-ology`, `-ization`, `meta-`, `poly-`).
 *
 * Dictionary and glossary matching runs over raw text rather than tokens, which
 * is what makes multi-word English phrases (`event sourcing`) and spacer-less
 * Chinese terms (`幂等`) work through one code path. Everything is synchronous
 * and pure, so it can run on every rendered message without a network round
 * trip.
 */

const core = require("./core.js");

const {
	normalizeTerm,
	termId,
	contextAround,
	isTermShaped,
	looksLikeIdentifier,
	isAcronym,
	hasTechnicalMorphology,
	tokenize
} = core;

/** Evidence weights, also the confidence reported per occurrence. */
const CONFIDENCE = {
	/** The user curated this term. */
	dictionary: 1,
	/** The built-in glossary knows this term. */
	glossary: 0.8,
	/** An acronym or initialism: `API`, `SLO`. */
	acronym: 0.55,
	/** Identifier spelling: `eventSourcing`, `snake_case`. */
	identifier: 0.5,
	/** A long English word with technical morphology. */
	morphology: 0.45
};

/** Longest known term, in characters, the substring matcher will look for. */
const MAX_TERM_LENGTH = 48;

/**
 * Words that are common enough to refuse even when they arrive capitalized,
 * which is how they appear at the start of most sentences. Kept small on
 * purpose: the stopword list already covers the real prose, and this only has to
 * catch the sentence-initial cases the lowercase test cannot see.
 */
const CAPITALIZED_STOPWORDS = new Set([
	"a", "an", "and", "as", "at", "be", "but", "by", "can", "do", "for", "from",
	"he", "her", "here", "his", "how", "i", "if", "in", "is", "it", "its", "let",
	"my", "no", "not", "of", "on", "or", "our", "out", "she", "so", "that", "the",
	"their", "them", "then", "there", "these", "they", "this", "those", "to", "up",
	"us", "was", "we", "were", "what", "when", "where", "which", "who", "why",
	"will", "with", "you", "your"
]);

/**
 * The detector. Construct one per (glossary, dictionary) generation and reuse it
 * for every message; {@link TermDetector#scan} is stateless.
 */
class TermDetector {
	/**
	 * Build the term index the detector matches against.
	 *
	 * @param options - `lexicon` is the built-in map (key -> `{ zh, domain, gloss }`),
	 *   `entries` is the user's dictionary, and `stopwords` holds the two word
	 *   lists the detector must ignore.
	 */
	constructor(options) {
		const config = options ?? {};
		const lexicon = config.lexicon ?? {};
		const stopwords = config.stopwords ?? {};
		const entries = Array.isArray(config.entries) ? config.entries : [];

		/** Known glossary records, keyed by normalized term. */
		const glossary = new Map();
		/** Match keys ordered longest first, so a phrase wins over the words in it. */
		const keys = [];
		for (const [term, value] of Object.entries(lexicon)) {
			const key = normalizeTerm(term);
			if (key === "" || key.length > MAX_TERM_LENGTH) continue;
			glossary.set(key, {
				key,
				zh: typeof value?.zh === "string" ? value.zh : "",
				domain: typeof value?.domain === "string" ? value.domain : "",
				gloss: typeof value?.gloss === "string" ? value.gloss : ""
			});
			keys.push(key);
		}

		/** User dictionary projected for highlighting, keyed by term and alias. */
		const known = new Map();
		for (const entry of entries) {
			if (entry === null || typeof entry !== "object") continue;
			const key = normalizeTerm(entry.term);
			if (key === "") continue;
			const record = {
				term: typeof entry.term === "string" && entry.term.trim() !== "" ? entry.term.trim() : key,
				id: typeof entry.id === "string" && entry.id !== "" ? entry.id : termId(key),
				key,
				entry
			};
			known.set(key, record);
			for (const alias of Array.isArray(entry.aliases) ? entry.aliases : []) {
				const aliasKey = normalizeTerm(alias);
				if (aliasKey !== "" && !known.has(aliasKey)) known.set(aliasKey, record);
			}
		}

		// The user's own terms must be MATCHED, not merely recorded.
		//
		// `scan` finds occurrences by searching the text for each key in `keys`, and the
		// loop above only ever filled `keys` from the lexicon. Every collected term that is
		// not also a built-in glossary word was therefore invisible to the matcher: a
		// dictionary entry for `WriteAheadLog` came back as an unknown `identifier`
		// candidate (`known: false`) instead of a dictionary hit. Three user-visible
		// consequences, all reported from the running plugin:
		//
		//   - the term was never marked in the transcript ("没有变成词条块");
		//   - hovering it offered no explanation;
		//   - clicking it offered to CREATE an entry that already existed.
		//
		// Only entries that are also lexicon words (like `quorum`) worked, which is why
		// this survived every test: the tests happened to use glossary terms.
		for (const key of known.keys()) {
			if (key.length > MAX_TERM_LENGTH) continue;
			if (!keys.includes(key)) keys.push(key);
		}
		keys.sort((left, right) => right.length - left.length);

		this.glossary = glossary;
		this.keys = keys;
		this.known = known;
		this.stopEn = new Set((stopwords.EN ?? []).map((word) => String(word).toLowerCase()));
		this.stopZh = new Set(stopwords.ZH ?? []);
	}

	/**
	 * Glossary knowledge for one normalized term, if the built-in lexicon has it.
	 * @param key - normalized term text.
	 * @returns the glossary record, or undefined.
	 */
	glossaryOf(key) {
		return this.glossary.get(key);
	}

	/**
	 * The user's own entry covering this term or alias.
	 * @param key - normalized term text.
	 * @returns the known-term record, or undefined.
	 */
	knownOf(key) {
		return this.known.get(key);
	}

	/**
	 * Whether the word is common enough that it must never count as jargon on its
	 * own. A dictionary entry or glossary hit outranks this.
	 * @param token - a tokenized word.
	 * @returns true when the word carries no terminology signal.
	 */
	isCommon(token) {
		if (core.hasCjk(token.raw)) return this.stopZh.has(token.raw);
		return token.raw === token.lower && this.stopEn.has(token.lower);
	}

	/**
	 * Classify one token that is not covered by the dictionary or the glossary.
	 * @param token - a tokenized word.
	 * @returns the confidence and evidence name, or null for ordinary prose.
	 */
	classify(token) {
		const { raw } = token;
		if (!isTermShaped(raw)) return null;
		if (this.isCommon(token)) return null;
		if (core.hasCjk(raw)) return null;
		if (looksLikeIdentifier(raw)) return { confidence: CONFIDENCE.identifier, source: "identifier" };
		if (isAcronym(raw)) return { confidence: CONFIDENCE.acronym, source: "acronym" };
		if (raw === token.lower && hasTechnicalMorphology(token.lower)) return { confidence: CONFIDENCE.morphology, source: "morphology" };
		return null;
	}

	/**
	 * Detect every term occurrence in one message.
	 *
	 * Matches never overlap: a longer dictionary or glossary term wins over the
	 * words inside it, and later candidates that intersect an accepted range are
	 * dropped. The result is ordered by position, which is what the renderer
	 * walks.
	 *
	 * @param text - the message's plain text.
	 * @param options - `includeCandidates` (default true) controls whether weak
	 *   evidence (spelling and morphology) is reported alongside real hits.
	 * @returns occurrences sorted by start offset.
	 */
	scan(text, options) {
		if (typeof text !== "string" || text === "") return [];
		const includeCandidates = options?.includeCandidates !== false;
		const accepted = [];
		const claimed = [];
		const overlaps = (start, end) => claimed.some((range) => start < range.end && end > range.start);
		const accept = (occurrence) => {
			accepted.push(occurrence);
			claimed.push({ start: occurrence.start, end: occurrence.end });
		};

		// 1. Known terms, longest first, so `event sourcing` is one hit and the
		//    words inside it are never claimed separately.
		const lowerText = text.toLowerCase();
		for (const key of this.keys) {
			if (key.length > text.length) continue;
			let from = 0;
			for (;;) {
				const at = lowerText.indexOf(key, from);
				if (at < 0) break;
				from = at + 1;
				const end = at + key.length;
				if (!boundaryOk(text, at, end, hasCjkKey(key))) continue;
				if (overlaps(at, end)) continue;
				const occurrence = this.occurrenceFor(at, end, key, text);
				if (occurrence !== null) accept(occurrence);
			}
		}

		// 2. Token-level evidence for everything no known term claimed.
		for (const token of tokenize(text)) {
			if (overlaps(token.start, token.end)) continue;
			const classified = includeCandidates ? this.classify(token) : null;
			if (classified === null) continue;
			accept({
				term: token.raw,
				key: token.lower,
				id: termId(token.raw),
				start: token.start,
				end: token.end,
				confidence: classified.confidence,
				source: classified.source,
				known: false
			});
		}

		accepted.sort((left, right) => left.start - right.start || right.end - left.end);
		return accepted;
	}

	/**
	 * Build one occurrence for a known-term match, preferring the user's own
	 * dictionary over the built-in glossary.
	 * @param start - match start offset.
	 * @param end - match end offset.
	 * @param key - the normalized term that matched.
	 * @param text - the containing message text.
	 * @returns the occurrence, or null when neither source covers the key.
	 */
	occurrenceFor(start, end, key, text) {
		const known = this.knownOf(key);
		if (known !== undefined) {
			return {
				term: known.term,
				key: known.key,
				id: known.id,
				start,
				end,
				confidence: CONFIDENCE.dictionary,
				source: "dictionary",
				known: true
			};
		}
		const glossary = this.glossaryOf(key);
		if (glossary === undefined) return null;
		return {
			term: text.slice(start, end),
			key,
			id: termId(key),
			start,
			end,
			confidence: CONFIDENCE.glossary,
			source: "glossary",
			known: true
		};
	}

	/**
	 * Whether a bare word is a plausible *new* dictionary term, used when a click
	 * lands on text the scan did not flag.
	 *
	 * Without this gate, clicking any ordinary word would offer to create an entry
	 * for it. English is judged by the same shape and morphology rules the scan
	 * uses, so a plain word like "folder" is refused while `runInTransaction` and
	 * `idempotency` are accepted. Chinese has no such signal — a two-character word
	 * is already a plausible term — so any in-range Chinese word is accepted, and
	 * the built-in glossary decides what is *known* rather than what is offered.
	 *
	 * @param raw - the word as it appeared.
	 * @returns true when the word may become a new entry.
	 */
	isCandidateWord(raw) {
		if (typeof raw !== "string") return false;
		if (core.hasCjk(raw)) return raw.length >= 2 && raw.length <= 8;
		if (raw.length < 3 || raw.length > 48) return false;
		if (!/[A-Za-z]/.test(raw)) return false;
		const lower = raw.toLowerCase();
		if (this.glossary.has(lower) || this.known.has(lower)) return true;
		if (looksLikeIdentifier(raw) || isAcronym(raw)) return true;
		if (raw === lower && hasTechnicalMorphology(lower)) return true;
		if (this.stopEn.has(lower)) return false;
		// Capitalization alone is not evidence: it is also how every sentence starts,
		// so accepting it would offer to define "The" and "We". What remains is a word
		// with no morphological signal and no stopword entry — rare enough to be worth
		// offering, though never certain.
		return raw === lower ? false : !CAPITALIZED_STOPWORDS.has(lower);
	}

	/**
	 * The strongest evidence in a message that the dictionary does not have yet,
	 * used when the plugin offers a new entry.
	 * @param text - the message text.
	 * @returns the best unknown occurrence with its context, or null.
	 */
	bestCandidate(text) {
		const unknown = this.scan(text, { includeCandidates: true }).filter((occurrence) => !occurrence.known);
		let best = null;
		for (const occurrence of unknown) {
			if (best === null || occurrence.confidence > best.occurrence.confidence) {
				best = { occurrence, context: contextAround(text, occurrence.start, occurrence.end) };
			}
		}
		return best;
	}

	/**
	 * Every occurrence of one exact term in a message, regardless of evidence.
	 * @param text - the message text.
	 * @param term - the term to locate.
	 * @returns occurrences in source order.
	 */
	findAll(text, term) {
		const key = normalizeTerm(term);
		if (key === "" || typeof text !== "string") return [];
		return this.scan(text, { includeCandidates: true }).filter((occurrence) => occurrence.key === key);
	}
}

/** Memoized "does this key contain ideographs" test for the match loop. */
const CJK_KEY_CACHE = new Map();

/**
 * Whether a normalized match key contains ideographs.
 * @param key - normalized term text.
 * @returns true for Chinese terms.
 */
function hasCjkKey(key) {
	let cached = CJK_KEY_CACHE.get(key);
	if (cached === undefined) {
		cached = core.hasCjk(key);
		CJK_KEY_CACHE.set(key, cached);
	}
	return cached;
}

/**
 * Whether a raw substring match is a real occurrence of the term.
 *
 * Latin terms must sit on token boundaries, so `act` inside `interaction` is
 * not a hit. A Chinese term is exempt from the boundary test against ideograph
 * neighbours: Chinese writes no spaces, so `幂等` is a genuine occurrence inside
 * `幂等键` and `幂等性`, and a stricter rule would make a one-word Chinese entry
 * almost unmatchable.
 *
 * @param text - the containing text.
 * @param start - match start offset.
 * @param end - match end offset.
 * @param cjk - whether the matched term itself contains ideographs.
 * @returns true when the match is a real occurrence.
 */
function boundaryOk(text, start, end, cjk) {
	if (cjk) return true;
	if (start > 0 && core.isWordCharacter(text[start - 1])) return false;
	if (end < text.length && core.isWordCharacter(text[end])) return false;
	return true;
}

module.exports = {
	CONFIDENCE,
	MAX_TERM_LENGTH,
	TermDetector,
	boundaryOk
};
