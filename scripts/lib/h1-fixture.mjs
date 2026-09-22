// The H1 fixture repository — a real, isolated git repository for the first
// live CodexExecAdapter runs (contract §20).
//
// It is materialised from the template below, never from the FlowCredit
// checkout, and lives entirely under /tmp. The initial state is a small,
// dependency-free request-validation library whose sources are an unfinished
// first cut: `node --test` fails until the documented behavior in
// docs/REQUIREMENTS.md is implemented, and the tests must stay untouched.
//
// Everything is deterministic: fixed files, fixed committer, fixed dates, so
// the base revision is stable across runs. Keep template literals out of the
// embedded files (or escape them) — the template is one nested literal.
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const FIXED_DATE = "2026-01-01T00:00:00Z";

const TEMPLATE = {
  "package.json": `{
  "name": "request-lab",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "node --test"
  }
}
`,
  "README.md": `# request-lab

A deliberately small, dependency-free library used as the FlowCredit H1
execution target: it validates a plain request object against a plain schema
and answers it.

The current sources are an unfinished first cut. docs/REQUIREMENTS.md is the
documented behavior, and test/ is the verification of that behavior. Run:

    node --test
`,
  "docs/REQUIREMENTS.md": `# Request validation — required behavior

The library has exactly two modules. Both are part of the documented behavior.

## validateRequest(schema, input)

Returns { ok: true, value } when the input is valid, { ok: false, errors }
otherwise. On success, value is a shallow copy of input.

A schema carries \`properties\`: a map of field name to rule. A rule may declare:

- \`required: true\` — the field must be present,
- \`type: "string" | "number" | "boolean"\`,
- \`minLength: N\` — string length lower bound (inclusive),
- \`maxLength: N\` — string length upper bound (inclusive).

Rules, in order:

1. required: a field that is missing, or present with the value undefined,
   produces { path: <field>, code: "required" }.
2. type: when a rule declares type and the value's typeof does not match,
   produce { path: <field>, code: "type" }. For type "number", NaN is also a
   type error (Number.isFinite must hold).
3. minLength / maxLength: apply to string values. A too-short string produces
   { path: <field>, code: "min_length" }; a too-long string produces
   { path: <field>, code: "max_length" }.
4. At most one error per field, chosen by rule order: required, then type,
   then min_length, then max_length.
5. Every key of input that is not declared in schema.properties produces
   { path: <key>, code: "unknown_field" } — one error per undeclared key.
6. errors is sorted by path (lexicographic, code-unit order).

## handleRequest(schema, input)

- valid input -> { status: 200, body: { ok: true, value } }
- invalid input -> { status: 400, body: { ok: false, errors } }

handleRequest never throws for a validation failure, and it never returns any
other status.
`,
  "src/validate.mjs": `// Request validation — first cut.
//
// Only the required rule is implemented so far. The documented behavior in
// docs/REQUIREMENTS.md is not complete yet; test/ says what is expected.
export function validateRequest(schema, input) {
  const properties = schema?.properties ?? {};
  const errors = [];
  for (const [field, rule] of Object.entries(properties)) {
    if (rule?.required === true && !(field in input)) {
      errors.push({ path: field, code: "required" });
    }
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: { ...input } };
}
`,
  "src/handler.mjs": `// The request entry point — first cut.
//
// Validation failures are not answered yet; the documented behavior in
// docs/REQUIREMENTS.md is not complete. test/ says what is expected.
import { validateRequest } from "./validate.mjs";

export function handleRequest(schema, input) {
  const result = validateRequest(schema, input);
  if (!result.ok) throw new Error("invalid request");
  return { status: 200, body: { ok: true, value: result.value } };
}
`,
  "test/validate.test.mjs": `import test from "node:test";
import assert from "node:assert/strict";
import { validateRequest } from "../src/validate.mjs";

const schema = {
  properties: {
    name: { required: true, type: "string", minLength: 2, maxLength: 20 },
    age: { type: "number" },
    active: { type: "boolean" },
  },
};

test("a valid request returns ok with a copy of the input", () => {
  const input = { name: "Ada", age: 36, active: true };
  const result = validateRequest(schema, input);
  assert.deepEqual(result, { ok: true, value: { name: "Ada", age: 36, active: true } });
  assert.notEqual(result.value, input, "the returned value is a copy, not the input object");
});

test("a missing required field is reported", () => {
  assert.deepEqual(validateRequest(schema, { age: 1 }), {
    ok: false,
    errors: [{ path: "name", code: "required" }],
  });
});

test("a required field present as undefined is treated as missing", () => {
  assert.deepEqual(validateRequest({ properties: { name: { required: true } } }, { name: undefined }), {
    ok: false,
    errors: [{ path: "name", code: "required" }],
  });
});

test("type mismatches are reported, and NaN is not a number", () => {
  assert.deepEqual(validateRequest({ properties: { age: { type: "number" } } }, { age: "36" }), {
    ok: false,
    errors: [{ path: "age", code: "type" }],
  });
  assert.deepEqual(validateRequest({ properties: { age: { type: "number" } } }, { age: Number.NaN }), {
    ok: false,
    errors: [{ path: "age", code: "type" }],
  });
});

test("string bounds are enforced", () => {
  assert.deepEqual(validateRequest({ properties: { name: { type: "string", minLength: 2 } } }, { name: "A" }), {
    ok: false,
    errors: [{ path: "name", code: "min_length" }],
  });
  assert.deepEqual(validateRequest({ properties: { name: { type: "string", maxLength: 3 } } }, { name: "Ada!" }), {
    ok: false,
    errors: [{ path: "name", code: "max_length" }],
  });
});

test("keys that the schema does not declare are reported", () => {
  assert.deepEqual(validateRequest(schema, { name: "Ada", extra: true }), {
    ok: false,
    errors: [{ path: "extra", code: "unknown_field" }],
  });
});

test("errors are sorted by path and only the first failing rule per field is kept", () => {
  assert.deepEqual(validateRequest({ properties: { b: { required: true }, a: { required: true } } }, {}), {
    ok: false,
    errors: [
      { path: "a", code: "required" },
      { path: "b", code: "required" },
    ],
  });
  assert.deepEqual(
    validateRequest({ properties: { name: { required: true, type: "string", minLength: 5 } } }, { name: 7 }),
    { ok: false, errors: [{ path: "name", code: "type" }] },
  );
});
`,
  "test/handler.test.mjs": `import test from "node:test";
import assert from "node:assert/strict";
import { handleRequest } from "../src/handler.mjs";

test("a valid request is answered 200 with the value", () => {
  const response = handleRequest({ properties: { name: { required: true, type: "string" } } }, { name: "Ada" });
  assert.deepEqual(response, { status: 200, body: { ok: true, value: { name: "Ada" } } });
});

test("an invalid request is answered 400 with the errors, not an exception", () => {
  const response = handleRequest({ properties: { name: { required: true } } }, {});
  assert.deepEqual(response, {
    status: 400,
    body: { ok: false, errors: [{ path: "name", code: "required" }] },
  });
});
`,
};

