// The H1.1 fixture repository — a harder, isolated target for the real Repair
// experiment (contract §8–§11).
//
// It is materialised from the template below, never from the FlowCredit
// checkout, and lives entirely under /tmp/flowcredit-h1-1. The initial state is
// `request-lab` release 2 in progress: release 1 is shipped and green, the new
// normalization behavior in docs/REQUIREMENTS.md is not implemented yet, and
// `node --test` is red until it is.
//
// REQUIREMENTS.md is authoritative and deliberately wider than test/: the
// shipped tests are a regression suite, not a complete specification. The
// documented-but-untested rules (duplicate alias input, the no-mutation
// guarantee, never inventing absent keys) are exactly the kind of requirement
// that independent review — not the Worker's own test run — has to catch.
//
// Everything is deterministic: fixed files, fixed committer, fixed dates, so
// the base revision is stable across runs. Keep template literals out of the
// embedded files (or escape them) — the template is one nested literal.
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const FIXED_DATE = "2026-01-01T00:00:00Z";

const NORMALIZATION_TEMPLATE = {
  "package.json": `{
  "name": "request-lab",
  "version": "2.0.0-dev",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "node --test"
  }
}
`,
  "README.md": `# request-lab

A deliberately small, dependency-free request library used by two internal
services. Release 1 is shipped: src/validate.mjs and src/handler.mjs validate a
plain request object against a plain schema and answer it.

Release 2 adds input normalization. docs/REQUIREMENTS.md is the authoritative
description of both releases. test/ is the regression suite and does not cover
every documented rule. Run:

    node --test
`,
  "docs/REQUIREMENTS.md": `# request-lab — required behavior

The library has one public entry point per concern:

    normalizeInput(schema, input)  -> { value, dropped, duplicates }   (src/normalize.mjs)
    validateRequest(schema, input) -> { ok: true, value } | { ok: false, errors }
    handleRequest(schema, input)   -> { status, body }

A schema carries \`properties\`: a map of field name to rule. A rule may declare

- \`required: true\`,
- \`type: "string" | "number" | "boolean"\`,
- \`minLength: N\` / \`maxLength: N\` — string length bounds, inclusive,
- \`alias: "legacyName"\` — a caller may use the alias instead of the field name.

## Release 1 — shipped, must keep working

validateRequest(schema, input) returns { ok: true, value } — value is a shallow
copy of input — or { ok: false, errors }, where every error is
{ path, code }:

1. required — a field that is missing, or present with the value undefined,
   produces { path: <field>, code: "required" }.
2. type — a type mismatch produces { path: <field>, code: "type" }. For type
   "number", NaN and non-finite values are type errors too.
3. minLength / maxLength apply to string values and produce "min_length" /
   "max_length".
4. At most one error per field, chosen by rule order: required, then type, then
   min_length, then max_length.
5. Every key of input that the schema does not declare produces
   { path: <key>, code: "unknown_field" } — one error per undeclared key.
6. errors is sorted by path (lexicographic), then by code.

handleRequest returns { status: 200, body: { ok: true, value } } for valid input
and { status: 400, body: { ok: false, errors } } for invalid input. It never
throws for a validation failure and never returns any other status.

## Release 2 — input normalization (the change to implement)

normalizeInput(schema, input) produces the value the services validate:

    { value, dropped, duplicates }

- value is a NEW object. input, and everything reachable from it, is never
  mutated: normalization is a pure function of the caller's data.
- Coercion is driven by the rule's declared type:
  * "string": surrounding whitespace is trimmed;
  * "number": a string that reads as a finite number becomes that number
    ("42", " -3.5 " -> -3.5);
  * "boolean": "true" / "false" in any case, and the numbers 1 and 0, become
    booleans.
  A value that cannot be coerced is left exactly as the caller wrote it, and
  the type rule then reports it against that original value.
- Aliases: an input key equal to a rule's alias is that field. value stores it
  under the canonical field name, never under the alias key.
- dropped lists the caller's keys that no rule declares. Such a key is never
  carried forward into value, and it still has to be reported — as
  { path: <caller's key>, code: "unknown_field" }.
- duplicates lists the alias keys for which the caller provided BOTH the
  canonical name and the alias. The canonical value wins, and each such alias
  key is reported as { path: <alias key>, code: "duplicate_input" }.
- A field the caller did not provide is never invented in value: no key is
  present with the value undefined merely because a rule exists.

## How the two fit together

handleRequest normalizes first and validates the normalized value, so:

- required, type and length rules judge the normalized value (length bounds
  apply to the trimmed string, and a coerced number is a number);
- the final error list is the validation errors plus one "unknown_field" per
  dropped key plus one "duplicate_input" per duplicate alias key, sorted by
  path, then code;
- a successful response carries the normalized value, not the caller's raw
  object;
- the "at most one error per field" rule still holds for the validation rules.
`,
  "src/validate.mjs": `// Request validation — release 1, shipped.
//
// docs/REQUIREMENTS.md describes this behavior and the release 2 change that
// src/normalize.mjs and src/handler.mjs still have to implement.
export function validateRequest(schema, input) {
  const properties = schema?.properties ?? {};
  const source = input ?? {};
  const errors = [];
  for (const [field, rule] of Object.entries(properties)) {
    const present = field in source && source[field] !== undefined;
    if (rule?.required === true && !present) {
      errors.push({ path: field, code: "required" });
      continue;
    }
    if (!present) continue;
    const value = source[field];
    if (rule?.type !== undefined) {
      const okType =
        rule.type === "number"
          ? typeof value === "number" && Number.isFinite(value)
          : typeof value === rule.type;
      if (!okType) {
        errors.push({ path: field, code: "type" });
        continue;
      }
    }
    if (typeof value === "string") {
      if (Number.isInteger(rule?.minLength) && value.length < rule.minLength) {
        errors.push({ path: field, code: "min_length" });
        continue;
      }
      if (Number.isInteger(rule?.maxLength) && value.length > rule.maxLength) {
        errors.push({ path: field, code: "max_length" });
        continue;
      }
    }
  }
  for (const key of Object.keys(source)) {
    if (!(key in properties)) errors.push({ path: key, code: "unknown_field" });
  }
  errors.sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : a.code < b.code ? -1 : a.code > b.code ? 1 : 0,
  );
  return errors.length > 0 ? { ok: false, errors } : { ok: true, value: { ...source } };
}
`,
  "src/handler.mjs": `// Request handling — release 1, shipped.
//
// Release 2 requires normalizing first and answering with the normalized value.
import { validateRequest } from "./validate.mjs";

export function handleRequest(schema, input) {
  const result = validateRequest(schema, input);
  if (!result.ok) return { status: 400, body: { ok: false, errors: result.errors } };
  return { status: 200, body: { ok: true, value: result.value } };
}
`,
  "src/normalize.mjs": `// Input normalization — first cut, incomplete.
//
// Only top-level string trimming is implemented so far. docs/REQUIREMENTS.md
// describes the rest of release 2: coercion by declared type, aliases, dropped
// keys and duplicate alias input.
export function normalizeInput(schema, input) {
  const source = input ?? {};
  const value = { ...source };
  for (const [key, current] of Object.entries(value)) {
    if (typeof current === "string") value[key] = current.trim();
  }
  return { value, dropped: [] };
}
`,
  "test/validate.test.mjs": `// Release 1 regression suite for validateRequest.
import test from "node:test";
import assert from "node:assert/strict";
import { validateRequest } from "../src/validate.mjs";

const schema = {
  properties: {
    name: { type: "string", required: true, minLength: 2 },
    age: { type: "number" },
  },
};

test("a valid request returns a shallow copy of the input", () => {
  const input = { name: "Ada", age: 36 };
  const result = validateRequest(schema, input);
  assert.equal(result.ok, true);
  assert.deepEqual(result.value, input);
  assert.notEqual(result.value, input);
});

test("a missing required field is reported", () => {
  const result = validateRequest(schema, { age: 36 });
  assert.equal(result.ok, false);
  assert.deepEqual(result.errors, [{ path: "name", code: "required" }]);
});

test("a type mismatch is reported, and NaN is not a number", () => {
  assert.deepEqual(validateRequest(schema, { name: "Ada", age: "36" }).errors, [
    { path: "age", code: "type" },
  ]);
  assert.deepEqual(validateRequest(schema, { name: "Ada", age: Number.NaN }).errors, [
    { path: "age", code: "type" },
  ]);
});

test("string bounds are enforced", () => {
  assert.deepEqual(validateRequest(schema, { name: "A" }).errors, [
    { path: "name", code: "min_length" },
  ]);
  assert.deepEqual(
    validateRequest(
      { properties: { name: { type: "string", maxLength: 3 } } },
      { name: "Ada!" },
    ).errors,
    [{ path: "name", code: "max_length" }],
  );
});

test("undeclared keys are reported once each, and errors are sorted by path", () => {
  const result = validateRequest(schema, { name: "Ada", zeta: 1, alpha: 2 });
  assert.deepEqual(result.errors, [
    { path: "alpha", code: "unknown_field" },
    { path: "zeta", code: "unknown_field" },
  ]);
});

test("only the first failing rule per field is reported", () => {
  const result = validateRequest(
    { properties: { name: { type: "string", required: true, minLength: 5 } } },
    { name: 12 },
  );
  assert.deepEqual(result.errors, [{ path: "name", code: "type" }]);
});
`,
  "test/normalize.test.mjs": `// Release 2: input normalization.
import test from "node:test";
import assert from "node:assert/strict";
import { normalizeInput } from "../src/normalize.mjs";

const schema = {
  properties: {
    name: { type: "string", required: true, minLength: 2 },
    age: { type: "number" },
    active: { type: "boolean" },
    nickname: { type: "string", alias: "nick" },
  },
};

test("a string field is trimmed", () => {
  const result = normalizeInput(schema, { name: "  Ada  " });
  assert.equal(result.value.name, "Ada");
});

test("a numeric string becomes a number", () => {
  const result = normalizeInput(schema, { name: "Ada", age: " -3.5 " });
  assert.equal(result.value.age, -3.5);
  assert.equal(typeof result.value.age, "number");
});

test("boolean spellings and 1/0 become booleans", () => {
  assert.equal(normalizeInput(schema, { name: "Ada", active: "TRUE" }).value.active, true);
  assert.equal(normalizeInput(schema, { name: "Ada", active: "false" }).value.active, false);
  assert.equal(normalizeInput(schema, { name: "Ada", active: 1 }).value.active, true);
  assert.equal(normalizeInput(schema, { name: "Ada", active: 0 }).value.active, false);
});

test("a value that cannot be coerced is left exactly as the caller wrote it", () => {
  const result = normalizeInput(schema, { name: "Ada", age: "forty" });
  assert.equal(result.value.age, "forty");
});

test("an alias key is normalized to the canonical name", () => {
  const result = normalizeInput(schema, { name: "Ada", nick: "Addie" });
  assert.equal(result.value.nickname, "Addie");
  assert.equal("nick" in result.value, false);
});

test("an undeclared key is dropped from the value and listed in dropped", () => {
  const result = normalizeInput(schema, { name: "Ada", colour: "red" });
  assert.equal("colour" in result.value, false);
  assert.deepEqual(result.dropped, ["colour"]);
});

test("a missing field is not invented", () => {
  const result = normalizeInput(schema, { name: "Ada" });
  assert.equal("nickname" in result.value, false);
});
`,
  "test/handler.test.mjs": `// Release 2: the handler normalizes first and answers with the normalized value.
import test from "node:test";
import assert from "node:assert/strict";
import { handleRequest } from "../src/handler.mjs";

const schema = {
  properties: {
    name: { type: "string", required: true, minLength: 2 },
    age: { type: "number" },
    nickname: { type: "string", alias: "nick" },
  },
};

test("a valid request answers with the normalized value", () => {
  const response = handleRequest(schema, { name: " Ada ", age: "36" });
  assert.equal(response.status, 200);
  assert.equal(response.body.ok, true);
  assert.equal(response.body.value.name, "Ada");
  assert.equal(response.body.value.age, 36);
});

test("validation judges the normalized value", () => {
  const response = handleRequest(schema, { name: " A " });
  assert.equal(response.status, 400);
  assert.deepEqual(response.body.errors, [{ path: "name", code: "min_length" }]);
});

test("an alias key is accepted end to end and answered under the canonical name", () => {
  const response = handleRequest(schema, { name: "Ada", nick: "Addie" });
  assert.equal(response.status, 200);
  assert.equal(response.body.value.nickname, "Addie");
  assert.equal("nick" in response.body.value, false);
});

test("an undeclared key is reported at the caller's key", () => {
  const response = handleRequest(schema, { name: "Ada", colour: "red" });
  assert.equal(response.status, 400);
  assert.deepEqual(response.body.errors, [{ path: "colour", code: "unknown_field" }]);
});
`,
};

