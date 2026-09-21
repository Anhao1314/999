// Input validation for the command boundary. Everything that can reach recorded
// truth is checked here: shape, bounds, JSON-safety and credential-shaped text.
import { BOUNDS } from "../work/records.mjs";
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

export function assertKind(value, field) {
  if (typeof value !== "string" || !/^[A-Za-z][A-Za-z0-9_.-]{0,47}$/.test(value))
    throw kernelError(
      "INVALID_INPUT",
      `${field} must start with a letter and use letters, digits, dot, dash or underscore`,
    );
  return value;
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
