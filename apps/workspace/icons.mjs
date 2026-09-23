// A small, original symbol set for the Founder Workspace. Symbols carry
// meaning through silhouette first; color and motion only reinforce state.
const shape = (tag, attrs) => ({ tag, attrs });
const path = (d, extra = {}) => shape('path', { d, ...extra });
const circle = (cx, cy, r, extra = {}) => shape('circle', { cx, cy, r, ...extra });
const rect = (x, y, width, height, rx, extra = {}) => shape('rect', { x, y, width, height, rx, ...extra });

export const ICON_SHAPES = Object.freeze({
  workspace: [
    path('M12 8.5v3.3M6.2 14.2v-2.4h11.6v2.4'),
    rect(9, 3, 6, 5.5, 1.8), rect(3.2, 14.2, 6, 5.5, 1.8), rect(14.8, 14.2, 6, 5.5, 1.8),
    circle(12, 5.75, 1.1, { 'data-fill': 'true' }),
  ],
  work: [
    rect(3.5, 4.2, 17, 16.2, 3.2),
    path('m7.4 10.2 1.4 1.4 2.2-2.4M13.3 10.4h3.5M7.3 15.7h9.5'),
    rect(5.8, 3, 5.2, 2.8, 1.2, { 'data-fill': 'true' }),
  ],
  employees: [
    circle(9, 8, 3), path('M3.6 19.4v-1.2a5.4 5.4 0 0 1 10.8 0v1.2H3.6z'),
    path('M16.3 5.6a2.6 2.6 0 0 1 0 5.1M16.8 14.2a4.6 4.6 0 0 1 3.6 4.5v.7h-3.3'),
    circle(9, 8, .9, { 'data-fill': 'true' }),
  ],
  hiring: [
    circle(8.5, 8, 3), path('M3.2 19v-1.1a5.3 5.3 0 0 1 10.6 0V19H3.2z'),
    circle(17.5, 16.5, 4.2, { 'data-fill': 'true' }),
    path('M17.5 14.5v4M15.5 16.5h4', { 'data-inverse': 'true' }),
  ],
  artifacts: [
    path('M7 4h8l3 3v12a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zM15 4v3h3M8.5 11h6.5M8.5 14.5h4.3'),
    path('m16.3 16.8 1 1.1 2-2.4', { 'data-emphasis': 'true' }),
  ],
  knowledge: [
    path('M12 6.2C9.8 4.8 6.5 4.5 3.3 5v13c3.5-.5 6.7.2 8.7 1.7 2-1.5 5.2-2.2 8.7-1.7V5c-3.2-.5-6.5-.2-8.7 1.2zM12 6.2v13.5'),
    path('M6.4 9.2h2.9M6.4 12.4h2.9M14.8 9.2h2.9M14.8 12.4h2.9'),
  ],
  settings: [
    path('M4 6h16M4 12h16M4 18h16'),
    circle(8, 6, 2.15, { 'data-fill': 'true' }),
    circle(16, 12, 2.15, { 'data-fill': 'true' }),
    circle(10, 18, 2.15, { 'data-fill': 'true' }),
  ],
  attention: [
    path('M6 17h12l-1.5-2.1V10a4.5 4.5 0 0 0-9 0v4.9L6 17zM10 20h4'),
    circle(17.8, 5.2, 2.2, { 'data-fill': 'true' }),
  ],
  search: [circle(10.6, 10.6, 6.1), path('m15.2 15.2 5 5')],
  plus: [path('M12 5v14M5 12h14')],
  minus: [path('M5 12h14')],
  close: [path('M6 6l12 12M18 6 6 18')],
  arrowUpRight: [path('M6 18 18 6M8 6h10v10')],
  chevronDown: [path('m5 9 7 7 7-7')],
  fit: [path('M9 4H5a1 1 0 0 0-1 1v4M15 4h4a1 1 0 0 1 1 1v4M4 15v4a1 1 0 0 0 1 1h4M20 15v4a1 1 0 0 1-1 1h-4')],
  reset: [path('M4.8 10.2a7.5 7.5 0 1 1 .4 4.8M4.8 5.8v4.4h4.4')],
});

export function symbol(name, className = 'fc-icon') {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', className);
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  for (const part of ICON_SHAPES[name] ?? ICON_SHAPES.workspace) {
    const element = document.createElementNS('http://www.w3.org/2000/svg', part.tag);
    for (const [key, value] of Object.entries(part.attrs)) element.setAttribute(key, String(value));
    svg.append(element);
  }
  return svg;
}