const DURATION_TEMPLATE = {
  "package.json": `{
  "name": "duration-lab",
  "version": "2.0.0-dev",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "node --test"
  }
}
`,
  "README.md": `# duration-lab

A dependency-free duration library used by a scheduling service and a billing
service. Release 1 is shipped: the legacy compact format, in src/parse.mjs and
src/format.mjs.

Release 2 adds ISO-8601 durations and one canonical form.
docs/REQUIREMENTS.md is authoritative and is deliberately wider than test/:
the shipped tests are a regression suite, not a complete specification. Run:

    node --test
`,
  "docs/REQUIREMENTS.md": `# duration-lab — required behavior

Two accepted input formats, one canonical output form.

## Legacy compact — release 1, shipped, must keep working

parseDuration(text) -> seconds (number) | null

- A component is an integer immediately followed by one of d, h, m, s:
  no space between the number and its unit.
- Components follow strictly descending units (d before h before m before s),
  each unit at most once; any other order or repetition is invalid.
- Arbitrary whitespace may separate components; surrounding whitespace is
  ignored. At least one component is required.
- "0s" is valid and means 0. Anything else is null. It never throws.

formatDuration(seconds) -> string | null

- seconds must be a non-negative integer, otherwise null.
- Largest units first, space-separated, zero components omitted, and 0 is "0s":
  5400 -> "1h 30m"; 93784 -> "1d 2h 3m 4s".

## ISO-8601 durations — release 2, to implement

parseIsoDuration(text) -> seconds (number) | null

- Uppercase only, no spaces anywhere: P [<n>D] [T [<n>H] [<n>M] [<n>S]].
- A "T" must be followed by at least one time component. "P" alone, "PT" alone
  and a trailing "T" with no time component are invalid.
- The date part accepts days only: a month or year component is NOT a duration
  this library accepts ("P1M" is invalid; "PT1M" is one minute).
- Components are integers >= 0 and may carry leading zeros ("PT01H" is 3600).
  Signs and fractions are invalid.
- At least one component overall; "P0D" and "PT0S" are valid and mean 0.
- Surrounding whitespace is ignored. Anything else is null. It never throws.

formatIsoDuration(seconds) -> string | null

- seconds must be a non-negative integer, otherwise null.
- Canonical form: days as P<n>D, then a T part only when at least one of H, M, S
  is non-zero; zero components are omitted; everything zero is "PT0S".
  86400 -> "P1D"; 3600 -> "PT1H"; 5400 -> "PT1H30M"; 93784 -> "P1DT2H3M4S";
  0 -> "PT0S".

normalizeDuration(text) -> canonical ISO string | null

- Accepts either format and returns the canonical ISO form.
- Legacy input is carried into the largest units:
  "90m" -> "PT1H30M"; "1h 60m" -> "PT2H"; "100s" -> "PT1M40S"; "0s" -> "PT0S".
- ISO input is canonicalized: "PT90S" -> "PT1M30S"; "P1DT0H0M0S" -> "P1D".
- Invalid input is null. It never throws.
`,
  "src/parse.mjs": `// Legacy compact durations — release 1, shipped.
//
// docs/REQUIREMENTS.md describes this behavior and the ISO-8601 format that
// src/normalize.mjs still has to implement.
const LEGACY = /^(?:(\\d+)d)?\\s*(?:(\\d+)h)?\\s*(?:(\\d+)m)?\\s*(?:(\\d+)s)?$/;

export function parseDuration(text) {
  if (typeof text !== "string") return null;
  const trimmed = text.trim();
  if (trimmed.length === 0) return null;
  const match = LEGACY.exec(trimmed);
  if (!match) return null;
  const [, days, hours, minutes, seconds] = match;
  if (days === undefined && hours === undefined && minutes === undefined && seconds === undefined)
    return null;
  return (
    Number(days ?? 0) * 86400 + Number(hours ?? 0) * 3600 + Number(minutes ?? 0) * 60 + Number(seconds ?? 0)
  );
}
`,
  "src/format.mjs": `// Legacy compact formatting — release 1, shipped.
const UNITS = [
  [86400, "d"],
  [3600, "h"],
  [60, "m"],
  [1, "s"],
];

export function formatDuration(seconds) {
  if (!Number.isInteger(seconds) || seconds < 0) return null;
  if (seconds === 0) return "0s";
  let rest = seconds;
  const parts = [];
  for (const [size, unit] of UNITS) {
    const value = Math.floor(rest / size);
    if (value > 0) {
      parts.push(String(value) + unit);
      rest -= value * size;
    }
  }
  return parts.join(" ");
}
`,
  "src/normalize.mjs": `// ISO-8601 durations and the canonical form — first cut, incomplete.
//
// Only a strictly canonical time-only ISO echo is implemented so far. The day
// component, the leading-zero, carry and rejection rules in
// docs/REQUIREMENTS.md are still missing.
export function parseIsoDuration(text) {
  const match =
    typeof text === "string" ? /^PT(?:(\\d+)H)?(?:(\\d+)M)?(?:(\\d+)S)?$/.exec(text.trim()) : null;
  if (!match) return null;
  const [, hours, minutes, seconds] = match;
  if (hours === undefined && minutes === undefined && seconds === undefined) return null;
  return Number(hours ?? 0) * 3600 + Number(minutes ?? 0) * 60 + Number(seconds ?? 0);
}

export function formatIsoDuration(seconds) {
  if (!Number.isInteger(seconds) || seconds < 0) return null;
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  let out = "PT";
  if (hours > 0) out += hours + "H";
  if (minutes > 0) out += minutes + "M";
  if (rest > 0) out += rest + "S";
  return out === "PT" ? "PT0S" : out;
}

export function normalizeDuration(text) {
  const parsed = parseIsoDuration(text);
  return parsed === null ? null : formatIsoDuration(parsed);
}
`,
  "test/parse.test.mjs": `// Release 1 regression suite for the legacy compact format.
import test from "node:test";
import assert from "node:assert/strict";
import { parseDuration } from "../src/parse.mjs";
import { formatDuration } from "../src/format.mjs";

test("legacy components parse to seconds", () => {
  assert.equal(parseDuration("1h30m"), 5400);
  assert.equal(parseDuration("90m"), 5400);
  assert.equal(parseDuration("2d"), 172800);
  assert.equal(parseDuration("1d 2h 3m 4s"), 93784);
  assert.equal(parseDuration(" 5s "), 5);
  assert.equal(parseDuration("0s"), 0);
});

test("an invalid legacy duration is null, never a throw", () => {
  assert.equal(parseDuration("abc"), null);
  assert.equal(parseDuration(""), null);
  assert.equal(parseDuration("1 h"), null);
  assert.equal(parseDuration(42), null);
});

test("legacy formatting writes the compact form", () => {
  assert.equal(formatDuration(5400), "1h 30m");
  assert.equal(formatDuration(0), "0s");
  assert.equal(formatDuration(93784), "1d 2h 3m 4s");
  assert.equal(formatDuration(-1), null);
});
`,
  "test/normalize.test.mjs": `// Release 2: ISO-8601 durations and the canonical form.
import test from "node:test";
import assert from "node:assert/strict";
import { parseIsoDuration, formatIsoDuration, normalizeDuration } from "../src/normalize.mjs";

test("ISO durations parse to seconds", () => {
  assert.equal(parseIsoDuration("PT1H30M"), 5400);
  assert.equal(parseIsoDuration("P1DT2H3M4S"), 93784);
  assert.equal(parseIsoDuration("P1D"), 86400);
  assert.equal(parseIsoDuration("PT0S"), 0);
});

test("an invalid ISO duration is null, never a throw", () => {
  assert.equal(parseIsoDuration("PT"), null);
  assert.equal(parseIsoDuration("1h"), null);
  assert.equal(parseIsoDuration(""), null);
});

test("formatIsoDuration writes the canonical form", () => {
  assert.equal(formatIsoDuration(86400), "P1D");
  assert.equal(formatIsoDuration(5400), "PT1H30M");
  assert.equal(formatIsoDuration(93784), "P1DT2H3M4S");
  assert.equal(formatIsoDuration(0), "PT0S");
  assert.equal(formatIsoDuration(-1), null);
});

test("normalizeDuration accepts both formats and answers in canonical ISO", () => {
  assert.equal(normalizeDuration("90m"), "PT1H30M");
  assert.equal(normalizeDuration("1d 2h"), "P1DT2H");
  assert.equal(normalizeDuration("PT2H"), "PT2H");
  assert.equal(normalizeDuration("0s"), "PT0S");
  assert.equal(normalizeDuration("nonsense"), null);
});
`,
};

