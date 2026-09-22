// Minimal runtime process for the Persistent Work Kernel (v0A → v0B4).
//
// Purpose: prove the kernel can be hosted as a long-lived process, and give the
// restart tests and the demonstrations a real process to kill. It is a kernel
// transport, not a product API: it exposes the kernel's commands and its read
// model as they already are, and adds no lifecycle of its own. A UI would
// render these projections; this file is not one.
//
//   FLOWCREDIT_RUNTIME_DIR  store directory (default: ./.runtime/kernel)
//   FLOWCREDIT_PORT         port on 127.0.0.1 (default: 0 = ephemeral)
//   FLOWCREDIT_COORDINATION `driver` installs the Continuation Driver inside
//                           this process: committed changes wake it, and every
//                           non-terminal Work is driven once after recovery.
//                           `off` (default) leaves the kernel exactly as v0A–v0B3
//                           describe it. The host decides; the kernel never
//                           drives itself, and `driveWork` stays available as
//                           an explicit command either way.
//   FLOWCREDIT_WORKER_BACKEND `off` (default) | `test-worker` | `codex-exec` —
//                           which WorkerAdapter executes committed attempts.
//                           `codex-exec` additionally needs FLOWCREDIT_CODEX_REPO
//                           and reads FLOWCREDIT_CODEX_BASE_REVISION,
//                           FLOWCREDIT_CODEX_VERIFICATION (whitespace-separated
//                           argv, default `node --test`),
//                           FLOWCREDIT_CODEX_PROTECTED_PATHS (comma-separated)
//                           and FLOWCREDIT_CODEX_EVIDENCE_DIR.
//
// Routes: GET /health, GET /status, GET /companies, GET /companies/:id,
//         GET /companies/:id/works, GET /companies/:id/positions,
//         GET /companies/:id/employees, GET /companies/:id/attention,
//         GET /employees/:id, GET /works/:id, GET /works/:id/tasks,
//         GET /works/:id/traces, GET /tasks/:id, GET /runs/:id,
//         GET /reviews/:id, GET /artifacts/:id, GET /review-requests/:id,
//         GET /repair-bindings/:id,
//         GET /experience/companies/:id/workspace, /experience/companies/:id/workforce,
//         GET /experience/employees/:id, GET /experience/works/:id/lineage
//           (Workforce Experience v0A: derived, bounded, GET-only product
//            projections — see docs/contracts/workforce-experience-v0.md),
//         POST /commands { command, input }.
import { createServer } from "node:http";
import { join } from "node:path";
import { isKernelError } from "../../packages/runtime/errors.mjs";
import { createContinuationDriver, openKernel } from "../../packages/runtime/index.mjs";
import {
  createCodexExecAdapter,
  createStaticWorkerBackendResolver,
  createWorkerHost,
  discoverCodexVersion,
} from "../../packages/harness/index.mjs";
import { createTestWorkerAdapter } from "../../packages/harness/adapters/test-worker.mjs";
import {
  projectEmployeeDetail,
  projectFounderWorkspace,
  projectWorkLineage,
  projectWorkforceLobby,
} from "../../packages/experience/index.mjs";
import { createEmployeeRoutes, isLocalBrowserRequest } from "../employee/server.mjs";

const DIR = process.env.FLOWCREDIT_RUNTIME_DIR ?? join(process.cwd(), ".runtime", "kernel");
const PORT = Number(process.env.FLOWCREDIT_PORT ?? 0);
const BODY_LIMIT = 1024 * 1024;

const COORDINATION_MODES = Object.freeze(["driver", "off"]);
const COORDINATION = process.env.FLOWCREDIT_COORDINATION ?? "off";
if (!COORDINATION_MODES.includes(COORDINATION)) {
  process.stderr.write(
    `FLOWCREDIT_COORDINATION must be one of ${COORDINATION_MODES.join(" | ")} (got ${COORDINATION})\n`,
  );
  process.exit(1);
}

