"use strict";

/**
 * The plugin's switches, persisted in the page.
 *
 * Why these live beside the dictionary instead of inside it
 * ---------------------------------------------------------
 * The dictionary document is MERGED: it travels to the host, comes back, and every
 * reader has to agree on it. A preference is not like that. There is one user and one
 * page, nothing to reconcile, and putting a switch in the merged document would drag it
 * through the whole tombstone/revival machinery — and would make two windows fight over
 * a setting neither of them shares a meaning for. So the switches get their own
 * `localStorage` key and the document keeps only entries.
 *
 * Failure is not fatal: an unreadable or unavailable store yields the defaults, because
 * a plugin that cannot remember "auto-collect is off" must still collect nothing rather
 * than refuse to start.
 */

/** The storage key. Versioned so a future shape change can migrate rather than guess. */
const SETTINGS_KEY = "dsh-plugin-term-dictionary:settings:v1";

/**
 * The three switches and their defaults.
 *
 * `autoExplain` defaults ON because the complaint that produced it was the opposite:
 * collected terms arrived with no explanation and stayed "待补充" forever, which made the
 * dictionary a list of words rather than a dictionary.
 */
const DEFAULT_SETTINGS = {
	/** Collect rare terminology from agent replies automatically. */
	autoCollect: true,
	/** Mark collected terms in the transcript (the "词条块"). */
	autoAnnotate: true,
	/** Ask the model for an explanation as soon as a term is collected. */
	autoExplain: true,
	/** Which language an explanation is written in: the UI's, or one forced. */
	explainLang: "auto",
	/** How much an explanation says. */
	explainDepth: "normal",
	/** Whether the model also gets the paragraph the term appeared in, not just its sentence. */
	explainParagraph: true,
	/**
	 * The shortest term automatic collection will record.
	 *
	 * Four by default: below that a "term" is a fragment (`12-0D`, `id`), and the dictionary is
	 * worse for holding it.
	 */
	collectMinLength: 4,
	/**
	 * Whether code-shaped names are collected (`data-conversation-region`, `Set-Content`).
	 *
	 * OFF by default. When the dictionary was cleaned out, every junk entry was code-shaped and
	 * none of the real ones were — so this is the switch that would have prevented it.
	 */
	collectIdentifiers: false,
	/** Whether Chinese terms are collected. */
	collectCjk: true,
	/**
	 * How long the pointer must rest on a term before the hover card appears, in milliseconds.
	 *
	 * The hard-coded 110ms, exposed: a slower reader wants a steadier card, a faster one is
	 * annoyed by it.
	 */
	hoverInMs: 110,
	/**
	 * How long the card lingers after the pointer leaves the term, in milliseconds.
	 *
	 * ZERO by default, and that default is a decision rather than an omission: a delay on the EXIT
	 * was removed once already because it read as lag — the card sat there for the whole delay after
	 * the pointer had gone. Anyone who wants a grace period may have one; nobody gets it by accident.
	 */
	hoverOutMs: 0
};

/** The accepted minimum term lengths, for the panel's cycling control. */
const COLLECT_LENGTHS = [2, 3, 4, 6, 8];

/** The accepted hover delays, in milliseconds: the bounds for both the slider and manual entry. */
const HOVER_DELAY_MIN = 0;
const HOVER_DELAY_MAX = 200;

/** The step the hover slider moves in. */
const HOVER_DELAY_STEP = 10;

/** The accepted explanation languages. `auto` follows the active UI language. */
const EXPLAIN_LANGS = ["auto", "zh", "en"];

/** The accepted explanation depths. */
const EXPLAIN_DEPTHS = ["brief", "normal", "detailed"];

/**
 * Read one switch's value from an unknown record.
 * @param value - the raw stored value.
 * @param fallback - the default.
 * @returns a boolean.
 */
function readFlag(value, fallback) {
	return typeof value === "boolean" ? value : fallback;
}

/**
 * Read one choice from an unknown record.
 *
 * An unrecognized value falls back rather than being stored: a hand-edited or older record
 * must not be able to put a value in the prompt builder that it has no branch for.
 *
 * @param value - the raw stored value.
 * @param allowed - the accepted values.
 * @param fallback - the default.
 * @returns one of `allowed`.
 */
function readChoice(value, allowed, fallback) {
	// `includes` is a strict comparison, so this admits a NUMBER list (the minimum term length)
	// as well as a string one, and an object or array can still never match a member.
	return allowed.includes(value) ? value : fallback;
}

/**
 * Read one delay from an unknown record, as a whole number of milliseconds inside the range.
 *
 * Clamped rather than rejected, and rounded rather than trusted: a slider and a text field feed the
 * same setter, so `"120"`, `120.4` and `5000` all arrive here, and a delay outside the range is a
 * worse outcome than the nearest valid one.
 *
 * @param value - the raw stored value.
 * @param fallback - the default.
 * @returns an integer between {@link HOVER_DELAY_MIN} and {@link HOVER_DELAY_MAX}.
 */
