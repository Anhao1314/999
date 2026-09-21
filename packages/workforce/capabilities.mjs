// Capability identifiers and capability matching (pure).
// Contract: docs/contracts/workforce-identity-assignment-v0.md §4, §5.
//
// A capability is an opaque, stable string. The core does not know a registry,
// a score, a role or a provider — only whether one set of capabilities covers
// another. Nothing in this file names a real capability or a real employee.

export const CAPABILITY_PATTERN = /^[a-z][a-z0-9]*(\.[a-z][a-z0-9_]*)*$/;
export const CAPABILITY_MAX_LENGTH = 64;

export function isCapability(value) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= CAPABILITY_MAX_LENGTH &&
    CAPABILITY_PATTERN.test(value)
  );
}

// Deterministic order: anything derived from capabilities (requirements,
// packet digest) must not depend on how a caller happened to order the list.
export function normalizeCapabilities(capabilities) {
  return Object.freeze([...new Set(capabilities)].sort());
}

export function missingCapabilities(required, available) {
  const have = new Set(available);
  return required.filter((capability) => !have.has(capability));
}

export function satisfiesCapabilities(required, available) {
  return missingCapabilities(required, available).length === 0;
}