const SLOTS_TEMPLATE = {
  "package.json": `{
  "name": "slots-lab",
  "version": "2.0.0-dev",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "node --test"
  }
}
`,
  "README.md": `# slots-lab

A dependency-free interval library used by a scheduling service. Release 1 is
shipped: mergeIntervals and totalMinutes in src/intervals.mjs.

Release 2 adds subtraction, intersection and free-slot discovery.
docs/REQUIREMENTS.md is authoritative and is deliberately wider than test/:
the shipped tests are a regression suite, not a complete specification. Run:

    node --test
`,
  "docs/REQUIREMENTS.md": `# slots-lab — required behavior

Every interval is half-open: it covers start up to, but not including, end. All
bounds are integer minutes.

An interval is *usable* when it is an object (not null) whose start and end are
finite integers and end > start. A value that is not usable is ignored
everywhere: it is never an error, never a throw, and never part of a result.

## Release 1 — shipped, must keep working

mergeIntervals(intervals) -> array of intervals

- Usable intervals are merged only when they OVERLAP. Two intervals that merely
  touch (one ends exactly where the next starts) stay two intervals: [1,3) and
  [3,5) merge to nothing, they remain [1,3), [3,5).
- The result is sorted by start, contains no zero-length interval, and every
  interval in it is a NEW object: inputs are never mutated.

totalMinutes(intervals) -> number

- The merged coverage, in minutes.

## Release 2 — interval algebra, to implement

subtractIntervals(base, cuts) -> array of intervals

- Removes every minute covered by a usable cut from every usable base interval.
- A cut may sit anywhere relative to a base interval: inside it, covering it
  entirely, or hanging over either end. Overhang is clipped away, so
  subtract([1,10), [0,5)) is [5,10) and subtract([1,10), [0,99)) is empty.
- Cuts that merely touch each other still remove one continuous range, and a
  remaining piece is never zero-length: subtract([1,10), [3,5), [5,7)) is
  [1,3), [7,10) — never [1,3), [5,5), [7,10).
- The result is sorted by start, non-overlapping, and every interval in it is a
  NEW object, including when a base interval is returned unchanged.
- Neither base nor cuts is mutated.

intersectIntervals(a, b) -> array of intervals

- The shared coverage of the two lists. Intervals that merely touch share
  nothing: intersect([1,3), [3,5)) is empty.
- Sorted, non-overlapping, no zero-length interval, all objects new.

freeSlots(day, busy) -> array of intervals

- The part of day that busy does not cover — exactly
  subtractIntervals(day, busy), with the same rules.

No function throws for unusable input: unusable values are ignored, and an
empty result is an empty array.
`,
  "src/intervals.mjs": `// Interval algebra — release 1, shipped.
//
// Every interval is half-open: [start, end). A value that is not an object with
// finite integer bounds and end > start is ignored everywhere.
export function isUsableInterval(value) {
  return (
    typeof value === "object" &&
    value !== null &&
    Number.isInteger(value.start) &&
    Number.isInteger(value.end) &&
    value.end > value.start
  );
}

export function usableIntervals(intervals) {
  return (Array.isArray(intervals) ? intervals : [])
    .filter(isUsableInterval)
    .map((interval) => ({ start: interval.start, end: interval.end }));
}

export function mergeIntervals(intervals) {
  const sorted = usableIntervals(intervals).sort((a, b) => a.start - b.start || a.end - b.end);
  const merged = [];
  for (const interval of sorted) {
    const last = merged[merged.length - 1];
    // Overlap only. A touching interval starts exactly where the last one ends
    // and stays separate.
    if (last && interval.start < last.end) {
      if (interval.end > last.end) last.end = interval.end;
      continue;
    }
    merged.push(interval);
  }
  return merged;
}

export function totalMinutes(intervals) {
  return mergeIntervals(intervals).reduce((sum, interval) => sum + (interval.end - interval.start), 0);
}
`,
  "src/subtract.mjs": `// Release 2 — subtraction, intersection and free slots: first cut.
//
// Only the trivial case is implemented so far: docs/REQUIREMENTS.md describes
// clipping, continuous cuts, new-object results and the half-open boundary
// rules that are still missing.
import { mergeIntervals } from "./intervals.mjs";

export function subtractIntervals(base, cuts) {
  return mergeIntervals(base);
}

export function intersectIntervals(a, b) {
  return [];
}

export function freeSlots(day, busy) {
  return subtractIntervals(day, busy);
}
`,
  "test/intervals.test.mjs": `// Release 1 regression suite for the interval library.
import test from "node:test";
import assert from "node:assert/strict";
import { mergeIntervals, totalMinutes } from "../src/intervals.mjs";

test("overlapping intervals merge, and the result is sorted", () => {
  assert.deepEqual(
    mergeIntervals([
      { start: 100, end: 120 },
      { start: 0, end: 50 },
      { start: 40, end: 70 },
    ]),
    [
      { start: 0, end: 70 },
      { start: 100, end: 120 },
    ],
  );
});

test("touching intervals do not merge", () => {
  assert.deepEqual(
    mergeIntervals([
      { start: 1, end: 3 },
      { start: 3, end: 5 },
    ]),
    [
      { start: 1, end: 3 },
      { start: 3, end: 5 },
    ],
  );
});

test("unusable intervals are ignored, never an error", () => {
  assert.deepEqual(mergeIntervals([{ start: 5, end: 5 }, { start: 7, end: 3 }, null, 42, "x", { start: 1.5, end: 4 }]), []);
});

test("merging returns new objects and never mutates the input", () => {
  const base = [{ start: 1, end: 10 }];
  const snapshot = JSON.stringify(base);
  const merged = mergeIntervals(base);
  assert.deepEqual(merged, [{ start: 1, end: 10 }]);
  assert.notEqual(merged[0], base[0]);
  assert.equal(JSON.stringify(base), snapshot);
});

test("totalMinutes sums the merged coverage", () => {
  assert.equal(totalMinutes([{ start: 0, end: 60 }, { start: 30, end: 90 }]), 90);
});
`,
  "test/subtract.test.mjs": `// Release 2: subtraction, intersection and free slots.
import test from "node:test";
import assert from "node:assert/strict";
import { subtractIntervals, intersectIntervals, freeSlots } from "../src/subtract.mjs";

test("a cut removes exactly the half-open range and splits the base", () => {
  assert.deepEqual(
    subtractIntervals([{ start: 1, end: 10 }], [{ start: 3, end: 5 }]),
    [
      { start: 1, end: 3 },
      { start: 5, end: 10 },
    ],
  );
});

test("a cut covering the base leaves nothing", () => {
  assert.deepEqual(subtractIntervals([{ start: 1, end: 10 }], [{ start: 1, end: 10 }]), []);
});

test("freeSlots returns the gaps of a day", () => {
  assert.deepEqual(
    freeSlots(
      [{ start: 0, end: 1440 }],
      [
        { start: 0, end: 60 },
        { start: 1380, end: 1440 },
      ],
    ),
    [{ start: 60, end: 1380 }],
  );
});

test("intersectIntervals returns the shared coverage", () => {
  assert.deepEqual(
    intersectIntervals([{ start: 1, end: 5 }], [{ start: 3, end: 9 }]),
    [{ start: 3, end: 5 }],
  );
});

test("inputs are never mutated and results are new objects", () => {
  const base = [{ start: 1, end: 10 }];
  const cuts = [{ start: 3, end: 5 }];
  const snapshot = JSON.stringify({ base, cuts });
  const result = subtractIntervals(base, cuts);
  assert.equal(JSON.stringify({ base, cuts }), snapshot);
  assert.notEqual(result[0], base[0]);
});
`,
};