function readDelay(value, fallback) {
	const number = typeof value === "number" ? value : Number.parseFloat(value);
	if (!Number.isFinite(number)) return fallback;
	return Math.min(HOVER_DELAY_MAX, Math.max(HOVER_DELAY_MIN, Math.round(number)));
}

/**
 * Normalize a stored settings record.
 * @param raw - the parsed record, or anything.
 * @returns a complete settings object.
 */
function normalizeSettings(raw) {
	const value = raw !== null && typeof raw === "object" ? raw : {};
	return {
		autoCollect: readFlag(value.autoCollect, DEFAULT_SETTINGS.autoCollect),
		autoAnnotate: readFlag(value.autoAnnotate, DEFAULT_SETTINGS.autoAnnotate),
		autoExplain: readFlag(value.autoExplain, DEFAULT_SETTINGS.autoExplain),
		explainLang: readChoice(value.explainLang, EXPLAIN_LANGS, DEFAULT_SETTINGS.explainLang),
		explainDepth: readChoice(value.explainDepth, EXPLAIN_DEPTHS, DEFAULT_SETTINGS.explainDepth),
		explainParagraph: readFlag(value.explainParagraph, DEFAULT_SETTINGS.explainParagraph),
		collectMinLength: readChoice(value.collectMinLength, COLLECT_LENGTHS, DEFAULT_SETTINGS.collectMinLength),
		collectIdentifiers: readFlag(value.collectIdentifiers, DEFAULT_SETTINGS.collectIdentifiers),
		collectCjk: readFlag(value.collectCjk, DEFAULT_SETTINGS.collectCjk),
		hoverInMs: readDelay(value.hoverInMs, DEFAULT_SETTINGS.hoverInMs),
		hoverOutMs: readDelay(value.hoverOutMs, DEFAULT_SETTINGS.hoverOutMs)
	};
}

/**
 * Build the page's settings store.
 *
 * @param options - `storage` (a `Storage`-alike) and an optional `logger`.
 * @returns `{ getSnapshot, subscribe, set, reset, dispose }`.
 */
function createSettingsStore(options) {
	const storage = options?.storage ?? null;
	const logger = options?.logger ?? null;
	let current = DEFAULT_SETTINGS;

	/** Read what was persisted. Anything unusable leaves the defaults in place. */
	function load() {
		if (storage === null || typeof storage.getItem !== "function") return;
		try {
			const text = storage.getItem(SETTINGS_KEY);
			if (typeof text !== "string" || text === "") return;
			current = normalizeSettings(JSON.parse(text));
		} catch (error) {
			logger?.warn?.(`term-dictionary: reading the settings failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	const listeners = new Set();

	/** Tell every subscriber the settings changed. */
	function emit() {
		for (const listener of [...listeners]) {
			try {
				listener();
			} catch (error) {
				logger?.warn?.(`term-dictionary: a settings listener failed: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
	}

	/** Write the current settings, tolerating a storage that refuses. */
	function persist() {
		if (storage === null || typeof storage.setItem !== "function") return;
		try {
			storage.setItem(SETTINGS_KEY, JSON.stringify(current));
		} catch (error) {
			logger?.warn?.(`term-dictionary: saving the settings failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	load();

	return {
		/**
		 * The current settings.
		 *
		 * Returns the SAME object until something changes, because
		 * `useSyncExternalStore` compares snapshots by identity and a fresh object each
		 * call would re-render forever.
		 * @returns the settings.
		 */
		getSnapshot() {
			return current;
		},
		/**
		 * Observe changes.
		 * @param listener - the callback.
		 * @returns the unsubscribe function.
		 */
		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		/**
		 * Set one switch.
		 * @param key - the setting's name.
		 * @param value - the new value.
		 * @returns the new settings.
		 */
		set(key, value) {
			if (!Object.prototype.hasOwnProperty.call(DEFAULT_SETTINGS, key)) return current;
			const next = normalizeSettings({ ...current, [key]: value });
			if (next[key] === current[key]) return current;
			current = next;
			persist();
			emit();
			return current;
		},
		/** Put every switch back to its default. */
		reset() {
			current = DEFAULT_SETTINGS;
			persist();
			emit();
			return current;
		},
		/** Drop every listener. */
		dispose() {
			listeners.clear();
		}
	};
}

module.exports = {
	createSettingsStore,
	SETTINGS_KEY,
	DEFAULT_SETTINGS,
	normalizeSettings,
	EXPLAIN_LANGS,
	EXPLAIN_DEPTHS,
	COLLECT_LENGTHS,
	HOVER_DELAY_MIN,
	HOVER_DELAY_MAX,
	HOVER_DELAY_STEP
};