// The execution switch: `off` means this process coordinates but executes
// nothing. `test-worker` runs the deterministic Worker Harness backend — it is
// NOT a model and NOT intelligence. `codex-exec` runs the production
// CodexExecAdapter: one real local `codex exec` child per attempt, configured
// entirely through FLOWCREDIT_CODEX_* (see docs/contracts/codex-exec-adapter-v1.md).
const WORKER_BACKENDS = Object.freeze(["off", "test-worker", "codex-exec"]);
const WORKER_BACKEND = process.env.FLOWCREDIT_WORKER_BACKEND ?? "off";
if (!WORKER_BACKENDS.includes(WORKER_BACKEND)) {
  process.stderr.write(
    `FLOWCREDIT_WORKER_BACKEND must be one of ${WORKER_BACKENDS.join(" | ")} (got ${WORKER_BACKEND})\n`,
  );
  process.exit(1);
}

const COMMANDS = Object.freeze({
  createCompany: (kernel, input) => kernel.createCompany(input),
  createWork: (kernel, input) => kernel.createWork(input),
  createTask: (kernel, input) => kernel.createTask(input),
  startTask: (kernel, input) => kernel.startTask(input),
  checkpointTask: (kernel, input) => kernel.checkpointTask(input),
  recordArtifact: (kernel, input) => kernel.recordArtifact(input),
  completeTask: (kernel, input) => kernel.completeTask(input),
  cancelTask: (kernel, input) => kernel.cancelTask(input),
  createPosition: (kernel, input) => kernel.createPosition(input),
  createEmployee: (kernel, input) => kernel.createEmployee(input),
  setEmployeeEnabled: (kernel, input) => kernel.setEmployeeEnabled(input),
  setTaskRequirements: (kernel, input) => kernel.setTaskRequirements(input),
  assignTask: (kernel, input) => kernel.assignTask(input),
  startWorkerRun: (kernel, input) => kernel.startWorkerRun(input),
  completeWorkerRun: (kernel, input) => kernel.completeWorkerRun(input),
  submitWorkerResult: (kernel, input) => kernel.submitWorkerResult(input),
  interruptWorkerRun: (kernel, input) => kernel.interruptWorkerRun(input),
  requestReview: (kernel, input) => kernel.requestReview(input),
  submitReview: (kernel, input) => kernel.submitReview(input),
  createRepairTask: (kernel, input) => kernel.createRepairTask(input),
  acceptWork: (kernel, input) => kernel.acceptWork(input),
  materializeNextAction: (kernel, input) => kernel.materializeNextAction(input),
  driveWork: (kernel, input) => driver.driveWork(input.workId, { triggerType: "EXPLICIT" }),
  bootstrapWorkforce: (kernel, input) => kernel.bootstrapWorkforce(input),
  recover: (kernel) => kernel.recover(),
});

const kernel = openKernel({ dir: DIR });
const employeeRoutes = createEmployeeRoutes(kernel, { enabled: process.env.FLOWCREDIT_EMPLOYEE_UI !== "0" });
// The host's choice, made once, visible in one place: whether this process lets
// the Runtime coordinate itself. v0B4 adds no clock, queue or scheduler — only
// this observer, and the deterministic NextActionProposer behind it.
const driver = createContinuationDriver({ kernel, observe: COORDINATION === "driver" });

