const c = document.getElementById("c");
const ctx = c.getContext("2d");

// Responsive canvas sizing
function resizeCanvas() {
  const container = c.parentElement;
  const containerWidth = container.clientWidth - 20; // Account for padding
  c.width = Math.min(containerWidth, 1920);
  c.height = 150;
  c.style.width = '100%';
  c.style.height = 'auto';
}

window.addEventListener('resize', resizeCanvas);
resizeCanvas();

const ITEM_WIDTH = () => Math.max(80, Math.min(120, c.width / 16)); // Responsive item width
const ITEM_HEIGHT = 100;
const CENTER_X = () => c.width / 2 - ITEM_WIDTH() / 2;

let pos = 0;
// NOTE: speed now represents px/second (time-based), not px/frame
let speed = 0;

let maxSpeed = 12; // legacy; kept to avoid breaking external assumptions (not used directly now)
let stopping = false;
let done = true;
let wonGames = [];
let spinStartTime = 0;
let stopStartTime = 0;
let lastFrameTime = 0;
let currentUsername = '';
let decelerationStartPos = 0;
let lastTickedIndex = -1; // Track which item we last played a tick for
const SPIN_COOLDOWN = 10 * 60 * 1000; // 10 minutes in milliseconds

/* ---------------- USER DATA MANAGEMENT ---------------- */

async function setUsername() {
  const input = document.getElementById('usernameInput');
  const username = input.value.trim();
  
  if (!username || username.length > 50) {
    alert('Please enter a valid username (max 50 characters)');
    return;
  }

  currentUsername = username;
  document.getElementById('usernamePrompt').classList.add('hidden');

  const spinBtn = document.getElementById('spinBtn');
  spinBtn.disabled = true;
  spinBtn.textContent = 'Checking...';

  await loadUserData();
}

async function loadUserData() {
  try {
    const url = `/api/user?username=${encodeURIComponent(currentUsername)}`;
    console.log("Loading user data from:", url);
    const response = await fetch(url);
    
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    
    const data = await response.json();
    console.log("Loaded user data:", data);
    wonGames = data.wonGames || [];
    populateInventory();
    
    // ALWAYS check spin cooldown from server on load
    await checkSpinCooldown();
  } catch (err) {
    console.error('Failed to load user data:', err);
    // Fallback to localStorage if server fails
    checkLocalStorageCooldown();
  }
}

function checkLocalStorageCooldown() {
  document.getElementById('spinBtn').disabled = false;
  document.getElementById('spinBtn').textContent = 'SPIN';
}

async function checkSpinCooldown() {
  try {
    console.log('Checking spin cooldown for:', currentUsername);
    const response = await fetch(`/api/spin-check?username=${encodeURIComponent(currentUsername)}`);
    
    if (response.status === 503) {
      console.log('Database not ready, enabling button');
      document.getElementById('spinBtn').disabled = false;
      document.getElementById('spinBtn').textContent = 'SPIN';
      return;
    }
    
    const data = await response.json();
    console.log('Spin check response:', data);
    
    if (!data.canSpin && data.remainingMs > 0) {
      console.log('Starting cooldown timer with', data.remainingMs, 'ms');
      startCooldownTimer(data.remainingMs);
    } else if (data.canSpin) {
      console.log('Can spin, enabling button');
      document.getElementById('spinBtn').disabled = false;
      document.getElementById('spinBtn').textContent = 'SPIN';
    }
  } catch (err) {
    console.error('Failed to check spin cooldown:', err);
    document.getElementById('spinBtn').disabled = false;
    document.getElementById('spinBtn').textContent = 'SPIN';
  }
}

async function saveUserData() {
  if (!currentUsername) return;
  
  try {
    const userData = { username: currentUsername, wonGames };
    console.log("Saving user data:", userData);
    
    const response = await fetch('/api/user', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(userData)
    });
    
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    
    const result = await response.json();
    console.log("Save result:", result);
  } catch (err) {
    console.error('Failed to save user data:', err);
  }
}

// Auto-save every 10 seconds
setInterval(saveUserData, 10000);

// Save on page unload
window.addEventListener('beforeunload', saveUserData);

/* ---------------- LOAD GAME DATA ---------------- */

let games = [];
let reelItems = [];
let images = new Map();

