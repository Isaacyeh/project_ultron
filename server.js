const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" }
});

const PORT = process.env.PORT || 3000;

// Serve static files from /public
app.use(express.static(path.join(__dirname, "public")));

// ─── Game State ───────────────────────────────────────────────────────────────
const SPAWN = { x: 0, y: 0, z: 0 };

const players = {}; // socketId → playerState

function createPlayer(id) {
  return {
    id,
    position: { ...SPAWN },
    rotation: 0,       // Y-axis rotation in radians
    animation: "Idle",
    health: 100,
    name: `Player_${id.slice(0, 4)}`
  };
}

// ─── Socket Events ────────────────────────────────────────────────────────────
io.on("connection", (socket) => {
  console.log(`[+] Player connected: ${socket.id}`);

  // Create and register new player
  const player = createPlayer(socket.id);
  players[socket.id] = player;

  // Send this player their own state + all existing players
  socket.emit("init", {
    self: player,
    players: Object.values(players).filter(p => p.id !== socket.id)
  });

  // Broadcast new player to everyone else
  socket.broadcast.emit("playerJoined", player);

  // ── Movement / State Update ──────────────────────────────────────────────
  socket.on("playerUpdate", (data) => {
    const p = players[socket.id];
    if (!p) return;

    // Sanitize & clamp
    p.position.x = typeof data.position?.x === "number" ? data.position.x : p.position.x;
    p.position.y = typeof data.position?.y === "number" ? data.position.y : p.position.y;
    p.position.z = typeof data.position?.z === "number" ? data.position.z : p.position.z;
    p.rotation   = typeof data.rotation   === "number" ? data.rotation   : p.rotation;
    p.animation  = typeof data.animation  === "string" ? data.animation  : p.animation;

    // Broadcast to all OTHER players
    socket.broadcast.emit("playerUpdated", {
      id: socket.id,
      position: p.position,
      rotation: p.rotation,
      animation: p.animation
    });
  });

  // ── Chat ─────────────────────────────────────────────────────────────────
  socket.on("chat", (msg) => {
    const p = players[socket.id];
    if (!p) return;
    const payload = {
      id: socket.id,
      name: p.name,
      message: String(msg).slice(0, 200)
    };
    io.emit("chat", payload);
  });

  // ── Disconnect ────────────────────────────────────────────────────────────
  socket.on("disconnect", () => {
    console.log(`[-] Player disconnected: ${socket.id}`);
    delete players[socket.id];
    io.emit("playerLeft", socket.id);
  });
});

// ─── Server Tick (broadcast authoritative state every 100ms) ─────────────────
setInterval(() => {
  if (Object.keys(players).length > 0) {
    io.emit("worldState", { players: Object.values(players) });
  }
}, 100);

server.listen(PORT, () => {
  console.log(`Game server running at http://localhost:${PORT}`);
});