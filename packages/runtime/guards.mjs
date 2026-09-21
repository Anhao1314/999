// Input validation for the command boundary. Everything that can reach recorded
// truth is checked here: shape, bounds, JSON-safety and credential-shaped text.
import { BOUNDS } from "../work/records.mjs";
import { isCapability, normalizeCapabilities } from "../workforce/capabilities.mjs";
import { REVIEW_VERDICT_VALUES } from "../workforce/reviews.mjs";
import { kernelError } from "./errors.mjs";

// Patterns are assembled at runtime so this guard file does not itself match the
// repository credential scan (scripts/check.mjs).
const SECRET_PATTERNS = Object.freeze([
  [new RegExp(["s", "k", "-[A-Za-z0-9]{20,}"].join("")), "provider key"],
  [new RegExp(["api", "key", "_[A-Za-z0-9]{16,}"].join("")), "api key identifier"],
  [new RegExp(["gh", "p_[A-Za-z0-9]{20,}"].join("")), "git hosting token"],
  [new RegExp(["AK", "IA[0-9A-Z]{16}"].join("")), "cloud access key id"],
  [
    new RegExp(["-{5}", "BEGIN [A-Z ]*PRIVATE KEY", "-{5}"].join("")),
    "private key block",
  ],
  [
    new RegExp(["x", "ox[baprs]-[A-Za-z0-9-]{10,}"].join("")),
    "workspace chat token",
  ],
  [
    new RegExp(["TYPE", "SAFE", "_API_KEY"].join("")),
    "sensor credential reference",
  ],
]);

export function assertText(value, field, max, { min = 1, trim = true } = {}) {
  if (typeof value !== "string")
    throw kernelError("INVALID_INPUT", `${field} must be a string`);
  const text = trim ? value.trim() : value;
  if (text.length < min)
    throw kernelError("INVALID_INPUT", `${field} must not be empty`);
  if (text.length > max)
    throw kernelError(
      "INVALID_INPUT",
      `${field} must be at most ${max} characters`,
    );
  return text;
}

export function assertId(value, field) {
  if (typeof value !== "string" || value.length === 0 || value.length > BOUNDS.idMax)
    throw kernelError("INVALID_INPUT", `${field} must be a non-empty identifier`);
  return value;
}

export function assertInteger(value, field, { min = 0 } = {}) {
  if (!Number.isInteger(value) || value < min)
    throw kernelError("INVALID_INPUT", `${field} must be an integer >= ${min}`);
  return value;
}

export function assertEnabled(value, field) {
  if (typeof value !== "boolean")
    throw kernelError("INVALID_INPUT", `${field} must be a boolean`);
  return value;
}

export function assertKind(value, field) {
  if (typeof value !== "string" || !/^[A-Za-z][A-Za-z0-9_.-]{0,47}$/.test(value))
    throw kernelError(
      "INVALID_INPUT",
      `${field} must start with a letter and use letters, digits, dot, dash or underscore`,
    );
  return value;
}

// Capability identifiers are opaque to the core: validate the shape, then store
// them sorted and de-duplicated so anything derived from them is deterministic.
export function assertCapabilityList(value, field) {
  if (!Array.isArray(value))
    throw kernelError(
      "INVALID_CAPABILITY",
      `${field} must be an array of capability identifiers`,
    );
  for (const capability of value)
    if (!isCapability(capability))
      throw kernelError(
        "INVALID_CAPABILITY",
        `${field} contains an invalid capability: ${JSON.stringify(capability)}`,
      );
  return normalizeCapabilities(value);
}

// Identifiers that may be supplied by a caller (a seed or bootstrap path) must
// still be stable, opaque strings.
export function assertRecordId(value, field) {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_:.-]{0,127}$/.test(value))
    throw kernelError(
      "INVALID_INPUT",
      `${field} must be a stable identifier (letters, digits, underscore, colon, dot or dash)`,
    );
  return value;
}

// A review verdict is one of two words, and nothing else. There is no score, no
// severity and no probability: the runtime has no consumer that could act on
// them, and a number nobody reads is a number that will be believed anyway.
export function assertVerdict(value) {
  if (!REVIEW_VERDICT_VALUES.includes(value))
    throw kernelError(
      "INVALID_VERDICT",
      `verdict must be one of ${REVIEW_VERDICT_VALUES.join(", ")}`,
    );
  return value;
}

export function assertFindings(value, field) {
  if (!Array.isArray(value))
    throw kernelError("INVALID_INPUT", `${field} must be an array of text findings`);
  if (value.length > BOUNDS.reviewFindingsMax)
    throw kernelError(
      "INVALID_INPUT",
      `${field} must hold at most ${BOUNDS.reviewFindingsMax} findings`,
    );
  return value.map((finding, index) => {
    const text = assertText(finding, `${field}[${index}]`, BOUNDS.reviewFindingMax);
    assertNoSecret(text, `${field}[${index}]`);
    return text;
  });
}

export function assertNoSecret(text, field) {
  for (const [pattern, label] of SECRET_PATTERNS)
    if (pattern.test(text))
      throw kernelError(
        "SECRET_IN_OUTPUT",
        `${field} looks like it contains a ${label}; recorded truth must not hold credentials`,
      );
  return text;
}

export function serializeJsonValue(value, field, maxBytes) {
  let serialized;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw kernelError("INVALID_INPUT", `${field} must be JSON-serializable`);
  }
  if (serialized === undefined)
    throw kernelError("INVALID_INPUT", `${field} must be JSON-serializable`);
  if (Buffer.byteLength(serialized, "utf8") > maxBytes)
    throw kernelError(
      "INVALID_INPUT",
      `${field} exceeds the ${maxBytes}-byte bound`,
    );
  return serialized;
}
