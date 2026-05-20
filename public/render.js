/**
 * render.js
 * Handles all Babylon.js rendering: engine, scene, lighting, camera, model loading,
 * animation management, and per-frame updates.
 * Consumed by script.js which drives game logic and networking.
 */

"use strict";

import {
  CAMERA_FIRST_PERSON_RADIUS,
  CAMERA_THIRD_PERSON_MAX_RADIUS,
  CAMERA_THIRD_PERSON_MIN_RADIUS,
  CAMERA_FOLLOW_SMOOTHING,
  DEBUG,
  GRAVITY_Y,
  TERMINAL_VELOCITY,
  JUMP_HEIGHT
} from "./variables.js";

export const Renderer = (() => {

  // ── Private state ─────────────────────────────────────────────────────────
  let engine, scene, camera, shadowGenerator;
  let localPlayer = null;       // { root, collider, animGroups, config, currentAnim }
  const remotePlayers = {};     // id → { root, animGroups, nameTag, currentAnim }
  const DEFAULT_CHARACTER_COLLISION = { radius: 0.4, height: 1.8 };

  // ── Animation helpers ─────────────────────────────────────────────────────
  function playAnim(animGroups, name, loop = true) {
    playAnimRange(animGroups, name, { loop });
  }

  function playAnimRange(animGroups, name, options = {}) {
    if (!animGroups || !animGroups.length) return false;

    const loop = options.loop ?? true;
    const startRatio = Math.max(0, Math.min(1, options.startRatio ?? 0));
    const endRatio = Math.max(startRatio, Math.min(1, options.endRatio ?? 1));
    const speedRatio = options.speedRatio ?? 1.0;
    let played = false;

    animGroups.forEach(ag => {
      if (ag.name === name) {
        const from = Number.isFinite(ag.from) ? ag.from : 0;
        const to = Number.isFinite(ag.to) ? ag.to : from;
        const range = to - from;
        const startFrame = from + range * startRatio;
        const endFrame = from + range * endRatio;

        ag.start(loop, speedRatio, startFrame, endFrame, false);
        ag.setWeightForAllAnimatables(1);
        played = true;
      } else {
        ag.setWeightForAllAnimatables(0);
        ag.stop();
      }
    });

    return played;
  }

  function playJumpPhase(animGroups, jumpAnimName, phase) {
    const segments = {
      windup: { startRatio: 0.0, endRatio: 0.28, loop: false },
      launch: { startRatio: 0.28, endRatio: 0.78, loop: true },
      recover: { startRatio: 0.78, endRatio: 1.0, loop: false }
    };

    const segment = segments[phase] || segments.launch;
    return playAnimRange(animGroups, jumpAnimName, segment);
  }

  function shouldLoopAnimation(name) {
    if (!name) return true;
    if (name === "Punch" || name === "Jump") return false;
    return !/(slash|attack)/i.test(name);
  }

  const SWORD_DEFAULTS = {
    file: "weapons/Katana Sword.glb",
    attachBone: "RightHand",
    hiltOffset: { x: 0.35, y: 1.5, z: 0.2 },
    hiltRotation: { x: 0.15, y: 0, z: 0 }
  };

  const GUN_DEFAULTS = {
    file: "weapons/Animated Pistol.glb",
    attachBone: "RightHand",
    hiltOffset: { x: 0.25, y: 1.25, z: 0.15 },
    hiltRotation: { x: 0.05, y: 0, z: 0 }
  };

  function clampHealth(value) {
    const health = Number(value);
    if (!Number.isFinite(health)) return 100;
    return Math.max(0, Math.min(100, Math.round(health)));
  }

  function getMarkerHeight(playerHeight) {
    return Math.max(2.0, Number(playerHeight) + 0.35);
  }

  function healthColor(health) {
    const pct = clampHealth(health) / 100;
    const red = Math.round(255 * (1 - pct));
    const green = Math.round(232 * pct);
    return `rgb(${red}, ${green}, 122)`;
  }

  function drawHealthTexture(texture, health, label) {
    const ctx = texture.getContext();
    const size = texture.getSize();
    const width = size.width || 256;
    const height = size.height || 48;
    const pct = clampHealth(health) / 100;

    ctx.save();
    ctx.clearRect(0, 0, width, height);
    ctx.translate(0, height);
    ctx.scale(1, -1);

    ctx.fillStyle = "rgba(8, 16, 28, 0.82)";
    ctx.strokeStyle = "rgba(0, 200, 255, 0.55)";
    ctx.lineWidth = 3;
    roundRect(ctx, 2, 2, width - 4, height - 4, 8, true, true);

    ctx.fillStyle = "rgba(255, 255, 255, 0.08)";
    roundRect(ctx, 8, 16, width - 16, 14, 7, true, false);

    ctx.fillStyle = healthColor(health);
    roundRect(ctx, 8, 16, Math.max(6, (width - 16) * pct), 14, 7, true, false);

    ctx.font = "bold 18px monospace";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = "#d4eaff";
    ctx.fillText(label, width / 2, 10);

    ctx.restore();

    texture.update(false);
  }

  function roundRect(ctx, x, y, w, h, r, fill, stroke) {
    const radius = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + radius, y);
    ctx.lineTo(x + w - radius, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + radius);
    ctx.lineTo(x + w, y + h - radius);
    ctx.quadraticCurveTo(x + w, y + h, x + w - radius, y + h);
    ctx.lineTo(x + radius, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - radius);
    ctx.lineTo(x, y + radius);
    ctx.quadraticCurveTo(x, y, x + radius, y);
    ctx.closePath();
    if (fill) ctx.fill();
    if (stroke) ctx.stroke();
  }

  function createRemoteHealthBar(label, parentMesh, playerHeight, initialHealth = 100) {
    const plane = BABYLON.MeshBuilder.CreatePlane(
      "health_" + label,
      { width: 1.7, height: 0.28 },
      scene
    );
    plane.parent = parentMesh;
    plane.position = new BABYLON.Vector3(0, getMarkerHeight(playerHeight) + 0.18, 0);
    plane.billboardMode = BABYLON.Mesh.BILLBOARDMODE_ALL;
    plane.isPickable = false;

    const texture = new BABYLON.DynamicTexture("health_tex_" + label, { width: 256, height: 48 }, scene, false);
    texture.hasAlpha = true;
    texture.wrapU = BABYLON.Texture.CLAMP_ADDRESSMODE;
    texture.wrapV = BABYLON.Texture.CLAMP_ADDRESSMODE;

    const material = new BABYLON.StandardMaterial("health_mat_" + label, scene);
    material.diffuseTexture = texture;
    material.emissiveTexture = texture;
    material.opacityTexture = texture;
    material.backFaceCulling = false;
    material.disableLighting = true;
    plane.material = material;

    const health = clampHealth(initialHealth);
    drawHealthTexture(texture, health, String(health));

    return { plane, texture, material, health };
  }

  function updateRemoteHealthBar(healthBar, health) {
    if (!healthBar || !healthBar.texture) return;
    const nextHealth = clampHealth(health);
    if (healthBar.health === nextHealth) return;
    healthBar.health = nextHealth;
    drawHealthTexture(healthBar.texture, nextHealth, String(nextHealth));
  }

  function updateRemoteMarkerPosition(nameTag, healthBar, collision) {
    updateNameTagPosition(nameTag, collision);
    if (!healthBar || !healthBar.plane) return;

    const playerHeight = Number(collision?.height);
    const tagHeight = Number.isFinite(playerHeight) && playerHeight > 0
      ? getMarkerHeight(playerHeight)
      : 2.6;

    healthBar.plane.position.y = tagHeight + 0.18;
  }

  function loadHeldWeaponModel(player, weaponKey, label, defaults, configUrl) {
    return new Promise(async (resolve, reject) => {
      if (player[weaponKey]) {
        return resolve(player[weaponKey]);
      }

      let cfg = Object.assign({}, defaults);

      try {
        const r = await fetch(configUrl);
        if (r.ok) {
          const userCfg = await r.json();
          cfg = Object.assign(cfg, userCfg);
        }
      } catch (e) {
        // Ignore missing config and keep the defaults above.
      }

      BABYLON.SceneLoader.ImportMesh(
        "",
        "/assets/",
        cfg.file,
        scene,
        function (meshes, _ps, _sk, _ag) {
          if (!meshes || meshes.length === 0) {
            return reject(new Error("Failed to load " + label.toLowerCase() + " model"));
          }

          // Stop any animations from the weapon model to prevent autoplay/looping
          if (_ag && _ag.length > 0) {
            console.log("[" + label + "] Available animations:", _ag.map(ag => ag.name));
            _ag.forEach(ag => {
              ag.stop();
            });
          }

          const weaponRoot = new BABYLON.TransformNode(weaponKey + "Root", scene);
          const s = typeof cfg.scale === "number" ? cfg.scale : 1.0;
          weaponRoot.scaling = new BABYLON.Vector3(s, s, s);

          meshes.forEach(mesh => {
            mesh.parent = weaponRoot;
            if (mesh.getTotalVertices && mesh.getTotalVertices() > 0) {
              try { shadowGenerator.addShadowCaster(mesh, true); } catch (_) {}
              mesh.receiveShadows = true;
            }
          });

          const pivot = new BABYLON.Mesh(weaponKey + "Pivot", scene);
          pivot.isVisible = false;
          pivot.parent = player.visualRoot;

          if (player.skinnedMesh && player.skinnedMesh.skeleton && cfg.attachBone) {
            const bone = player.skinnedMesh.skeleton.bones.find(b => b.name === cfg.attachBone);
            if (bone) {
              try {
                pivot.attachToBone(bone, player.skinnedMesh);
                weaponRoot.parent = pivot;
                player[weaponKey] = { root: weaponRoot, meshes: meshes, pivotAttached: true, pivot, animGroups: _ag, config: cfg };
                weaponRoot.position = new BABYLON.Vector3(cfg.hiltOffset.x, cfg.hiltOffset.y, cfg.hiltOffset.z);
                weaponRoot.rotation = new BABYLON.Vector3(cfg.hiltRotation.x, cfg.hiltRotation.y, cfg.hiltRotation.z);
                return resolve(player[weaponKey]);
              } catch (e) {
                console.warn("[" + label + "] Could not attach to bone, falling back to visualRoot", e);
              }
            }
          }

          weaponRoot.parent = player.visualRoot;
          weaponRoot.position = new BABYLON.Vector3(cfg.hiltOffset.x, cfg.hiltOffset.y, cfg.hiltOffset.z);
          weaponRoot.rotation = new BABYLON.Vector3(cfg.hiltRotation.x, cfg.hiltRotation.y, cfg.hiltRotation.z);

          player[weaponKey] = { root: weaponRoot, meshes: meshes, pivotAttached: false, animGroups: _ag, config: cfg };
          resolve(player[weaponKey]);
        },
        function (_evt) {
          // Progress ignored.
        },
        function (_sceneErr, msg, ex) {
          const detail = (ex && ex.message) ? ex.message : String(msg ?? "unknown error");
          console.error("[" + label + "] Load failed:", detail);
          reject(new Error("Failed to load " + label.toLowerCase() + " — " + detail));
        }
      );
    });
  }

  function updateHeldWeaponPosition(player, weaponKey, defaults) {
    const weapon = player[weaponKey];
    if (!weapon || !weapon.root) return;

    if (weapon.pivotAttached) return;

    const weaponRoot = weapon.root;
    const offset = defaults.hiltOffset;
    const rotation = defaults.hiltRotation;
    weaponRoot.position.copyFrom(new BABYLON.Vector3(offset.x, offset.y, offset.z));
    weaponRoot.rotation.x = rotation.x;
    weaponRoot.rotation.y = rotation.y;
    weaponRoot.rotation.z = rotation.z;
  }

  async function equipHeldWeapon(player, weaponKey, label, defaults, configUrl) {
    if (!player) return;
    try {
      await loadHeldWeaponModel(player, weaponKey, label, defaults, configUrl);
      if (player[weaponKey] && !player[weaponKey].pivotAttached) {
        updateHeldWeaponPosition(player, weaponKey, defaults);
      }
    } catch (err) {
      console.error("[" + label + "] Failed to equip:", err);
    }
  }

  function unequipHeldWeapon(player, weaponKey, label) {
    if (!player || !player[weaponKey]) return;
    try {
      if (player[weaponKey].root) {
        player[weaponKey].root.dispose();
      }
      player[weaponKey].meshes?.forEach(m => {
        try { m.dispose(); } catch (_) {}
      });
      player[weaponKey] = null;
    } catch (err) {
      console.error("[" + label + "] Failed to unequip:", err);
    }
  }

  // ── Held weapon wrappers ─────────────────────────────────────────────────
  function loadSwordModel(player) {
    return loadHeldWeaponModel(player, "sword", "Sword", SWORD_DEFAULTS, "/assets/weapons/Katana Sword.json");
  }

  function updateSwordPosition(player) {
    return updateHeldWeaponPosition(player, "sword", SWORD_DEFAULTS);
  }

  async function equipSword(player) {
    return equipHeldWeapon(player, "sword", "Sword", SWORD_DEFAULTS, "/assets/weapons/Katana Sword.json");
  }

  function unequipSword(player) {
    return unequipHeldWeapon(player, "sword", "Sword");
  }

  function loadGunModel(player) {
    return loadHeldWeaponModel(player, "gun", "Gun", GUN_DEFAULTS, "/assets/weapons/Animated Pistol.json");
  }

  function updateGunPosition(player) {
    return updateHeldWeaponPosition(player, "gun", GUN_DEFAULTS);
  }

  async function equipGun(player) {
    return equipHeldWeapon(player, "gun", "Gun", GUN_DEFAULTS, "/assets/weapons/Animated Pistol.json");
  }

  function unequipGun(player) {
    return unequipHeldWeapon(player, "gun", "Gun");
  }

  function playWeaponAnim(weaponKey, animName, loop = false) {
    if (!localPlayer || !localPlayer[weaponKey]) return false;
    const weapon = localPlayer[weaponKey];
    if (!weapon.animGroups || !weapon.animGroups.length) return false;
    
    return playAnimRange(weapon.animGroups, animName, { loop });
  }

  // ── Loading bar ───────────────────────────────────────────────────────────
  function setLoadProgress(pct, msg) {
    const bar = document.getElementById("loading-bar");
    const lbl = document.getElementById("loading-msg");
    if (bar) bar.style.width = pct + "%";
    if (lbl && msg) lbl.textContent = msg;
  }

  function hideLoadingScreen() {
    const ls = document.getElementById("loading-screen");
    if (!ls) return;
    ls.classList.add("hidden");
    setTimeout(() => { if (ls.parentNode) ls.parentNode.removeChild(ls); }, 700);
  }

  function sanitizeCollision(collision) {
    const radius = Number(collision?.radius);
    const height = Number(collision?.height);

    return {
      radius: Number.isFinite(radius) && radius > 0 ? radius : DEFAULT_CHARACTER_COLLISION.radius,
      height: Number.isFinite(height) && height > 0 ? height : DEFAULT_CHARACTER_COLLISION.height
    };
  }

  function getRealMeshes(meshes) {
    return (meshes || []).filter(m => typeof m?.getTotalVertices === "function" ? m.getTotalVertices() > 0 : true);
  }

  function getHierarchyBounds(meshes) {
    const realMeshes = getRealMeshes(meshes);
    if (!realMeshes.length) return null;

    let min = null;
    let max = null;

    realMeshes.forEach(mesh => {
      try {
        mesh.computeWorldMatrix(true);
      } catch (_) {
        // Ignore individual mesh failures and continue with the rest.
      }

      const info = mesh.getBoundingInfo ? mesh.getBoundingInfo() : null;
      const box = info?.boundingBox;
      const minimum = box?.minimumWorld;
      const maximum = box?.maximumWorld;

      if (!minimum || !maximum) return;

      min = min
        ? BABYLON.Vector3.Minimize(min, minimum)
        : minimum.clone();
      max = max
        ? BABYLON.Vector3.Maximize(max, maximum)
        : maximum.clone();
    });

    return min && max ? { min, max } : null;
  }

  function getBoundsCorners(bounds) {
    if (!bounds?.min || !bounds?.max) return [];

    const { min, max } = bounds;
    return [
      new BABYLON.Vector3(min.x, min.y, min.z),
      new BABYLON.Vector3(min.x, min.y, max.z),
      new BABYLON.Vector3(min.x, max.y, min.z),
      new BABYLON.Vector3(min.x, max.y, max.z),
      new BABYLON.Vector3(max.x, min.y, min.z),
      new BABYLON.Vector3(max.x, min.y, max.z),
      new BABYLON.Vector3(max.x, max.y, min.z),
      new BABYLON.Vector3(max.x, max.y, max.z)
    ];
  }

  function getWeaponForwardVector(weapon) {
    if (!weapon?.root) return null;

    try {
      const forward = weapon.root.getDirection(BABYLON.Axis.Z);
      return forward.normalize();
    } catch (_err) {
      return null;
    }
  }

  function getWeaponMuzzlePoint(weapon) {
    if (!weapon?.root) return null;

    const rootMatrix = weapon.root.getWorldMatrix ? weapon.root.getWorldMatrix() : null;
    const origin = weapon.root.getAbsolutePosition
      ? weapon.root.getAbsolutePosition().clone()
      : weapon.root.position.clone();

    const muzzleOffset = weapon.config?.muzzleOffset;
    if (rootMatrix && muzzleOffset) {
      const offset = new BABYLON.Vector3(
        Number(muzzleOffset.x) || 0,
        Number(muzzleOffset.y) || 0,
        Number(muzzleOffset.z) || 0
      );
      return BABYLON.Vector3.TransformCoordinates(offset, rootMatrix);
    }

    const forward = getWeaponForwardVector(weapon);
    if (!forward) return origin.clone();

    const bounds = getHierarchyBounds(weapon.meshes);
    if (!bounds) {
      return origin.add(forward.scale(0.45));
    }

    let bestPoint = null;
    let bestScore = -Infinity;

    for (const corner of getBoundsCorners(bounds)) {
      const score = BABYLON.Vector3.Dot(corner.subtract(origin), forward);
      if (score > bestScore) {
        bestScore = score;
        bestPoint = corner;
      }
    }

    return bestPoint ? bestPoint.add(forward.scale(0.05)) : origin.add(forward.scale(0.45));
  }

  function getWeaponRayRange(weaponKey, weapon) {
    const configuredRange = Number(weapon?.config?.rayRange);
    if (Number.isFinite(configuredRange) && configuredRange > 0) {
      return configuredRange;
    }

    return weaponKey === "gun" ? 8 : 3;
  }

  function showDebugRay(origin, direction, length) {
    if (!DEBUG || !scene || !origin || !direction || !Number.isFinite(length) || length <= 0) return;

    const end = origin.add(direction.scale(length));
    const ray = BABYLON.MeshBuilder.CreateLines(
      "debugRay",
      { points: [origin.clone(), end] },
      scene
    );

    ray.color = new BABYLON.Color3(1, 0, 0);
    ray.alpha = 0.95;
    ray.isPickable = false;

    window.setTimeout(() => {
      try {
        ray.dispose();
      } catch (_) {}
    }, 120);
  }

  function getWeaponRayData(weaponKey) {
    if (!localPlayer || !scene) return null;

    const weapon = localPlayer[weaponKey];
    if (!weapon?.root) return null;

    const origin = getWeaponMuzzlePoint(weapon);
    const direction = getWeaponForwardVector(weapon);
    if (!origin || !direction) return null;

    const ray = new BABYLON.Ray(origin, direction, getWeaponRayRange(weaponKey, weapon));
    const pick = scene.pickWithRay(
      ray,
      mesh => Boolean(mesh?.metadata?.characterCollider) && mesh !== localPlayer.collider
    );

    return {
      origin,
      direction,
      length: ray.length
    };
  }

  function showWeaponRay(rayData) {
    if (!rayData) return;
    showDebugRay(rayData.origin, rayData.direction, rayData.length);
  }

  function buildCharacterCollision(meshes, fallbackCollision) {
    const bounds = getHierarchyBounds(meshes);
    if (!bounds) return sanitizeCollision(fallbackCollision);

    const width = Math.max(0.1, bounds.max.x - bounds.min.x);
    const depth = Math.max(0.1, bounds.max.z - bounds.min.z);
    const height = Math.max(0.1, bounds.max.y - bounds.min.y);

    return sanitizeCollision({
      radius: Math.max(width, depth) * 0.5,
      height
    });
  }

  function getCharacterVisualOffset(meshes) {
    const bounds = getHierarchyBounds(meshes);
    if (!bounds) return BABYLON.Vector3.Zero();

    const centerX = (bounds.min.x + bounds.max.x) * 0.5;
    const centerZ = (bounds.min.z + bounds.max.z) * 0.5;

    return new BABYLON.Vector3(-centerX, -bounds.min.y, -centerZ);
  }

  function createCharacterCollider(name, collision) {
    const shape = sanitizeCollision(collision);
    const collider = BABYLON.MeshBuilder.CreateBox(
      name,
      { width: shape.radius * 2, depth: shape.radius * 2, height: shape.height },
      scene
    );

    collider.isVisible = false;
    collider.isPickable = true;
    collider.checkCollisions = true;
    collider.ellipsoid = new BABYLON.Vector3(shape.radius, shape.height / 2, shape.radius);
    collider.ellipsoidOffset = new BABYLON.Vector3(0, shape.height / 2, 0);
    collider.metadata = { characterCollider: true };

    return collider;
  }

  function attachCharacterMeshes(meshes, visualRoot, isRemote = false) {
    getRealMeshes(meshes).forEach(mesh => {
      mesh.parent = visualRoot;
      if (mesh.getTotalVertices && mesh.getTotalVertices() > 0) {
        if (!isRemote) {
          shadowGenerator.addShadowCaster(mesh, true);
        }
        mesh.receiveShadows = true;
      }
      if (mesh.material) {
        mesh.material.backFaceCulling = !isRemote;
      }
    });
  }

  // ── Engine & Scene ────────────────────────────────────────────────────────
  function initEngine() {
    const canvas = document.getElementById("renderCanvas");
    engine = new BABYLON.Engine(canvas, true, {
      preserveDrawingBuffer: true,
      stencil: true,
      antialias: true,
      adaptToDeviceRatio: false
    });

    const deviceRatio = window.devicePixelRatio || 1;
    if (deviceRatio > 1) {
      engine.setHardwareScalingLevel(deviceRatio);
    }

    scene = new BABYLON.Scene(engine);
    scene.clearColor   = new BABYLON.Color4(0.02, 0.04, 0.10, 1.0);
    scene.ambientColor = new BABYLON.Color3(0.1, 0.1, 0.2);

    // Mild fog so the void feels infinite
    scene.fogMode    = BABYLON.Scene.FOGMODE_EXP2;
    scene.fogDensity = 0.012;
    scene.fogColor   = new BABYLON.Color3(0.02, 0.04, 0.10);

    // Enable collisions system
    scene.collisionsEnabled = true;
    scene.gravity = new BABYLON.Vector3(0, GRAVITY_Y, 0);

    window.addEventListener("resize", () => engine.resize());
    return { engine, scene };
  }

  // ── Lighting ──────────────────────────────────────────────────────────────
  function initLighting() {
    // Hemisphere ambient
    const hemi = new BABYLON.HemisphericLight("hemi", new BABYLON.Vector3(0, 1, 0), scene);
    hemi.intensity   = 0.5;
    hemi.diffuse     = new BABYLON.Color3(0.55, 0.75, 1.0);
    hemi.groundColor = new BABYLON.Color3(0.05, 0.05, 0.15);

    // Main directional (sun)
    const sun = new BABYLON.DirectionalLight("sun", new BABYLON.Vector3(-1, -2, -1), scene);
    sun.position  = new BABYLON.Vector3(20, 40, 20);
    sun.intensity = 0.9;
    sun.diffuse   = new BABYLON.Color3(0.9, 0.92, 1.0);

    // Shadow generator
    shadowGenerator = new BABYLON.ShadowGenerator(512, sun);
    shadowGenerator.useBlurExponentialShadowMap = true;
    shadowGenerator.blurKernel = 8;

    // Soft fill from opposite side
    const fill = new BABYLON.DirectionalLight("fill", new BABYLON.Vector3(1, -0.5, 1), scene);
    fill.intensity = 0.25;
    fill.diffuse   = new BABYLON.Color3(0.4, 0.5, 1.0);

    return shadowGenerator;
  }

  // ── Invisible floor (y = 0) ───────────────────────────────────────────────
  function initFloor() {
    const floor = BABYLON.MeshBuilder.CreateGround(
      "floor", { width: 500, height: 500 }, scene
    );
    floor.isVisible      = false;
    floor.isPickable     = false;
    floor.checkCollisions = false; // player y-clamp handles floor
    return floor;
  }

  // ── Third-person ArcRotate camera ─────────────────────────────────────────
  function initCamera(config) {
    const tp = config.camera.thirdPerson;
    camera = new BABYLON.ArcRotateCamera(
      "cam",
      -Math.PI / 2,
      Math.PI / 3,
      tp.radius,
      BABYLON.Vector3.Zero(),
      scene
    );
    camera.lowerRadiusLimit  = CAMERA_FIRST_PERSON_RADIUS;
    camera.upperRadiusLimit  = CAMERA_THIRD_PERSON_MAX_RADIUS;
    camera.lowerBetaLimit    = 0;
    camera.upperBetaLimit    = Math.PI;
    camera.useBouncingBehavior     = false;
    camera.useAutoRotationBehavior = false;

    // Attach pointer input; keyboard handled manually in script.js
    camera.attachControl(engine.getRenderingCanvas(), true);
    camera.inputs.removeByType("ArcRotateCameraKeyboardMoveInput");

    return camera;
  }

  // ── Load map_1.gltf ────────────────────────────────────────────────────────
  // Rotation is driven by map_1.json so each map can define its own orientation.
  // The map geometry is ~2.54 m across, so we scale it up to arena size.
  function loadMap(mapConfig) {
    setLoadProgress(20, "Loading map…");

    return new Promise((resolve, reject) => {
      BABYLON.SceneLoader.ImportMesh(
        "",          // meshNames — "" = all
        "/assets/",  // rootUrl   — trailing slash required
        mapConfig.file,
        scene,
        // ── onSuccess ──────────────────────────────────────────────────────
        function (meshes, _particleSystems, _skeletons, _animationGroups, _transformNodes, _geometries, rootNode) {

          if (!meshes || meshes.length === 0) {
            return reject(new Error("map_1.gltf loaded but contained no meshes."));
          }

          // Scale factor: raw geometry is ~2.54 units wide; multiply to arena size
          const WORLD_SCALE = 8 * (mapConfig.scale ?? 1);

          // The GLTF loader creates a __root__ TransformNode that parents everything
          const pivot = rootNode
            || (meshes[0] && meshes[0].parent)
            || meshes[0];

          // Allow per-map rotation in radians from JSON.
          const mapRotation = new BABYLON.Vector3(
            mapConfig.rotation?.x ?? -Math.PI / 2,
            mapConfig.rotation?.y ?? 0,
            mapConfig.rotation?.z ?? 0
          );

          if (pivot && typeof pivot.scaling !== "undefined") {
            pivot.scaling  = new BABYLON.Vector3(WORLD_SCALE, WORLD_SCALE, WORLD_SCALE);
            pivot.rotation = mapRotation;
            pivot.position = new BABYLON.Vector3(
              mapConfig.position?.x ?? 0,
              mapConfig.position?.y ?? 0,
              mapConfig.position?.z ?? 0
            );
          } else {
            // Fallback: set each mesh directly
            meshes.forEach(m => {
              m.scaling  = new BABYLON.Vector3(WORLD_SCALE, WORLD_SCALE, WORLD_SCALE);
              m.rotation = mapRotation;
              m.position = new BABYLON.Vector3(
                mapConfig.position?.x ?? 0,
                mapConfig.position?.y ?? 0,
                mapConfig.position?.z ?? 0
              );
            });
          }

          // Enable collisions and shadows on all real meshes
          meshes.forEach(m => {
            if (!m.getTotalVertices || m.getTotalVertices() === 0) return;

            // Some CAD/GLTF exports end up with inward-facing triangle winding.
            // Babylon collisions are triangle-facing sensitive, which can cause
            // one-way walls (pass in from outside, blocked from inside).
            // Flip faces once so collision blocks on the intended outside.
            if (mapConfig.collision?.flipFaces === true && typeof m.flipFaces === "function") {
              try {
                m.flipFaces(true);
                m.refreshBoundingInfo(true);
              } catch (e) {
                console.warn("[Map] Could not flip faces for mesh:", m.name, e);
              }
            }

            m.checkCollisions = true;
            m.isPickable = true;
            m.receiveShadows  = mapConfig.lighting?.receiveShadows ?? true;
            if (m.material) m.material.backFaceCulling = false;
            if (typeof m.freezeWorldMatrix === "function") m.freezeWorldMatrix();
          });

          setLoadProgress(45, "Map loaded.");
          resolve(meshes);
        },
        // ── onProgress ─────────────────────────────────────────────────────
        function (evt) {
          if (evt.lengthComputable && evt.total > 0) {
            const pct = 20 + Math.round((evt.loaded / evt.total) * 20);
            setLoadProgress(pct, "Loading map…");
          }
        },
        // ── onError ────────────────────────────────────────────────────────
        function (scene, msg, ex) {
          const detail = (ex && ex.message) ? ex.message : String(msg ?? "unknown error");
          console.error("[Map] Load failed:", detail, ex);
          reject(new Error("Failed to load map_1.gltf — " + detail));
        }
      );
    });
  }

  // ── Load local player ─────────────────────────────────────────────────────
  function loadLocalPlayer(charConfig, spawnPos) {
    setLoadProgress(55, "Loading character…");

    return new Promise((resolve, reject) => {
      BABYLON.SceneLoader.ImportMesh(
        "",
        "/assets/",
        charConfig.file,
        scene,
        // onSuccess
        function (meshes, _ps, skeletons, animGroups) {

          if (!meshes || meshes.length === 0) {
            return reject(new Error("Character GLTF returned no meshes."));
          }

          // Create a parent transform node for cleaner rotation control
          const root = new BABYLON.TransformNode("localPlayer", scene);
          const visualRoot = new BABYLON.TransformNode("localPlayerVisual", scene);
          visualRoot.parent = root;
          // Model assets sometimes export facing the opposite direction; apply
          // a 180° correction so the visible model faces the same way the
          // logical player root is oriented and moves.
          visualRoot.rotation.y = (charConfig.modelYawOffset ?? 0) + Math.PI;
          const s = charConfig.scale ?? 1;
          visualRoot.scaling = new BABYLON.Vector3(s, s, s);

          // Parent all loaded meshes to the transform node so model swaps keep
          // the collision logic and visible model aligned.
          attachCharacterMeshes(meshes, visualRoot, false);

          // Keep the visible model grounded at the logical player root.
          visualRoot.position = getCharacterVisualOffset(meshes);

          root.position = new BABYLON.Vector3(
            (spawnPos?.x ?? 0) + (charConfig.spawnOffset?.x ?? 0),
            (spawnPos?.y ?? 0) + (charConfig.spawnOffset?.y ?? 0),
            (spawnPos?.z ?? 0) + (charConfig.spawnOffset?.z ?? 0)
          );

          const collision = buildCharacterCollision(meshes, charConfig.collision);

          // Create a hidden collider that participates in scene collisions.
          // The visible GLTF hierarchy stays parented under `root`.
          const collider = createCharacterCollider("localPlayerCollider", collision);
          collider.position = new BABYLON.Vector3(
            root.position.x,
            root.position.y,
            root.position.z
          );

          // Start Idle
          const idleAnimName = charConfig.animations?.idle ?? "Idle";
          playAnim(animGroups, idleAnimName, true);

          // Point camera at character
          const heightOffset = charConfig.camera?.thirdPerson?.heightOffset ?? 2;
          camera.setTarget(
            root.position.add(new BABYLON.Vector3(0, heightOffset, 0))
          );

          // Find skinned mesh (the mesh that contains a skeleton) for bone attachment
          const skinnedMesh = (meshes || []).find(m => m.skeleton) || null;

          localPlayer = {
            root,
            visualRoot,
            collider,
            animGroups,
            config: charConfig,
            collision,
            health: 100,
            lastAppliedCorrectionVersion: 0,
            currentAnim: idleAnimName,
            jumpState: null,
            // vertical velocity in world units/second (positive = up)
            _velY: 0,
            _grounded: true,
            _lastGroundedAt: typeof performance !== "undefined" ? performance.now() : 0
          };
          // Store skeletons/skinned mesh for later attachment
          localPlayer.skeletons = skeletons || null;
          localPlayer.skinnedMesh = skinnedMesh;
          localPlayer.collider.metadata = {
            characterCollider: true,
            playerId: "local"
          };
          localPlayer.swordEquipped = false;
          localPlayer.gunEquipped = false;
          localPlayer.sword = null;
          localPlayer.gun = null;
          setLoadProgress(85, "Character ready.");
          resolve(localPlayer);
        },
        // onProgress
        function (evt) {
          if (evt.lengthComputable && evt.total > 0) {
            const pct = 55 + Math.round((evt.loaded / evt.total) * 25);
            setLoadProgress(pct, "Loading character…");
          }
        },
        // onError
        function (scene, msg, ex) {
          const detail = (ex && ex.message) ? ex.message : String(msg ?? "unknown");
          console.error("[Character] Load failed:", detail, ex);
          reject(new Error("Failed to load character — " + detail));
        }
      );
    });
  }

  // ── Load remote player ────────────────────────────────────────────────────
  function addRemotePlayer(id, charConfig, spawnPos, collisionFromServer, healthFromServer) {
    return new Promise((resolve) => {
      BABYLON.SceneLoader.ImportMesh(
        "", "/assets/", charConfig.file, scene,
        function (meshes, _ps, skeletons, animGroups) {
          if (!meshes || meshes.length === 0) return resolve(null);

          // Create a parent transform node for cleaner rotation control
          const root = new BABYLON.TransformNode("remote_" + id, scene);
          const visualRoot = new BABYLON.TransformNode("remote_" + id + "_visual", scene);
          visualRoot.parent = root;
          // Apply the same 180° correction for remote visuals so everyone
          // sees models oriented consistently.
          visualRoot.rotation.y = (charConfig.modelYawOffset ?? 0) + Math.PI;
          const s = charConfig.scale ?? 1;
          visualRoot.scaling = new BABYLON.Vector3(s, s, s);

          attachCharacterMeshes(meshes, visualRoot, true);
          visualRoot.position = getCharacterVisualOffset(meshes);

          root.position = new BABYLON.Vector3(
            spawnPos?.x ?? 0, spawnPos?.y ?? 0, spawnPos?.z ?? 0
          );

          const collision = sanitizeCollision(
            collisionFromServer || buildCharacterCollision(meshes, charConfig.collision)
          );
          const collider = createCharacterCollider("remote_" + id + "_collider", collision);
          collider.position = new BABYLON.Vector3(
            root.position.x,
            root.position.y,
            root.position.z
          );
          collider.metadata = {
            characterCollider: true,
            playerId: id
          };

          const idleAnimName = charConfig.animations?.idle ?? "Idle";
          playAnim(animGroups, idleAnimName, true);

          const nameTag = makeNameTag("P_" + id.slice(0, 6), root, collision.height);
          const healthBar = createRemoteHealthBar("P_" + id.slice(0, 6), root, collision.height, healthFromServer);
          const skinnedMesh = (meshes || []).find(m => m.skeleton) || null;
          remotePlayers[id] = {
            root,
            visualRoot,
            collider,
            animGroups,
            nameTag,
            healthBar,
            health: clampHealth(healthFromServer ?? 100),
            currentAnim: idleAnimName,
            currentJumpPhase: null,
            collision,
            skeletons: skeletons || null,
            skinnedMesh,
            swordEquipped: false,
            gunEquipped: false,
            sword: null,
            gun: null
          };
          resolve(remotePlayers[id]);
        }
      );
    });
  }

  // ── Floating name tag ─────────────────────────────────────────────────────
  function makeNameTag(label, parentMesh, playerHeight = DEFAULT_CHARACTER_COLLISION.height) {
    const tagHeight = Math.max(2.0, Number(playerHeight) + 0.35);
    const plane = BABYLON.MeshBuilder.CreatePlane(
      "tag_" + label, { width: 2.2, height: 0.55 }, scene
    );
    plane.parent       = parentMesh;
    plane.position     = new BABYLON.Vector3(0, tagHeight, 0);
    plane.billboardMode = BABYLON.Mesh.BILLBOARDMODE_ALL;
    plane.isPickable   = false;

    const tex = new BABYLON.DynamicTexture("dtex_" + label, { width: 256, height: 64 }, scene, false);
    tex.hasAlpha = true;
    tex.drawText(label, null, 46, "bold 32px monospace", "#00c8ff", "transparent", true);

    const mat = new BABYLON.StandardMaterial("tagmat_" + label, scene);
    mat.diffuseTexture  = tex;
    mat.emissiveTexture = tex;
    mat.backFaceCulling = false;
    mat.hasAlpha        = true;
    plane.material      = mat;

    return plane;
  }

  function updateNameTagPosition(nameTag, collision) {
    if (!nameTag) return;

    const playerHeight = Number(collision?.height);
    const tagHeight = Number.isFinite(playerHeight) && playerHeight > 0
      ? getMarkerHeight(playerHeight)
      : 2.6;

    nameTag.position.y = tagHeight;
  }

  // ── Remove remote player ──────────────────────────────────────────────────
  function removeRemotePlayer(id) {
    const rp = remotePlayers[id];
    if (!rp) return;
    try { rp.root.dispose(); }     catch (_) {}
    try { if (rp.collider) rp.collider.dispose(); } catch (_) {}
    try { if (rp.nameTag) rp.nameTag.dispose(); } catch (_) {}
    try { if (rp.healthBar?.plane) rp.healthBar.plane.dispose(); } catch (_) {}
    try { if (rp.healthBar?.material) rp.healthBar.material.dispose(); } catch (_) {}
    try { if (rp.healthBar?.texture) rp.healthBar.texture.dispose(); } catch (_) {}
    delete remotePlayers[id];
  }

  // ── Update remote player ──────────────────────────────────────────────────
  function updateRemotePlayer(id, position, rotation, animName, swordEquipped, gunEquipped, collision, jumpPhase, health) {
    const rp = remotePlayers[id];
    if (!rp) return;

    if (typeof swordEquipped === "boolean" && swordEquipped !== rp.swordEquipped) {
      rp.swordEquipped = swordEquipped;
      if (rp.swordEquipped) {
        equipSword(rp);
      } else {
        unequipSword(rp);
      }
    }

    if (typeof gunEquipped === "boolean" && gunEquipped !== rp.gunEquipped) {
      rp.gunEquipped = gunEquipped;
      if (rp.gunEquipped) {
        equipGun(rp);
      } else {
        unequipGun(rp);
      }
    }

    if (collision) {
      rp.collision = sanitizeCollision(collision);
      updateRemoteMarkerPosition(rp.nameTag, rp.healthBar, rp.collision);
    }

    if (typeof health === "number") {
      rp.health = clampHealth(health);
      updateRemoteHealthBar(rp.healthBar, rp.health);
    }

    const nextPosition = BABYLON.Vector3.Lerp(
      rp.root.position,
      new BABYLON.Vector3(position.x, position.y, position.z),
      0.2
    );
    rp.root.position = nextPosition;
    if (rp.collider) {
      rp.collider.position.copyFrom(nextPosition);
      rp.collider.rotation.y = rotation;
    }
    
    // Smooth rotation towards target rotation
    let diff = rotation - rp.root.rotation.y;
    // Wrap to [-π, π]
    while (diff >  Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    rp.root.rotation.y += diff * 0.15;

    const jumpAnimName = rp.config?.animations?.jump ?? "Jump";
    if (animName === jumpAnimName) {
      const nextJumpPhase = jumpPhase || "launch";
      if (rp.currentAnim !== animName || rp.currentJumpPhase !== nextJumpPhase) {
        rp.currentAnim = animName;
        rp.currentJumpPhase = nextJumpPhase;
        playJumpPhase(rp.animGroups, jumpAnimName, nextJumpPhase);
      }
      return;
    }

    if (animName && animName !== rp.currentAnim) {
      rp.currentAnim = animName;
      rp.currentJumpPhase = null;
      playAnim(rp.animGroups, animName, shouldLoopAnimation(animName));
    }
  }

  function requestJump() {
    if (!localPlayer || localPlayer.jumpState) return false;

    const now = typeof performance !== "undefined" ? performance.now() : Date.now();
    const groundedRecently =
      localPlayer._grounded === true ||
      (typeof localPlayer._lastGroundedAt === "number" && (now - localPlayer._lastGroundedAt) <= 120);
    if (!groundedRecently) return false;

    const jumpAnimName = localPlayer.config.animations?.jump ?? "Jump";
    const gravityMagnitude = Math.max(0.001, Math.abs(scene?.gravity?.y ?? GRAVITY_Y));
    const defaultLaunchVelocity = Math.sqrt(2 * gravityMagnitude * JUMP_HEIGHT);
    localPlayer.jumpState = {
      phase: "windup",
      timer: 0,
      jumpAnimName,
      windupDuration: localPlayer.config.movement?.jumpWindup ?? 0.12,
      launchVelocity: localPlayer.config.movement?.jumpVelocity ?? defaultLaunchVelocity,
      recoverDuration: localPlayer.config.movement?.jumpRecover ?? 0.18,
      animatedPhase: null,
      landed: false
    };
    localPlayer._grounded = true;
    localPlayer._velY = 0;
    playJumpPhase(localPlayer.animGroups, jumpAnimName, "windup");
    localPlayer.currentAnim = jumpAnimName;
    return true;
  }

  function setLocalPlayerState(position, rotation, collision, correctionVersion, health) {
    if (!localPlayer) return;

    if (typeof correctionVersion === "number") {
      if (typeof localPlayer.lastAppliedCorrectionVersion === "number" &&
          correctionVersion <= localPlayer.lastAppliedCorrectionVersion) {
        return;
      }
      localPlayer.lastAppliedCorrectionVersion = correctionVersion;
    }

    if (collision) {
      localPlayer.collision = sanitizeCollision(collision);
    }

    if (typeof health === "number") {
      localPlayer.health = clampHealth(health);
    }

    const nextPosition = new BABYLON.Vector3(position.x, position.y, position.z);
    const collider = localPlayer.collider;

    if (collider) {
      const dist = BABYLON.Vector3.Distance(collider.position, nextPosition);

      // Snap only when server correction is clearly large; otherwise blend in
      // to avoid visible jitter while still respecting authoritative collisions.
      if (dist > 1.0) {
        collider.position.copyFrom(nextPosition);
      } else if (dist > 0.03) {
        collider.position = BABYLON.Vector3.Lerp(collider.position, nextPosition, 0.35);
      }

      if (typeof rotation === "number") {
        let diff = rotation - localPlayer.root.rotation.y;
        while (diff > Math.PI) diff -= Math.PI * 2;
        while (diff < -Math.PI) diff += Math.PI * 2;

        const nextRot = Math.abs(diff) > 1.0
          ? rotation
          : localPlayer.root.rotation.y + diff * 0.35;

        localPlayer.root.rotation.y = nextRot;
        collider.rotation.y = nextRot;
      }

      localPlayer.root.position.copyFrom(collider.position);
      return;
    }

    localPlayer.root.position.copyFrom(nextPosition);
    if (typeof rotation === "number") {
      localPlayer.root.rotation.y = rotation;
    }
  }

  // ── Local player animation ────────────────────────────────────────────────
  function updateLocalAnimation(isMoving, isRunning) {
    if (!localPlayer) return null;
    const anims = localPlayer.config.animations ?? {};

    if (localPlayer.jumpState) {
      const jumpState = localPlayer.jumpState;
      const jumpAnimName = jumpState.jumpAnimName ?? (anims.jump ?? "Jump");

      if (jumpState.animatedPhase !== jumpState.phase) {
        playJumpPhase(localPlayer.animGroups, jumpAnimName, jumpState.phase);
        jumpState.animatedPhase = jumpState.phase;
      }

      if (jumpState.phase === "recover" && jumpState.timer >= jumpState.recoverDuration && localPlayer._grounded) {
        localPlayer.jumpState = null;
        return updateLocalAnimation(isMoving, isRunning);
      }

      localPlayer.currentAnim = jumpAnimName;
      return jumpAnimName;
    }

    const targetAnim = isMoving
      ? (isRunning ? (anims.run ?? "Run") : (anims.walk ?? "Walk"))
      : (anims.idle ?? "Idle");

    if (targetAnim !== localPlayer.currentAnim) {
      localPlayer.currentAnim = targetAnim;
      playAnim(localPlayer.animGroups, targetAnim, true);
    }
    return targetAnim;
  }

  // ── Local collision movement ─────────────────────────────────────────────
  // delta: horizontal movement (x,z) per-frame; dt: time delta in seconds
  function moveLocalWithCollisions(delta, dt = 1 / 60) {
    if (!localPlayer || !localPlayer.collider) return;

    const collider = localPlayer.collider;

    // Ensure vertical velocity is present
    if (typeof localPlayer._velY !== "number") localPlayer._velY = 0;

    // Use fixed-size physics substeps so gravity feels consistent across varying frame times.
    const safeDt = Math.max(0, Math.min(dt, 0.1));
    const targetStepDt = 1 / 120;
    const physicsSteps = Math.max(1, Math.ceil(safeDt / targetStepDt));
    const subDt = safeDt / physicsSteps;
    const horizontalPerStep = delta.scale(1 / physicsSteps);

    const maxStep = 0.08;
    // Tolerance for detecting ground contact — raised slightly to avoid
    // tiny oscillations when gravity is high or floating-point error occurs.
    const groundedEps = 0.02;
    const gravityY = scene?.gravity?.y ?? GRAVITY_Y;

    const jumpState = localPlayer.jumpState;
    if (jumpState) {
      jumpState.timer += safeDt;

      if (jumpState.phase === "windup" && jumpState.timer >= jumpState.windupDuration) {
        jumpState.phase = "launch";
        jumpState.timer = 0;
        jumpState.animatedPhase = null;
        localPlayer._velY = jumpState.launchVelocity;
        localPlayer._grounded = false;
      }
    }

    let supported = localPlayer._grounded === true;

    for (let i = 0; i < physicsSteps; i++) {
      // Gravity is always integrated at the same acceleration; collision response
      // determines whether downward motion is canceled by ground contact.
      localPlayer._velY += gravityY * subDt;
      if (localPlayer._velY < TERMINAL_VELOCITY) localPlayer._velY = TERMINAL_VELOCITY;

      const horizontalStep = new BABYLON.Vector3(horizontalPerStep.x, 0, horizontalPerStep.z);
      const horizontalDistance = horizontalStep.length();

      if (horizontalDistance > 0) {
        const horizontalSteps = Math.max(1, Math.ceil(horizontalDistance / maxStep));
        const horizontalCollisionStep = horizontalStep.scale(1 / horizontalSteps);
        const yBeforeHorizontal = collider.position.y;

        for (let j = 0; j < horizontalSteps; j++) {
          collider.moveWithCollisions(horizontalCollisionStep);
        }

        // In air, keep horizontal collision response from injecting extra vertical speed.
        // On slopes, preserve upward ground-following movement, but snap back
        // tiny downward corrections so the collider does not chatter on the incline.
        const yAfterHorizontal = collider.position.y;

        // Make slope tolerance scale with horizontal movement so faster
        // movement (sprinting) allows slightly larger micro-step corrections
        // without producing visible jitter. Clamp the added tolerance so
        // we don't swallow meaningful collisions.
        // For sprinting, allow larger micro-step tolerance to avoid jitter.
        // Increase multiplier and clamp so faster movement tolerates more.
        const slopeTolerance = groundedEps + Math.max(0, Math.min(horizontalDistance * 0.6, 0.3));

        const smallDownwardCorrection =
          yAfterHorizontal < yBeforeHorizontal &&
          (yBeforeHorizontal - yAfterHorizontal) < slopeTolerance;

        if (!supported || smallDownwardCorrection) {
          collider.position.y = yBeforeHorizontal;
        }
      }

      const verticalStep = localPlayer._velY * subDt;
      if (verticalStep !== 0) {
        const verticalDistance = Math.abs(verticalStep);
        const verticalSteps = Math.max(1, Math.ceil(verticalDistance / maxStep));
        const verticalCollisionStep = new BABYLON.Vector3(0, verticalStep / verticalSteps, 0);

        const yBeforeVertical = collider.position.y;

        for (let j = 0; j < verticalSteps; j++) {
          collider.moveWithCollisions(verticalCollisionStep);
        }

        const yAfterVertical = collider.position.y;
        const verticalMoved = yAfterVertical - yBeforeVertical;
        const groundedNow = verticalStep < 0 && verticalMoved > verticalStep + groundedEps;

        // Landing: reset accumulated fall acceleration immediately and
        // snap the collider to the pre-vertical position to avoid tiny
        // penetrations that can cause visual vibration.
        if (groundedNow) {
          localPlayer._velY = 0;
          try {
            collider.position.y = yBeforeVertical;
          } catch (e) {
            // If anything goes wrong with snapping, ignore and continue.
          }

          if (jumpState && jumpState.phase === "launch") {
            jumpState.phase = "recover";
            jumpState.timer = 0;
            jumpState.animatedPhase = null;
            jumpState.landed = true;
          }
        }

        supported = groundedNow;
      }

      localPlayer._grounded = supported;
      if (supported) {
        localPlayer._lastGroundedAt = typeof performance !== "undefined" ? performance.now() : Date.now();
      }

      if (jumpState && jumpState.phase === "recover" && localPlayer._grounded && jumpState.timer >= jumpState.recoverDuration) {
        localPlayer.jumpState = null;
      }
    }

    // Sync visible root to collider position
    localPlayer.root.position.copyFrom(collider.position);
    if (localPlayer.collider) {
      localPlayer.collider.rotation.y = localPlayer.root.rotation.y;
    }
  }

  // ── Camera follow ─────────────────────────────────────────────────────────
  function updateCameraTarget() {
    if (!localPlayer) return;
    const heightOffset = localPlayer.config.camera?.thirdPerson?.heightOffset ?? 2;
    const desiredTarget = localPlayer.root.position.add(new BABYLON.Vector3(0, heightOffset, 0));
    
    // Smoothly interpolate the camera target to reduce collision vibrations
    camera.target.x += (desiredTarget.x - camera.target.x) * CAMERA_FOLLOW_SMOOTHING;
    camera.target.y += (desiredTarget.y - camera.target.y) * CAMERA_FOLLOW_SMOOTHING;
    camera.target.z += (desiredTarget.z - camera.target.z) * CAMERA_FOLLOW_SMOOTHING;

    const isFirstPerson = camera.radius < CAMERA_THIRD_PERSON_MIN_RADIUS;
    if (localPlayer.visualRoot) {
      localPlayer.visualRoot.setEnabled(!isFirstPerson);
    }
  }

  // ── Render loop ───────────────────────────────────────────────────────────
  function startRenderLoop(onFrameCb) {
    engine.runRenderLoop(() => {
      const dt = engine.getDeltaTime() / 1000;
      if (onFrameCb) onFrameCb(dt);
      scene.render();
    });
  }

  // ── Public API ────────────────────────────────────────────────────────────
  return {
    initEngine,
    initLighting,
    initFloor,
    initCamera,
    loadMap,
    loadLocalPlayer,
    addRemotePlayer,
    removeRemotePlayer,
    updateRemotePlayer,
    setLocalPlayerState,
    updateLocalAnimation,
    moveLocalWithCollisions,
    updateCameraTarget,
    startRenderLoop,
    setLoadProgress,
    hideLoadingScreen,
    playAnim,
    playJumpPhase,
    playWeaponAnim,
    equipSword,
    unequipSword,
    updateSwordPosition,
    equipGun,
    unequipGun,
    updateGunPosition,
    requestJump,
    getWeaponRayData,
    showWeaponRay,

    getScene:   () => scene,
    getCamera:  () => camera,
    getPlayer:  () => localPlayer,
    getRemotes: () => remotePlayers,
    getEngine:  () => engine,
  };

})();