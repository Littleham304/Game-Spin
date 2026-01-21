# Database Setup Instructions

## MongoDB Atlas (Free Tier)

1. Go to https://www.mongodb.com/atlas
2. Create a free account
3. Create a new cluster (select free tier M0)
4. Create a database user with read/write permissions
5. Add your IP to the whitelist (or use 0.0.0.0/0 for all IPs)
6. Get your connection string from "Connect" > "Connect your application"

## Environment Variable

Set the MONGODB_URI environment variable:

**Local development:**
```
MONGODB_URI=mongodb+srv://username:password@cluster.mongodb.net/gamespin
```

**Render deployment:**
1. Go to your Render dashboard
2. Select your service
3. Go to Environment tab
4. Add: `MONGODB_URI` = `mongodb+srv://username:password@cluster.mongodb.net/gamespin`

Replace `username`, `password`, and `cluster` with your actual values.

## Install Dependencies

Run: `npm install`

The server will now use persistent MongoDB storage instead of in-memory storage.