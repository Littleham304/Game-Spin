/**
 * SPIN ANIMATION PATCH
 * Goal: CS:GO-like case opening reel: fast start, long smooth decel, exact landing.
 *
 * Fixes overshoot + snap-back by removing the mixed model:
 *   - old: integrate pos += speed*dt, then later interpolate pos -> target (can overshoot and snap back)
 *   - new: deterministic time-based distance curve that always lands exactly once
 *
 * Public function signatures and existing listeners remain unchanged.
 * Only animation-related code is modified.
 */

// -------------------- NEW/UPDATED ANIMATION CONSTANTS --------------------
// All values are time-based (ms) so behavior is stable at low frame rates.
const SPIN_ACCEL_MS = 450;          // quick mechanical punch
const SPIN_COAST_MS = 2950;         // stays fast before "stopping" is triggered (~3.4s)
const SPIN_DECEL_MS = 2400;         // long deceleration tail (CS:GO feel)
const SPIN_TOTAL_MS = SPIN_ACCEL_MS + SPIN_COAST_MS + SPIN_DECEL_MS;

const MAX_SPEED_PX_PER_SEC = 2600;  // peak reel speed during coast
const DT_CLAMP_SEC = 0.05;          // cap dt to avoid teleports on low FPS / tab restore

// Optional micro randomness only at start (subpixel); keep tiny to avoid jitter.
const START_JITTER_PX = 0.8;
const START_JITTER_MS = 120;

// -------------------- NEW/UPDATED ANIMATION STATE --------------------
let spinStartPerf = 0;          // performance.now() at spin start (for smooth dt)
let spinStartPos = 0;           // pos at spin start (usually 0)
let lastFramePerf = 0;          // last performance.now() seen
let plannedStopPos = 0;         // the exact targetPos we will land on
let totalPlannedDistance = 0;   // distance from spinStartPos to targetPos (>=0)

// NOTE: keep existing variables used elsewhere
// let pos = 0;
// let speed = 0;
// let stopping = false;
// let done = true;
// let targetPos = 0;
// let stopStartTime = 0;
// let spinStartTime = 0;
// let decelerationStartPos = 0;

// -------------------- EASING HELPERS --------------------
function easeOutQuint(t) {
  // Strong ease-out for long decel tail (weighted, no bounce)
  return 1 - Math.pow(1 - t, 5);
}

function easeInCubic(t) {
  // Fast ramp-up (mechanical "grab")
  return t * t * t;
}

// Piecewise "distance traveled" curve that reaches 1.0 at end.
// IMPORTANT: monotonic increasing => no overshoot => no snap-back.
function spinDistance01(elapsedMs) {
  const t = Math.max(0, Math.min(elapsedMs, SPIN_TOTAL_MS));

  // Phase weights: accel (small), coast (medium), decel (largest perceived tail).
  // These define *how much of total distance* is allocated to each phase.
  const ACCEL_W = 0.12;
  const COAST_W = 0.58;
  const DECEL_W = 1 - ACCEL_W - COAST_W;

  if (t <= SPIN_ACCEL_MS) {
    const p = t / SPIN_ACCEL_MS;
    // accelerate distance: starts slow then ramps quickly (still monotonic)
    return ACCEL_W * easeInCubic(p);
  }

  if (t <= SPIN_ACCEL_MS + SPIN_COAST_MS) {
    const p = (t - SPIN_ACCEL_MS) / SPIN_COAST_MS;
    // linear-ish coast distance (constant-ish speed feel)
    return ACCEL_W + COAST_W * p;
  }

  // Decel phase: long ease-out tail
  const p = (t - SPIN_ACCEL_MS - SPIN_COAST_MS) / SPIN_DECEL_MS;
  return ACCEL_W + COAST_W + DECEL_W * easeOutQuint(Math.min(Math.max(p, 0), 1));
}

// Clamp pos so the canvas never runs into "black" (no content visible).
function clampPosToReelBounds(p) {
  const itemWidth = ITEM_WIDTH();
  // Allow some room so at least one item is visible; ensure non-negative.
  const maxPos = Math.max(0, reelItems.length * itemWidth - c.width + itemWidth);
  return Math.min(Math.max(p, 0), maxPos);
}

// Ensure targetPos itself is reachable within bounds (prevents trying to land beyond content).
function clampTargetPos(p) {
  return clampPosToReelBounds(p);
}

