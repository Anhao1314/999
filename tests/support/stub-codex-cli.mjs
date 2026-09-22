// A controlled `codex exec` test double for CodexExecAdapter tests.
//
// It is NOT Codex and NOT a model: it speaks the same process contract the real
// CLI was observed to speak (argv shape, stdin prompt, JSONL on stdout,
// --output-last-message file) so the adapter's own logic — workspace
// provisioning, JSONL mapping, result parsing, independent evidence — can be
// tested deterministically. Real CLI behavior is exercised only by the opt-in
// H1 scenarios (scripts/h1-codex-exec.mjs).
//
// Mode: FLOWCREDIT_STUB_MODE (default "execution-ok"). Dumps (all optional):
// FLOWCREDIT_STUB_ARGV_DUMP, FLOWCREDIT_STUB_ENV_DUMP, FLOWCREDIT_STUB_PROMPT_DUMP.
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const args = process.argv.slice(2);
const mode = process.env.FLOWCREDIT_STUB_MODE ?? "execution-ok";

if (args.includes("--version")) {
  process.stdout.write("codex-cli 0.0.0-stub\n");
  process.exit(0);
}

const valueOf = (flag) => {
  const index = args.indexOf(flag);
  return index >= 0 && index + 1 < args.length ? args[index + 1] : null;
};
const lastMessagePath = valueOf("--output-last-message");
const schemaPath = valueOf("--output-schema");
const workspace = process.cwd();

const envDump = process.env.FLOWCREDIT_STUB_ENV_DUMP;
if (envDump)
  writeFileSync(
    envDump,
    JSON.stringify({
      TMPDIR: process.env.TMPDIR ?? null,
      TMP: process.env.TMP ?? null,
      TEMP: process.env.TEMP ?? null,
      cwd: process.cwd(),
      schemaPresent: schemaPath ? true : false,
      argv: args,
    }),
    "utf8",
  );
const argvDump = process.env.FLOWCREDIT_STUB_ARGV_DUMP;
if (argvDump) writeFileSync(argvDump, JSON.stringify(process.argv.slice(2)), "utf8");

let prompt = "";
try {
  prompt = readFileSync(0, "utf8");
} catch {
  prompt = "";
}
const promptDump = process.env.FLOWCREDIT_STUB_PROMPT_DUMP;
if (promptDump) writeFileSync(promptDump, prompt, "utf8");

const writeLast = (text) => {
  if (lastMessagePath) writeFileSync(lastMessagePath, text, "utf8");
};
const write = (path, body) => writeFileSync(`${workspace}/${path}`, body, "utf8");
const emit = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);

function emitSession({ withReasoning = true } = {}) {
  emit({ type: "thread.started", thread_id: "stub-thread-0001" });
  emit({ type: "turn.started" });
  emit({
    type: "item.started",
    item: { id: "item_0", type: "command_execution", command: "node --test" },
  });
  emit({
    type: "item.completed",
    item: {
      id: "item_0",
      type: "command_execution",
      command: "node --test",
      aggregated_output: "ok",
      exit_code: 0,
      status: "completed",
    },
  });
  if (withReasoning)
    emit({
      type: "item.completed",
      item: { id: "item_1", type: "reasoning", text: "STUB CHAIN OF THOUGHT — MUST NOT CROSS THE SEAM" },
    });
  emit({
    type: "item.completed",
    item: { id: "item_2", type: "agent_message", text: "stub attempt finished" },
  });
  emit({ type: "turn.completed", usage: { input_tokens: 10, output_tokens: 5, reasoning_output_tokens: 2 } });
}

process.stderr.write("stub-codex-cli stderr note\n");

