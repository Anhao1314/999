// Manual public-read smoke, invoked only with five Founder-supplied URLs.
// It tests real GET -> Host-minted observations -> Runtime Artifact. It uses a
// deterministic TestModelBackend, so it does not claim to perform model research.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createTestModelBackend, WEB_READ,
} from "../packages/harness/index.mjs";
import { openKernel } from "../packages/runtime/index.mjs";
import {
  createProductResearchHost, createProductResearchWork, PRODUCT_RESEARCH_ARTIFACT_KIND,
  PRODUCT_RESEARCH_ARTIFACT_VERSION, PRODUCT_RESEARCH_CAPABILITY,
} from "../packages/product/product-research.mjs";
import { createNovaProductResearchSeed } from "../fixtures/seeds/nova-product-researcher.mjs";

const urls = process.argv.slice(2);
if (urls.length === 1 && urls[0] === "--help") {
  process.stdout.write("Usage: node scripts/smoke-nova-real-read.mjs <public-product-url-1> ... <public-product-url-5>\n");
  process.exit(0);
}
if (urls.length !== 5) {
  process.stderr.write("Five Founder-supplied public product URLs are required.\n");
  process.exit(2);
}

const dir = mkdtempSync(join(tmpdir(), "flowcredit-nova-read-"));
const kernel = openKernel({ dir });
let host;
try {
  const company = kernel.createCompany({ name: "Nova public-read smoke" });
  const seed = createNovaProductResearchSeed(company.id);
  kernel.bootstrapWorkforce({ companyId: company.id, ...seed });
  const work = createProductResearchWork({ kernel, companyId: company.id, publicProductUrls: urls });
  const task = kernel.createTask({ workId: work.id, title: "Read five supplied public product pages", intent: work.intent,
    requiredCapabilities: [PRODUCT_RESEARCH_CAPABILITY] });
  kernel.assignTask({ taskId: task.id, employeeId: seed.employees[0].id, reason: "manual smoke" });
  const modelBackend = createTestModelBackend({ steps: [
    ...urls.map((url, index) => ({ type: "TOOL_REQUEST", callId: `read-${index + 1}`, capability: WEB_READ, input: { url } })),
    ({ messages }) => {
      const reads = messages.filter((message) => message.role === "tool").map((message) => JSON.parse(message.content));
      const candidates = reads.map((read) => ({
        productName: null, brand: null, price: null, rating: null, reviewCount: null,
        sellingPoints: [], observedWeaknesses: [], sourceIds: [read.output.sourceObservation.sourceId],
      }));
      return { type: "FINAL_RESULT", candidate: {
        resultVersion: 1, outcome: "SUCCEEDED", summary: "Five supplied public pages were read; product facts remain unknown in this smoke.",
        blockers: [], suggestedNextActions: [],
        proposedArtifacts: [{ kind: PRODUCT_RESEARCH_ARTIFACT_KIND, title: "Public-read smoke observations",
          content: JSON.stringify({ schemaVersion: PRODUCT_RESEARCH_ARTIFACT_VERSION, category: "automatic pet feeder", market: "US",
            candidates, marketObservations: [], opportunities: [], risks: [] }) }],
      } };
    },
  ] });
  host = createProductResearchHost({ kernel, runtimeRoot: dir, timeoutMs: 60_000,
    modelBackend, approvedCapabilities: [WEB_READ] });
  host.start();
  const started = kernel.startWorkerRun({ taskId: task.id });
  await host.idle();
  const run = kernel.workerRun(started.workerRun.id);
  const report = host.reportFor(run.id)[0];
  const observations = report?.detail?.evidence?.toolSession?.sources ?? [];
  const artifact = kernel.workProjection(work.id).outcome.candidateArtifacts[0] ?? null;
  process.stdout.write(`${JSON.stringify({
    mode: "MANUAL_REAL_READ_TEST_MODEL",
    workerRunState: run.state,
    observedSources: observations.length,
    artifactCreated: Boolean(artifact),
    failureCode: report?.detail?.failureCode ?? null,
  })}\n`);
  if (run.state !== "COMPLETED" || observations.length !== 5 || !artifact) process.exitCode = 1;
} catch (error) {
  process.stderr.write(`${error?.message ?? error}\n`);
  process.exitCode = 1;
} finally {
  await host?.stop();
  kernel.close();
  rmSync(dir, { recursive: true, force: true });
}
