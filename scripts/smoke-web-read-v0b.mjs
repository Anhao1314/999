// Manual, local-only smoke. Never imported by CI or the normal test suite.
import { createWebResearchActuator, WEB_READ } from "../packages/harness/adapters/web-research-actuator.mjs";
import { createAuthorizedToolSession, createToolBudget, createToolGrant } from "../packages/harness/tool-session.mjs";

if (process.env.CI) throw new Error("real web smoke is disabled in CI");
const url = process.env.FLOWCREDIT_WEB_READ_SMOKE_URL;
if (!url) throw new Error("set FLOWCREDIT_WEB_READ_SMOKE_URL for a manual public read smoke");

// A synthetic, local execution context proves the real reader and Host-side
// source minting together. It creates no Runtime row or production grant.
const run = {
  id: "manual_web_read_smoke", generation: 1,
  workPacket: {
    requirements: { requiredCapabilities: ["manual.web.read"] },
    position: { capabilities: ["manual.web.read"] },
  },
};
const skill = {
  skillId: "ManualWebReadSmoke", version: "0.1.0",
  requiredCapabilities: ["manual.web.read"], allowedToolCapabilities: [WEB_READ],
};
const actuator = createWebResearchActuator();
const grant = createToolGrant({ run, skill, approvedCapabilities: [WEB_READ], actuators: [actuator] });
const session = createAuthorizedToolSession({
  run, grant, budget: createToolBudget({ maxToolCalls: 1, maxElapsedMs: 8_000, toolTimeoutMs: 8_000 }),
  actuators: [actuator],
});
const result = await session.invoke({ callId: "manual-read", capability: WEB_READ, input: { url } });
const observation = result.output.sourceObservation;
const evidence = session.snapshot();
if (evidence.sources.length !== 1 || evidence.sources[0].sourceId !== observation.sourceId ||
    evidence.receipts[0].sourceId !== observation.sourceId)
  throw new Error("manual read did not bind one Host-minted source to its receipt");
console.log(JSON.stringify({
  status: "PASS",
  sourceId: observation.sourceId,
  sourceOrigin: new URL(observation.canonicalUrl).origin,
  title: observation.title,
  observedAt: observation.observedAt,
  contentDigest: observation.contentDigest,
  extractedBytes: Buffer.byteLength(observation.content),
  observedSources: evidence.sources.length,
  searchSmoke: "unavailable: no real SearchProvider is configured",
}));
