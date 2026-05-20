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
const respawnTimers = {}; // socketId → timeout handle

const DEFAULT_COLLISION = { radius: 0.6, height: 1.8 };
const MAX_HEALTH = 100;
const GUN_DAMAGE = 10;
const RESPAWN_DELAY_MS = 1200;

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

function clampHealth(value) {
  const health = Number(value);
  if (!Number.isFinite(health)) return MAX_HEALTH;
  return Math.max(0, Math.min(MAX_HEALTH, Math.round(health)));
}

function clampVector3(value) {
  const x = Number(value?.x);
  const y = Number(value?.y);
  const z = Number(value?.z);

  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
    return null;
  }

  return { x, y, z };
}

function normalizeVector3(vector) {
  const length = Math.hypot(vector.x, vector.y, vector.z);
  if (!Number.isFinite(length) || length <= 0) return null;
  return { x: vector.x / length, y: vector.y / length, z: vector.z / length };
}

function getPlayerCenter(player) {
  return {
    x: player.position.x,
    y: player.position.y + getHeight(player) * 0.5,
    z: player.position.z
  };
}

function findGunRayHit(attackerId, rayOrigin, rayDirection, rayLength) {
  const origin = clampVector3(rayOrigin);
  const direction = clampVector3(rayDirection);
  const maxLength = Number(rayLength);

  if (!origin || !direction || !Number.isFinite(maxLength) || maxLength <= 0) {
    return null;
  }

  const normalizedDirection = normalizeVector3(direction);
  if (!normalizedDirection) return null;

  let bestHit = null;
  let bestProjection = Infinity;

  for (const [id, player] of Object.entries(players)) {
    if (id === attackerId || !player || player.health <= 0) continue;

    const hit = rayIntersectsPlayerCollider(origin, normalizedDirection, maxLength, player);
    if (hit && hit.distance < bestProjection) {
      bestProjection = hit.distance;
      bestHit = player;
    }
  }

  return bestHit;
}

function rayIntersectsPlayerCollider(origin, direction, maxLength, player) {
  const radius = getRadius(player);
  const height = getHeight(player);
  const min = {
    x: player.position.x - radius,
    y: player.position.y,
    z: player.position.z - radius
  };
  const max = {
    x: player.position.x + radius,
    y: player.position.y + height,
    z: player.position.z + radius
  };

  let tMin = 0;
  let tMax = maxLength;

  for (const axis of ["x", "y", "z"]) {
    const rayDir = direction[axis];
    const rayOrigin = origin[axis];
    const axisMin = min[axis];
    const axisMax = max[axis];

    if (Math.abs(rayDir) < 1e-8) {
      if (rayOrigin < axisMin || rayOrigin > axisMax) return null;
      continue;
    }

    const invDir = 1 / rayDir;
    let t1 = (axisMin - rayOrigin) * invDir;
    let t2 = (axisMax - rayOrigin) * invDir;
    if (t1 > t2) {
      const temp = t1;
      t1 = t2;
      t2 = temp;
    }

    tMin = Math.max(tMin, t1);
    tMax = Math.min(tMax, t2);
    if (tMax < tMin) return null;
  }

  return { distance: tMin };
}

function syncPlayerHealth(player, health) {
  player.health = clampHealth(health);
  return player.health;
}

function scheduleRespawn(id) {
  if (respawnTimers[id]) return;

  respawnTimers[id] = setTimeout(() => {
    delete respawnTimers[id];

    const player = players[id];
    if (!player) return;

    player.position = { ...SPAWN };
    player.rotation = 0;
    player.animation = "Idle";
    player.jumpPhase = null;
    syncPlayerHealth(player, MAX_HEALTH);
    bumpCorrectionVersion(player);
    emitWorldState();
    io.emit("playerUpdated", {
      id,
      position: player.position,
      rotation: player.rotation,
      animation: player.animation,
      jumpPhase: player.jumpPhase,
      swordEquipped: player.swordEquipped,
      gunEquipped: player.gunEquipped,
      collision: player.collision,
      correctionVersion: player.correctionVersion ?? 0,
      health: player.health
    });
  }, RESPAWN_DELAY_MS);
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
    gunEquipped: false,
    health: MAX_HEALTH,
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
    if (typeof data.gunEquipped === "boolean") {
      p.gunEquipped = data.gunEquipped;
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
      gunEquipped: p.gunEquipped,
      collision: p.collision,
      correctionVersion: p.correctionVersion ?? 0,
      health: p.health
    });

    emitWorldState();
  });

  socket.on("damagePlayer", (data) => {
    const attacker = players[socket.id];
    let targetId = data?.targetId;
    let target = targetId ? players[targetId] : null;

    if (!attacker) return;
    if (targetId === socket.id) return;

    const weaponType = data?.weaponType === "gun" ? "gun" : "sword";
    const damage = weaponType === "gun" ? GUN_DAMAGE : 25;
    const maxRange = weaponType === "gun" ? 8 : 3;
    const allowedDot = weaponType === "gun" ? 0.1 : 0.35;

    if (weaponType === "gun") {
      const rayOrigin = clampVector3(data?.rayOrigin);
      const rayDirection = clampVector3(data?.rayDirection);
      const rayLength = Number(data?.rayLength);

      if (!rayOrigin || !rayDirection || !Number.isFinite(rayLength) || rayLength <= 0 || rayLength > maxRange) {
        return;
      }

      const hitTarget = findGunRayHit(socket.id, rayOrigin, rayDirection, rayLength);
      if (!hitTarget) {
        return;
      }

      targetId = hitTarget.id;
      target = hitTarget;
    } else {
      if (!target) return;

      const dx = target.position.x - attacker.position.x;
      const dz = target.position.z - attacker.position.z;
      const distance = Math.hypot(dx, dz);
      if (!Number.isFinite(distance) || distance > maxRange || distance < 0.1) return;

      const forward = { x: Math.sin(attacker.rotation), z: Math.cos(attacker.rotation) };
      const length = Math.hypot(dx, dz) || 1;
      const dot = (forward.x * dx + forward.z * dz) / length;
      if (dot < allowedDot) return;
    }

    if (target.health <= 0) return;

    syncPlayerHealth(target, target.health - damage);
    bumpCorrectionVersion(target);

    io.emit("playerUpdated", {
      id: target.id,
      position: target.position,
      rotation: target.rotation,
      animation: target.animation,
      jumpPhase: target.jumpPhase,
      swordEquipped: target.swordEquipped,
      gunEquipped: target.gunEquipped,
      collision: target.collision,
      correctionVersion: target.correctionVersion ?? 0,
      health: target.health
    });

    emitWorldState();

    if (target.health <= 0) {
      scheduleRespawn(target.id);
    }
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
    if (respawnTimers[socket.id]) {
      clearTimeout(respawnTimers[socket.id]);
      delete respawnTimers[socket.id];
    }
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