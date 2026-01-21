const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');
const { MongoClient } = require('mongodb');

const PORT = process.env.PORT || 3000;
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/gamespin';

let db;
let users;

// Connect to MongoDB
MongoClient.connect(MONGODB_URI, {
  serverSelectionTimeoutMS: 5000,
  socketTimeoutMS: 45000,
  ssl: true,
  sslValidate: false
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
    res.writeHead(503);
    res.end('Database not ready');
    return;
  }

  // ---- API: Get user ----
  if (pathname === '/api/user' && req.method === 'GET') {
    const username = parsedUrl.query.username;
    users.findOne({ username })
      .then(user => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(user || {}));
      })
      .catch(err => {
        res.writeHead(500);
        res.end('Database error');
      });
    return;
  }

  // ---- API: Save user ----
  if (pathname === '/api/user' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        if (!data.username) {
          res.writeHead(400);
          res.end('Missing username');
          return;
        }
        users.replaceOne({ username: data.username }, data, { upsert: true })
          .then(() => {
            res.writeHead(200);
            res.end('Saved');
          })
          .catch(err => {
            res.writeHead(500);
            res.end('Database error');
          });
      } catch {
        res.writeHead(400);
        res.end('Invalid JSON');
      }
    });
    return;
  }

  // ---- API: Check spin cooldown ----
  if (pathname === '/api/spin-check' && req.method === 'GET') {
    const username = parsedUrl.query.username;
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
        res.writeHead(500);
        res.end('Database error');
      });
    return;
  }

  // ---- API: Record spin ----
  if (pathname === '/api/spin' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        if (!data.username) {
          res.writeHead(400);
          res.end('Missing username');
          return;
        }
        
        users.findOne({ username: data.username })
          .then(user => {
            const now = Date.now();
            const cooldown = 10 * 60 * 1000;
            
            if (user && user.lastSpinTime && (now - user.lastSpinTime) < cooldown) {
              res.writeHead(429, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'Cooldown active', remainingMs: cooldown - (now - user.lastSpinTime) }));
              return;
            }
            
            return users.updateOne(
              { username: data.username },
              { $set: { lastSpinTime: now } },
              { upsert: true }
            );
          })
          .then(() => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true }));
          })
          .catch(err => {
            res.writeHead(500);
            res.end('Database error');
          });
      } catch {
        res.writeHead(400);
        res.end('Invalid JSON');
      }
    });
    return;
  }

  // ---- Static files ----
  let filePath = path.join(__dirname, pathname === '/' ? 'index.html' : pathname);
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
