"use strict";

/**
 * Environment-free text primitives shared by the lexicon engine, the store, and
 * the browser bundle.
 *
 * Everything here is pure: no DOM, no `node:` imports, no globals beyond the
 * language built-ins. Both the browser bundle (through the module loader) and
 * the Node-side tests load this same file, so a rule proved here holds in the
 * page.
 */

//#region character classes

/** Code point of the first CJK Unified Ideograph. */
const CJK_MIN = 0x3400;
/** Code point just past the last common CJK Unified Ideograph. */
const CJK_MAX = 0x9fff;

/**
 * Whether one code point is a CJK ideograph.
 * @param code - a UTF-16 code unit.
 * @returns true for ideographs a Chinese dictionary could hold.
 */
function isCjkCode(code) {
	return code >= CJK_MIN && code <= CJK_MAX;
}

/** CJK punctuation and full-width symbols: sentence boundaries for Chinese text. */
const CJK_PUNCTUATION = "，。！？；：、（）《》〈〉「」『』【】〔〕—…·～　";

/** ASCII punctuation that ends an English sentence. */
const ASCII_SENTENCE_END = ".!?\n";

/**
 * Whether one character can sit inside a term (letters, digits, connectors and
 * ideographs). A term boundary is any position where this is false.
 * @param character - a single code unit.
 * @returns true when the character may belong to a word.
 */
function isWordCharacter(character) {
	if (character === "-" || character === "_") return true;
	const code = character.charCodeAt(0);
	if (isCjkCode(code)) return true;
	return (
		(code >= 0x30 && code <= 0x39) ||
		(code >= 0x41 && code <= 0x5a) ||
		(code >= 0x61 && code <= 0x7a)
	);
}

/**
 * Whether a string contains at least one CJK ideograph.
 * @param text - candidate text.
 * @returns true for Chinese text.
 */
function hasCjk(text) {
	for (const character of text) {
		if (isCjkCode(character.codePointAt(0))) return true;
	}
	return false;
}

//#endregion

//#region tokenization

/**
 * Split text into candidate tokens with their offsets.
 *
 * A token is a maximal run of letters, digits, `-` and `_`; every CJK ideograph
 * is its own token because Chinese has no spaces and dictionary lookup is
 * per-word. Offsets index the original string, so a caller can map a token back
 * to a DOM text position.
 *
 * @param text - text to scan.
 * @returns tokens in source order; each carries its raw slice and range.
 * @throws {TypeError} when `text` is not a string.
 */
function tokenize(text) {
	if (typeof text !== "string") throw new TypeError("tokenize expects a string");
	const tokens = [];
	let start = -1;
	let end = -1;

	/** Emit the pending run, if any. */
	const flush = () => {
		if (start < 0) return;
		const raw = text.slice(start, end);
		tokens.push({ raw, lower: raw.toLowerCase(), start, end });
		start = -1;
		end = -1;
	};

	for (let index = 0; index < text.length; index++) {
		const character = text[index];
		if (!isWordCharacter(character)) {
			flush();
			continue;
		}
		// One ideograph is one token: Chinese compounds have no delimiter, so a
		// second ideograph closes the previous run and opens its own.
		if (isCjkCode(character.charCodeAt(0))) {
			flush();
			start = index;
			end = index + 1;
			flush();
			continue;
		}
		if (start < 0) start = index;
		end = index + 1;
	}
	flush();
	return tokens;
}

//#endregion

//#region shape tests

/** Suffixes that reliably mark an English loanword as a technical noun. */
const TECHNICAL_SUFFIXES = [
	"tion", "sion", "ism", "ity", "ance", "ence", "ology", "ography",
	"ization", "isation", "ability", "ibility", "escence", "ification"
];

/** Prefixes that reliably mark an English loanword as a technical coinage. */
const TECHNICAL_PREFIXES = [
	"meta", "hyper", "multi", "poly", "mono", "micro", "macro", "pseudo",
	"auto", "hetero", "homo", "isomorphic", "ortho", "tele", "cyber", "neuro"
];

/**
 * Whether a word is written as a code identifier rather than as prose:
 * `camelCase`, `PascalCase`, `ALL_CAPS`, `snake_case` or `kebab-case`.
 * @param raw - the token exactly as it appeared.
 * @returns true when the spelling itself signals a technical term.
 */
function looksLikeIdentifier(raw) {
	if (raw.includes("_")) return /[A-Za-z]/.test(raw);
	if (raw.includes("-")) return raw.length >= 5 && raw.split("-").every((part) => part.length >= 2);
	if (raw.length >= 3 && /^[A-Z][a-z]*[A-Z]/.test(raw)) return true;
	if (raw.length >= 4 && /[a-z][A-Z]/.test(raw)) return true;
	return false;
}

/**
 * Whether a token is an acronym or initialism (`API`, `TCP`, `ISO8601`).
 * @param raw - the token exactly as it appeared.
 * @returns true for an all-caps token of two or more letters.
 */
function isAcronym(raw) {
	return /^[A-Z][A-Z0-9]{1,7}$/.test(raw);
}

