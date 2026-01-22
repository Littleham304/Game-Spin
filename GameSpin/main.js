const c = document.getElementById("c");
const ctx = c.getContext("2d");

// Responsive canvas sizing
function resizeCanvas() {
  const container = c.parentElement;
  const containerWidth = container.clientWidth - 20; // Account for padding
  c.width = Math.min(containerWidth, 1920);
  c.height = 150;
  c.style.width = "100%";
  c.style.height = "auto";
}

window.addEventListener("resize", resizeCanvas);
resizeCanvas();

const ITEM_WIDTH = () => Math.max(80, Math.min(120, c.width / 16)); // Responsive item width
const ITEM_HEIGHT = 100;
const CENTER_X = () => c.width / 2 - ITEM_WIDTH() / 2;

let pos = 0;
let speed = 0;

let stopping = false;
let done = true;
let wonGames = [];
let spinStartTime = 0;
let stopStartTime = 0;
let lastFrameTime = 0;
let currentUsername = "";
let buttonColor = "#facc15";
let decelerationStartPos = 0;
let lastTickedIndex = -1; // Track which item we last played a tick for
const SPIN_COOLDOWN = 10 * 60 * 1000; // 10 minutes in milliseconds

/* ---------------- USER DATA MANAGEMENT ---------------- */

async function setUsername() {
  const input = document.getElementById("usernameInput");
  const username = input.value.trim();

  if (!username || username.length > 50) {
    alert("Please enter a valid username (max 50 characters)");
    return;
  }

  currentUsername = username;
  document.getElementById("usernamePrompt").classList.add("hidden");

  const spinBtn = document.getElementById("spinBtn");
  spinBtn.disabled = true;
  spinBtn.textContent = "Checking...";

  await loadUserData();
}

async function loadUserData() {
  try {
    const url = `/api/user?username=${encodeURIComponent(currentUsername)}`;
    const response = await fetch(url);

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const data = await response.json();
    wonGames = data.wonGames || [];
    buttonColor = data.buttonColor || "#facc15";
    applyButtonColor();
    populateInventory();

    await checkSpinCooldown();
  } catch (err) {
    console.error("Failed to load user data:", err);
    checkLocalStorageCooldown();
  }
}

function checkLocalStorageCooldown() {
  document.getElementById("spinBtn").disabled = false;
  document.getElementById("spinBtn").textContent = "SPIN";
}

async function checkSpinCooldown() {
  try {
    const response = await fetch(`/api/spin-check?username=${encodeURIComponent(currentUsername)}`);

    if (response.status === 503) {
      document.getElementById("spinBtn").disabled = false;
      document.getElementById("spinBtn").textContent = "SPIN";
      return;
    }

    const data = await response.json();

    if (!data.canSpin && data.remainingMs > 0) {
      startCooldownTimer(data.remainingMs);
    } else if (data.canSpin) {
      document.getElementById("spinBtn").disabled = false;
      document.getElementById("spinBtn").textContent = "SPIN";
    }
  } catch (err) {
    console.error("Failed to check spin cooldown:", err);
    document.getElementById("spinBtn").disabled = false;
    document.getElementById("spinBtn").textContent = "SPIN";
  }
}

async function saveUserData() {
  if (!currentUsername) return;

  try {
    const userData = { username: currentUsername, wonGames, buttonColor };
    const response = await fetch("/api/user", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(userData),
    });

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
  } catch (err) {
    console.error("Failed to save user data:", err);
  }
}

setInterval(saveUserData, 10000);
window.addEventListener("beforeunload", saveUserData);

/* ---------------- LOAD GAME DATA ---------------- */

let games = [];
let reelItems = [];
let images = new Map();

fetch("./games.json")
  .then((r) => {
    if (!r.ok) throw new Error(`HTTP error! status: ${r.status}`);
    return r.json();
  })
  .then((data) => {
    games = data;
    initializeCanvas();
  })
  .catch((err) => {
    console.error("Failed to load games.json:", err);
  });

function initializeCanvas() {
  reelItems = [];
  for (let i = 0; i < 40; i++) {
    reelItems.push(games[Math.floor(Math.random() * games.length)]);
  }
  pos = 0;

  preloadImages(reelItems).then(() => {
    draw();
  });
}

