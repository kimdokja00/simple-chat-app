import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { io } from "socket.io-client";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = Number(process.env.TEST_PORT) || 3101;
const URL = `http://localhost:${PORT}`;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const server = spawn(
  process.execPath,
  [path.join(root, "server", "index.js")],
  {
    cwd: root,
    env: { ...process.env, PORT: String(PORT), CLIENT_ORIGIN: URL },
    stdio: ["ignore", "pipe", "pipe"],
  }
);

let serverLog = "";
server.stdout.on("data", (chunk) => {
  serverLog += chunk.toString();
});
server.stderr.on("data", (chunk) => {
  serverLog += chunk.toString();
});

const clients = [];

async function waitForServer() {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const response = await fetch(`${URL}/health`);
      if (response.ok) return;
    } catch {
      // Server is still starting.
    }
    await delay(100);
  }
  throw new Error(`Server did not start.\n${serverLog}`);
}

async function connectClient(name) {
  const socket = io(URL, {
    transports: ["websocket"],
    reconnection: false,
    timeout: 3000,
  });
  const client = {
    name,
    socket,
    messages: [],
    events: [],
  };
  socket.on("message", (message) => client.messages.push(message));
  socket.on("random:matched", (payload) =>
    client.events.push({ type: "matched", ...payload })
  );
  socket.on("random:waiting", () =>
    client.events.push({ type: "waiting" })
  );
  socket.on("random:partner-left", (payload) =>
    client.events.push({ type: "partner-left", ...payload })
  );
  socket.on("random:timeout", (payload) =>
    client.events.push({ type: "timeout", ...payload })
  );
  socket.on("presence", (payload) =>
    client.events.push({ type: "presence", ...payload })
  );
  await new Promise((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("connect_error", reject);
  });
  clients.push(client);
  return client;
}

function emitAck(client, event, payload = {}) {
  return new Promise((resolve, reject) => {
    client.socket.timeout(3000).emit(event, payload, (error, response) => {
      if (error) {
        reject(new Error(`${client.name}: no ack for "${event}"`));
      } else {
        resolve(response);
      }
    });
  });
}

async function waitUntil(check, description, timeout = 2500) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (await check()) return;
    await delay(25);
  }
  throw new Error(`Timed out waiting for ${description}`);
}

function sawMessage(client, text) {
  return client.messages.some((message) => message.text === text);
}

async function health() {
  const response = await fetch(`${URL}/health`);
  return response.json();
}

