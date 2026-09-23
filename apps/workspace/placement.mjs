// Viewport-only placement for the Workspace's contextual surfaces.
const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

export function placeAnchoredSurface(anchor, viewport, desired, { gap = 12, margin = 12 } = {}) {
  const width = Math.min(desired.width, viewport.width - margin * 2);
  const height = Math.min(desired.height, viewport.height - margin * 2);
  const centerX = anchor.left + anchor.width / 2;
  const centerY = anchor.top + anchor.height / 2;
  let side;
  let left;
  let top;

  if (viewport.width <= 620) {
    left = clamp(centerX - width / 2, margin, viewport.width - width - margin);
    const below = anchor.bottom + gap;
    const above = anchor.top - gap - height;
    if (below + height <= viewport.height - margin) {
      side = 'below';
      top = below;
    } else if (above >= margin) {
      side = 'above';
      top = above;
    } else {
      side = 'center';
      top = clamp(centerY - height / 2, margin, viewport.height - height - margin);
    }
  } else if (anchor.right + gap + width <= viewport.width - margin) {
    side = 'right';
    left = anchor.right + gap;
    top = clamp(centerY - height / 2, margin, viewport.height - height - margin);
  } else if (anchor.left - gap - width >= margin) {
    side = 'left';
    left = anchor.left - gap - width;
    top = clamp(centerY - height / 2, margin, viewport.height - height - margin);
  } else {
    const belowSpace = viewport.height - margin - anchor.bottom;
    const aboveSpace = anchor.top - margin;
    side = belowSpace >= aboveSpace ? 'below' : 'above';
    left = clamp(centerX - width / 2, margin, viewport.width - width - margin);
    top = side === 'below'
      ? clamp(anchor.bottom + gap, margin, viewport.height - height - margin)
      : clamp(anchor.top - gap - height, margin, viewport.height - height - margin);
  }
  return { left, top, width, height, side };
}
