// Product workforce data. Applying this seed creates ordinary Position and
// Employee records; it does not create a model, a WorkerRun, or permission.
import { createHash } from "node:crypto";

export function createNovaProductResearchSeed(companyId) {
  if (typeof companyId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_:.-]{0,127}$/.test(companyId))
    throw new Error("Nova seed requires a stable Company ID");
  const scope = createHash("sha256").update(companyId, "utf8").digest("hex").slice(0, 24);
  const positionId = `pos_product_researcher_${scope}`;
  return Object.freeze({
    positions: Object.freeze([
      Object.freeze({
        id: positionId,
        title: "Product Researcher",
        capabilities: Object.freeze(["commerce.product.research"]),
      }),
    ]),
    employees: Object.freeze([
      Object.freeze({
        id: `emp_nova_product_researcher_${scope}`,
        positionId,
        displayName: "Nova",
      }),
    ]),
  });
}
