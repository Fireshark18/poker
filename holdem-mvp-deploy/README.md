# Hold'em MVP (Texas Hold'em with room codes)

This is a **minimal** Texas Hold'em web app you can play with friends:

- Host clicks **Create lobby** → gets a **room code**
- Friends enter **name + room code** → join the lobby
- Host clicks **Start game**
- Real-time gameplay via **WebSockets (Socket.IO)**

> This is an MVP for learning / playing with friends. It is *not* production-hardened and it assumes **play-money**.

## Run locally

1. Install Node.js (v18+)
2. In this folder:

```bash
npm install
npm run start
```

3. Open: http://localhost:3000

### Test with friends quickly

- Same Wi‑Fi: use your computer's LAN IP (e.g. `http://192.168.1.20:3000`)
- Different networks: use a tunnel like **ngrok** (or Cloudflare Tunnel)

## Deploy

Because this uses WebSockets, deploy it as a **persistent Node server** (not serverless-only).

Good beginner-friendly hosts:
- Render (Web Service)
- Fly.io (Docker or Node app)

You can host the *frontend* anywhere static, but the Socket.IO server must run where WebSockets are supported.

## Notes / limitations (MVP)

- Joining is only supported while the room is in the lobby
- "Odd chip" split is simplified (extra chip goes to first winner)
- No account system / reconnection flow
- No anti-cheat (beyond server-side turn validation)


## Deploy as a real website (no one needs to run it locally)

Because this game uses WebSockets (Socket.IO), you need a **persistent server** host.

### Option 1: Render (easy, has a free tier)
Render supports inbound WebSocket connections for web services. See their docs:
https://render.com/docs/websocket

1) Put this repo on GitHub
2) In Render: New → **Blueprint** (or Web Service) → connect the repo
3) If using Blueprint, this repo includes `render.yaml`
4) Build command: `npm install`
5) Start command: `npm start`

> Note: Render free web services can spin down after inactivity; when they spin back up, existing WebSocket connections will drop.

### Option 2: Railway (easy, usually always-on but can cost a little)
Railway supports WebSockets over HTTP/1.1 (see their public networking docs):
https://docs.railway.com/reference/public-networking

1) Put this repo on GitHub
2) In Railway: New Project → Deploy from GitHub
3) Railway will detect Node and run `npm start`

### Option 3: Fly.io (best “game server” vibe, more setup)
This repo includes a Dockerfile. You can deploy as a single small VM close to players.
