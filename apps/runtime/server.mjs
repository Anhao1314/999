// Minimal runtime process for the Persistent Work Kernel (v0A).
//
// Purpose: prove the kernel can be hosted as a long-lived process, and give the
// restart tests and the demonstration a real process to kill. It is a kernel
// transport, not a product API: no Founder endpoints, no workforce endpoints.
//
//   FLOWCREDIT_RUNTIME_DIR  store directory (default: ./.runtime/kernel)
//   FLOWCREDIT_PORT         port on 127.0.0.1 (default: 0 = ephemeral)
//
// Routes: GET /health, GET /status, GET /companies, GET /companies/:id,
//         GET /companies/:id/works, GET /works/:id, GET /tasks/:id,
//         POST /commands { command, input }.
import { createServer } from "node:http";
import { join } from "node:path";
import { isKernelError } from "../../packages/runtime/errors.mjs";
import { openKernel } from "../../packages/runtime/index.mjs";

const DIR = process.env.FLOWCREDIT_RUNTIME_DIR ?? join(process.cwd(), ".runtime", "kernel");
const PORT = Number(process.env.FLOWCREDIT_PORT ?? 0);
const BODY_LIMIT = 1024 * 1024;

const COMMANDS = Object.freeze({
  createCompany: (kernel, input) => kernel.createCompany(input),
  createWork: (kernel, input) => kernel.createWork(input),
  createTask: (kernel, input) => kernel.createTask(input),
  startTask: (kernel, input) => kernel.startTask(input),
  checkpointTask: (kernel, input) => kernel.checkpointTask(input),
  recordArtifact: (kernel, input) => kernel.recordArtifact(input),
  completeTask: (kernel, input) => kernel.completeTask(input),
  cancelTask: (kernel, input) => kernel.cancelTask(input),
  recover: (kernel) => kernel.recover(),
});

const kernel = openKernel({ dir: DIR });

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
      error: { code: error.code, message: error.message },
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

  if (request.method === "GET" && segments[0] === "companies" && segments.length === 2)
    return send(response, 200, { company: kernel.company(segments[1]) });

  if (request.method === "GET" && segments[0] === "works" && segments.length === 2)
    return send(response, 200, kernel.workProjection(segments[1]));

  if (request.method === "GET" && segments[0] === "tasks" && segments.length === 2)
    return send(response, 200, kernel.taskDetail(segments[1]));

  if (request.method === "POST" && url.pathname === "/commands") {
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
  if (kernel.recovery.count > 0)
    process.stdout.write(
      `recovered ${kernel.recovery.count} interrupted execution(s): ${kernel.recovery.interrupted
        .map((entry) => entry.taskId)
        .join(", ")}\n`,
    );
  process.stdout.write(
    `FlowCredit runtime v0A ready on http://127.0.0.1:${port} dir=${DIR}\n`,
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