/**
 * Whether a lowercase English word carries technical morphology, which is how a
 * term missing from the built-in lexicon still gets noticed.
 * @param lower - the lowercased token.
 * @returns true when a prefix or suffix marks it as jargon.
 */
function hasTechnicalMorphology(lower) {
	if (lower.length < 8) return false;
	if (TECHNICAL_SUFFIXES.some((suffix) => lower.endsWith(suffix) && lower.length > suffix.length + 3)) return true;
	if (lower.length >= 10 && TECHNICAL_PREFIXES.some((prefix) => lower.startsWith(prefix) && lower.length > prefix.length + 4)) return true;
	return false;
}

/** Mixed-script or full-width latin is data, not a term. */
const DIGITS_ONLY = /^[0-9]+$/;

/**
 * Whether a token is worth registering as a dictionary entry on its own.
 * @param raw - the token exactly as it appeared.
 * @returns true when the token is a plausible standalone term.
 */
function isTermShaped(raw) {
	if (raw.length < 2 || DIGITS_ONLY.test(raw)) return false;
	if (hasCjk(raw)) return raw.length >= 2 && raw.length <= 8;
	if (!/[A-Za-z]/.test(raw)) return false;
	if (raw.length > 48) return false;
	return true;
}

//#endregion

//#region keys

/**
 * Normalize a term to its dictionary key: trimmed, lowercased, and with runs of
 * internal whitespace collapsed so `Event  Sourcing` and `event sourcing` are
 * one entry.
 * @param term - user- or detector-supplied term text.
 * @returns the canonical key, or an empty string when nothing survives.
 */
function normalizeTerm(term) {
	if (typeof term !== "string") return "";
	return term.replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * Stable identifier for a term, so the same term never becomes two entries.
 * FNV-1a over the normalized key, rendered in base 36.
 * @param term - term text in any casing.
 * @returns a short, stable, filesystem-safe id.
 */
function termId(term) {
	const key = normalizeTerm(term);
	let hash = 0x811c9dc5;
	for (let index = 0; index < key.length; index++) {
		hash ^= key.charCodeAt(index);
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	return `t${hash.toString(36)}`;
}

/**
 * Human-readable title case for a key that lost its original casing.
 * @param term - term text in any casing.
 * @returns the term with each word capitalized.
 */
function titleCase(term) {
	const trimmed = typeof term === "string" ? term.trim() : "";
	if (trimmed === "") return "";
	return trimmed
		.split(" ")
		.map((word) => (word.length === 0 ? word : word[0].toUpperCase() + word.slice(1)))
		.join(" ");
}

//#endregion

//#region context

/** Sentence terminators for either writing system. */
const SENTENCE_ENDS = "。！？；.!?;\n";

/**
 * Extract the surrounding text of an occurrence, trimmed to whole sentences
 * where possible and hard-clamped so one entry never stores a whole document.
 * @param text - the full message text.
 * @param start - occurrence start offset.
 * @param end - occurrence end offset.
 * @param limit - maximum characters to keep on the window.
 * @returns the context sentence fragment, single-lined.
 */
function contextAround(text, start, end, limit = 240) {
	if (typeof text !== "string" || text.length === 0) return "";
	const safeStart = Math.max(0, Math.min(start, text.length));
	const safeEnd = Math.max(safeStart, Math.min(end, text.length));
	let from = safeStart;
	while (from > 0 && !SENTENCE_ENDS.includes(text[from - 1]) && safeStart - from < limit) from--;
	let to = safeEnd;
	while (to < text.length && !SENTENCE_ENDS.includes(text[to]) && to - safeEnd < limit) to++;
	let window = text.slice(from, to);
	if (window.length > limit) {
		const cut = Math.floor((limit - (safeEnd - safeStart)) / 2);
		window = text.slice(Math.max(from, safeStart - cut), Math.min(to, safeEnd + cut));
	}
	return window.replace(/\s+/g, " ").trim();
}

/** Characters that make a run of text a URL rather than prose. */
function isUrlLike(raw) {
	return /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) || /^www\./i.test(raw);
}

//#endregion

//#region formatting

/** Escape text for safe placement inside a regular expression. */
function escapeRegExp(text) {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Short local timestamp for a dictionary entry.
 * @param at - epoch milliseconds.
 * @returns `YYYY-MM-DD HH:mm`, or an empty string without a usable value.
 */
function formatStamp(at) {
	if (typeof at !== "number" || !Number.isFinite(at)) return "";
	const date = new Date(at);
	const pad = (value) => String(value).padStart(2, "0");
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

//#endregion

module.exports = {
	isCjkCode,
	hasCjk,
	isWordCharacter,
	tokenize,
	looksLikeIdentifier,
	isAcronym,
	hasTechnicalMorphology,
	isTermShaped,
	normalizeTerm,
	termId,
	titleCase,
	contextAround,
	isUrlLike,
	escapeRegExp,
	formatStamp,
	CJK_PUNCTUATION,
	ASCII_SENTENCE_END
};
