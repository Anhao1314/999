// Apply the shipped system workforce seed to a company's store.
//
//   FLOWCREDIT_RUNTIME_DIR=<store dir> node scripts/seed-system-workforce.mjs <companyId>
//
// Idempotent: running it twice creates nothing the second time. The seed data
// itself lives in fixtures/seeds/system-workforce.mjs — this script only wires
// it to the generic bootstrap command.
import { openKernel } from "../packages/runtime/index.mjs";
import { SYSTEM_WORKFORCE_SEED } from "../fixtures/seeds/system-workforce.mjs";

const [companyId] = process.argv.slice(2);
const dir = process.env.FLOWCREDIT_RUNTIME_DIR;

if (!companyId || !dir) {
  console.error(
    "usage: FLOWCREDIT_RUNTIME_DIR=<store dir> node scripts/seed-system-workforce.mjs <companyId>",
  );
  process.exit(2);
}

const kernel = openKernel({ dir });
try {
  if (!kernel.company(companyId)) {
    console.error(`company ${companyId} does not exist in ${dir}`);
    process.exit(1);
  }
  const result = kernel.bootstrapWorkforce({
    companyId,
    positions: SYSTEM_WORKFORCE_SEED.positions,
    employees: SYSTEM_WORKFORCE_SEED.employees,
  });
  console.log(
    `seeded: ${result.positions} position(s) created, ${result.employees} employee(s) created, ${result.skipped} already present`,
  );
} finally {
  kernel.close();
}
