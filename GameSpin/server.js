const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');
const { MongoClient } = require('mongodb');

const PORT = process.env.PORT || 3000;
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/gamespin';
const MAX_BODY_SIZE = 1048576; // 1MB limit

let db;
let users;

// Connect to MongoDB
MongoClient.connect(MONGODB_URI, {
  serverSelectionTimeoutMS: 5000,
  socketTimeoutMS: 45000
})
  .then(client => {
    console.log('Connected to MongoDB');
    db = client.db('gamespin');
    users = db.collection('users');
  })
  .catch(err => {
    console.error('MongoDB connection failed:', err);
    // Don't exit on Render - keep server running for static files
    console.log('Running without database - data will not persist');
  });

const contentTypes = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.json': 'application/json',
  '.css': 'text/css'
};

const server = http.createServer((req, res) => {
  // Add CORS headers for all requests
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  const parsedUrl = url.parse(req.url, true);
  const pathname = parsedUrl.pathname;

  // Wait for database connection before handling API requests
  if (pathname.startsWith('/api/') && !users) {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Database not ready' }));
    return;
  }

  // ---- API: Get user ----
  if (pathname === '/api/user' && req.method === 'GET') {
    const username = parsedUrl.query.username;
    if (!username || typeof username !== 'string' || username.length > 50) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid username' }));
      return;
    }
    users.findOne({ username })
      .then(user => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(user || {}));
      })
      .catch(err => {
        console.error('Database error:', err);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Database error' }));
      });
    return;
  }

  // ---- API: Save user ----
  if (pathname === '/api/user' && req.method === 'POST') {
    let body = '';
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BODY_SIZE) {
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Payload too large' }));
        req.destroy();
        return;
      }
      body += chunk;
    });
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        if (!data.username || typeof data.username !== 'string' || data.username.length > 50) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid username' }));
          return;
        }
        users.updateOne(
          { username: data.username },
          { 
            $set: { 
              wonGames: data.wonGames,
              buttonColor: data.buttonColor
            },
            $setOnInsert: { username: data.username }
          },
          { upsert: true }
        )
          .then(() => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, message: 'Saved' }));
          })
          .catch(err => {
            console.error('Database error:', err);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Database error' }));
          });
      } catch (err) {
        console.error('JSON parse error:', err);
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON' }));
      }
    });
    return;
  }

  // ---- API: Check spin cooldown ----
  if (pathname === '/api/spin-check' && req.method === 'GET') {
    const username = parsedUrl.query.username;
    if (!username || typeof username !== 'string' || username.length > 50) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid username' }));
      return;
    }
    users.findOne({ username })
      .then(user => {
        const now = Date.now();
        const cooldown = 10 * 60 * 1000;
        
        if (!user || !user.lastSpinTime) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ canSpin: true, remainingMs: 0 }));
          return;
        }
        
        const elapsed = now - user.lastSpinTime;
        const canSpin = elapsed >= cooldown;
        const remainingMs = canSpin ? 0 : cooldown - elapsed;
        
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ canSpin, remainingMs }));
      })
      .catch(err => {
        console.error('Database error:', err);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Database error' }));
      });
    return;
  }

  // ---- API: Record spin (atomic) ----
  if (pathname === '/api/spin' && req.method === 'POST') {
    let body = '';
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BODY_SIZE) {
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Payload too large' }));
        req.destroy();
        return;
      }
      body += chunk;
    });
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        if (!data.username || typeof data.username !== 'string' || data.username.length > 50) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid username' }));
          return;
        }
        
        const now = Date.now();
        const cooldown = 10 * 60 * 1000;
        
        // First check if user exists and has active cooldown
        users.findOne({ username: data.username })
          .then(existingUser => {
            if (existingUser && existingUser.lastSpinTime) {
              const elapsed = now - existingUser.lastSpinTime;
              if (elapsed < cooldown) {
                console.log('Cooldown active for', data.username, 'remaining:', cooldown - elapsed);
                res.writeHead(429, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Cooldown active' }));
                return;
              }
            }
            
            // Cooldown OK or no previous spin - set timestamp
            return users.updateOne(
              { username: data.username },
              { $set: { lastSpinTime: now, username: data.username } },
              { upsert: true }
            ).then(() => {
              console.log('Spin accepted for', data.username, 'at', now);
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ success: true, spinTime: now }));
            });
          })
          .catch(err => {
            console.error('Database error:', err);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Database error' }));
          });
      } catch (err) {
        console.error('JSON parse error:', err);
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON' }));
      }
    });
    return;
  }

  // ---- Static files ----
  const safePath = pathname === '/' ? 'index.html' : pathname;
  const filePath = path.join(__dirname, safePath);
  
  // Prevent directory traversal
  if (!filePath.startsWith(__dirname)) {
    res.writeHead(403);
    res.end('403 Forbidden');
    return;
  }
  
  const ext = path.extname(filePath);

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('404 Not Found');
      return;
    }
    res.writeHead(200, { 'Content-Type': contentTypes[ext] || 'text/plain' });
    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