fetch("./games.json")
  .then(r => {
    if (!r.ok) throw new Error(`HTTP error! status: ${r.status}`);
    return r.json();
  })
  .then(data => {
    games = data;
    // Initialize the canvas with empty reel
    initializeCanvas();
  })
  .catch(err => {
    console.error("Failed to load games.json:", err);
  });

function initializeCanvas() {
  // Create an initial reel for display
  reelItems = [];
  for (let i = 0; i < 40; i++) {
    reelItems.push(games[Math.floor(Math.random() * games.length)]);
  }
  pos = 0;
  
  // Preload images and then draw
  preloadImages(reelItems).then(() => {
    draw();
  });
}

/* ---------------- SPIN SETUP ---------------- */

async function startSpin() {
  if (!done) return;
  if (!games.length) return;
  if (!currentUsername) {
    alert('Please enter a username first');
    return;
  }
  
  const success = await recordSpinOnServer();
  if (!success) return;
  
  console.log("=== SPIN STARTED ===");
    
  // pick winner
  const winner = games[Math.floor(Math.random() * games.length)];

  // build reel with 50 items
  reelItems = [];
  for (let i = 0; i < 50; i++) {
    reelItems.push(games[Math.floor(Math.random() * games.length)]);
  }

  // Place winner at index 25 (middle)
  spinTargetIndex = 25;
  reelItems[spinTargetIndex] = winner;

  done = false;
  pos = 0;
  stopping = false;

  // speed is time-based now (px/second). Seed with a small value; ramp handled in draw().
  speed = 0;

  targetPos = spinTargetIndex * ITEM_WIDTH() - CENTER_X();
  spinStartTime = Date.now();
  
  document.getElementById('spinBtn').disabled = true;

  // keep the same event/timing semantics: after 3.5s we enter "stopping"/deceleration
  setTimeout(() => {
    stopping = true;
    stopStartTime = Date.now();
    decelerationStartPos = pos;
  }, 3500);
  
  preloadImages(reelItems).catch(() => {});
  // IMPORTANT: reset frame timer so low-FPS / tab-switch doesn't jump on first frame
  lastFrameTime = performance.now();
  requestAnimationFrame(draw);
}

async function recordSpinOnServer() {
  try {
    console.log('Recording spin on server for:', currentUsername);
    const response = await fetch('/api/spin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: currentUsername })
    });
    
    console.log('Spin response status:', response.status);
    
    if (response.status === 429) {
      alert('Please wait before your next spin!');
      checkSpinCooldown();
      return false;
    }
    
    if (!response.ok) {
      alert('Server error. Please try again later.');
      return false;
    }
    
    const result = await response.json();
    console.log('Spin accepted, starting timer');
    // Server confirmed spin - start cooldown timer immediately
    startCooldownTimer(SPIN_COOLDOWN);
    return true;
  } catch (err) {
    console.error('Server spin validation failed:', err);
    alert('Cannot connect to server. Please check your connection.');
    return false;
  }
}

/* ---------------- IMAGE PRELOAD ---------------- */

function preloadImages(items) {
  const promises = items.map(item => {
    if (images.has(item.image)) return Promise.resolve();
    return new Promise(res => {
      const img = new Image();
      img.crossOrigin = "anonymous";
      const timeout = setTimeout(() => {
        res(); // Resolve anyway after timeout
      }, 5000);
      img.onload = () => {
        clearTimeout(timeout);
        images.set(item.image, img);
        res();
      };
      img.onerror = () => {
        clearTimeout(timeout);
        res(); // Still resolve, just without the image
      };
      img.src = item.image;
    });
  });
  return Promise.all(promises);
}

/* ---------------- DRAW LOOP ---------------- */

let targetPos = 0;
let spinTargetIndex = 0;

/**
 * CS:GO-like spin profile constants (time-based, stable at low FPS)
 * - Fast ramp-up, then a long, weighted deceleration tail
 * - Exact landing (no bounce), no frame-dependent stepping
 */
