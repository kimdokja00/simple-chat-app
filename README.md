# Chatter

A minimal real-time chat app with:

- **Public chat** — one shared room for everyone online.
- **Private rooms** — create a room, share its 6-character code; only members can read it.
- **Random chat** — match one-on-one with a waiting stranger, with **Next** and **Disconnect**.
- **Temporary by design** — no accounts, no database, no browser storage. Everything is kept in server memory and disappears on restart.

Built with React + Vite on the frontend and Node.js + Express + Socket.IO on the backend.

## Requirements

Node.js 18 or newer and npm.

## Run locally

```bash
npm install
```

Then start the two processes in separate terminals:

```bash
# terminal 1 — backend on http://localhost:3001
npm run dev:server

# terminal 2 — frontend on http://localhost:5173
npm run dev:client
```

Open **http://localhost:5173** in two browser windows to test real-time delivery. The Vite dev server proxies `/socket.io` to the backend.

## Production-style run (single server)

```bash
npm run build
npm start
```

Open **http://localhost:3001**. When `client/dist` exists, Express serves the built frontend alongside Socket.IO.

## Tests

```bash
npm test
```

The smoke test starts a throwaway server, connects several independent Socket.IO clients, and checks public delivery, private-room isolation, invalid room codes, random matching, **Next**, **Disconnect**, nickname/message validation, rate limiting, and cleanup after disconnects.

## Configuration

| Variable        | Default                                             | Purpose                               |
| --------------- | --------------------------------------------------- | ------------------------------------- |
| `PORT`          | `3001`                                              | Backend HTTP/Socket.IO port           |
| `CLIENT_ORIGIN` | `http://localhost:5173,http://127.0.0.1:5173`       | Comma-separated allowed CORS origins  |

Example: `PORT=8080 CLIENT_ORIGIN=https://chat.example.com npm start`.

## Limits and behavior

- Nicknames: 2–16 characters, letters/numbers/spaces and `. _ - '`.
- Messages: 1–500 characters, trimmed, rendered strictly as text.
- Rate limit: 8 messages per 5 seconds per connection.
- Private rooms: up to 10 members and 500 concurrent rooms.
- Empty rooms are deleted immediately; private rooms idle for 2 hours are closed. Waiters time out after 5 minutes.
- A user is in exactly one room at a time (public, private, or random).
- Reconnecting creates a new in-memory session and returns you to the lobby.

## Project structure

```
.
├── client/                 React + Vite frontend
│   ├── src/App.jsx         Socket.IO wiring and all four views
│   ├── src/index.css       Minimal responsive styles
│   └── vite.config.js      Dev proxy to the backend
├── server/
│   └── index.js            Express, Socket.IO, validation, in-memory state
├── test/smoke.mjs          End-to-end protocol smoke test
└── package.json            npm workspaces + root scripts
```

## Notes

This is intentionally small and built for friendly, temporary conversations. It has no authentication or moderation, and all state is held by one Node process — restarting the server clears messages and rooms. Do not run it as an internet-facing service without adding the operational and security features you need.
