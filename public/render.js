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
  let localPlayer = null;           // { mesh, animationGroups, config }
  const remotePlayers = {};         // id → { root, animationGroups, nameTag }

  // Current animation name → AnimationGroup
  function getAnim(animGroups, name) {
    return animGroups.find(ag => ag.name === name) || null;
  }

  function playAnim(animGroups, name, loop = true, blendSpeed = 0.15) {
    animGroups.forEach(ag => {
      if (ag.name === name) {
        if (!ag.isPlaying) { ag.play(loop); }
        ag.setWeightForAllAnimatables(1);
      } else {
        ag.setWeightForAllAnimatables(0);
        if (ag.isPlaying) ag.stop();
      }
    });
  }

  // ── Loading bar helpers ───────────────────────────────────────────────────
  function setLoadProgress(pct, msg) {
    const bar = document.getElementById("loading-bar");
    const lbl = document.getElementById("loading-msg");
    if (bar) bar.style.width = pct + "%";
    if (lbl) lbl.textContent = msg;
  }

  function hideLoadingScreen() {
    const ls = document.getElementById("loading-screen");
    if (ls) {
      ls.classList.add("hidden");
      setTimeout(() => ls.remove(), 700);
    }
  }

  // ── Engine & Scene ────────────────────────────────────────────────────────
  function initEngine() {
    const canvas = document.getElementById("renderCanvas");
    engine = new BABYLON.Engine(canvas, true, {
      preserveDrawingBuffer: true,
      stencil: true,
      antialias: true
    });

    scene = new BABYLON.Scene(engine);

    // Void background — deep space blue
    scene.clearColor = new BABYLON.Color4(0.02, 0.04, 0.1, 1);

    // Slight ambient fog for depth
    scene.fogMode    = BABYLON.Scene.FOGMODE_EXP2;
    scene.fogDensity = 0.018;
    scene.fogColor   = new BABYLON.Color3(0.02, 0.04, 0.1);

    // Resize
    window.addEventListener("resize", () => engine.resize());

    return { engine, scene };
  }

  // ── Lighting ──────────────────────────────────────────────────────────────
  function initLighting() {
    // Hemisphere (ambient sky/ground)
    const hemi = new BABYLON.HemisphericLight(
      "hemi", new BABYLON.Vector3(0, 1, 0), scene
    );
    hemi.intensity    = 0.45;
    hemi.diffuse      = new BABYLON.Color3(0.55, 0.75, 1.0);
    hemi.groundColor  = new BABYLON.Color3(0.05, 0.05, 0.12);

    // Directional (sun) with shadows
    const sun = new BABYLON.DirectionalLight(
      "sun", new BABYLON.Vector3(-1, -2, -1), scene
    );
    sun.position  = new BABYLON.Vector3(20, 40, 20);
    sun.intensity = 0.9;
    sun.diffuse   = new BABYLON.Color3(0.9, 0.92, 1.0);

    // Shadow generator
    shadowGenerator = new BABYLON.ShadowGenerator(1024, sun);
    shadowGenerator.useBlurExponentialShadowMap = true;
    shadowGenerator.blurKernel = 16;

    // Subtle fill light from opposite side
    const fill = new BABYLON.DirectionalLight(
      "fill", new BABYLON.Vector3(1, -0.5, 1), scene
    );
    fill.intensity = 0.25;
    fill.diffuse   = new BABYLON.Color3(0.4, 0.5, 1.0);

    return shadowGenerator;
  }

  // ── Invisible floor plane ─────────────────────────────────────────────────
  function initFloor() {
    const floor = BABYLON.MeshBuilder.CreateGround(
      "floor", { width: 200, height: 200 }, scene
    );
    floor.isVisible = false;
    floor.isPickable = false;

    // Physics (Babylon's built-in impostor)
    floor.physicsImpostor = new BABYLON.PhysicsImpostor(
      floor, BABYLON.PhysicsImpostor.BoxImpostor,
      { mass: 0, restitution: 0, friction: 0.8 }, scene
    );
    return floor;
  }

  // ── Third-person Camera ───────────────────────────────────────────────────
  function initCamera(config) {
    const tp = config.camera.thirdPerson;
    camera = new BABYLON.ArcRotateCamera(
      "cam",
      -Math.PI / 2,      // alpha  (horizontal)
      Math.PI / 3,       // beta   (vertical ~60°)
      tp.radius,
      BABYLON.Vector3.Zero(),
      scene
    );

    camera.lowerRadiusLimit = tp.lowerRadiusLimit;
    camera.upperRadiusLimit = tp.upperRadiusLimit;
    camera.lowerBetaLimit   = 0.1;
    camera.upperBetaLimit   = Math.PI / 2.1;

    // Smooth follow
    camera.useBouncingBehavior   = false;
    camera.useAutoRotationBehavior = false;

    const canvas = engine.getRenderingCanvas();
    camera.attachControl(canvas, true);

    // Disable default keyboard handling — we do it manually
    camera.inputs.removeByType("ArcRotateCameraKeyboardMoveInput");

    return camera;
  }

  // ── Load map ──────────────────────────────────────────────────────────────
  async function loadMap(mapConfig) {
    setLoadProgress(20, "Loading map…");

    return new Promise((resolve, reject) => {
      BABYLON.SceneLoader.ImportMesh(
        "", "/assets/", mapConfig.file, scene,
        (meshes) => {
          meshes.forEach(m => {
            m.scaling = new BABYLON.Vector3(
              mapConfig.scale, mapConfig.scale, mapConfig.scale
            );
            m.position = new BABYLON.Vector3(
              mapConfig.position.x,
              mapConfig.position.y,
              mapConfig.position.z
            );
            m.receiveShadows = mapConfig.lighting.receiveShadows;
            m.checkCollisions = mapConfig.collision.enabled;

            // Give the map mesh a nice material tint
            if (m.material) {
              m.material.backFaceCulling = false;
            }
          });

          setLoadProgress(45, "Map loaded.");
          resolve(meshes);
        },
        null,
        (_, msg, err) => reject(err || msg)
      );
    });
  }

  // ── Load local player ─────────────────────────────────────────────────────
  async function loadLocalPlayer(charConfig, spawnPos) {
    setLoadProgress(55, "Loading character…");

    return new Promise((resolve, reject) => {
      BABYLON.SceneLoader.ImportMesh(
        "", "/assets/", charConfig.file, scene,
        (meshes, particleSystems, skeletons, animGroups) => {

          const root = meshes[0];
          root.name = "localPlayer";
          root.scaling = new BABYLON.Vector3(
            charConfig.scale, charConfig.scale, charConfig.scale
          );
          root.position = new BABYLON.Vector3(
            spawnPos.x + charConfig.spawnOffset.x,
            spawnPos.y + charConfig.spawnOffset.y,
            spawnPos.z + charConfig.spawnOffset.z
          );

          // Shadows
          meshes.forEach(m => {
            shadowGenerator.addShadowCaster(m, true);
            m.receiveShadows = true;
          });

          // Collision ellipsoid
          const col = charConfig.collision;
          root.ellipsoid       = new BABYLON.Vector3(col.radius, col.height / 2, col.radius);
          root.ellipsoidOffset = new BABYLON.Vector3(0, col.height / 2, 0);

          // Start Idle
          playAnim(animGroups, charConfig.animations.idle, true, charConfig.animationBlendSpeed);

          // Attach camera target
          camera.setTarget(
            root.position.add(new BABYLON.Vector3(0, charConfig.camera.thirdPerson.heightOffset, 0))
          );

          localPlayer = { root, animGroups, config: charConfig, currentAnim: "idle" };
          setLoadProgress(80, "Character ready.");
          resolve(localPlayer);
        },
        null,
        (_, msg, err) => reject(err || msg)
      );
    });
  }

  // ── Load remote player ────────────────────────────────────────────────────
  async function addRemotePlayer(id, charConfig, spawnPos) {
    return new Promise((resolve) => {
      BABYLON.SceneLoader.ImportMesh(
        "", "/assets/", charConfig.file, scene,
        (meshes, _, __, animGroups) => {
          const root = meshes[0];
          root.name = `remote_${id}`;
          root.scaling = new BABYLON.Vector3(
            charConfig.scale, charConfig.scale, charConfig.scale
          );
          root.position = new BABYLON.Vector3(spawnPos.x, spawnPos.y, spawnPos.z);

          shadowGenerator.addShadowCaster(root, true);
          meshes.forEach(m => m.receiveShadows = true);

          // Tint remote players slightly differently
          meshes.forEach(m => {
            if (m.material) {
              const mat = m.material.clone("remotemat_" + id);
              mat.emissiveColor = new BABYLON.Color3(0.05, 0.05, 0.15);
              m.material = mat;
            }
          });

          playAnim(animGroups, charConfig.animations.idle, true);

          // Floating name tag
          const nameTag = makeNameTag(id.slice(0, 8), root);

          remotePlayers[id] = { root, animGroups, nameTag, currentAnim: "idle" };
          resolve(remotePlayers[id]);
        }
      );
    });
  }

  function makeNameTag(label, parentMesh) {
    const plane = BABYLON.MeshBuilder.CreatePlane(
      "tag_" + label, { width: 2, height: 0.5 }, scene
    );
    plane.parent   = parentMesh;
    plane.position = new BABYLON.Vector3(0, 3.2, 0);
    plane.billboardMode = BABYLON.Mesh.BILLBOARDMODE_ALL;

    const texture = new BABYLON.DynamicTexture("dyn_" + label, { width: 256, height: 64 }, scene, false);
    texture.hasAlpha = true;
    texture.drawText(label, null, 48, "bold 36px monospace", "#00c8ff", "transparent", true);

    const mat = new BABYLON.StandardMaterial("tagmat_" + label, scene);
    mat.diffuseTexture  = texture;
    mat.emissiveTexture = texture;
    mat.backFaceCulling = false;
    mat.hasAlpha = true;
    plane.material = mat;

    return plane;
  }

  function removeRemotePlayer(id) {
    const rp = remotePlayers[id];
    if (!rp) return;
    rp.root.dispose();
    if (rp.nameTag) rp.nameTag.dispose();
    delete remotePlayers[id];
  }

  // ── Update remote player state ────────────────────────────────────────────
  function updateRemotePlayer(id, position, rotation, animName) {
    const rp = remotePlayers[id];
    if (!rp) return;

    // Smooth interpolation
    rp.root.position = BABYLON.Vector3.Lerp(
      rp.root.position,
      new BABYLON.Vector3(position.x, position.y, position.z),
      0.18
    );
    rp.root.rotation.y = rotation;

    if (animName !== rp.currentAnim) {
      rp.currentAnim = animName;
      playAnim(rp.animGroups, animName, true);
    }
  }

  // ── Local player animation selection ─────────────────────────────────────
  function updateLocalAnimation(isMoving, isRunning) {
    if (!localPlayer) return;
    const cfg = localPlayer.config;
    let targetAnim = isMoving
      ? (isRunning ? cfg.animations.run : cfg.animations.walk)
      : cfg.animations.idle;

    if (targetAnim !== localPlayer.currentAnim) {
      localPlayer.currentAnim = targetAnim;
      playAnim(localPlayer.animGroups, targetAnim, true, cfg.animationBlendSpeed);
    }
    return targetAnim;
  }

  // ── Camera follow ─────────────────────────────────────────────────────────
  function updateCameraTarget() {
    if (!localPlayer) return;
    const offset = new BABYLON.Vector3(0, localPlayer.config.camera.thirdPerson.heightOffset, 0);
    camera.target = BABYLON.Vector3.Lerp(
      camera.target,
      localPlayer.root.position.add(offset),
      0.12
    );
  }

  // ── Render loop ───────────────────────────────────────────────────────────
  function startRenderLoop(onFrameCb) {
    engine.runRenderLoop(() => {
      if (onFrameCb) onFrameCb(engine.getDeltaTime() / 1000); // seconds
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

    // Expose refs for script.js
    getScene:    () => scene,
    getCamera:   () => camera,
    getPlayer:   () => localPlayer,
    getRemotes:  () => remotePlayers,
    getEngine:   () => engine,
  };

})();
