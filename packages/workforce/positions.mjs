// Position — what kind of work capability the company needs.
// Contract: docs/contracts/workforce-identity-assignment-v0.md §2.
import { randomUUID } from "node:crypto";

export const POSITION_ID_PREFIX = "pos_";

export function newPositionId() {
  return `${POSITION_ID_PREFIX}${randomUUID()}`;
}

export function newPosition({ id = newPositionId(), companyId, title, capabilities, createdAt }) {
  return Object.freeze({
    id,
    companyId,
    title,
    capabilities: Object.freeze([...capabilities]),
    createdAt,
  });
}
