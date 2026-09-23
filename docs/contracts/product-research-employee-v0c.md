# Product Research Employee v0C — freeze candidate

## Product path

Nova is an ordinary Employee in the Product Researcher Position. The seed from
`createNovaProductResearchSeed(companyId)` is applied with the existing
`bootstrapWorkforce` command. It gives the Position
`commerce.product.research`; it does not create a model, a WorkerRun, or tool
permission. Its IDs are stable for each Company, so repeated application is
idempotent and separate Companies receive distinct Nova records.

`createProductResearchWork` creates an ordinary persistent Work. Its intent is
bounded JSON with `requestKind: ProductSelectionResearch.v0`, category, market,
candidate count and optional Founder-supplied public product URLs. v0C supports
the US market and at most five candidates. The first acceptance Work is five
automatic pet feeder candidates for the US market. The existing Continuation
Driver, configured with research and independent review capabilities,
materializes and assigns its Task. Runtime owns all assignments, WorkerRuns,
Review, Repair and Artifact records.

## Skill and authorization

`ProductSelectionResearch@v0` is a static method supplied to the existing
GenericModelWorkerAdapter. Search results are discovery candidates. Only a
successful authorized web read causes the Host to mint a SourceObservation and
`sourceId`. The Skill cannot grant search or read access. `createProductResearchHost`
requires an explicit `approvedCapabilities` list; the Host intersects it with
the Skill, Task requirements, Position and available WebResearchActuator. A
separate Reviewer adapter may be supplied for `REVIEW_JUDGMENT`.

The product Host resolves only Work whose persisted intent names this request
kind. It installs `validateProductResearchArtifact` as a trusted Host delivery
postcondition. The Host invokes the validator after the generic WorkerResult
parser and before `submitWorkerResult`. Rejection interrupts the attempt as
`WORKER_OUTPUT_REJECTED`; it creates no Artifact. The validator receives the
run-scoped source registry from the Host-owned AuthorizedToolSession, never a
model-supplied registry.

## Artifact schema

The single proposed Artifact has kind `product-research` and JSON content:

```json
{
  "schemaVersion": "ProductResearchArtifact.v0",
  "category": "automatic pet feeder",
  "market": "US",
  "candidates": [
    {
      "productName": "Example feeder",
      "brand": null,
      "price": { "amount": 49.99, "currency": "USD" },
      "rating": null,
      "reviewCount": null,
      "sellingPoints": [],
      "observedWeaknesses": [],
      "sourceIds": ["src_<Host-minted UUID>"]
    }
  ],
  "marketObservations": [],
  "opportunities": [],
  "risks": []
}
```

The candidate array length must equal the Work request's candidate count.
Every required field must be present; unavailable scalar facts are `null`,
and unavailable lists are empty. Every candidate has at least one distinct
source ID. Each market observation, opportunity or risk is a bounded
`{text, sourceIds}` entry; unsupported insights remain an empty list. Every
cited ID must be in that WorkerRun's successful read observations. A search
result, URL, failed read, or source from another WorkerRun or generation cannot
satisfy this postcondition. The validator checks schema and source
lineage, not the semantic truth of model-written claims; independent Review
remains necessary. Reviewer PASS still does not mean Founder ACCEPT or
Knowledge Admission.

The category is at most 120 characters; v0C market is `US`. Candidate count is
1–5 and must match the Work request. Product name is at most 200 characters,
brand 120, each selling point or observed weakness 500, and each such list has
at most 10 entries. Price is `null` or a USD amount between 0 and 1,000,000;
rating is `null` or 0–5; review count is `null` or a safe integer from 0 to
1,000,000,000. Unknown does not mean zero. The three insight lists each have
at most 10 entries; each entry has text of at most 500 characters. Every
candidate and insight entry cites 1–10 distinct SourceObservation IDs. The
whole JSON content remains within the existing 100 KiB Artifact bound.

## Manual read smoke

When no SearchProvider is configured, a Founder may supply five public product
URLs to `node scripts/smoke-nova-real-read.mjs <url1> ... <url5>`. This uses real
bounded HTTP GET reads, the existing Host tool authorization, and a
TestModelBackend. It deliberately leaves all product facts unknown and proves
only the real read, SourceObservation and Artifact path. It is never run by
the deterministic test suite and does not claim real model research.

Before Founder-supplied URLs and a manual run, real web read is unproven. No
production ModelBackend or SearchProvider is configured in v0C. The default
regression is deterministic and performs no external network access.