// -------------------- PATCH startSpin (animation-related changes only) --------------------
async function startSpin() {
  if (!done) return;
  if (!games.length) return;
  if (!currentUsername) {
    alert("Please enter a username first");
    return;
  }

  const success = await recordSpinOnServer();
  if (!success) return;

  // pick winner
  const winner = games[Math.floor(Math.random() * games.length)];

  // build reel with padding so content exists before/after target (prevents black gaps)
  const REEL_PADDING_ITEMS = 18;
  const RUNWAY_ITEMS = 50;

  reelItems = [];
  for (let i = 0; i < REEL_PADDING_ITEMS; i++) {
    reelItems.push(games[Math.floor(Math.random() * games.length)]);
  }
  for (let i = 0; i < RUNWAY_ITEMS; i++) {
    reelItems.push(games[Math.floor(Math.random() * games.length)]);
  }
  for (let i = 0; i < REEL_PADDING_ITEMS; i++) {
    reelItems.push(games[Math.floor(Math.random() * games.length)]);
  }

  // Winner well away from edges
  spinTargetIndex = REEL_PADDING_ITEMS + 25;
  reelItems[spinTargetIndex] = winner;

  done = false;
  stopping = false;

  // reset motion state
  pos = 0;
  speed = 0;
  spinStartPos = pos;

  // compute & clamp target
  const itemWidth = ITEM_WIDTH();
  const centerX = CENTER_X();
  targetPos = spinTargetIndex * itemWidth - centerX;
  targetPos = clampTargetPos(targetPos);

  // Plan a single monotonic distance from start -> target (no overshoot possible)
  plannedStopPos = targetPos;
  totalPlannedDistance = Math.max(0, plannedStopPos - spinStartPos);

  // time baselines (keep existing semantics)
  spinStartTime = Date.now();
  spinStartPerf = performance.now();
  lastFramePerf = spinStartPerf;

  // Reset tick tracking
  lastTickedIndex = Math.floor(pos / itemWidth);

  document.getElementById("spinBtn").disabled = true;

  // Preserve existing logic: stopping flips at 3500ms (we keep it, but it won't cause snapping)
  setTimeout(() => {
    stopping = true;
    stopStartTime = Date.now();
    // decelerationStartPos kept for legacy/debug; no longer used for interpolation start
    decelerationStartPos = pos;
  }, 3500);

  preloadImages(reelItems).catch(() => {});
  requestAnimationFrame(draw);
}

// -------------------- PATCH draw (animation-related changes only) --------------------
function draw() {
  // Fill background
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, c.width, c.height);

  const itemWidth = ITEM_WIDTH();
  const centerX = CENTER_X();

  // draw items
  reelItems.forEach((item, i) => {
    const x = i * itemWidth - pos;
    if (x < -itemWidth || x > c.width) return;

    const cardWidth = itemWidth - 10;
    const cardHeight = ITEM_HEIGHT;
    const radius = 8;

    ctx.fillStyle = "#111";
    roundRect(ctx, x, 20, cardWidth, cardHeight, radius);
    ctx.fill();

    ctx.save();
    roundRect(ctx, x + 5, 25, cardWidth - 10, cardHeight - 10, radius - 2);
    ctx.clip();
    const img = images.get(item.image);
    if (img) ctx.drawImage(img, x + 5, 25, cardWidth - 10, cardHeight - 10);
    ctx.restore();

    // keep your existing rarity outline logic elsewhere if you've already added it;
    // default border (safe fallback)
    ctx.strokeStyle = "#fff";
    ctx.lineWidth = 2;
    roundRect(ctx, x, 20, cardWidth, cardHeight, radius);
    ctx.stroke();
  });

  // center marker
  ctx.strokeStyle = "#fff";
  ctx.beginPath();
  ctx.moveTo(centerX + itemWidth / 2, 10);
  ctx.lineTo(centerX + itemWidth / 2, 130);
  ctx.stroke();

  if (!done) {
    const nowPerf = performance.now();
    const dtSecRaw = (nowPerf - (lastFramePerf || nowPerf)) / 1000;
    const dtSec = Math.min(Math.max(dtSecRaw, 0), DT_CLAMP_SEC);
    lastFramePerf = nowPerf;

    const elapsedMs = nowPerf - spinStartPerf;

    // Compute desired position from a single monotonic curve (0..1 distance).
    const u = spinDistance01(elapsedMs);
    const prevPos = pos;

    // Add micro jitter only at the very start to mimic mechanical start variance.
    const jitter = elapsedMs < START_JITTER_MS ? (Math.random() - 0.5) * START_JITTER_PX : 0;

    pos = spinStartPos + totalPlannedDistance * u + jitter;

    // Clamp to bounds every frame => never scroll into black even if resized mid-spin.
    pos = clampPosToReelBounds(pos);

    // Derive speed (px/sec) from position delta (time-based; not frame-step dependent)
    speed = dtSec > 0 ? (pos - prevPos) / dtSec : 0;

    // Tick sounds when crossing item boundaries; handle low FPS by emitting limited ticks.
    const prevIndex = Math.floor(prevPos / itemWidth);
    const currIndex = Math.floor(pos / itemWidth);
    if (currIndex !== prevIndex) {
      const steps = Math.min(8, Math.abs(currIndex - prevIndex));
      for (let i = 0; i < steps; i++) playTickSound();
      lastTickedIndex = currIndex;
    }

    // Finish exactly at end of planned curve (no bounce, no snap-back)
    if (elapsedMs >= SPIN_TOTAL_MS) {
      pos = plannedStopPos; // exact landing
      speed = 0;
      done = true;

      const winner = reelItems[spinTargetIndex];

      playWinSound();

      if (!wonGames.find((g) => g.id === winner.id)) {
        wonGames.push(winner);
        populateInventory();
        saveUserData();
      }

      showGameModal(winner);
    }
  }

  if (!done) requestAnimationFrame(draw);
}