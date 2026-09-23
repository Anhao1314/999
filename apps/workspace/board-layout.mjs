// Presentation-only placement for the three cards on the Company Canvas.
export function clampCardPosition(position, bounds, size, margin = 14) {
  const maxX = Math.max(margin, bounds.width - size.width - margin);
  const maxY = Math.max(margin, bounds.height - size.height - margin);
  return {
    x: Math.min(maxX, Math.max(margin, Number.isFinite(position.x) ? position.x : margin)),
    y: Math.min(maxY, Math.max(margin, Number.isFinite(position.y) ? position.y : margin)),
  };
}

export function initialCardPosition(index, bounds, size, previousHeight = 0) {
  return clampCardPosition(
    { x: bounds.width - size.width - 14, y: 18 + previousHeight + index * 14 },
    bounds,
    size,
  );
}
