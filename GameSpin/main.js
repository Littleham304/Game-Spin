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
let speed = 0;
let maxSpeed = 12; // pixels per frame at full speed
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
  
  if (!username) {
    alert('Please enter a username');
    return;
  }

  currentUsername = username;
  document.getElementById('usernamePrompt').classList.add('hidden');

  // Load user data from server
  await loadUserData();
  
  // Enable spin button
  document.getElementById('spinBtn').disabled = false;
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
    
    // Check spin cooldown from server
    await checkSpinCooldown();
  } catch (err) {
    console.error('Failed to load user data:', err);
    // Always check localStorage on load
    checkLocalStorageCooldown();
  }
}

function checkLocalStorageCooldown() {
  const lastSpin = localStorage.getItem(`lastSpin_${currentUsername}`);
  console.log('Checking localStorage for:', `lastSpin_${currentUsername}`, 'Value:', lastSpin);
  
  if (lastSpin) {
    const elapsed = Date.now() - parseInt(lastSpin);
    console.log('Time elapsed since last spin:', elapsed, 'Cooldown:', SPIN_COOLDOWN);
    
    if (elapsed < SPIN_COOLDOWN) {
      const remaining = SPIN_COOLDOWN - elapsed;
      console.log('Still in cooldown, remaining:', remaining);
      startCooldownTimer(remaining);
      return;
    }
  }
  
  document.getElementById('spinBtn').disabled = false;
  document.getElementById('spinBtn').textContent = 'SPIN';
}

