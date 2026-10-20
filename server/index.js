import express from "express";
import { createServer } from "node:http";
import { randomUUID, randomInt } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Server } from "socket.io";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3001;
const CLIENT_ORIGINS = (process.env.CLIENT_ORIGIN ||
  "http://localhost:5173,http://127.0.0.1:5173")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

const PUBLIC_ROOM = "public";
const MAX_NICKNAME_LENGTH = 16;
const MIN_NICKNAME_LENGTH = 2;
const MAX_MESSAGE_LENGTH = 500;
const MAX_PRIVATE_MEMBERS = 10;
const MAX_PRIVATE_ROOMS = 500;
const PRIVATE_ROOM_TTL_MS = 2 * 60 * 60 * 1000;
const WAITING_TIMEOUT_MS = 5 * 60 * 1000;
const RATE_LIMIT_WINDOW_MS = 5000;
const RATE_LIMIT_MAX_MESSAGES = 8;
const ROOM_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

// All state lives in memory and disappears when the process stops.
const users = new Map(); // socket id -> { id, nickname, roomKey, recent }
const rooms = new Map(); // "private:CODE" or "random:ID" -> room
const waiting = []; // [{ id, since }] – ordered queue of strangers

const app = express();
app.disable("x-powered-by");

const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: { origin: CLIENT_ORIGINS },
  maxHttpBufferSize: 100_000,
  pingInterval: 20_000,
  pingTimeout: 20_000,
});

const reply = (ack, payload) => {
  if (typeof ack === "function") ack(payload);
};
const ok = (data = {}) => ({ ok: true, ...data });
const fail = (error) => ({ ok: false, error });