switch (mode) {
  case "execution-ok": {
    write("src/change.txt", "stub change\n");
    emitSession();
    writeLast(
      JSON.stringify({
        outcome: "SUCCEEDED",
        summary: "the stub implemented the requested behavior",
        reportedVerification: "stub ran node --test",
      }),
    );
    break;
  }
  case "execution-fenced": {
    write("src/change.txt", "stub change\n");
    emitSession();
    writeLast(
      'The attempt is complete.\n```json\n{"outcome":"SUCCEEDED","summary":"the stub implemented the requested behavior"}\n```\n',
    );
    break;
  }
  case "execution-two-fences": {
    write("src/change.txt", "stub change\n");
    emitSession();
    writeLast(
      '```json\n{"outcome":"SUCCEEDED","summary":"first"}\n```\nand also\n```json\n{"outcome":"FAILED","summary":"second"}\n```\n',
    );
    break;
  }
  case "execution-malformed": {
    // The stub first does real, complete work (the fixture's documented
    // behavior, so the independent `node --test` verification would pass) and
    // then answers with prose instead of the required JSON object. That is the
    // sharpest form of the protocol boundary: a green workspace, an invalid
    // result, and therefore no delivery at all.
    write(
      "src/validate.mjs",
      `export function validateRequest(schema, input) {
  const properties = schema?.properties ?? {};
  const errors = [];
  for (const key of Object.keys(input)) {
    if (!(key in properties)) errors.push({ path: key, code: "unknown_field" });
  }
  for (const [field, rule] of Object.entries(properties)) {
    const present = field in input && input[field] !== undefined;
    if (rule?.required === true && !present) {
      errors.push({ path: field, code: "required" });
      continue;
    }
    if (!present) continue;
    const value = input[field];
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
  errors.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return errors.length > 0 ? { ok: false, errors } : { ok: true, value: { ...input } };
}
`,
    );
    write(
      "src/handler.mjs",
      `import { validateRequest } from "./validate.mjs";

export function handleRequest(schema, input) {
  const result = validateRequest(schema, input);
  if (!result.ok) return { status: 400, body: { ok: false, errors: result.errors } };
  return { status: 200, body: { ok: true, value: result.value } };
}
`,
    );
    emitSession();
    writeLast("I finished the work. Everything is fine.");
    break;
  }
  case "execution-extra-field": {
    write("src/change.txt", "stub change\n");
    emitSession();
    writeLast(
      JSON.stringify({
        outcome: "SUCCEEDED",
        summary: "the stub tried to name Runtime facts",
        workerRunId: "run_forged",
      }),
    );
    break;
  }
  case "execution-no-change": {
    emitSession();
    writeLast(JSON.stringify({ outcome: "SUCCEEDED", summary: "claimed success without changing anything" }));
    break;
  }
  case "execution-agent-message-only": {
    // No last-message file at all: the adapter must fall back to the final
    // agent_message from the JSONL stream.
    write("src/change.txt", "stub change\n");
    emit({ type: "thread.started", thread_id: "stub-thread-0001" });
    emit({ type: "turn.started" });
    emit({
      type: "item.completed",
      item: {
        id: "item_2",
        type: "agent_message",
        text: JSON.stringify({ outcome: "SUCCEEDED", summary: "delivered only through the JSONL stream" }),
      },
    });
    emit({ type: "turn.completed", usage: { input_tokens: 3, output_tokens: 2, reasoning_output_tokens: 0 } });
    break;
  }
  case "execution-protected": {
    write("test/tampered.txt", "the stub touched a protected path\n");
    emitSession();
    writeLast(JSON.stringify({ outcome: "SUCCEEDED", summary: "the stub tampered with the tests" }));
    break;
  }
  case "execution-commit": {
    write("src/change.txt", "stub change\n");
    execFileSync("git", ["add", "-A"], { cwd: workspace, stdio: "ignore" });
    execFileSync(
      "git",
      ["-c", "user.name=stub", "-c", "user.email=stub@example.invalid", "commit", "-m", "stub commit"],
      { cwd: workspace, stdio: "ignore" },
    );
    emitSession();
    writeLast(JSON.stringify({ outcome: "SUCCEEDED", summary: "the stub committed" }));
    break;
  }
  case "review-ok": {
    emitSession();
    writeLast(JSON.stringify({ verdict: "PASS", findings: [], summary: "the stub judges the artifact acceptable" }));
    break;
  }
  case "review-revision": {
    emitSession();
    writeLast(
      JSON.stringify({
        verdict: "REQUEST_REVISION",
        findings: ["the stub wants one concrete change"],
        summary: "the stub asks for a revision",
      }),
    );
    break;
  }
  case "review-extra-field": {
    emitSession();
    writeLast(
      JSON.stringify({
        verdict: "PASS",
        findings: [],
        summary: "the stub tried to name a lineage fact",
        targetArtifactId: "artifact_forged",
      }),
    );
    break;
  }
  case "exit-1": {
    emit({ type: "thread.started", thread_id: "stub-thread-0001" });
    process.stdout.write("partial output before the failure\n");
    process.stderr.write("stub failed on purpose\n");
    process.exit(1);
    break;
  }
  case "hang": {
    emit({ type: "thread.started", thread_id: "stub-thread-0001" });
    setInterval(() => {}, 1000);
    break;
  }
  default:
    process.stderr.write(`unknown FLOWCREDIT_STUB_MODE: ${mode}\n`);
    process.exit(2);
}