async function checkSpinCooldown() {
  try {
    const response = await fetch(`/api/spin-check?username=${encodeURIComponent(currentUsername)}`);
    
    if (response.status === 503) {
      // Database not ready, use localStorage fallback
      const lastSpin = localStorage.getItem(`lastSpin_${currentUsername}`);
      if (lastSpin) {
        const elapsed = Date.now() - parseInt(lastSpin);
        if (elapsed < SPIN_COOLDOWN) {
          startCooldownTimer(SPIN_COOLDOWN - elapsed);
          return;
        }
      }
      document.getElementById('spinBtn').disabled = false;
      document.getElementById('spinBtn').textContent = 'SPIN';
      return;
    }
    
    const data = await response.json();
    
    if (!data.canSpin) {
      startCooldownTimer(data.remainingMs);
    } else {
      document.getElementById('spinBtn').disabled = false;
      document.getElementById('spinBtn').textContent = 'SPIN';
    }
  } catch (err) {
    console.error('Failed to check spin cooldown:', err);
    // Fallback to localStorage
    const lastSpin = localStorage.getItem(`lastSpin_${currentUsername}`);
    if (lastSpin) {
      const elapsed = Date.now() - parseInt(lastSpin);
      if (elapsed < SPIN_COOLDOWN) {
        startCooldownTimer(SPIN_COOLDOWN - elapsed);
        return;
      }
    }
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

function startSpin() {
  // Prevent spinning if already spinning
  if (!done) return;
  
  if (!games.length) {
    console.error("No games loaded yet");
    return;
  }
  
  // Record spin on server first
  recordSpinOnServer().then(canSpin => {
    if (!canSpin) return; // Server rejected the spin
    
    console.log("=== SPIN STARTED ===");
    
    // pick winner
    const winner = games[Math.random() * games.length | 0];

    // build reel with 50 items
    reelItems = [];
    for (let i = 0; i < 50; i++) {
      reelItems.push(games[Math.random() * games.length | 0]);
    }

    // Place winner at index 25 (middle)
    spinTargetIndex = 25;
    reelItems[spinTargetIndex] = winner;

    // Reset state - CRITICAL: must set done to false BEFORE animation starts
    done = false;
    pos = 0;
    stopping = false;
    speed = 0;
    
    // Target position: where index 25 should be centered
    targetPos = spinTargetIndex * ITEM_WIDTH() - CENTER_X();
    console.log("Target position:", targetPos);
    
    // Disable spin button
    document.getElementById('spinBtn').disabled = true;

    // Start animation immediately - don't wait for image preload
    spinStartTime = Date.now();
    
    // Acceleration: 0.5s
    // Full spin: 3s
    // Deceleration: 1.5s
    // Total: 5 seconds
    
    setTimeout(() => {
      stopping = true;
      stopStartTime = Date.now();
      decelerationStartPos = pos;
      console.log("=== DECELERATION STARTED ===");
      console.log("Current pos:", pos, "Need to reach:", targetPos);
    }, 3500); // Stop acceleration + spin phase at 3.5 seconds
    
    // Preload images in background (non-blocking)
    preloadImages(reelItems).catch(() => {
      console.warn("Some images failed to load, but continuing animation");
    });
    
    requestAnimationFrame(draw);
  });
}

async function recordSpinOnServer() {
  try {
    const response = await fetch('/api/spin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: currentUsername })
    });
    
    if (response.status === 503) {
      // Database not ready, use localStorage fallback
      const lastSpin = localStorage.getItem(`lastSpin_${currentUsername}`);
      if (lastSpin) {
        const elapsed = Date.now() - parseInt(lastSpin);
        if (elapsed < SPIN_COOLDOWN) {
          const minutes = Math.ceil((SPIN_COOLDOWN - elapsed) / 60000);
          alert(`Please wait ${minutes} minute${minutes > 1 ? 's' : ''} before your next spin!`);
          return false;
        }
      }
      localStorage.setItem(`lastSpin_${currentUsername}`, Date.now().toString());
      return true;
    }
    
    if (response.status === 429) {
      const data = await response.json();
      const minutes = Math.ceil(data.remainingMs / 60000);
      alert(`Please wait ${minutes} minute${minutes > 1 ? 's' : ''} before your next spin!`);
      return false;
    }
    
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    
    // Store spin time locally as backup
    localStorage.setItem(`lastSpin_${currentUsername}`, Date.now().toString());
    return true;
  } catch (err) {
    console.error('Server spin validation failed, using local storage');
    
    // Fallback to localStorage if server fails
    const lastSpin = localStorage.getItem(`lastSpin_${currentUsername}`);
    if (lastSpin) {
      const elapsed = Date.now() - parseInt(lastSpin);
      if (elapsed < SPIN_COOLDOWN) {
        const minutes = Math.ceil((SPIN_COOLDOWN - elapsed) / 60000);
        alert(`Please wait ${minutes} minute${minutes > 1 ? 's' : ''} before your next spin!`);
        return false;
      }
    }
    
    localStorage.setItem(`lastSpin_${currentUsername}`, Date.now().toString());
    return true;
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

function easeOutCubic(t) {
  return 1 - Math.pow(1 - t, 3);
}

function easeInCubic(t) {
  return t * t * t;
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
    const now = Date.now();
    const elapsed = now - spinStartTime;
    
    if (!stopping) {
      // ACCELERATION + SPINNING PHASE (3.5 seconds total)
      const accelDuration = 500; // First 0.5s is acceleration
      
      if (elapsed < accelDuration) {
        // Acceleration phase - smooth ramp up
        const accelProgress = elapsed / accelDuration;
        speed = maxSpeed * easeInCubic(accelProgress);
      } else {
        // Full speed spinning phase
        speed = maxSpeed;
      }
      
      pos += speed;
      
      // Play tick sound as we pass each item
      const currentIndex = Math.floor(pos / itemWidth);
      if (currentIndex !== lastTickedIndex) {
        lastTickedIndex = currentIndex;
        playTickSound();
      }
    } else {
      // DECELERATION PHASE (1.5 seconds)
      const elapsed2 = now - stopStartTime;
      const duration = 1500; // 1.5 second deceleration
      const progress = Math.min(elapsed2 / duration, 1);
      
      // Smooth easing from current position to target
      const eased = easeOutCubic(progress);
      pos = decelerationStartPos + (targetPos - decelerationStartPos) * eased;
      
      if (progress >= 1) {
        // DONE - snap to exact target
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
        // Don't start local timer - let server handle it
        document.getElementById('spinBtn').disabled = true;
        // Check server for actual cooldown time
        checkSpinCooldown();
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
  const btn = document.getElementById('spinBtn');
  const endTime = Date.now() + remainingMs;
  
  const updateTimer = () => {
    const now = Date.now();
    const remaining = endTime - now;
    
    if (remaining <= 0) {
      btn.disabled = false;
      btn.textContent = 'SPIN';
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