const SPIN_ACCEL_MS = 550;          // quick ramp (mechanical punch)
const SPIN_CRUISE_MS = 2950;        // stays fast before "stop" is triggered (~3.5s total with accel)
const SPIN_DECEL_MS = 2200;         // long deceleration tail (perceived smoothness)
const MAX_SPEED_PX_PER_SEC = 2400;  // peak reel speed
const START_JITTER_PX = 0.9;        // optional micro-randomness only at the start (sub-pixel)
const DT_CLAMP_SEC = 0.05;          // clamp to avoid huge jumps on tab-switch / low FPS

function easeOutCubic(t) {
  return 1 - Math.pow(1 - t, 3);
}

function easeInCubic(t) {
  return t * t * t;
}

// Stronger tail than cubic (more CS:GO-ish weight). Used for decel only.
function easeOutQuint(t) {
  return 1 - Math.pow(1 - t, 5);
}

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

function draw() {
  // Fill background
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, c.width, c.height);

  const itemWidth = ITEM_WIDTH();
  const centerX = CENTER_X();

  reelItems.forEach((item, i) => {
    const x = i * itemWidth - pos;
    if (x < -itemWidth || x > c.width) return;

    const cardWidth = itemWidth - 10;
    const cardHeight = ITEM_HEIGHT;
    const radius = 8;

    // background with rounded corners
    ctx.fillStyle = "#111";
    roundRect(ctx, x, 20, cardWidth, cardHeight, radius);
    ctx.fill();

    // image with rounded corners
    ctx.save();
    roundRect(ctx, x + 5, 25, cardWidth - 10, cardHeight - 10, radius - 2);
    ctx.clip();
    const img = images.get(item.image);
    if (img) {
      ctx.drawImage(img, x + 5, 25, cardWidth - 10, cardHeight - 10);
    }
    ctx.restore();

    // border with rounded corners
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
    const dtSecRaw = (nowPerf - (lastFrameTime || nowPerf)) / 1000;
    // Clamp dt so very low FPS doesn't skip ticks/teleport.
    const dtSec = Math.min(Math.max(dtSecRaw, 0), DT_CLAMP_SEC);
    lastFrameTime = nowPerf;

    const now = Date.now();
    const elapsed = now - spinStartTime;

    if (!stopping) {
      // MOMENTUM PHASE (accelerate quickly then cruise).
      // This replaces "pos += speed (per frame)" with time-based integration.
      const accelProgress = Math.min(elapsed / SPIN_ACCEL_MS, 1);

      // Fast initial movement (ease-in gives a mechanical "grab" rather than floaty)
      const v = MAX_SPEED_PX_PER_SEC * easeInCubic(accelProgress);

      // Optional micro-randomness ONLY at start (kept tiny to avoid jitter later)
      const startJitter = (elapsed < 120) ? ((Math.random() - 0.5) * START_JITTER_PX) : 0;

      speed = v;
      pos += (speed * dtSec) + startJitter;

      // Tick sound on each item boundary crossed (stable even when dt is bigger)
      const currentIndex = Math.floor(pos / itemWidth);
      if (currentIndex !== lastTickedIndex) {
        lastTickedIndex = currentIndex;
        playTickSound();
      }
    } else {
      // DECELERATION PHASE (long smooth ease-out, exact stop at targetPos).
      // We interpolate position from decelerationStartPos -> targetPos using time,
      // so landing is deterministic and frame rate independent.
      const elapsed2 = now - stopStartTime;
      const progress = Math.min(elapsed2 / SPIN_DECEL_MS, 1);

      // Strong ease-out tail (quint) for CS:GO-like long slow-down feel.
      const eased = easeOutQuint(progress);

      const prevPos = pos;
      pos = decelerationStartPos + (targetPos - decelerationStartPos) * eased;

      // Derive speed (px/sec) for any future use/debug; avoids frame-dependence.
      speed = dtSec > 0 ? (pos - prevPos) / dtSec : 0;

      // Continue ticking during decel; we may cross multiple items at low FPS.
      const currentIndex = Math.floor(pos / itemWidth);
      if (currentIndex !== lastTickedIndex) {
        lastTickedIndex = currentIndex;
        playTickSound();
      }

      if (progress >= 1) {
        // DONE - clean exact landing, no bounce, no snapping after this point
        pos = targetPos;
        done = true;

        const winner = reelItems[spinTargetIndex];
        console.log("=== SPIN COMPLETE ===");
        console.log("WINNER:", winner.title);

        // Play success sound
        playWinSound();

        if (!wonGames.find(g => g.id === winner.id)) {
          wonGames.push(winner);
          populateInventory();
          saveUserData();
        }

        showGameModal(winner);
      }
    }
  }

  if (!done) {
    requestAnimationFrame(draw);
  }
}