/* ---------------- SPIN SETUP ---------------- */

let targetPos = 0;
let spinTargetIndex = 0;

function computeClampedTargetPos(targetIndex) {
  const itemWidth = ITEM_WIDTH();
  const centerX = CENTER_X();
  const rawTarget = targetIndex * itemWidth - centerX;

  const maxPos = Math.max(0, reelItems.length * itemWidth - c.width + itemWidth);
  const minPos = 0;

  return Math.min(Math.max(rawTarget, minPos), maxPos);
}

async function recordSpinOnServer() {
  try {
    const response = await fetch("/api/spin", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: currentUsername }),
    });

    if (response.status === 429) {
      alert("Please wait before your next spin!");
      checkSpinCooldown();
      return false;
    }

    if (!response.ok) {
      alert("Server error. Please try again later.");
      return false;
    }

    startCooldownTimer(SPIN_COOLDOWN);
    return true;
  } catch (err) {
    console.error("Server spin validation failed:", err);
    alert("Cannot connect to server. Please check your connection.");
    return false;
  }
}

/* ---------------- IMAGE PRELOAD ---------------- */

function preloadImages(items) {
  const promises = items.map((item) => {
    if (images.has(item.image)) return Promise.resolve();
    return new Promise((res) => {
      const img = new Image();
      img.crossOrigin = "anonymous";
      const timeout = setTimeout(() => res(), 5000);
      img.onload = () => {
        clearTimeout(timeout);
        images.set(item.image, img);
        res();
      };
      img.onerror = () => {
        clearTimeout(timeout);
        res();
      };
      img.src = item.image;
    });
  });
  return Promise.all(promises);
}

/* ---------------- DRAW LOOP ---------------- */

const RARITY_COLORS = {
  common: "#9ca3af",
  uncommon: "#22c55e",
  rare: "#3b82f6",
  epic: "#a855f7",
  legendary: "#eab308",
  mythic: "#ef4444",
  exotic: "#ec4899",
};

function roundRect(ctx, x, y, width, height, radius) {
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + width - radius, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + radius);
  ctx.lineTo(x + width, y + height - radius);
  ctx.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
  ctx.lineTo(x + radius, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - radius);
  ctx.lineTo(x, y + radius);
  ctx.quadraticCurveTo(x, y, x + radius, y);
  ctx.closePath();
}

// -------------------- NEW/UPDATED ANIMATION CONSTANTS --------------------
const SPIN_ACCEL_MS = 450;
const SPIN_COAST_MS = 2950;
const SPIN_DECEL_MS = 2400;
const SPIN_TOTAL_MS = SPIN_ACCEL_MS + SPIN_COAST_MS + SPIN_DECEL_MS;

const DT_CLAMP_SEC = 0.05;

const START_JITTER_PX = 0.8;
const START_JITTER_MS = 120;

let spinStartPerf = 0;
let spinStartPos = 0;
let lastFramePerf = 0;
let plannedStopPos = 0;
let totalPlannedDistance = 0;

// -------------------- EASING HELPERS --------------------
function easeOutQuint(t) {
  return 1 - Math.pow(1 - t, 5);
}

function easeInCubic(t) {
  return t * t * t;
}

function spinDistance01(elapsedMs) {
  const t = Math.max(0, Math.min(elapsedMs, SPIN_TOTAL_MS));

  const ACCEL_W = 0.12;
  const COAST_W = 0.58;
  const DECEL_W = 1 - ACCEL_W - COAST_W;

  if (t <= SPIN_ACCEL_MS) {
    const p = t / SPIN_ACCEL_MS;
    return ACCEL_W * easeInCubic(p);
  }

  if (t <= SPIN_ACCEL_MS + SPIN_COAST_MS) {
    const p = (t - SPIN_ACCEL_MS) / SPIN_COAST_MS;
    return ACCEL_W + COAST_W * p;
  }

  const p = (t - SPIN_ACCEL_MS - SPIN_COAST_MS) / SPIN_DECEL_MS;
  return ACCEL_W + COAST_W + DECEL_W * easeOutQuint(Math.min(Math.max(p, 0), 1));
}