function sanitizeNickname(value) {
  if (typeof value !== "string") return null;
  const nickname = value.trim().replace(/\s+/g, " ");
  const length = [...nickname].length;
  if (length < MIN_NICKNAME_LENGTH || length > MAX_NICKNAME_LENGTH) return null;
  if (!/^[\p{L}\p{N}][\p{L}\p{N} ._'-]*$/u.test(nickname)) return null;
  return nickname;
}

function sanitizeMessage(value) {
  if (typeof value !== "string") return null;
  const text = value
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .trim();
  if (!text) return null;
  if ([...text].length > MAX_MESSAGE_LENGTH) return null;
  return text;
}

function isRateLimited(socketId) {
  const now = Date.now();
  const user = users.get(socketId);
  if (!user) return true;
  user.recent = user.recent.filter((time) => now - time < RATE_LIMIT_WINDOW_MS);
  if (user.recent.length >= RATE_LIMIT_MAX_MESSAGES) return true;
  user.recent.push(now);
  return false;
}

function generateRoomCode() {
  let code = "";
  for (let i = 0; i < 6; i += 1) {
    code += ROOM_CODE_ALPHABET[randomInt(ROOM_CODE_ALPHABET.length)];
  }
  return code;
}

function publicOnlineCount() {
  return io.sockets.adapter.rooms.get(PUBLIC_ROOM)?.size ?? 0;
}

function emitPresence(roomKey) {
  if (roomKey === PUBLIC_ROOM) {
    io.to(PUBLIC_ROOM).emit("presence", { count: publicOnlineCount() });
    return;
  }
  const room = rooms.get(roomKey);
  if (room) io.to(roomKey).emit("presence", { count: room.members.size });
}

function leaveWaiting(socketId) {
  const index = waiting.findIndex((entry) => entry.id === socketId);
  if (index !== -1) waiting.splice(index, 1);
}

/**
 * Removes a user from their current room. For random chats the partner is
 * notified, and both sides are detached from the shared room.
 */
function leaveRoom(socket, reason = "leave") {
  const user = users.get(socket.id);
  if (!user?.roomKey) return;

  const key = user.roomKey;
  const wasPublic = key === PUBLIC_ROOM;
  user.roomKey = null;
  socket.leave(key);

  if (wasPublic) {
    socket.to(PUBLIC_ROOM).emit("notice", {
      text: `${user.nickname} left the chat.`,
    });
    emitPresence(PUBLIC_ROOM);
    return;
  }

  const room = rooms.get(key);
  if (!room) return;

  if (room.type === "random") {
    rooms.delete(key);
    const partnerId = [...room.members].find((id) => id !== socket.id);
    if (partnerId) {
      const partnerUser = users.get(partnerId);
      const partnerSocket = io.sockets.sockets.get(partnerId);
      if (partnerUser) partnerUser.roomKey = null;
      if (partnerSocket) {
        partnerSocket.leave(key);
        partnerSocket.emit("random:partner-left", {
          message:
            reason === "disconnect"
              ? "Your partner disconnected."
              : reason === "next"
                ? "Your partner moved on to the next stranger."
                : "Your partner left the chat.",
        });
      }
    }
    return;
  }

  room.members.delete(socket.id);
  if (room.members.size === 0) {
    rooms.delete(key);
    return;
  }
  io.to(key).emit("notice", { text: `${user.nickname} left the room.` });
  emitPresence(key);
}

function joinPublicRoom(socket) {
  const user = users.get(socket.id);
  if (!user) return null;
  leaveRoom(socket);
  leaveWaiting(socket.id);
  user.roomKey = PUBLIC_ROOM;
  socket.join(PUBLIC_ROOM);
  io.to(PUBLIC_ROOM).emit("notice", {
    text: `${user.nickname} joined the chat.`,
  });
  emitPresence(PUBLIC_ROOM);
  return publicOnlineCount();
}

function addToPrivateRoom(socket, room) {
  const user = users.get(socket.id);
  user.roomKey = room.key;
  socket.join(room.key);
  room.members.add(socket.id);
  room.lastActive = Date.now();
  socket.to(room.key).emit("notice", {
    text: `${user.nickname} joined the room.`,
  });
  emitPresence(room.key);
  return room.members.size;
}

function createPrivateRoom(socket) {
  if (rooms.size >= MAX_PRIVATE_ROOMS) return null;
  const user = users.get(socket.id);
  if (!user) return null;
  leaveRoom(socket);
  leaveWaiting(socket.id);

  let code = generateRoomCode();
  while (rooms.has(`private:${code}`)) code = generateRoomCode();

  const room = {
    key: `private:${code}`,
    type: "private",
    code,
    members: new Set(),
    createdAt: Date.now(),
    lastActive: Date.now(),
  };
  rooms.set(room.key, room);
  addToPrivateRoom(socket, room);
  return room;
}

function findStranger(socket) {
  const user = users.get(socket.id);
  if (!user) return { ok: false };

  if (user.roomKey) leaveRoom(socket, "next");
  leaveWaiting(socket.id);

  const now = Date.now();
  for (let i = waiting.length - 1; i >= 0; i -= 1) {
    const entry = waiting[i];
    if (
      !users.has(entry.id) ||
      !io.sockets.sockets.has(entry.id) ||
      now - entry.since > WAITING_TIMEOUT_MS
    ) {
      waiting.splice(i, 1);
      const staleSocket = io.sockets.sockets.get(entry.id);
      if (staleSocket) {
        staleSocket.emit("random:timeout", {
          message: "No one showed up in time. Try again whenever you like.",
        });
      }
    }
  }

  const index = waiting.findIndex((entry) => entry.id !== socket.id);
  if (index === -1) {
    waiting.push({ id: socket.id, since: Date.now() });
    socket.emit("random:waiting");
    return { status: "waiting" };
  }

  const [entry] = waiting.splice(index, 1);
  const partnerSocket = io.sockets.sockets.get(entry.id);
  const partnerUser = users.get(entry.id);
  if (!partnerSocket || !partnerUser) {
    waiting.push({ id: socket.id, since: Date.now() });
    socket.emit("random:waiting");
    return { status: "waiting" };
  }

  const room = {
    key: `random:${randomUUID()}`,
    type: "random",
    code: null,
    members: new Set([socket.id, partnerSocket.id]),
    createdAt: Date.now(),
    lastActive: Date.now(),
  };
  rooms.set(room.key, room);
  user.roomKey = room.key;
  partnerUser.roomKey = room.key;
  socket.join(room.key);
  partnerSocket.join(room.key);

  socket.emit("random:matched", { partner: partnerUser.nickname });
  partnerSocket.emit("random:matched", { partner: user.nickname });
  return { status: "matched", partner: partnerUser.nickname };
}

io.on("connection", (socket) => {
  socket.on("join", (payload, ack) => {
    const nickname = sanitizeNickname(payload?.nickname);
    if (!nickname) {
      return reply(
        ack,
        fail(
          `Nickname must be ${MIN_NICKNAME_LENGTH}–${MAX_NICKNAME_LENGTH} characters using letters, numbers, spaces, . _ - or '.`
        )
      );
    }

    const existing = users.get(socket.id);
    if (existing?.roomKey) leaveRoom(socket);
    leaveWaiting(socket.id);

    users.set(socket.id, {
      id: socket.id,
      nickname,
      roomKey: null,
      recent: [],
      joinedAt: Date.now(),
    });
    return reply(ack, ok({ nickname }));
  });

  socket.on("room:public", (_payload, ack) => {
    if (!users.has(socket.id)) return reply(ack, fail("Pick a nickname first."));
    const count = joinPublicRoom(socket);
    return reply(ack, ok({ count }));
  });

  socket.on("room:create", (_payload, ack) => {
    if (!users.has(socket.id)) return reply(ack, fail("Pick a nickname first."));
    const room = createPrivateRoom(socket);
    if (!room) {
      return reply(ack, fail("Too many rooms are open right now. Try again later."));
    }
    return reply(ack, ok({ code: room.code, count: room.members.size }));
  });

  socket.on("room:join", (payload, ack) => {
    const user = users.get(socket.id);
    if (!user) return reply(ack, fail("Pick a nickname first."));

    const code =
      typeof payload?.code === "string"
        ? payload.code.trim().toUpperCase()
        : "";
    if (!/^[A-Z0-9]{6}$/.test(code)) {
      return reply(ack, fail("Enter a valid 6-character room code."));
    }

    const room = rooms.get(`private:${code}`);
    if (!room) {
      return reply(ack, fail("Room not found. Check the code and try again."));
    }
    if (!room.members.has(socket.id) && room.members.size >= MAX_PRIVATE_MEMBERS) {
      return reply(ack, fail("This room is full."));
    }

    leaveRoom(socket);
    leaveWaiting(socket.id);
    const count = addToPrivateRoom(socket, room);
    return reply(ack, ok({ code: room.code, count }));
  });

  socket.on("room:leave", (_payload, ack) => {
    leaveRoom(socket);
    leaveWaiting(socket.id);
    return reply(ack, ok());
  });

  socket.on("message:send", (payload, ack) => {
    const user = users.get(socket.id);
    if (!user?.roomKey) return reply(ack, fail("Join a room first."));

    const text = sanitizeMessage(payload?.text);
    if (!text) {
      return reply(
        ack,
        fail(`Messages must be 1–${MAX_MESSAGE_LENGTH} characters.`)
      );
    }
    if (isRateLimited(socket.id)) {
      return reply(ack, fail("You are sending messages too quickly. Slow down."));
    }

    if (
      user.roomKey !== PUBLIC_ROOM &&
      !rooms.get(user.roomKey)?.members.has(socket.id)
    ) {
      return reply(ack, fail("You are not a member of this room."));
    }

    const room = rooms.get(user.roomKey);
    if (room) room.lastActive = Date.now();

    const message = {
      id: randomUUID(),
      from: user.nickname,
      fromId: user.id,
      text,
      ts: Date.now(),
    };
    io.to(user.roomKey).emit("message", message);
    return reply(ack, ok({ id: message.id }));
  });

  socket.on("random:find", (_payload, ack) => {
    if (!users.has(socket.id)) return reply(ack, fail("Pick a nickname first."));
    return reply(ack, ok(findStranger(socket)));
  });

  socket.on("random:next", (_payload, ack) => {
    if (!users.has(socket.id)) return reply(ack, fail("Pick a nickname first."));
    return reply(ack, ok(findStranger(socket)));
  });

  socket.on("random:leave", (_payload, ack) => {
    leaveWaiting(socket.id);
    leaveRoom(socket);
    return reply(ack, ok());
  });

  socket.on("disconnect", () => {
    leaveWaiting(socket.id);
    leaveRoom(socket, "disconnect");
    const user = users.get(socket.id);
    users.delete(socket.id);
    if (user) emitPresence(PUBLIC_ROOM);
  });
});

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    users: users.size,
    rooms: rooms.size,
    waiting: waiting.length,
  });
});