function showGameModal(game) {
  const modal = document.getElementById('modal');
  const title = document.getElementById('modal-title');
  const image = document.getElementById('modal-image');
  const info = document.getElementById('modal-info');

  title.textContent = game.title;
  image.src = game.image;

  let infoHtml = '';
  
  // Display all properties except id and slug
  if (game.release_year) {
    infoHtml += `<div class="game-info"><strong>Release Year:</strong> ${game.release_year}</div>`;
  }
  if (game.platforms && game.platforms.length > 0) {
    infoHtml += `<div class="game-info"><strong>Platforms:</strong> ${game.platforms.join(', ')}</div>`;
  }
  if (game.genres && game.genres.length > 0) {
    infoHtml += `<div class="game-info"><strong>Genres:</strong> ${game.genres.join(', ')}</div>`;
  }
  if (game.ratings_count) {
    infoHtml += `<div class="game-info"><strong>Ratings Count:</strong> ${game.ratings_count}</div>`;
  }
  if (game.rarity) {
    infoHtml += `<div class="game-info"><strong>Rarity:</strong> ${game.rarity}</div>`;
  }

  info.innerHTML = infoHtml;
  modal.classList.add('active');
}

function closeModal() {
  const modal = document.getElementById('modal');
  modal.classList.remove('active');
}

function populateInventory() {
  const inventoryGrid = document.getElementById('inventoryGrid');
  inventoryGrid.innerHTML = '';

  // Only show games that have been won
  if (wonGames.length === 0) {
    inventoryGrid.innerHTML = '<div style="color: #999; grid-column: 1/-1; text-align: center; padding: 20px;">Spin to collect games!</div>';
    return;
  }

  wonGames.forEach(game => {
    const gameCard = document.createElement('div');
    gameCard.className = 'game-card';
    gameCard.innerHTML = `
      <img src="${game.image}" alt="${game.title}" onerror="this.src='data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%22150%22 height=%22100%22%3E%3Crect fill=%22%23333%22 width=%22150%22 height=%22100%22/%3E%3C/svg%3E'">
      <div class="game-card-title">${game.title}</div>
    `;
    gameCard.onclick = () => showGameModal(game);
    inventoryGrid.appendChild(gameCard);
  });
}

function handleSpin() {
  if (!done) return; // Only allow spin if current spin is done
  startSpin();
}

function playWinSound() {
  try {
    const audioContext = new (window.AudioContext || window.webkitAudioContext)();
    
    // Create a satisfying "ding" sound
    const now = audioContext.currentTime;
    
    // Main tone
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
    
    // Higher harmony (0.1s delay)
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
    
    // Short, sharp tick sound
    const osc = audioContext.createOscillator();
    const gain = audioContext.createGain();
    osc.connect(gain);
    gain.connect(audioContext.destination);
    
    osc.frequency.setValueAtTime(400, now);
    gain.gain.setValueAtTime(0.15, now);
    gain.gain.exponentialRampToValueAtTime(0.01, now + 0.08);
    
    osc.start(now);
    osc.stop(now + 0.08);
  } catch (e) {
    // Silently fail if audio unavailable
  }
}

function startCooldownTimer(remainingMs = SPIN_COOLDOWN) {
  console.log('startCooldownTimer called with', remainingMs, 'ms');
  const btn = document.getElementById('spinBtn');
  const endTime = Date.now() + remainingMs;
  
  const updateTimer = () => {
    const now = Date.now();
    const remaining = endTime - now;
    
    if (remaining <= 0) {
      console.log('Cooldown expired, checking server');
      // Cooldown expired - verify with server before enabling
      checkSpinCooldown();
      return;
    }
    
    const minutes = Math.floor(remaining / 60000);
    const seconds = Math.floor((remaining % 60000) / 1000);
    btn.textContent = `${minutes}:${seconds.toString().padStart(2, '0')}`;
    btn.disabled = true;
    
    setTimeout(updateTimer, 100);
  };
  
  updateTimer();
}