function clampPosToReelBounds(p) {
  const itemWidth = ITEM_WIDTH();
  const maxPos = Math.max(0, reelItems.length * itemWidth - c.width + itemWidth);
  return Math.min(Math.max(p, 0), maxPos);
}

function clampTargetPos(p) {
  return clampPosToReelBounds(p);
}

/* -------------------- PATCH startSpin (animation changes) -------------------- */
async function startSpin() {
  if (!done) return;
  if (!games.length) return;
  if (!currentUsername) {
    alert("Please enter a username first");
    return;
  }

  const success = await recordSpinOnServer();
  if (!success) return;

  const winner = games[Math.floor(Math.random() * games.length)];

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

  spinTargetIndex = REEL_PADDING_ITEMS + 25;
  reelItems[spinTargetIndex] = winner;

  done = false;
  stopping = false;

  pos = 0;
  speed = 0;
  spinStartPos = pos;

  const itemWidth = ITEM_WIDTH();
  const centerX = CENTER_X();
  targetPos = spinTargetIndex * itemWidth - centerX;
  targetPos = clampTargetPos(targetPos);

  plannedStopPos = targetPos;
  totalPlannedDistance = Math.max(0, plannedStopPos - spinStartPos);

  spinStartTime = Date.now();
  spinStartPerf = performance.now();
  lastFramePerf = spinStartPerf;

  lastTickedIndex = Math.floor(pos / itemWidth);

  document.getElementById("spinBtn").disabled = true;

  setTimeout(() => {
    stopping = true;
    stopStartTime = Date.now();
    decelerationStartPos = pos;
  }, 3500);

  preloadImages(reelItems).catch(() => {});
  requestAnimationFrame(draw);
}

