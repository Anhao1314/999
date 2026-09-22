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
//
// Routes: GET /health, GET /status, GET /companies, GET /companies/:id,
//         GET /companies/:id/works, GET /companies/:id/positions,
//         GET /companies/:id/employees, GET /companies/:id/attention,
//         GET /employees/:id, GET /works/:id, GET /works/:id/tasks,
//         GET /works/:id/traces, GET /tasks/:id, GET /runs/:id,
//         GET /reviews/:id, GET /artifacts/:id, GET /review-requests/:id,
//         GET /repair-bindings/:id,
//         POST /commands { command, input }.
import { createServer } from "node:http";
import { join } from "node:path";
import { isKernelError } from "../../packages/runtime/errors.mjs";
import { createContinuationDriver, openKernel } from "../../packages/runtime/index.mjs";
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

function send(response, status, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  response.end(body);
}

function sendError(response, error) {
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
  process.stdout.write(
    `FlowCredit runtime ready on http://127.0.0.1:${port} dir=${DIR}\n`,
  );
});

function shutdown(signal) {
  process.stdout.write(`shutting down on ${signal}\n`);
  server.close(() => {
    kernel.close();
    process.exit(0);
  });
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