export const H1_FIXTURE_VERIFICATION = Object.freeze(["node", "--test"]);
export const H1_FIXTURE_PROTECTED_PATHS = Object.freeze(["test/"]);

const git = (args, cwd, env) =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });

// Materialise /tmp/flowcredit-h1/<...>/repo with one deterministic base commit.
export function buildH1Fixture({ root }) {
  if (!root) throw new Error("buildH1Fixture requires a root directory");
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  for (const [path, content] of Object.entries(TEMPLATE)) {
    const target = join(root, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content, "utf8");
  }
  const identity = [
    "-c", "user.name=H1 Fixture",
    "-c", "user.email=h1-fixture@example.invalid",
    "-c", "commit.gpgsign=false",
  ];
  const dates = { GIT_AUTHOR_DATE: FIXED_DATE, GIT_COMMITTER_DATE: FIXED_DATE };
  git(["init", "-q"], root);
  git(["add", "."], root);
  git([...identity, "commit", "-qm", "request-lab: unfinished first cut"], root, dates);
  const baseRevision = git(["rev-parse", "HEAD"], root).trim();
  return Object.freeze({
    repository: root,
    baseRevision,
    verification: H1_FIXTURE_VERIFICATION,
    protectedPaths: H1_FIXTURE_PROTECTED_PATHS,
  });
}
