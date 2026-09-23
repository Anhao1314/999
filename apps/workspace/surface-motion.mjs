// Visual transitions only. An interrupted close cannot hide a reopened surface.
export const SURFACE_TIMING = Object.freeze({ open: 210, close: 160, reduced: 90 });

export function surfaceOrigin(source, target) {
  if (!source || !target.width || !target.height) return { opacity: 0, transform: 'scale(.96)' };
  // Uniform scale preserves text and icon proportions. The small translation
  // points back to the source without sweeping a large page across the canvas.
  const dx = (source.left + source.width / 2 - target.left - target.width / 2) * .12;
  const dy = (source.top + source.height / 2 - target.top - target.height / 2) * .12;
  return { opacity: 0, transform: `translate(${dx}px, ${dy}px) scale(.94)` };
}

export function createSurfaceMotion(element, { reduced = () => false, read = () => getComputedStyle(element) } = {}) {
  let animation = null;
  let revision = 0;
  let opening = false;
  function cancel() {
    revision += 1;
    animation?.cancel();
    animation = null;
  }
  async function run(open, source, target) {
    const interrupted = Boolean(animation);
    const current = interrupted ? read() : null;
    const from = current ? { opacity: current.opacity, transform: current.transform } : null;
    cancel();
    const ticket = revision;
    opening = open;
    const quiet = reduced();
    const origin = quiet ? { opacity: 0 } : surfaceOrigin(source, target);
    const shown = quiet ? { opacity: 1 } : { opacity: 1, transform: 'none' };
    const first = from ? quiet ? { opacity: from.opacity } : from : open ? origin : shown;
    animation = element.animate([first, open ? shown : origin], {
      duration: quiet ? SURFACE_TIMING.reduced : open ? SURFACE_TIMING.open : SURFACE_TIMING.close,
      easing: open ? 'cubic-bezier(.2,.82,.22,1)' : 'cubic-bezier(.4,0,1,1)',
      fill: 'both',
    });
    try { await animation.finished; } catch { return false; }
    if (ticket !== revision) return false;
    animation.cancel();
    animation = null;
    return true;
  }
  return { run, cancel, get opening() { return opening; } };
}
