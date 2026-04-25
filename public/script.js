/**
 * script.js
 * Game logic: input, movement, networking, HUD updates.
 * All rendering is delegated to render.js (Renderer).
 */

"use strict";

// ── Configs (loaded from JSON) ─────────────────────────────────────────────
let charConfig = null;
let mapConfig  = null;

// ── Input state ────────────────────────────────────────────────────────────
const keys = {
  w: false, a: false, s: false, d: false,
  ArrowUp: false, ArrowDown: false, ArrowLeft: false, ArrowRight: false,
  ShiftLeft: false, ShiftRight: false
};

let chatFocused  = false;
let mouseDown    = false;
let lastMouseX   = 0;
let lastMouseY   = 0;

// ── Networking ─────────────────────────────────────────────────────────────
let socket       = null;
let selfId       = null;
const SEND_RATE  = 50; // ms between network sends
let lastSend     = 0;

// ── Movement ───────────────────────────────────────────────────────────────
const WALK_SPEED = 1;
const RUN_SPEED  = 2;
const TURN_SPEED = 0.1;
const CAM_KEY_ROT_SPEED = 0.025; // arrow key camera speed (radians/frame)

// ────────────────────────────────────────────────────────────────────────────
async function fetchJSON(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Failed to load ${url}: ${r.status}`);
  return r.json();
}

// ── Bootstrap ──────────────────────────────────────────────────────────────
async function main() {
  try {
    Renderer.setLoadProgress(5, "Fetching configs…");

    [charConfig, mapConfig] = await Promise.all([
      fetchJSON("/assets/BaseCharacter.json"),
      fetchJSON("/assets/map.json")
    ]);

    // Apply JSON-driven speeds to Renderer constants
    // (override module-level if provided)
    const mv = charConfig.movement;

    Renderer.setLoadProgress(10, "Starting engine…");
    Renderer.initEngine();
    Renderer.initLighting();
    Renderer.initFloor();

    const cam = Renderer.initCamera(charConfig);

    Renderer.setLoadProgress(15, "Connecting to server…");
    await connectSocket();

    await Renderer.loadMap(mapConfig);

    const spawn = { x: 0, y: 0, z: 0 };
    await Renderer.loadLocalPlayer(charConfig, spawn);

    Renderer.setLoadProgress(95, "Almost there…");
    setupInput();
    setupChat();
    updateHUD();

    Renderer.startRenderLoop(onFrame);

    Renderer.setLoadProgress(100, "Ready!");
    setTimeout(() => Renderer.hideLoadingScreen(), 400);

  } catch (err) {
    console.error("Startup error:", err);
    document.getElementById("loading-msg").textContent = "Error: " + err.message;
  }
}

// ── Network ────────────────────────────────────────────────────────────────
function connectSocket() {
  return new Promise((resolve) => {
    socket = io();

    socket.on("connect", () => {
      selfId = socket.id;
      console.log("Connected:", selfId);
    });

    // Init: we receive our own state + all existing players
    socket.on("init", async ({ self, players }) => {
      for (const p of players) {
        await Renderer.addRemotePlayer(p.id, charConfig, p.position);
      }
      updateOnlineCount(Object.keys(Renderer.getRemotes()).length + 1);
      resolve();
    });

    socket.on("playerJoined", async (p) => {
      addSystemMsg(`${p.name} joined.`);
      await Renderer.addRemotePlayer(p.id, charConfig, p.position);
      updateOnlineCount(Object.keys(Renderer.getRemotes()).length + 1);
    });

    socket.on("playerLeft", (id) => {
      Renderer.removeRemotePlayer(id);
      addSystemMsg(`${id.slice(0, 8)} left.`);
      updateOnlineCount(Object.keys(Renderer.getRemotes()).length + 1);
    });

    socket.on("playerUpdated", ({ id, position, rotation, animation }) => {
      Renderer.updateRemotePlayer(id, position, rotation, animation);
    });

    socket.on("worldState", ({ players }) => {
      players.forEach(p => {
        if (p.id === selfId) return;
        Renderer.updateRemotePlayer(p.id, p.position, p.rotation, p.animation);
      });
    });

    socket.on("chat", ({ id, name, message }) => {
      addChatMsg(name, message, id === selfId);
    });
  });
}

// ── Per-frame logic ────────────────────────────────────────────────────────
function onFrame(dt) {
  if (!charConfig) return;

  const player = Renderer.getPlayer();
  if (!player) return;

  const scene  = Renderer.getScene();
  const camera = Renderer.getCamera();

  // ── Arrow key camera rotation ──────────────────────────────────────────
  if (!chatFocused) {
    if (keys.ArrowLeft)  camera.alpha -= CAM_KEY_ROT_SPEED;
    if (keys.ArrowRight) camera.alpha += CAM_KEY_ROT_SPEED;
    if (keys.ArrowUp)    camera.beta  = Math.max(0.1, camera.beta - CAM_KEY_ROT_SPEED);
    if (keys.ArrowDown)  camera.beta  = Math.min(Math.PI / 2.1, camera.beta + CAM_KEY_ROT_SPEED);
  }

  // ── WASD movement ──────────────────────────────────────────────────────
  const isRunning = keys.ShiftLeft || keys.ShiftRight;
  const speed = isRunning
    ? (charConfig.movement?.runSpeed  || RUN_SPEED)
    : (charConfig.movement?.walkSpeed || WALK_SPEED);

  // Forward direction = camera look direction (flattened to XZ)
  const camDir = camera.target.subtract(camera.position);
  camDir.y = 0;
  camDir.normalize();

  const right = BABYLON.Vector3.Cross(BABYLON.Vector3.Up(), camDir).normalize();

  let move = BABYLON.Vector3.Zero();
  let isMoving = false;

  if (!chatFocused) {
    if (keys.w) { move.addInPlace(camDir); isMoving = true; }
    if (keys.s) { move.addInPlace(camDir.scale(-1)); isMoving = true; }
    if (keys.a) { move.addInPlace(right.scale(-1)); isMoving = true; }
    if (keys.d) { move.addInPlace(right); isMoving = true; }
  }

  if (isMoving) {
    const frameScale = Math.min(dt * 60, 2);
    move.normalize().scaleInPlace(speed * frameScale);

    // Rotate character to face movement direction
    const targetAngle = Math.atan2(move.x, move.z);
    let currentAngle  = player.root.rotation.y;
    let diff = targetAngle - currentAngle;
    // Wrap to [-π, π]
    while (diff >  Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    // Use turnSpeed from config, defaulting to 0.15
    const turnSpeed = charConfig.movement?.turnSpeed ?? 0.15;
    player.root.rotation.y += diff * turnSpeed;

    Renderer.moveLocalWithCollisions(move);
  }

  // ── Animation ─────────────────────────────────────────────────────────
  const animName = Renderer.updateLocalAnimation(isMoving, isRunning);

  // ── Camera follow ──────────────────────────────────────────────────────
  Renderer.updateCameraTarget();

  // ── Network send ───────────────────────────────────────────────────────
  const now = performance.now();
  if (socket && now - lastSend > SEND_RATE) {
    lastSend = now;
    socket.emit("playerUpdate", {
      position: {
        x: player.root.position.x,
        y: player.root.position.y,
        z: player.root.position.z
      },
      rotation:  player.root.rotation.y,
      animation: animName
    });
  }
}

// ── Input setup ────────────────────────────────────────────────────────────
function setupInput() {
  const canvas = Renderer.getEngine().getRenderingCanvas();

  document.addEventListener("keydown", (e) => {
    if (chatFocused) return;
    if (keys.hasOwnProperty(e.key)) { keys[e.key] = true; e.preventDefault(); }
    if (e.code === "ShiftLeft" || e.code === "ShiftRight") {
      keys[e.code] = true;
    }
    // Arrow keys
    const arrowMap = { ArrowUp: true, ArrowDown: true, ArrowLeft: true, ArrowRight: true };
    if (arrowMap[e.key]) { keys[e.key] = true; e.preventDefault(); }
  });

  document.addEventListener("keyup", (e) => {
    if (keys.hasOwnProperty(e.key)) keys[e.key] = false;
    if (e.code === "ShiftLeft" || e.code === "ShiftRight") {
      keys[e.code] = false;
    }
  });

  // Mouse drag for camera rotation
  canvas.addEventListener("mousedown", (e) => {
    if (e.button === 2 || e.button === 0) {
      mouseDown = true;
      lastMouseX = e.clientX;
      lastMouseY = e.clientY;
    }
  });

  window.addEventListener("mouseup", () => { mouseDown = false; });

  window.addEventListener("mousemove", (e) => {
    if (!mouseDown || chatFocused) return;
    const dx = e.clientX - lastMouseX;
    const dy = e.clientY - lastMouseY;
    lastMouseX = e.clientX;
    lastMouseY = e.clientY;

    const cam = Renderer.getCamera();
    const sens = 0.006;
    cam.alpha += dx * sens;
    cam.beta   = Math.max(0.1, Math.min(Math.PI / 2.1, cam.beta + dy * sens));
  });

  // Scroll wheel zoom
  canvas.addEventListener("wheel", (e) => {
    const cam = Renderer.getCamera();
    const tp  = charConfig?.camera?.thirdPerson;
    const min = tp?.lowerRadiusLimit ?? 2;
    const max = tp?.upperRadiusLimit ?? 20;
    cam.radius = Math.max(min, Math.min(max, cam.radius + e.deltaY * 0.02));
    e.preventDefault();
  }, { passive: false });

  // Prevent context menu on right click
  canvas.addEventListener("contextmenu", e => e.preventDefault());
}

// ── Chat ───────────────────────────────────────────────────────────────────
function setupChat() {
  const input = document.getElementById("chat-input");

  input.addEventListener("focus", () => { chatFocused = true; });
  input.addEventListener("blur",  () => { chatFocused = false; });

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      const msg = input.value.trim();
      if (msg && socket) {
        socket.emit("chat", msg);
        input.value = "";
      }
      input.blur();
      e.stopPropagation();
    }
    if (e.key === "Escape") {
      input.blur();
    }
  });

  // Press Enter (when not focused) to open chat
  document.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !chatFocused) {
      input.focus();
      e.preventDefault();
    }
  });
}

function addChatMsg(name, text, isSelf) {
  const log  = document.getElementById("chat-log");
  const line = document.createElement("div");
  line.className = "chat-msg";
  line.innerHTML = `<span class="msg-name">${escapeHtml(name)}</span><span class="msg-text">${escapeHtml(text)}</span>`;
  log.appendChild(line);
  log.scrollTop = log.scrollHeight;

  // Trim to 50 lines
  while (log.children.length > 50) log.removeChild(log.firstChild);
}

function addSystemMsg(text) {
  const log  = document.getElementById("chat-log");
  const line = document.createElement("div");
  line.className = "chat-msg system";
  line.textContent = text;
  log.appendChild(line);
  log.scrollTop = log.scrollHeight;
  while (log.children.length > 50) log.removeChild(log.firstChild);
}

function escapeHtml(str) {
  return str.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
}

// ── HUD updates ────────────────────────────────────────────────────────────
function updateHUD() {
  // Player name from socket id
  if (selfId) {
    const pn = document.getElementById("player-name");
    if (pn) pn.textContent = `Player_${selfId.slice(0, 4).toUpperCase()}`;
  }
}

function updateOnlineCount(n) {
  const el = document.getElementById("online-count");
  if (el) el.textContent = n;
}

// ── Start ──────────────────────────────────────────────────────────────────
window.addEventListener("DOMContentLoaded", main);