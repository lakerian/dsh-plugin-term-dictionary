"use strict";

/**
 * A one-slot command bus between the conversation surface and the center panel.
 *
 * A click in the transcript has to open the editor *inside the panel* with the
 * term prefilled, and the panel is a separately mounted React tree. Rather than
 * lifting the editor's state into a shared store — which would couple the panel's
 * layout to the transcript — the shell writes one pending command here and the
 * panel consumes it.
 *
 * The panel acknowledges a command by consuming it, so a command issued while the
 * panel is not mounted (the user never opened it) is not replayed later.
 *
 * There are two commands, and they are deliberately separate slots rather than one
 * queue: `create` fills the editor, `focus` reveals an existing entry. A click on a
 * collected term produces a focus, so the panel must not open its editor for it.
 */

/**
 * @returns a bus with `requestCreate` / `consumeCreate` and `requestFocus` /
 *   `consumeFocus`, plus `subscribe` and `peek`.
 */
function createPanelCommandBus() {
	let pending = null;
	let pendingFocus = null;
	const listeners = new Set();

	/** Notify every subscriber that the pending command changed. */
	function emit() {
		for (const listener of [...listeners]) {
			try {
				listener();
			} catch (error) {
				console.warn("[term-dictionary] command listener failed:", error);
			}
		}
	}

	return {
		/**
		 * Ask the panel to open its editor on a term.
		 * @param term - the term to prefill.
		 * @param context - the sentence the term appeared in.
		 */
		requestCreate(term, context) {
			pending = { term: typeof term === "string" ? term : "", context: typeof context === "string" ? context : "", at: Date.now() };
			emit();
		},
		/**
		 * Read and clear the pending command.
		 * @returns the command, or null when there is none.
		 */
		consumeCreate() {
			const command = pending;
			pending = null;
			return command;
		},
		/**
		 * Ask the panel to reveal an entry it already holds.
		 *
		 * This is the other half of clicking a collected term: the explanation is
		 * already on screen under the pointer as a hover hint, so the click's job is
		 * to take the user to the entry itself.
		 *
		 * @param key - the entry's normalized key, or its id.
		 */
		requestFocus(key) {
			if (typeof key !== "string" || key === "") return;
			pendingFocus = { key, at: Date.now() };
			emit();
		},
		/**
		 * Read and clear the pending reveal.
		 * @returns the reveal request, or null when there is none.
		 */
		consumeFocus() {
			const command = pendingFocus;
			pendingFocus = null;
			return command;
		},
		/** Read the pending command without clearing it. @returns the command, or null. */
		peek() {
			return pending ?? pendingFocus;
		},
		/**
		 * Observe command changes.
		 * @param listener - the callback.
		 * @returns the unsubscribe function.
		 */
		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		}
	};
}

module.exports = { createPanelCommandBus };
