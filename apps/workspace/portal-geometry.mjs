// Screen-locked media is clipped to a projected rounded rectangle.
export const easeInOutCubic = t => t < .5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2;
export function portalOutline(rect, viewport, { expansion = 0, scale = 1, rx = 0, ry = 0 } = {}) {
  const e = Math.max(0, Math.min(1, expansion));
  const cx = (rect.left + rect.width / 2) * (1 - e) + viewport.width / 2 * e;
  const cy = (rect.top + rect.height / 2) * (1 - e) + viewport.height / 2 * e;
  const w = (rect.width * (1 - e) + viewport.width * e) * (e ? 1 : scale);
  const h = (rect.height * (1 - e) + viewport.height * e) * (e ? 1 : scale);
  const r = Math.min(90 * (1 - e) * scale, w / 2, h / 2);
  const ax = rx * (1 - e) * Math.PI / 180, ay = ry * (1 - e) * Math.PI / 180;
  const corners = [[w/2-r,-h/2+r,-Math.PI/2], [w/2-r,h/2-r,0], [-w/2+r,h/2-r,Math.PI/2], [-w/2+r,-h/2+r,Math.PI]];
  return corners.flatMap(([x,y,a]) => Array.from({length:11}, (_,i) => {
    const angle = a + i * Math.PI / 20;
    const px = x + r * Math.cos(angle), py = y + r * Math.sin(angle);
    const p = 850 / (850 + px * Math.sin(ay) - py * Math.sin(ax));
    return [cx + px * Math.cos(ay) * p, cy + py * Math.cos(ax) * p];
  }));
}
export function coverRect(mw, mh, width, height) {
  if (!(mw > 0 && mh > 0 && width > 0 && height > 0)) return null;
  const s = Math.max(width / mw, height / mh);
  return [(width - mw * s) / 2, (height - mh * s) / 2, mw * s, mh * s];
}
