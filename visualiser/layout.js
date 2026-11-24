// Layout maths, with no DOM: the mosaic that tiles one session's area, and the
// strip that shares the stage between sessions.

// The size below which a tile stops being comfortable to read.
const READABLE_W = 320;
const READABLE_H = 110;

// A mosaic is a binary tree of splits with one leaf per tile. Each split
// divides its rectangle in proportion to the weights beneath it, so a tile
// grows and shrinks smoothly as its weight changes, and tiles keep their
// neighbours. Tiles are added and removed while their weight is zero, so the
// tree can change shape without anything jumping.
export class Mosaic {
  constructor() {
    this.root = null;
    this.leaves = new Map(); // key -> leaf node
  }

  has(key) {
    return this.leaves.has(key);
  }

  add(key, weightOf) {
    const leaf = { key, parent: null };
    this.leaves.set(key, leaf);
    if (!this.root) {
      this.root = leaf;
      return;
    }
    // Split the shallowest leaf, preferring the heaviest one at that depth, so
    // the tree stays balanced and new tiles open next to the largest tile.
    let best = null;
    let bestDepth = Infinity;
    let bestWeight = -1;
    const visit = (node, depth) => {
      if (node.key !== undefined) {
        const weight = weightOf(node.key);
        if (depth < bestDepth || (depth === bestDepth && weight > bestWeight)) {
          best = node;
          bestDepth = depth;
          bestWeight = weight;
        }
        return;
      }
      visit(node.a, depth + 1);
      visit(node.b, depth + 1);
    };
    visit(this.root, 0);
    const split = { a: best, b: leaf, parent: best.parent, sideBySide: null };
    if (best.parent) {
      if (best.parent.a === best) best.parent.a = split;
      else best.parent.b = split;
    } else this.root = split;
    best.parent = split;
    leaf.parent = split;
  }

  remove(key) {
    const leaf = this.leaves.get(key);
    if (!leaf) return;
    this.leaves.delete(key);
    const parent = leaf.parent;
    if (!parent) {
      this.root = null;
      return;
    }
    const sibling = parent.a === leaf ? parent.b : parent.a;
    sibling.parent = parent.parent;
    if (parent.parent) {
      if (parent.parent.a === parent) parent.parent.a = sibling;
      else parent.parent.b = sibling;
    } else this.root = sibling;
  }

  // Fills `out` (key -> {x, y, w, h}) for the given rectangle.
  layout(rect, weightOf, out) {
    if (!this.root) return;
    const total = (node) => {
      if (node.key !== undefined) return (node.weight = Math.max(0, weightOf(node.key)));
      return (node.weight = total(node.a) + total(node.b));
    };
    total(this.root);
    const place = (node, x, y, w, h) => {
      if (node.key !== undefined) {
        out.set(node.key, { x, y, w, h });
        return;
      }
      const share = node.weight > 0 ? node.a.weight / node.weight : 0.5;
      // Pick the split that leaves both halves readable: text wants width far
      // more than height, so a thin sliver of a column scores badly while a
      // short wide strip does not. When both ways are fine, wide areas split
      // side by side and tall ones stack. The current choice is kept unless
      // the other is clearly better, so a split does not flicker.
      const ratio = w / Math.max(1, h);
      // A split is as good as its worse half; a half with almost no share is
      // on its way in or out and does not get a say.
      const fit = (part, cw, ch) => (part < 0.03 ? 1 : Math.min(1, cw / READABLE_W) * Math.min(1, ch / READABLE_H));
      const sideScore = Math.min(fit(share, w * share, h), fit(1 - share, w * (1 - share), h));
      const stackScore = Math.min(fit(share, w, h * share), fit(1 - share, w, h * (1 - share)));
      const margin = Math.abs(sideScore - stackScore);
      const byShape = ratio > 1.9 ? true : ratio < 1.15 ? false : null;
      if (node.sideBySide === null) node.sideBySide = margin > 0.05 ? sideScore > stackScore : (byShape ?? ratio > 1.5);
      else if (margin > 0.15) node.sideBySide = sideScore > stackScore;
      else if (margin <= 0.05 && byShape !== null) node.sideBySide = byShape;
      if (node.sideBySide) {
        place(node.a, x, y, w * share, h);
        place(node.b, x + w * share, y, w * (1 - share), h);
      } else {
        place(node.a, x, y, w, h * share);
        place(node.b, x, y + h * share, w, h * (1 - share));
      }
    };
    place(this.root, rect.x, rect.y, rect.w, rect.h);
  }
}

// Shares the stage between sessions. Each has an `open` amount from 0
// (collapsed to a strip) to 1 (fully open). Sessions sit side by side on a wide
// stage and stack on a tall one.
export function layoutSessions(stage, sessions, stripSize) {
  const row = stage.w >= stage.h;
  const length = row ? stage.w : stage.h;
  const openTotal = sessions.reduce((sum, s) => sum + s.open, 0);
  const spare = Math.max(0, length - sessions.length * stripSize);
  let at = 0;
  const rects = [];
  for (const s of sessions) {
    const size = stripSize + (openTotal > 0 ? (spare * s.open) / openTotal : spare / sessions.length);
    rects.push(row ? { x: stage.x + at, y: stage.y, w: size, h: stage.h } : { x: stage.x, y: stage.y + at, w: stage.w, h: size });
    at += size;
  }
  return { row, rects };
}

// Places commits in lanes for a simple graph. Returns one row per commit:
// { commit, col } plus `edges`, each { fromRow, fromCol, toRow, toCol, lane }
// where toRow is null when the parent is beyond the end of the list.
export function layoutGraph(commits) {
  const lanes = []; // the sha each lane is waiting for next
  const rows = [];
  const rowOf = new Map();
  const freeLane = () => {
    const i = lanes.indexOf(null);
    return i === -1 ? lanes.length : i;
  };
  commits.forEach((commit, index) => {
    let col = lanes.indexOf(commit.sha);
    if (col === -1) col = freeLane();
    // other lanes that were also waiting for this commit end here
    lanes.forEach((sha, i) => {
      if (sha === commit.sha && i !== col) lanes[i] = null;
    });
    const parentLanes = [];
    lanes[col] = commit.parents[0] ?? null;
    if (commit.parents.length) parentLanes.push(col);
    for (const parent of commit.parents.slice(1)) {
      let lane = lanes.indexOf(parent);
      if (lane === -1) {
        lane = freeLane();
        lanes[lane] = parent;
      }
      parentLanes.push(lane);
    }
    while (lanes.length && lanes[lanes.length - 1] === null) lanes.pop();
    rows.push({ commit, col, parentLanes });
    rowOf.set(commit.sha, index);
  });
  const edges = [];
  let width = 1;
  rows.forEach((row, index) => {
    width = Math.max(width, row.col + 1);
    row.commit.parents.forEach((parent, i) => {
      const toRow = rowOf.has(parent) ? rowOf.get(parent) : null;
      const lane = row.parentLanes[i];
      width = Math.max(width, lane + 1);
      edges.push({ fromRow: index, fromCol: row.col, toRow, toCol: toRow === null ? lane : rows[toRow].col, lane });
    });
  });
  return { rows, edges, width };
}
