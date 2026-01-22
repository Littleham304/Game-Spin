const c = document.getElementById("c");
const ctx = c.getContext("2d");

// Responsive canvas sizing
function resizeCanvas() {
  const container = c.parentElement;
  const containerWidth = container.clientWidth - 20;
  c.width = Math.min(containerWidth, 1920);
  c.height = 150;
  c.style.width = '100%';
  c.style.height = 'auto';
}

window.addEventListener('resize', resizeCanvas);
resizeCanvas();

const ITEM_WIDTH = () => Math.max(80, Math.min(120, c.width / 16));
const ITEM_HEIGHT = 100;
const CENTER_X = () => c.width / 2 - ITEM_WIDTH() / 2;

let pos = 0;
let speed = 0;
let maxSpeed = 12;
let stopping = false;
let done = true;
let wonGames = [];
let spinStartTime = 0;
let stopStartTime = 0;
let lastFrameTime = 0;
let currentUsername = '';
let decelerationStartPos = 0;
let lastTickedIndex = -1;
let targetPos = 0;
let spinTargetIndex = 0;
const SPIN_COOLDOWN = 10 * 60 * 1000;

let games = [];
let reelItems = [];
let images = new Map();

// Load games data
fetch("./games.json")
  .then(r => {
    if (!r.ok) throw new Error(`HTTP error! status: ${r.status}`);
    return r.json();
  })
  .then(data => {
    games = data;
    initializeCanvas();
  })
  .catch(err => {
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

async function setUsername() {
  const input = document.getElementById('usernameInput');
  const username = input.value.trim();
  
  if (!username) {
    alert('Please enter a username');
    return;
  }

  currentUsername = username;
  document.getElementById('usernamePrompt').classList.add('hidden');
  await loadUserData();
  document.getElementById('spinBtn').disabled = false;
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
    populateInventory();
    await checkSpinCooldown();
  } catch (err) {
    console.error('Failed to load user data:', err);
    checkLocalStorageCooldown();
  }
}

function checkLocalStorageCooldown() {
  const lastSpin = localStorage.getItem(`lastSpin_${currentUsername}`);
  
  if (lastSpin) {
    const elapsed = Date.now() - parseInt(lastSpin);
    
    if (elapsed < SPIN_COOLDOWN) {
      const remaining = SPIN_COOLDOWN - elapsed;
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
    
    const response = await fetch('/api/user', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(userData)
    });
    
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
  } catch (err) {
    console.error('Failed to save user data:', err);
  }
}

setInterval(saveUserData, 10000);
window.addEventListener('beforeunload', saveUserData);

function startSpin() {
  if (!done) return;
  
  if (!games.length) {
    console.error("No games loaded yet");
    return;
  }
  
  recordSpinOnServer().then(canSpin => {
    if (!canSpin) return;
    
    const winner = games[Math.random() * games.length | 0];

    reelItems = [];
    for (let i = 0; i < 50; i++) {
      reelItems.push(games[Math.random() * games.length | 0]);
    }

    spinTargetIndex = 25;
    reelItems[spinTargetIndex] = winner;

    done = false;
    pos = 0;
    stopping = false;
    speed = 0;
    
    targetPos = spinTargetIndex * ITEM_WIDTH() - CENTER_X();
    
    document.getElementById('spinBtn').disabled = true;

    spinStartTime = Date.now();
    
    setTimeout(() => {
      stopping = true;
      stopStartTime = Date.now();
      decelerationStartPos = pos;
    }, 3500);
    
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
    
    if (!response.ok) {
      const errorData = await response.json();
      if (response.status === 429) {
        const minutes = Math.ceil(errorData.remainingMs / 60000);
        alert(`Please wait ${minutes} minute${minutes > 1 ? 's' : ''} before your next spin!`);
        return false;
      }
      throw new Error(`Server error: ${response.status}`);
    }
    
    localStorage.setItem(`lastSpin_${currentUsername}`, Date.now().toString());
    return true;
  } catch (err) {
    console.error('Failed to record spin on server:', err);
    
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

function draw() {
  if (!games.length) return;
  
  const currentTime = Date.now();
  lastFrameTime = currentTime;
  
  if (!done) {
    const elapsed = currentTime - spinStartTime;
    
    if (!stopping) {
      if (elapsed < 500) {
        speed = (elapsed / 500) * maxSpeed;
      } else {
        speed = maxSpeed;
      }
    } else {
      const decelerationTime = currentTime - stopStartTime;
      const decelerationDuration = 1500;
      
      if (decelerationTime >= decelerationDuration) {
        pos = targetPos;
        speed = 0;
        done = true;
        
        const winner = reelItems[spinTargetIndex];
        if (winner && !wonGames.some(g => g.id === winner.id)) {
          wonGames.push(winner);
          populateInventory();
          saveUserData();
        }
        
        showWinnerModal(winner);
        checkSpinCooldown();
        return;
      }
      
      const progress = decelerationTime / decelerationDuration;
      const easeOut = 1 - Math.pow(1 - progress, 3);
      
      const remainingDistance = targetPos - decelerationStartPos;
      pos = decelerationStartPos + (remainingDistance * easeOut);
      
      speed = maxSpeed * (1 - progress);
    }
    
    if (!stopping) {
      pos += speed;
    }
    
    const currentIndex = Math.floor((pos + CENTER_X()) / ITEM_WIDTH());
    if (currentIndex !== lastTickedIndex && speed > 2) {
      playTickSound();
      lastTickedIndex = currentIndex;
    }
  }
  
  ctx.clearRect(0, 0, c.width, c.height);
  
  const startIndex = Math.floor(pos / ITEM_WIDTH()) - 2;
  const endIndex = startIndex + Math.ceil(c.width / ITEM_WIDTH()) + 4;
  
  for (let i = startIndex; i <= endIndex; i++) {
    const itemIndex = ((i % reelItems.length) + reelItems.length) % reelItems.length;
    const item = reelItems[itemIndex];
    if (!item) continue;
    
    const x = i * ITEM_WIDTH() - pos;
    
    if (x + ITEM_WIDTH() < 0 || x > c.width) continue;
    
    drawItem(item, x, 25);
  }
  
  const centerX = CENTER_X() + ITEM_WIDTH() / 2;
  ctx.strokeStyle = '#ff0000';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(centerX, 0);
  ctx.lineTo(centerX, c.height);
  ctx.stroke();
  
  if (!done) {
    requestAnimationFrame(draw);
  }
}

function drawItem(item, x, y) {
  ctx.fillStyle = getRarityColor(item.rarity);
  ctx.fillRect(x, y, ITEM_WIDTH(), ITEM_HEIGHT);
  
  ctx.strokeStyle = '#333';
  ctx.lineWidth = 2;
  ctx.strokeRect(x, y, ITEM_WIDTH(), ITEM_HEIGHT);
  
  const img = images.get(item.image);
  if (img && img.complete) {
    const imgSize = Math.min(ITEM_WIDTH() - 10, ITEM_HEIGHT - 30);
    const imgX = x + (ITEM_WIDTH() - imgSize) / 2;
    const imgY = y + 5;
    
    ctx.drawImage(img, imgX, imgY, imgSize, imgSize);
  }
  
  ctx.fillStyle = '#fff';
  ctx.font = '12px Arial';
  ctx.textAlign = 'center';
  const textY = y + ITEM_HEIGHT - 8;
  const textX = x + ITEM_WIDTH() / 2;
  
  let title = item.title;
  if (title.length > 12) {
    title = title.substring(0, 12) + '...';
  }
  
  ctx.fillText(title, textX, textY);
}

function getRarityColor(rarity) {
  const colors = {
    'common': '#9CA3AF',
    'uncommon': '#10B981', 
    'rare': '#3B82F6',
    'epic': '#8B5CF6',
    'legendary': '#F59E0B',
    'mythic': '#EF4444',
    'exotic': '#EC4899'
  };
  return colors[rarity] || colors.common;
}

async function preloadImages(items) {
  const promises = items.map(item => {
    return new Promise((resolve) => {
      if (images.has(item.image)) {
        resolve();
        return;
      }
      
      const img = new Image();
      img.onload = () => {
        images.set(item.image, img);
        resolve();
      };
      img.onerror = () => {
        resolve();
      };
      img.src = item.image;
    });
  });
  
  await Promise.all(promises);
}

function populateInventory() {
  const grid = document.getElementById('inventoryGrid');
  grid.innerHTML = '';
  
  wonGames.forEach(game => {
    const card = document.createElement('div');
    card.className = 'game-card';
    card.style.borderColor = getRarityColor(game.rarity);
    
    const img = document.createElement('img');
    img.src = game.image;
    img.alt = game.title;
    img.onerror = () => {
      img.style.display = 'none';
    };
    
    const title = document.createElement('div');
    title.className = 'game-card-title';
    title.textContent = game.title;
    
    card.appendChild(img);
    card.appendChild(title);
    
    card.onclick = () => showGameModal(game);
    
    grid.appendChild(card);
  });
}

function showWinnerModal(game) {
  showGameModal(game, true);
}

function showGameModal(game, isWinner = false) {
  const modal = document.getElementById('modal');
  const title = document.getElementById('modal-title');
  const image = document.getElementById('modal-image');
  const info = document.getElementById('modal-info');
  
  title.textContent = isWinner ? `🎉 You won: ${game.title}!` : game.title;
  image.src = game.image;
  image.alt = game.title;
  
  info.innerHTML = `
    <div class="game-info"><strong>Release Year:</strong> ${game.release_year}</div>
    <div class="game-info"><strong>Platforms:</strong> ${game.platforms.join(', ')}</div>
    <div class="game-info"><strong>Genres:</strong> ${game.genres.join(', ')}</div>
    <div class="game-info"><strong>Rarity:</strong> <span style="color: ${getRarityColor(game.rarity)}">${game.rarity.toUpperCase()}</span></div>
    <div class="game-info"><strong>Ratings:</strong> ${game.ratings_count.toLocaleString()}</div>
  `;
  
  modal.classList.add('active');
}

function closeModal() {
  document.getElementById('modal').classList.remove('active');
}

function handleSpin() {
  if (done && currentUsername) {
    startSpin();
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

document.addEventListener('DOMContentLoaded', () => {
  resizeCanvas();
  document.getElementById('usernamePrompt').classList.remove('hidden');
});