async function run() {
  await waitForServer();

  const alice = await connectClient("alice");
  const bob = await connectClient("bob");
  const eve = await connectClient("eve");

  console.log("• nickname and message validation");
  const shortName = await emitAck(alice, "join", { nickname: "a" });
  assert.equal(shortName.ok, false);
  const badName = await emitAck(alice, "join", { nickname: "<script>" });
  assert.equal(badName.ok, false);
  const beforeJoin = await emitAck(alice, "message:send", { text: "hi" });
  assert.equal(beforeJoin.ok, false);
  const joined = await emitAck(alice, "join", { nickname: "alice" });
  assert.equal(joined.ok, true);
  assert.equal(joined.nickname, "alice");
  assert.equal((await emitAck(bob, "join", { nickname: "bob" })).ok, true);
  assert.equal((await emitAck(eve, "join", { nickname: "eve" })).ok, true);

  console.log("• public chat delivers to everyone in the room");
  const alicePublic = await emitAck(alice, "room:public");
  assert.equal(alicePublic.ok, true);
  assert.equal(alicePublic.count, 1);
  const bobPublic = await emitAck(bob, "room:public");
  assert.equal(bobPublic.count, 2);
  await emitAck(eve, "room:public");

  const publicSend = await emitAck(alice, "message:send", {
    text: "hello public",
  });
  assert.equal(publicSend.ok, true);
  await waitUntil(
    () => sawMessage(bob, "hello public") && sawMessage(eve, "hello public"),
    "both public members to receive the message"
  );
  const delivered = bob.messages.find((m) => m.text === "hello public");
  assert.equal(delivered.from, "alice");
  assert.ok(delivered.fromId);

  console.log("• private rooms are isolated and require the code");
  const carol = await connectClient("carol");
  const dave = await connectClient("dave");
  assert.equal((await emitAck(carol, "join", { nickname: "carol" })).ok, true);
  assert.equal((await emitAck(dave, "join", { nickname: "dave" })).ok, true);

  const created = await emitAck(carol, "room:create");
  assert.equal(created.ok, true);
  assert.match(created.code, /^[A-Z0-9]{6}$/);
  const roomCode = created.code;

  const wrongCode = await emitAck(dave, "room:join", { code: "ZZZZZZ" });
  assert.equal(wrongCode.ok, false);
  const joinedRoom = await emitAck(dave, "room:join", {
    code: roomCode.toLowerCase(),
  });
  assert.equal(joinedRoom.ok, true);
  assert.equal(joinedRoom.code, roomCode);
  assert.equal(joinedRoom.count, 2);

  await emitAck(carol, "message:send", { text: "private hello" });
  await waitUntil(
    () => sawMessage(dave, "private hello"),
    "the second private room member to receive the message"
  );
  await emitAck(alice, "message:send", { text: "public again" });
  await waitUntil(
    () => sawMessage(bob, "public again"),
    "public members to receive the second public message"
  );
  await delay(150);
  assert.equal(sawMessage(carol, "public again"), false);
  assert.equal(sawMessage(dave, "public again"), false);
  assert.equal(sawMessage(alice, "private hello"), false);
  assert.equal(sawMessage(bob, "private hello"), false);

  console.log("• random chat matches a waiting stranger");
  const aliceFind = await emitAck(alice, "random:find");
  assert.equal(aliceFind.status, "waiting");
  await waitUntil(
    () => alice.events.some((event) => event.type === "waiting"),
    "alice to enter the waiting queue"
  );

  const bobFind = await emitAck(bob, "random:find");
  assert.equal(bobFind.status, "matched");
  assert.equal(bobFind.partner, "alice");
  await waitUntil(
    () =>
      alice.events.some((event) => event.type === "matched") &&
      bob.events.some((event) => event.type === "matched"),
    "both strangers to be matched"
  );
  const aliceMatch = alice.events.find((event) => event.type === "matched");
  const bobMatch = bob.events.find((event) => event.type === "matched");
  assert.equal(aliceMatch.partner, "bob");
  assert.equal(bobMatch.partner, "alice");

  await emitAck(alice, "message:send", { text: "hi stranger" });
  await waitUntil(
    () => sawMessage(bob, "hi stranger"),
    "bob to receive the random chat message"
  );
  await delay(150);
  assert.equal(sawMessage(eve, "hi stranger"), false);

  console.log("• Next re-queues the user and notifies the partner");
  const beforeNext = bob.events.length;
  await emitAck(bob, "random:next");
  await waitUntil(
    () =>
      bob.events
        .slice(beforeNext)
        .some((event) => event.type === "waiting"),
    "bob to be waiting again"
  );
  await waitUntil(
    () => alice.events.some((event) => event.type === "partner-left"),
    "alice to be told the partner left"
  );

  const eveFind = await emitAck(eve, "random:find");
  assert.equal(eveFind.status, "matched");
  assert.equal(eveFind.partner, "bob");
  await emitAck(eve, "message:send", { text: "hey bob" });
  await waitUntil(
    () => sawMessage(bob, "hey bob"),
    "bob to receive the new random partner's message"
  );

  console.log("• Disconnect ends random chat and notifies the partner");
  await emitAck(eve, "random:leave");
  await waitUntil(
    () =>
      bob.events
        .slice(beforeNext)
        .filter((event) => event.type === "partner-left").length >= 1,
    "bob to be notified about the second partner leaving"
  );

  console.log("• messages are length-limited and rate-limited");
  const tooLong = await emitAck(carol, "message:send", {
    text: "x".repeat(501),
  });
  assert.equal(tooLong.ok, false);
  const empty = await emitAck(carol, "message:send", { text: "   " });
  assert.equal(empty.ok, false);

  const frank = await connectClient("frank");
  assert.equal((await emitAck(frank, "join", { nickname: "frank" })).ok, true);
  assert.equal((await emitAck(frank, "room:public")).ok, true);
  let accepted = 0;
  let rejected = 0;
  for (let index = 0; index < 10; index += 1) {
    const response = await emitAck(frank, "message:send", {
      text: `burst ${index}`,
    });
    if (response.ok) accepted += 1;
    else {
      rejected += 1;
      assert.match(response.error, /quickly/i);
    }
  }
  assert.equal(accepted, 8);
  assert.equal(rejected, 2);

  console.log("• disconnects clean up users, rooms, and the wait queue");
  for (const client of clients) client.socket.disconnect();
  await waitUntil(async () => {
    const state = await health();
    return state.users === 0 && state.rooms === 0 && state.waiting === 0;
  }, "server state to be empty after disconnects");

  console.log("\nAll smoke tests passed.");
}

try {
  await run();
} catch (error) {
  console.error(`\nSmoke test failed: ${error.message}`);
  if (serverLog) console.error(`\nServer output:\n${serverLog}`);
  process.exitCode = 1;
} finally {
  for (const client of clients) client.socket.disconnect();
  server.kill();
  await delay(200);
}
