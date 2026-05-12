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

const DEFAULT_COLLISION = { radius: 0.6, height: 1.8 };

function sanitizeCollision(collision) {
  const radius = Number(collision?.radius);
  const height = Number(collision?.height);

  return {
    radius: Number.isFinite(radius) && radius > 0 ? radius : DEFAULT_COLLISION.radius,
    height: Number.isFinite(height) && height > 0 ? height : DEFAULT_COLLISION.height
  };
}

function attachCollision(state, collision) {
  state.collision = sanitizeCollision(collision || state.collision);
  return state;
}

function bumpCorrectionVersion(player) {
  player.correctionVersion = (player.correctionVersion ?? 0) + 1;
}

function getHeight(player) {
  return Math.max(0.1, player.collision?.height ?? DEFAULT_COLLISION.height);
}

function getRadius(player) {
  return Math.max(0.1, player.collision?.radius ?? DEFAULT_COLLISION.radius);
}

function resolvePlayerSeparation(playersMap) {
  const list = Object.values(playersMap);
  if (list.length < 2) return;

  const iterations = 3;
  const epsilon = 1e-5;

  for (let iteration = 0; iteration < iterations; iteration++) {
    let moved = false;

    for (let i = 0; i < list.length; i++) {
      const a = list[i];
      if (!a?.position) continue;

      const aRadius = getRadius(a);
      const aHeight = getHeight(a);

      for (let j = i + 1; j < list.length; j++) {
        const b = list[j];
        if (!b?.position) continue;

        const bRadius = getRadius(b);
        const bHeight = getHeight(b);

        const verticalOverlap = Math.min(a.position.y + aHeight, b.position.y + bHeight) -
          Math.max(a.position.y, b.position.y);
        if (verticalOverlap <= 0) continue;

        let dx = b.position.x - a.position.x;
        let dz = b.position.z - a.position.z;
        let dist = Math.hypot(dx, dz);
        const minDist = aRadius + bRadius;

        if (dist >= minDist) continue;

        if (dist < epsilon) {
          dx = a.id < b.id ? -1 : 1;
          dz = 0;
          dist = 1;
        }

        const overlap = minDist - dist;
        const nx = dx / dist;
        const nz = dz / dist;
        const push = overlap * 0.5;

        a.position.x -= nx * push;
        a.position.z -= nz * push;
        b.position.x += nx * push;
        b.position.z += nz * push;
        bumpCorrectionVersion(a);
        bumpCorrectionVersion(b);
        moved = true;
      }
    }

    if (!moved) break;
  }
}

function emitWorldState() {
  io.emit("worldState", { players: Object.values(players) });
}

function createPlayer(id) {
  return attachCollision({
    id,
    position: { ...SPAWN },
    rotation: 0,       // Y-axis rotation in radians
    animation: "Idle",
    jumpPhase: null,
    swordEquipped: false,
    health: 100,
    name: `Player_${id.slice(0, 4)}`,
    correctionVersion: 0
  });
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
    p.jumpPhase  = typeof data.jumpPhase  === "string" ? data.jumpPhase  : p.jumpPhase;
    if (typeof data.swordEquipped === "boolean") {
      p.swordEquipped = data.swordEquipped;
    }
    attachCollision(p, data.collision);

    resolvePlayerSeparation(players);

    // Broadcast the corrected state to everyone, including the mover.
    io.emit("playerUpdated", {
      id: socket.id,
      position: p.position,
      rotation: p.rotation,
      animation: p.animation,
      jumpPhase: p.jumpPhase,
      swordEquipped: p.swordEquipped,
      collision: p.collision,
      correctionVersion: p.correctionVersion ?? 0
    });

    emitWorldState();
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
    resolvePlayerSeparation(players);
    emitWorldState();
  }
}, 100);

server.listen(PORT, () => {
  console.log(`Game server running at http://localhost:${PORT}`);
});