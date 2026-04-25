/**
 * render.js
 * Handles all Babylon.js rendering: engine, scene, lighting, camera, model loading,
 * animation management, and per-frame updates.
 * Consumed by script.js which drives game logic and networking.
 */

"use strict";

const Renderer = (() => {

  // ── Private state ─────────────────────────────────────────────────────────
  let engine, scene, camera, shadowGenerator;
  let localPlayer = null;       // { root, animGroups, config, currentAnim }
  const remotePlayers = {};     // id → { root, animGroups, nameTag, currentAnim }

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
    scene.gravity = new BABYLON.Vector3(0, -0.5, 0);

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
    camera.lowerRadiusLimit  = tp.lowerRadiusLimit ?? 2;
    camera.upperRadiusLimit  = tp.upperRadiusLimit ?? 20;
    camera.lowerBetaLimit    = 0.05;
    camera.upperBetaLimit    = Math.PI / 2.1;
    camera.useBouncingBehavior     = false;
    camera.useAutoRotationBehavior = false;

    // Attach pointer input; keyboard handled manually in script.js
    camera.attachControl(engine.getRenderingCanvas(), true);
    camera.inputs.removeByType("ArcRotateCameraKeyboardMoveInput");

    return camera;
  }

  // ── Load map.gltf ─────────────────────────────────────────────────────────
  // Rotation is driven by map.json so each map can define its own orientation.
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
            return reject(new Error("map.gltf loaded but contained no meshes."));
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
            m.checkCollisions = mapConfig.collision?.enabled ?? true;
            m.receiveShadows  = mapConfig.lighting?.receiveShadows ?? true;
            if (m.material) m.material.backFaceCulling = true;
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
          reject(new Error("Failed to load map.gltf — " + detail));
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
        function (meshes, _ps, _sk, animGroups) {

          if (!meshes || meshes.length === 0) {
            return reject(new Error("Character GLTF returned no meshes."));
          }

          // Create a parent transform node for cleaner rotation control
          const root = new BABYLON.TransformNode("localPlayer", scene);
          const visualRoot = new BABYLON.TransformNode("localPlayerVisual", scene);
          visualRoot.parent = root;
          visualRoot.rotation.y = charConfig.modelYawOffset ?? 0;
          root.position = new BABYLON.Vector3(
            (spawnPos?.x ?? 0) + (charConfig.spawnOffset?.x ?? 0),
            (spawnPos?.y ?? 0) + (charConfig.spawnOffset?.y ?? 0),
            (spawnPos?.z ?? 0) + (charConfig.spawnOffset?.z ?? 0)
          );

          // Parent all loaded meshes to the transform node
          meshes[0].parent = visualRoot;
          const s = charConfig.scale ?? 1;
          meshes[0].scaling = new BABYLON.Vector3(s, s, s);

          // Add to shadow casters
          meshes.forEach(m => {
            if (m.getTotalVertices && m.getTotalVertices() > 0) {
              shadowGenerator.addShadowCaster(m, true);
              m.receiveShadows = true;
            }
          });

          // Collision ellipsoid
          const col = charConfig.collision ?? { radius: 0.4, height: 1.8 };

          // Set collision on the actual mesh child
          meshes[0].ellipsoid       = new BABYLON.Vector3(col.radius, col.height / 2, col.radius);
          meshes[0].ellipsoidOffset = new BABYLON.Vector3(0, col.height / 2, 0);
          meshes[0].checkCollisions = true;
          // Start Idle
          const idleAnimName = charConfig.animations?.idle ?? "Idle";
          playAnim(animGroups, idleAnimName, true);

          // Point camera at character
          const heightOffset = charConfig.camera?.thirdPerson?.heightOffset ?? 2;
          camera.setTarget(
            root.position.add(new BABYLON.Vector3(0, heightOffset, 0))
          );

          localPlayer = { root, animGroups, config: charConfig, currentAnim: idleAnimName };
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
  function addRemotePlayer(id, charConfig, spawnPos) {
    return new Promise((resolve) => {
      BABYLON.SceneLoader.ImportMesh(
        "", "/assets/", charConfig.file, scene,
        function (meshes, _ps, _sk, animGroups) {
          if (!meshes || meshes.length === 0) return resolve(null);

          // Create a parent transform node for cleaner rotation control
          const root = new BABYLON.TransformNode("remote_" + id, scene);
          const visualRoot = new BABYLON.TransformNode("remote_" + id + "_visual", scene);
          visualRoot.parent = root;
          visualRoot.rotation.y = charConfig.modelYawOffset ?? 0;
          root.position = new BABYLON.Vector3(
            spawnPos?.x ?? 0, spawnPos?.y ?? 0, spawnPos?.z ?? 0
          );

          // Parent all loaded meshes to the transform node
          meshes[0].parent = visualRoot;
          const s = charConfig.scale ?? 1;
          meshes[0].scaling = new BABYLON.Vector3(s, s, s);

          meshes.forEach(m => {
            if (m.getTotalVertices && m.getTotalVertices() > 0) {
              m.receiveShadows = true;
            }
            if (m.material) m.material.backFaceCulling = true;
          });

          const idleAnimName = charConfig.animations?.idle ?? "Idle";
          playAnim(animGroups, idleAnimName, true);

          const nameTag = makeNameTag("P_" + id.slice(0, 6), root);
          remotePlayers[id] = { root, animGroups, nameTag, currentAnim: idleAnimName };
          resolve(remotePlayers[id]);
        }
      );
    });
  }

  // ── Floating name tag ─────────────────────────────────────────────────────
  function makeNameTag(label, parentMesh) {
    const plane = BABYLON.MeshBuilder.CreatePlane(
      "tag_" + label, { width: 2.2, height: 0.55 }, scene
    );
    plane.parent       = parentMesh;
    plane.position     = new BABYLON.Vector3(0, 2.6, 0);
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

  // ── Remove remote player ──────────────────────────────────────────────────
  function removeRemotePlayer(id) {
    const rp = remotePlayers[id];
    if (!rp) return;
    try { rp.root.dispose(); }     catch (_) {}
    try { if (rp.nameTag) rp.nameTag.dispose(); } catch (_) {}
    delete remotePlayers[id];
  }

  // ── Update remote player ──────────────────────────────────────────────────
  function updateRemotePlayer(id, position, rotation, animName) {
    const rp = remotePlayers[id];
    if (!rp) return;

    rp.root.position = BABYLON.Vector3.Lerp(
      rp.root.position,
      new BABYLON.Vector3(position.x, position.y, position.z),
      0.2
    );
    
    // Smooth rotation towards target rotation
    let diff = rotation - rp.root.rotation.y;
    // Wrap to [-π, π]
    while (diff >  Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    rp.root.rotation.y += diff * 0.15;

    if (animName && animName !== rp.currentAnim) {
      rp.currentAnim = animName;
      playAnim(rp.animGroups, animName, true);
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

  // ── Camera follow ─────────────────────────────────────────────────────────
  function updateCameraTarget() {
    if (!localPlayer) return;
    const heightOffset = localPlayer.config.camera?.thirdPerson?.heightOffset ?? 2;
    const target = localPlayer.root.position.add(new BABYLON.Vector3(0, heightOffset, 0));
    camera.target = BABYLON.Vector3.Lerp(camera.target, target, 0.14);
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
    updateLocalAnimation,
    updateCameraTarget,
    startRenderLoop,
    setLoadProgress,
    hideLoadingScreen,
    playAnim,

    getScene:   () => scene,
    getCamera:  () => camera,
    getPlayer:  () => localPlayer,
    getRemotes: () => remotePlayers,
    getEngine:  () => engine,
  };

})();