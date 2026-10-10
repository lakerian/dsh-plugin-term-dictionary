/**
 * Share codes: a pack as one pasteable string.
 *
 * Host side only, and deliberately so. Deflate and a hash need `node:zlib` and `node:crypto`; the page
 * has neither, and a second implementation in the browser (`CompressionStream`) would be a second
 * thing to keep in step with this one. The page therefore asks its own host to encode and decode, over
 * routes that already exist for exactly this kind of request.
 *
 * The wire format is `dshpack1:<base64url of the raw-deflate of the pack's JSON>`, with the prefix
 * defined in `core/pack.js` because the panel checks it before anything is sent and this module checks
 * it before anything is decompressed.
 */

import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { deflateRawSync, inflateRawSync } from "node:zlib";

const require = createRequire(import.meta.url);
const pack = require("./core/pack.js");

/**
 * How much a share code may decompress to.
 *
 * A cap, not a nicety: deflate turns a few kilobytes of zeroes into a few bytes, so without one a
 * pasted string from a stranger is a memory exhaustion attack on the app that pastes it.
 */
const MAX_INFLATED_BYTES = 4 * 1024 * 1024;

/**
 * The SHA-256 of some bytes, lowercase hex.
 * @param bytes - a string or a buffer.
 * @returns the digest.
 */
export function sha256Hex(bytes) {
	return createHash("sha256").update(typeof bytes === "string" ? Buffer.from(bytes, "utf8") : bytes).digest("hex");
}

/**
 * Turn a pack into a share code.
 * @param value - a built or parsed pack.
 * @returns the code.
 */
export function encodePackCode(value) {
	const deflated = deflateRawSync(Buffer.from(pack.packBytes(value), "utf8"), { level: 9 });
	return `${pack.PACK_CODE_PREFIX}${deflated.toString("base64url")}`;
}

/**
 * Turn a share code back into a pack.
 *
 * Whitespace is stripped before anything else: a code is long, and every real path it travels — a chat
 * message, a terminal, a text editor — eventually wraps it. The failures are told apart because they
 * send the user to different places: `not-a-code` means this is not a share code at all, `corrupt`
 * means the paste lost or mangled characters, `too-large` means the payload exceeded the cap.
 *
 * @param code - the pasted string.
 * @returns `{ ok: true, pack }`, or `{ ok: false, error }`.
 */
export function decodePackCode(code) {
	if (typeof code !== "string") return { ok: false, error: "not-a-code" };
	const trimmed = code.replace(/\s+/g, "");
	if (!trimmed.startsWith(pack.PACK_CODE_PREFIX)) return { ok: false, error: "not-a-code" };
	const body = trimmed.slice(pack.PACK_CODE_PREFIX.length);
	if (body === "") return { ok: false, error: "empty-code" };
	let inflated;
	try {
		inflated = inflateRawSync(Buffer.from(body, "base64url"), { maxOutputLength: MAX_INFLATED_BYTES });
	} catch (error) {
		const code = String(error?.code ?? "");
		return { ok: false, error: code === "ERR_BUFFER_TOO_LARGE" || code.includes("maxOutputLength") ? "too-large" : "corrupt" };
	}
	let raw;
	try {
		raw = JSON.parse(inflated.toString("utf8"));
	} catch (error) {
		void error;
		return { ok: false, error: "corrupt" };
	}
	// The pack's own validation, not a second one: a code and a fetched file must be judged by the same
	// rules, or one of the two paths becomes the way around them.
	return pack.parsePack(raw);
}

export { MAX_INFLATED_BYTES };
