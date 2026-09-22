import { createServer } from "node:http";

// Minimal stand-in for the FlowCredit Runtime transport: it prints the ready
// line the real server prints and answers /health. Set
// RELAY_CODE_FIXTURE_HEALTH=degraded to simulate a bound-but-unhealthy Runtime.
const degraded = process.env.RELAY_CODE_FIXTURE_HEALTH === "degraded";

const server = createServer((request, response) => {
  if (request.url === "/health") {
    response.writeHead(degraded ? 503 : 200, { "content-type": "application/json" });
    response.end(JSON.stringify({ status: degraded ? "degraded" : "ok" }));
    return;
  }
  response.writeHead(404);
  response.end();
});

server.listen(0, "127.0.0.1", () => {
  const { port } = server.address();
  process.stdout.write(`FlowCredit runtime ready on http://127.0.0.1:${port}\n`);
});

function shutdown() {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 2000).unref();
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