/* -------------------- PATCH draw (animation changes) -------------------- */
function draw() {
  ctx.fillStyle = "rgba(0, 0, 0, 0.3)";
  ctx.fillRect(0, 0, c.width, c.height);

  const itemWidth = ITEM_WIDTH();
  const centerX = CENTER_X();

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
    if (img) {
      ctx.drawImage(img, x + 5, 25, cardWidth - 10, cardHeight - 10);
    }
    ctx.restore();

    const rarity = item.rarity ? item.rarity.toLowerCase() : "common";
    ctx.strokeStyle = RARITY_COLORS[rarity] || "#fff";
    ctx.lineWidth = 2;
    roundRect(ctx, x, 20, cardWidth, cardHeight, radius);
    ctx.stroke();
  });

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
    const u = spinDistance01(elapsedMs);
    const prevPos = pos;

    const jitter = elapsedMs < START_JITTER_MS ? (Math.random() - 0.5) * START_JITTER_PX : 0;

    pos = spinStartPos + totalPlannedDistance * u + jitter;
    pos = clampPosToReelBounds(pos);

    speed = dtSec > 0 ? (pos - prevPos) / dtSec : 0;

    const prevIndex = Math.floor(prevPos / itemWidth);
    const currIndex = Math.floor(pos / itemWidth);
    if (currIndex !== prevIndex) {
      const steps = Math.min(8, Math.abs(currIndex - prevIndex));
      for (let i = 0; i < steps; i++) playTickSound();
      lastTickedIndex = currIndex;
    }

    if (elapsedMs >= SPIN_TOTAL_MS) {
      pos = plannedStopPos;
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

/* ---------------- MODAL + INVENTORY + SOUND ---------------- */

function showGameModal(game) {
  const modal = document.getElementById("modal");
  const title = document.getElementById("modal-title");
  const image = document.getElementById("modal-image");
  const info = document.getElementById("modal-info");

  title.textContent = game.title;
  image.src = game.image;

  let infoHtml = "";

  if (game.release_year) {
    infoHtml += `<div class="game-info"><strong>Release Year:</strong> ${game.release_year}</div>`;
  }
  if (game.platforms && game.platforms.length > 0) {
    infoHtml += `<div class="game-info"><strong>Platforms:</strong> ${game.platforms.join(", ")}</div>`;
  }
  if (game.genres && game.genres.length > 0) {
    infoHtml += `<div class="game-info"><strong>Genres:</strong> ${game.genres.join(", ")}</div>`;
  }
  if (game.ratings_count) {
    infoHtml += `<div class="game-info"><strong>Ratings Count:</strong> ${game.ratings_count}</div>`;
  }
  if (game.rarity) {
    infoHtml += `<div class="game-info"><strong>Rarity:</strong> ${game.rarity}</div>`;
  }

  info.innerHTML = infoHtml;
  modal.classList.add("active");
}

function closeModal() {
  const modal = document.getElementById("modal");
  modal.classList.remove("active");
}

function populateInventory() {
  const inventoryGrid = document.getElementById("inventoryGrid");
  inventoryGrid.innerHTML = "";

  if (wonGames.length === 0) {
    inventoryGrid.innerHTML =
      '<div style="color: #999; grid-column: 1/-1; text-align: center; padding: 20px;">Spin to collect games!</div>';
    return;
  }

  wonGames.forEach((game) => {
    const gameCard = document.createElement("div");
    gameCard.className = "game-card";
    gameCard.innerHTML = `
      <img src="${game.image}" alt="${game.title}" onerror="this.src='data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%22150%22 height=%22100%22%3E%3Crect fill=%22%23333%22 width=%22150%22 height=%22100%22/%3E%3C/svg%3E'">
      <div class="game-card-title">${game.title}</div>
    `;
    gameCard.onclick = () => showGameModal(game);
    inventoryGrid.appendChild(gameCard);
  });
}

function handleSpin() {
  if (!done) return;
  startSpin();
}

function playWinSound() {
  try {
    const audioContext = new (window.AudioContext || window.webkitAudioContext)();
    const now = audioContext.currentTime;

    const osc1 = audioContext.createOscillator();
    const gain1 = audioContext.createGain();
    osc1.connect(gain1);
    gain1.connect(audioContext.destination);

    osc1.frequency.setValueAtTime(800, now);
    osc1.frequency.exponentialRampToValueAtTime(600, now + 0.3);
    gain1.gain.setValueAtTime(0.3, now);
    gain1.gain.exponentialRampToValueAtTime(0.01, now + 0.3);

    osc1.start(now);
    osc1.stop(now + 0.3);

    const osc2 = audioContext.createOscillator();
    const gain2 = audioContext.createGain();
    osc2.connect(gain2);
    gain2.connect(audioContext.destination);

    osc2.frequency.setValueAtTime(1200, now + 0.1);
    osc2.frequency.exponentialRampToValueAtTime(900, now + 0.4);
    gain2.gain.setValueAtTime(0.2, now + 0.1);
    gain2.gain.exponentialRampToValueAtTime(0.01, now + 0.4);

    osc2.start(now + 0.1);
    osc2.stop(now + 0.4);
  } catch (e) {
    console.warn("Web Audio API not available");
  }
}

function playTickSound() {
  try {
    const audioContext = new (window.AudioContext || window.webkitAudioContext)();
    const now = audioContext.currentTime;

    const osc = audioContext.createOscillator();
    const gain = audioContext.createGain();
    osc.connect(gain);
    gain.connect(audioContext.destination);

    osc.frequency.setValueAtTime(400, now);
    gain.gain.setValueAtTime(0.15, now);
    gain.gain.exponentialRampToValueAtTime(0.01, now + 0.08);

    osc.start(now);
    osc.stop(now + 0.08);
  } catch (e) {}
}

function startCooldownTimer(remainingMs = SPIN_COOLDOWN) {
  const btn = document.getElementById("spinBtn");
  const endTime = Date.now() + remainingMs;

  const updateTimer = () => {
    const now = Date.now();
    const remaining = endTime - now;

    if (remaining <= 0) {
      checkSpinCooldown();
      return;
    }

    const minutes = Math.floor(remaining / 60000);
    const seconds = Math.floor((remaining % 60000) / 1000);
    btn.textContent = `${minutes}:${seconds.toString().padStart(2, "0")}`;
    btn.disabled = true;

    setTimeout(updateTimer, 100);
  };

  updateTimer();
}

function updateButtonColor() {
  const picker = document.getElementById("colorPicker");
  buttonColor = picker.value;
  applyButtonColor();
  saveUserData();
}

function applyButtonColor() {
  const btn = document.getElementById("spinBtn");
  const picker = document.getElementById("colorPicker");
  btn.style.background = buttonColor;
  picker.value = buttonColor;
}
