/**
 * script.js
 * Game logic: input, movement, networking, HUD updates.
 * All rendering is delegated to render.js (Renderer).
 */

"use strict";

import { Renderer } from "./render.js";

// ── Configs (loaded from JSON) ─────────────────────────────────────────────
let charConfig = null;
let mapConfig  = null;
let selectedCharacterId = null;
let selectedMapId = null;

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

// ── Sword state ────────────────────────────────────────────────────────────
let swordEquipped = false;
let isAttacking = false;
let attackCooldown = 0;
const ATTACK_COOLDOWN = 0.6; // seconds between attacks

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

function pickMapIdFromURL() {
  const params = new URLSearchParams(window.location.search);
  return params.get("map") || params.get("mapId") || null;
}

function pickCharacterIdFromURL() {
  const params = new URLSearchParams(window.location.search);
  return params.get("character") || params.get("characterId") || null;
}

async function loadCharacterConfigFromId() {
  const requestedCharacterId = pickCharacterIdFromURL();

  let characterIndex = null;
  try {
    characterIndex = await fetchJSON("/assets/characters.json");
  } catch (_err) {
    // Fallback for projects that only have a single character config.
  }

  if (characterIndex && Array.isArray(characterIndex.characters) && characterIndex.characters.length > 0) {
    const defaultCharacterId = characterIndex.defaultCharacterId || characterIndex.characters[0].id;
    selectedCharacterId = requestedCharacterId || defaultCharacterId;

    let selectedCharacter = characterIndex.characters.find(c => c.id === selectedCharacterId);
    if (!selectedCharacter) {
      console.warn(`[Character] Unknown character id '${selectedCharacterId}', falling back to '${defaultCharacterId}'.`);
      selectedCharacterId = defaultCharacterId;
      selectedCharacter = characterIndex.characters.find(c => c.id === selectedCharacterId);
    }

    if (!selectedCharacter || !selectedCharacter.config) {
      throw new Error("characters.json is missing a valid character entry with a config path.");
    }

    const characterPath = selectedCharacter.config.startsWith("/")
      ? selectedCharacter.config
      : `/assets/${selectedCharacter.config}`;

    const config = await fetchJSON(characterPath);
    config.id = config.id || selectedCharacterId;
    return config;
  }

  selectedCharacterId = requestedCharacterId || "base";
  const legacyPath = selectedCharacterId === "base"
    ? "/assets/characters/BaseCharacter.json"
    : `/assets/characters/${selectedCharacterId}.json`;

  try {
    const config = await fetchJSON(legacyPath);
    config.id = config.id || selectedCharacterId;
    return config;
  } catch (err) {
    if (legacyPath !== "/assets/characters/BaseCharacter.json") {
      console.warn(`[Character] Failed to load '${legacyPath}', falling back to '/assets/characters/BaseCharacter.json'.`);
      selectedCharacterId = "base";
      const config = await fetchJSON("/assets/characters/BaseCharacter.json");
      config.id = config.id || selectedCharacterId;
      return config;
    }
    throw err;
  }
}

async function loadMapConfigFromId() {
  const requestedMapId = pickMapIdFromURL();

  let mapIndex = null;
  try {
    mapIndex = await fetchJSON("/assets/maps.json");
  } catch (_err) {
    // Fallback for projects that only have a single map config.
  }

  if (mapIndex && Array.isArray(mapIndex.maps) && mapIndex.maps.length > 0) {
    const defaultMapId = mapIndex.defaultMapId || mapIndex.maps[0].id;
      selectedMapId = requestedMapId || "map_1";

    let selectedMap = mapIndex.maps.find(m => m.id === selectedMapId);
    if (!selectedMap) {
      console.warn(`[Map] Unknown map id '${selectedMapId}', falling back to '${defaultMapId}'.`);
      selectedMapId = defaultMapId;
      selectedMap = mapIndex.maps.find(m => m.id === selectedMapId);
    }

    if (!selectedMap || !selectedMap.config) {
      throw new Error("maps.json is missing a valid map entry with a config path.");
    }

    const mapPath = selectedMap.config.startsWith("/")
      ? selectedMap.config
      : `/assets/${selectedMap.config}`;

    const config = await fetchJSON(mapPath);
    config.id = config.id || selectedMapId;
    return config;
  }

  // Legacy fallback: use /assets/maps/map_1.json when no maps index exists.
    selectedMapId = requestedMapId || "map_1";
    const legacyPath = selectedMapId === "map_1"
      ? "/assets/maps/map_1.json"
      : `/assets/${selectedMapId}.json`;

  try {
    const config = await fetchJSON(legacyPath);
    config.id = config.id || selectedMapId;
    return config;
  } catch (err) {
    if (legacyPath !== "/assets/maps/map_1.json") {
      console.warn(`[Map] Failed to load '${legacyPath}', falling back to '/assets/maps/map_1.json'.`);
      selectedMapId = "map_1";
      const config = await fetchJSON("/assets/maps/map_1.json");
      config.id = config.id || selectedMapId;
      return config;
    }
    throw err;
  }
}

function getSpawnFromMapConfig(config) {
  const spawn = config?.spawn || config?.spawns?.default;
  return {
    x: spawn?.x ?? 0,
    y: spawn?.y ?? 0,
    z: spawn?.z ?? 0
  };
}

