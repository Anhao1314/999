# FlowCredit pixel employees

These nine character looks and all frames are original FlowCredit artwork generated from `../scripts/generate-sprites.mjs`. No Pixel Agents or Clippy code or art is included.

Each transparent atlas uses 24×36 cells, four frames per direction, and four directions in this order: front, back, right, left. Each action occupies one row. `manifest.json` records row, frame count, speed, and loop behavior. `../sprite-motion.mjs` is the shared browser player and source for the generator. Portraits use the same front idle frame at 3× scale.

The eight numbered looks are stable presentation variants derived from employee ID. `assistant` is a dedicated uniform for any real employee with the `founder.assistant` capability. The homepage never creates a synthetic assistant.

The display-room routes in `../room-path.mjs` are presentation only. Runtime availability and work role choose a pose; sprite animation does not report work progress or issue commands.