// The WorkerHost executes attempts the Runtime started; it never coordinates.
// It is bound into this process with the same honesty as the coordination
// switch: absent an explicit backend, nothing executes.
//
// codex-exec configuration is execution configuration, never Company truth:
// a base repository to provision run worktrees from, the revision to stand on,
// an independent verification command and the paths that must stay untouched.
async function buildCodexExecWorkerHost() {
  const baseRepository = process.env.FLOWCREDIT_CODEX_REPO;
  if (!baseRepository) {
    process.stderr.write("FLOWCREDIT_WORKER_BACKEND=codex-exec requires FLOWCREDIT_CODEX_REPO\n");
    process.exit(1);
  }
  const verificationCommand = (process.env.FLOWCREDIT_CODEX_VERIFICATION ?? "node --test")
    .split(/\s+/)
    .filter((part) => part.length > 0);
  const protectedPaths = (process.env.FLOWCREDIT_CODEX_PROTECTED_PATHS ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  const adapter = createCodexExecAdapter({
    baseRepository,
    verification: { command: verificationCommand },
    protectedPaths,
    evidenceDir: process.env.FLOWCREDIT_CODEX_EVIDENCE_DIR ?? null,
  });
  const backendVersion = (await discoverCodexVersion()) ?? "unknown";
  return createWorkerHost({
    kernel,
    adapter,
    resolver: createStaticWorkerBackendResolver({
      backendType: "codex-exec",
      backendVersion,
      baseRevision: process.env.FLOWCREDIT_CODEX_BASE_REVISION ?? "HEAD",
    }),
    runtimeRoot: DIR,
    // A real model-backed attempt takes longer than the deterministic test
    // backend. The operator can always narrow or widen this explicitly.
    timeoutMs: Number(
      process.env.FLOWCREDIT_WORKER_TIMEOUT_MS ??
        (WORKER_BACKEND === "codex-exec" ? 600_000 : 30_000),
    ),
  });
}

const workerHost =
  WORKER_BACKEND === "test-worker"
    ? createWorkerHost({
        kernel,
        adapter: createTestWorkerAdapter(),
        resolver: createStaticWorkerBackendResolver(),
        runtimeRoot: DIR,
        timeoutMs: Number(process.env.FLOWCREDIT_WORKER_TIMEOUT_MS ?? 30_000),
      })
    : WORKER_BACKEND === "codex-exec"
      ? await buildCodexExecWorkerHost()
      : null;
if (workerHost) workerHost.start();

function send(response, status, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  response.end(body);
}

function sendError(response, error) {
  // Experience projections fail with their own bounded, product-facing errors
  // (a lineage mismatch, for one). They carry an explicit marker so this stays
  // a whitelist and an unexpected exception still never leaks.
  if (error?.experience === true)
    return send(response, error.status ?? 500, {
      error: { code: error.code ?? "INTERNAL", message: error.message },
    });
  if (isKernelError(error))
    return send(response, error.status, {
      error: {
        code: error.code,
        message: error.message,
        ...(error.details ? { details: error.details } : {}),
      },
    });
  process.stderr.write(`kernel error: ${error?.message ?? error}\n`);
  return send(response, 500, {
    error: { code: "INTERNAL", message: "internal runtime error" },
  });
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > BODY_LIMIT) {
        reject(
          Object.assign(new Error("request body too large"), {
            code: "INVALID_REQUEST",
            status: 413,
          }),
        );
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

async function handle(request, response) {
  const url = new URL(request.url, `http://127.0.0.1:${PORT}`);
  const segments = url.pathname.split("/").filter(Boolean);

  if (await employeeRoutes(request, response, url)) return;

  if (request.method === "GET" && url.pathname === "/health")
    return send(response, 200, {
      status: "ok",
      schemaVersion: kernel.status().schemaVersion,
    });

  if (request.method === "GET" && url.pathname === "/status")
    return send(response, 200, kernel.status());

  if (request.method === "GET" && url.pathname === "/companies")
    return send(response, 200, { companies: kernel.companies() });

  if (request.method === "GET" && segments[0] === "companies" && segments[2] === "works")
    return send(response, 200, { works: kernel.works(segments[1]) });

  if (request.method === "GET" && segments[0] === "companies" && segments[2] === "positions")
    return send(response, 200, { positions: kernel.positions(segments[1]) });

  if (request.method === "GET" && segments[0] === "companies" && segments[2] === "employees")
    return send(response, 200, { employees: kernel.employees(segments[1]) });

  if (request.method === "GET" && segments[0] === "companies" && segments[2] === "attention")
    return send(response, 200, {
      attention: kernel.founderAttention({ companyId: segments[1] }),
    });

  if (request.method === "GET" && segments[0] === "companies" && segments.length === 2)
    return send(response, 200, { company: kernel.company(segments[1]) });

  if (request.method === "GET" && segments[0] === "employees" && segments.length === 2)
    return send(response, 200, { employee: kernel.employee(segments[1]) });

  if (request.method === "GET" && segments[0] === "works" && segments.length === 2)
    return send(response, 200, kernel.workProjection(segments[1]));

  if (request.method === "GET" && segments[0] === "works" && segments[2] === "tasks")
    return send(response, 200, { tasks: kernel.tasks(segments[1]) });

  // Observability, read explicitly: a trace never appears inside a projection.
  if (request.method === "GET" && segments[0] === "works" && segments[2] === "traces")
    return send(response, 200, {
      traces: kernel.continuationTraces({
        workId: segments[1],
        limit: Number(url.searchParams.get("limit") ?? 100),
      }),
    });

  // Workforce Experience v0A: the product read model the Founder Workspace and
  // the Employee Lobby render from. GET-only, derived from the same Runtime
  // truth as every route above, and never a second way to change it.
  if (
    request.method === "GET" &&
    segments[0] === "experience" &&
    segments[1] === "companies" &&
    segments[3] === "workspace"
  )
    return send(response, 200, projectFounderWorkspace({ kernel, companyId: segments[2] }));

  if (
    request.method === "GET" &&
    segments[0] === "experience" &&
    segments[1] === "companies" &&
    segments[3] === "workforce"
  )
    return send(response, 200, projectWorkforceLobby({ kernel, companyId: segments[2] }));

  if (
    request.method === "GET" &&
    segments[0] === "experience" &&
    segments[1] === "employees" &&
    segments.length === 3
  )
    return send(response, 200, projectEmployeeDetail({ kernel, employeeId: segments[2] }));

  if (
    request.method === "GET" &&
    segments[0] === "experience" &&
    segments[1] === "works" &&
    segments[3] === "lineage"
  )
    return send(response, 200, projectWorkLineage({ kernel, workId: segments[2] }));

  if (request.method === "GET" && segments[0] === "tasks" && segments.length === 2)
    return send(response, 200, kernel.taskDetail(segments[1]));

  if (request.method === "GET" && segments[0] === "runs" && segments.length === 2)
    return send(response, 200, { workerRun: kernel.workerRun(segments[1]) });

  if (request.method === "GET" && segments[0] === "reviews" && segments.length === 2)
    return send(response, 200, { review: kernel.review(segments[1]) });

  if (request.method === "GET" && segments[0] === "artifacts" && segments.length === 2)
    return send(response, 200, { artifact: kernel.artifact(segments[1]) });

  if (
    request.method === "GET" &&
    segments[0] === "review-requests" &&
    segments.length === 2
  )
    return send(response, 200, { reviewRequest: kernel.reviewRequest(segments[1]) });

  if (
    request.method === "GET" &&
    segments[0] === "repair-bindings" &&
    segments.length === 2
  )
    return send(response, 200, { repairBinding: kernel.repairBinding(segments[1]) });

  if (request.method === "POST" && url.pathname === "/commands") {
    if (!isLocalBrowserRequest(request))
      return send(response, 403, { error: { code: "LOCAL_ORIGIN_REQUIRED", message: "same-origin loopback requests only" } });
    let payload;
    try {
      payload = JSON.parse((await readBody(request)) || "{}");
    } catch {
      return send(response, 400, {
        error: { code: "INVALID_REQUEST", message: "body must be JSON" },
      });
    }
    const handler = COMMANDS[payload?.command];
    if (!handler)
      return send(response, 404, {
        error: {
          code: "COMMAND_NOT_FOUND",
          message: `unknown command: ${payload?.command}`,
        },
      });
    try {
      return send(response, 200, { result: handler(kernel, payload.input ?? {}) });
    } catch (error) {
      return sendError(response, error);
    }
  }

  return send(response, 404, {
    error: { code: "ROUTE_NOT_FOUND", message: `no route for ${request.method} ${url.pathname}` },
  });
}

const server = createServer((request, response) => {
  handle(request, response).catch((error) => sendError(response, error));
});

server.listen(PORT, "127.0.0.1", () => {
  const { port } = server.address();
  // The startup seam: after recovery, every non-terminal Work is driven once,
  // before this process announces that it is ready.
  if (COORDINATION === "driver") driver.driveAll({ triggerType: "STARTUP" });
  if (kernel.recovery.count > 0)
    process.stdout.write(
      `recovered ${kernel.recovery.count} interrupted execution(s): ${kernel.recovery.interrupted
        .map((entry) => entry.taskId)
        .join(", ")}\n`,
    );
  if (workerHost) {
    const { reconciled } = { reconciled: workerHost.reconcile() };
    if (reconciled > 0)
      process.stdout.write(`worker host reconciled ${reconciled} running attempt(s)\n`);
  }
  process.stdout.write(
    `FlowCredit runtime ready on http://127.0.0.1:${port} dir=${DIR} coordination=${COORDINATION} worker=${WORKER_BACKEND}\n`,
  );
});

function shutdown(signal) {
  process.stdout.write(`shutting down on ${signal}\n`);
  server.close(() => {
    // A cancelled attempt writes nothing: whatever the Runtime still holds as
    // RUNNING is recovered on the next start, exactly like a crash.
    const settle = workerHost ? workerHost.stop() : Promise.resolve();
    settle.finally(() => {
      kernel.close();
      process.exit(0);
    });
  });
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