// ── Bootstrap ──────────────────────────────────────────────────────────────
async function main() {
  try {
    Renderer.setLoadProgress(5, "Fetching configs…");

    charConfig = await loadCharacterConfigFromId();
    mapConfig = await loadMapConfigFromId();
    console.log(`[Character] Using character id: ${charConfig.id}`);
    console.log(`[Map] Using map id: ${mapConfig.id}`);

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

    const spawn = getSpawnFromMapConfig(mapConfig);
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
        await Renderer.addRemotePlayer(p.id, charConfig, p.position, p.collision);
      }
      updateOnlineCount(Object.keys(Renderer.getRemotes()).length + 1);
      resolve();
    });

    socket.on("playerJoined", async (p) => {
      addSystemMsg(`${p.name} joined.`);
      await Renderer.addRemotePlayer(p.id, charConfig, p.position, p.collision);
      updateOnlineCount(Object.keys(Renderer.getRemotes()).length + 1);
    });

    socket.on("playerLeft", (id) => {
      Renderer.removeRemotePlayer(id);
      addSystemMsg(`${id.slice(0, 8)} left.`);
      updateOnlineCount(Object.keys(Renderer.getRemotes()).length + 1);
    });

    socket.on("playerUpdated", ({ id, position, rotation, animation, collision, correctionVersion }) => {
      if (id === selfId) {
        Renderer.setLocalPlayerState(position, rotation, collision, correctionVersion);
        return;
      }
      Renderer.updateRemotePlayer(id, position, rotation, animation, collision);
    });

    socket.on("worldState", ({ players }) => {
      players.forEach(p => {
        if (p.id === selfId) {
          Renderer.setLocalPlayerState(p.position, p.rotation, p.collision, p.correctionVersion);
          return;
        }
        Renderer.updateRemotePlayer(p.id, p.position, p.rotation, p.animation, p.collision);
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

  const previousPosition = player.root.position.clone();

  const scene  = Renderer.getScene();
  const camera = Renderer.getCamera();

  // ── Update sword state ─────────────────────────────────────────────────
  if (swordEquipped && player.sword) {
    Renderer.updateSwordPosition(player);
  }

  // ── Attack cooldown and state ──────────────────────────────────────────
  if (attackCooldown > 0) {
    attackCooldown -= dt;
  }

  // Check if attack animation has finished
  if (isAttacking && player.animGroups) {
    const punchAnim = player.animGroups.find(ag => ag.name === "Punch");
    if (punchAnim && !punchAnim.isPlaying) {
      isAttacking = false;
    }
  }

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

  // Apply movement and gravity every frame. Movement XZ is computed above; vertical
  // displacement is handled inside Renderer.moveLocalWithCollisions using scene gravity.
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
  }

  // Always call moveLocalWithCollisions so gravity is applied even when player isn't moving.
  Renderer.moveLocalWithCollisions(move, dt);

  updateVelocityReadout(player, previousPosition, dt);

  // ── Animation ─────────────────────────────────────────────────────────
  // Don't update base animation if attacking (attack animation takes priority)
  let animName = player.currentAnim;
  if (!isAttacking) {
    animName = Renderer.updateLocalAnimation(isMoving, isRunning);
  }

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
      animation: animName,
      collision: player.collision
    });
  }
}

// ── Input setup ────────────────────────────────────────────────────────────
function setupInput() {
  const canvas = Renderer.getEngine().getRenderingCanvas();

  document.addEventListener("keydown", (e) => {
    // Escape exits pointer lock
    if (e.key === "Escape") {
      document.exitPointerLock();
      return;
    }

    // Handle "1" key for sword equip/unequip
    if (e.key === "1" && !chatFocused) {
      swordEquipped = !swordEquipped;
      const player = Renderer.getPlayer();
      if (player) {
        if (swordEquipped) {
          Renderer.equipSword(player);
        } else {
          Renderer.unequipSword(player);
        }
      }
      e.preventDefault();
      return;
    }

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

  // Request pointer lock on canvas click
  canvas.addEventListener("click", () => {
    canvas.requestPointerLock = canvas.requestPointerLock || canvas.mozRequestPointerLock;
    if (canvas.requestPointerLock) {
      canvas.requestPointerLock();
    }
  });

  // Mouse drag for camera rotation and attacks
  canvas.addEventListener("mousedown", (e) => {
    if (e.button === 0) {
      // Left click: perform sword attack if equipped and not on cooldown
      if (swordEquipped && !isAttacking && attackCooldown <= 0) {
        isAttacking = true;
        attackCooldown = ATTACK_COOLDOWN;
        const player = Renderer.getPlayer();
        if (player) {
          // Prefer "SwordSlash" animation if available, fall back to "Punch"
          const preferred = (player.config.animations && player.config.animations.swordSlash) ? player.config.animations.swordSlash : "SwordSlash";
          const hasSwordSlash = player.animGroups && player.animGroups.some(ag => ag.name === preferred);
          const fallback = player.animGroups && player.animGroups.some(ag => ag.name === "Punch");
          if (hasSwordSlash) {
            Renderer.playAnim(player.animGroups, preferred, false);
          } else if (fallback) {
            Renderer.playAnim(player.animGroups, "Punch", false);
          } else {
            // As a last resort, stop updating animations briefly
          }
        }
      }
      mouseDown = true;
      lastMouseX = e.clientX;
      lastMouseY = e.clientY;
    } else if (e.button === 2) {
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

function updateVelocityReadout(player, previousPosition, dt) {
  const value = document.getElementById("velocity-value");
  if (!value || !player || !previousPosition || dt <= 0) return;

  const displacement = player.root.position.subtract(previousPosition);
  const speed = displacement.length() / dt;
  const verticalSpeed = displacement.y / dt;

  value.textContent = `Speed ${Math.round(speed)} u/s · Y ${Math.round(verticalSpeed)} u/s`;
}

function updateOnlineCount(n) {
  const el = document.getElementById("online-count");
  if (el) el.textContent = n;
}

// ── Start ──────────────────────────────────────────────────────────────────
window.addEventListener("DOMContentLoaded", main);