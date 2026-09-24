// Tracks only consecutive live projections for one company. Initial loads and
// reconnections establish a baseline instead of pretending that facts are new.
export function createAssistantMotionTracker() {
  let previous = null;
  return {
    observe({ companyId, live, attentionIds = [], deliveryIds = [] }) {
      if (!live) { previous = null; return null; }
      const next = { companyId, attention: new Set(attentionIds), deliveries: new Set(deliveryIds) };
      const event = previous?.companyId === companyId
        ? deliveryIds.some((id) => !previous.deliveries.has(id)) ? 'cheer'
          : attentionIds.some((id) => !previous.attention.has(id)) ? 'excited' : null
        : null;
      previous = next;
      return event;
    },
  };
}