// Serve the built client when it exists so `npm run build && npm start`
// runs the whole app from one server.
const clientDist = path.join(__dirname, "..", "client", "dist");
if (existsSync(path.join(clientDist, "index.html"))) {
  app.use(express.static(clientDist));
  app.get("*", (_req, res) => {
    res.sendFile(path.join(clientDist, "index.html"));
  });
}

// Drop empty rooms, idle private rooms, and expired waiters.
setInterval(() => {
  const now = Date.now();
  for (const [key, room] of rooms) {
    if (room.type !== "private") continue;
    const stale = now - room.lastActive > PRIVATE_ROOM_TTL_MS;
    if (room.members.size > 0 && !stale) continue;

    for (const memberId of room.members) {
      const memberSocket = io.sockets.sockets.get(memberId);
      if (memberSocket) {
        memberSocket.leave(key);
        memberSocket.emit("room:closed", {
          message: "That room was closed after being idle.",
        });
      }
      const member = users.get(memberId);
      if (member) member.roomKey = null;
    }
    rooms.delete(key);
  }

  for (let i = waiting.length - 1; i >= 0; i -= 1) {
    const entry = waiting[i];
    const expired = now - entry.since > WAITING_TIMEOUT_MS;
    const gone = !io.sockets.sockets.has(entry.id);
    if (expired || gone) {
      waiting.splice(i, 1);
      if (expired) {
        const waitingSocket = io.sockets.sockets.get(entry.id);
        waitingSocket?.emit("random:timeout", {
          message: "No one showed up in time. Try again whenever you like.",
        });
      }
    }
  }
}, 60_000).unref();

httpServer.listen(PORT, () => {
  console.log(`Chat server listening on http://localhost:${PORT}`);
});