export const H11_FIXTURE_VERIFICATION = Object.freeze(["node", "--test"]);
export const H11_FIXTURE_PROTECTED_PATHS = Object.freeze(["test/"]);

const git = (args, cwd, env) =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });

// The real task scenarios share one builder; each variant is a different
// plausible product change on a different library.
export const H11_VARIANTS = Object.freeze({
  normalization: NORMALIZATION_TEMPLATE,
  duration: DURATION_TEMPLATE,
  slots: SLOTS_TEMPLATE,
});

// Materialise /tmp/flowcredit-h1-1/<...>/repo with one deterministic base commit.
export function buildH11Fixture({ root, variant = "normalization" }) {
  if (!root) throw new Error("buildH11Fixture requires a root directory");
  const template = H11_VARIANTS[variant];
  if (!template) throw new Error(`unknown H1.1 fixture variant: ${variant}`);
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  for (const [path, content] of Object.entries(template)) {
    const target = join(root, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content, "utf8");
  }
  const identity = [
    "-c", "user.name=H1.1 Fixture",
    "-c", "user.email=h11-fixture@example.invalid",
    "-c", "commit.gpgsign=false",
  ];
  const dates = { GIT_AUTHOR_DATE: FIXED_DATE, GIT_COMMITTER_DATE: FIXED_DATE };
  git(["init", "-q"], root);
  git(["add", "."], root);
  git([...identity, "commit", "-qm", variant === "duration"
      ? "duration-lab: release 2 in progress"
      : variant === "slots"
        ? "slots-lab: release 2 in progress"
        : "request-lab: release 2 in progress"], root, dates);
  const baseRevision = git(["rev-parse", "HEAD"], root).trim();
  return Object.freeze({
    repository: root,
    baseRevision,
    verification: H11_FIXTURE_VERIFICATION,
    protectedPaths: H11_FIXTURE_PROTECTED_PATHS,
  });
}
