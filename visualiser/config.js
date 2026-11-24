// Tunable numbers for the visualiser. Times are in milliseconds.

// One envelope per kind of activity. While something is happening the tile is
// "gated" and rises to full level over `attack`; when it stops, the level falls
// back to `floor` over `release`. `weight` is the share of the mosaic the tile
// asks for at full level.
export const ENV = {
  reply: { attack: 250, release: 150000, floor: 0.3, weight: 3.2 },
  subreply: { attack: 250, release: 25000, weight: 1.5 },
  thinking: { attack: 250, release: 15000, weight: 1.5 },
  prompt: { attack: 250, release: 25000, weight: 0.9 },
  write: { attack: 200, release: 35000, weight: 2.0 },
  read: { attack: 200, release: 14000, weight: 1.3 },
  shell: { attack: 200, release: 22000, weight: 1.6 },
  search: { attack: 200, release: 12000, weight: 1.0 },
  agent: { attack: 200, release: 12000, weight: 0.9 },
  tool: { attack: 200, release: 8000, weight: 0.7 },
};

// Fraction of the release spent holding at full level before the fall begins.
export const RELEASE_HOLD = 0.12;

// A tile's size moves in steps so text is not constantly re-wrapping:
// [level threshold, share of its full weight].
export const SIZE_STEPS = [
  [0.55, 1],
  [0.2, 0.5],
  [0.02, 0.2],
];

// Content taller than its tile scrolls from top to bottom while the tile
// releases. 1 spreads the pass over the whole release; a smaller share finishes
// it sooner, while the tile is still large.
export const SCROLL_PASS_SHARE = 1;

export const LIMITS = {
  maxTilesPerSession: 10, // older quiet tiles are hurried out beyond this
  minGateMs: 500, // even an instant event keeps its tile lit this long
  weightEaseMs: 220, // how quickly tiles grow and shrink
  openEaseMs: 260, // how quickly sessions open and close
  activeWindowMs: 2500, // a session that did something this recently stays open
  sessionIdleMs: 15 * 60 * 1000, // forget a session with no events for this long
  sessionEndedMs: 90 * 1000, // forget an ended session after this long
  replyChars: 20000,
  outputChars: 12000,
  codeLines: 400,
  commitSubjectChars: 50,
};

export const DEFAULT_SETTINGS = {
  expandAll: false,
  minOpenSec: 8,
  showGraph: true,
};
