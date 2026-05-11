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
  GRAVITY_Y,
  TERMINAL_VELOCITY
} from "./variables.js";

export const Renderer = (() => {

  // ── Private state ─────────────────────────────────────────────────────────
  let engine, scene, camera, shadowGenerator;
  let localPlayer = null;       // { root, collider, animGroups, config, currentAnim }
  const remotePlayers = {};     // id → { root, animGroups, nameTag, currentAnim }
  const DEFAULT_CHARACTER_COLLISION = { radius: 0.4, height: 1.8 };

  // ── Animation helpers ─────────────────────────────────────────────────────
  function playAnim(animGroups, name, loop = true) {
    if (!animGroups || !animGroups.length) return;
    animGroups.forEach(ag => {
      if (ag.name === name) {
        ag.start(loop, 1.0, ag.from, ag.to, false);
        ag.setWeightForAllAnimatables(1);
      } else {
        ag.setWeightForAllAnimatables(0);
        ag.stop();
      }
    });
  }

  function shouldLoopAnimation(name) {
    if (!name) return true;
    if (name === "Punch") return false;
    return !/(slash|attack)/i.test(name);
  }

  // ── Sword loading and positioning ──────────────────────────────────────
  function loadSwordModel(player) {
    return new Promise(async (resolve, reject) => {
      if (player.sword) {
        return resolve(player.sword);
      }

      // Try to load optional JSON config for the sword (orientation, offsets, bone name)
      let cfg = {
        file: "weapons/Katana Sword.glb",
        attachBone: "RightHand",
        hiltOffset: { x: 0.35, y: 1.5, z: 0.2 },
        hiltRotation: { x: 0.15, y: 0, z: 0 }
      };

      try {
        const r = await fetch("/assets/weapons/Katana Sword.json");
        if (r.ok) {
          const userCfg = await r.json();
          cfg = Object.assign(cfg, userCfg);
        }
      } catch (e) {
        // Ignore missing config — use defaults above
      }

      BABYLON.SceneLoader.ImportMesh(
        "",
        "/assets/",
        cfg.file,
        scene,
        function (meshes, _ps, _sk, _ag) {
          if (!meshes || meshes.length === 0) {
            return reject(new Error("Failed to load sword model"));
          }

          // Create a parent transform for the sword meshes
          const swordRoot = new BABYLON.TransformNode("swordRoot", scene);
          // Apply scale from config (default 1)
          const s = typeof cfg.scale === 'number' ? cfg.scale : 1.0;
          swordRoot.scaling = new BABYLON.Vector3(s, s, s);

          // Parent all sword meshes to the root
          meshes.forEach(mesh => {
            mesh.parent = swordRoot;
            if (mesh.getTotalVertices && mesh.getTotalVertices() > 0) {
              try { shadowGenerator.addShadowCaster(mesh, true); } catch (_) {}
              mesh.receiveShadows = true;
            }
          });

          // Create a pivot mesh that will be attached to the bone if possible
          const pivot = new BABYLON.Mesh("swordPivot", scene);
          pivot.isVisible = false;

          // Default: parent pivot to visualRoot (local space)
          pivot.parent = player.visualRoot;

          // If we have a skinned mesh and a bone name, attach pivot to that bone
          if (player.skinnedMesh && player.skinnedMesh.skeleton && cfg.attachBone) {
            const bone = player.skinnedMesh.skeleton.bones.find(b => b.name === cfg.attachBone);
            if (bone) {
              try {
                pivot.attachToBone(bone, player.skinnedMesh);
                // When attached to bone, keep swordRoot parented to pivot so it follows bone
                swordRoot.parent = pivot;
                player.sword = { root: swordRoot, meshes: meshes, pivotAttached: true, pivot };
                // Apply local offsets/rotation
                swordRoot.position = new BABYLON.Vector3(cfg.hiltOffset.x, cfg.hiltOffset.y, cfg.hiltOffset.z);
                swordRoot.rotation = new BABYLON.Vector3(cfg.hiltRotation.x, cfg.hiltRotation.y, cfg.hiltRotation.z);
                return resolve(player.sword);
              } catch (e) {
                console.warn("[Sword] Could not attach to bone, falling back to visualRoot", e);
              }
            }
          }

          // Fallback: parent swordRoot to visualRoot and set local transform
          swordRoot.parent = player.visualRoot;
          swordRoot.position = new BABYLON.Vector3(cfg.hiltOffset.x, cfg.hiltOffset.y, cfg.hiltOffset.z);
          swordRoot.rotation = new BABYLON.Vector3(cfg.hiltRotation.x, cfg.hiltRotation.y, cfg.hiltRotation.z);

          player.sword = { root: swordRoot, meshes: meshes, pivotAttached: false };
          resolve(player.sword);
        },
        function (evt) {
          // Progress — ignored
        },
        function (sceneErr, msg, ex) {
          const detail = (ex && ex.message) ? ex.message : String(msg ?? "unknown error");
          console.error("[Sword] Load failed:", detail);
          reject(new Error("Failed to load sword — " + detail));
        }
      );
    });
  }

  function updateSwordPosition(player) {
    if (!player.sword || !player.sword.root) return;

    // If sword is attached to a bone pivot we don't need to update world position
    if (player.sword.pivotAttached) return;

    const swordRoot = player.sword.root;

    // Local offsets (if not attached to bone) — tweak via JSON config
    const handOffsetLocal = new BABYLON.Vector3(0.35, 1.5, 0.2);
    swordRoot.position.copyFrom(handOffsetLocal);
    swordRoot.rotation.x = 0.15;
    swordRoot.rotation.y = 0;
    swordRoot.rotation.z = 0;
  }

  // ── Sword equipment ───────────────────────────────────────────────────────
  async function equipSword(player) {
    if (!player) return;
    try {
      await loadSwordModel(player);
      // Position the sword immediately when not attached to bone
      if (player.sword && !player.sword.pivotAttached) updateSwordPosition(player);
    } catch (err) {
      console.error("[Sword] Failed to equip:", err);
    }
  }

  function unequipSword(player) {
    if (!player || !player.sword) return;
    try {
      if (player.sword.root) {
        player.sword.root.dispose();
      }
      player.sword.meshes?.forEach(m => {
        try { m.dispose(); } catch (_) {}
      });
      player.sword = null;
    } catch (err) {
      console.error("[Sword] Failed to unequip:", err);
    }
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
    collider.isPickable = false;
    collider.checkCollisions = true;
    collider.ellipsoid = new BABYLON.Vector3(shape.radius, shape.height / 2, shape.radius);
    collider.ellipsoidOffset = new BABYLON.Vector3(0, shape.height / 2, 0);

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
            lastAppliedCorrectionVersion: 0,
            currentAnim: idleAnimName,
            // vertical velocity in world units/second (positive = up)
            _velY: 0,
            _grounded: true
          };
          // Store skeletons/skinned mesh for later attachment
          localPlayer.skeletons = skeletons || null;
          localPlayer.skinnedMesh = skinnedMesh;
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
  function addRemotePlayer(id, charConfig, spawnPos, collisionFromServer) {
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

          const idleAnimName = charConfig.animations?.idle ?? "Idle";
          playAnim(animGroups, idleAnimName, true);

          const nameTag = makeNameTag("P_" + id.slice(0, 6), root, collision.height);
          const skinnedMesh = (meshes || []).find(m => m.skeleton) || null;
          remotePlayers[id] = {
            root,
            visualRoot,
            collider,
            animGroups,
            nameTag,
            currentAnim: idleAnimName,
            collision,
            skeletons: skeletons || null,
            skinnedMesh,
            swordEquipped: false,
            sword: null
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
      ? Math.max(2.0, playerHeight + 0.35)
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
    delete remotePlayers[id];
  }

  // ── Update remote player ──────────────────────────────────────────────────
  function updateRemotePlayer(id, position, rotation, animName, swordEquipped, collision) {
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

    if (collision) {
      rp.collision = sanitizeCollision(collision);
      updateNameTagPosition(rp.nameTag, rp.collision);
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

    if (animName && animName !== rp.currentAnim) {
      rp.currentAnim = animName;
      playAnim(rp.animGroups, animName, shouldLoopAnimation(animName));
    }
  }

  function setLocalPlayerState(position, rotation, collision, correctionVersion) {
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
    const groundedEps = 1e-3;
    const gravityY = scene?.gravity?.y ?? GRAVITY_Y;

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
        if (!supported) {
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

        // Landing: reset accumulated fall acceleration immediately.
        if (groundedNow) {
          localPlayer._velY = 0;
        }

        supported = groundedNow;
      }

      localPlayer._grounded = supported;
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
    const target = localPlayer.root.position.add(new BABYLON.Vector3(0, heightOffset, 0));
    camera.target.copyFrom(target);

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
    equipSword,
    unequipSword,
    updateSwordPosition,

    getScene:   () => scene,
    getCamera:  () => camera,
    getPlayer:  () => localPlayer,
    getRemotes: () => remotePlayers,
    getEngine:  () => engine,
  };

})();