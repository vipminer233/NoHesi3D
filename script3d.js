import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';

const CONFIG = {
    ROAD_WIDTH: 15, LANE_WIDTH: 5, LANE_COUNT: 3, ROAD_LENGTH: 200,
    MAX_SPEED: 1.2, BRAKE_POWER: 0.04, FRICTION: 0.003,
    STEERING_SPEED: 0.15, TILT_AMOUNT: 0.15,
    NITRO_MULTIPLIER: 1.5, NITRO_DURATION: 3000, NITRO_COOLDOWN: 15000,
    COLORS: {
        ROAD: 0x2c2c2c, GRASS: 0x1a4d1a, PLAYER: 0xffffff,
        TRAFFIC: [0x3366ff, 0xffcc00, 0x33cc33, 0xff66cc, 0xff9933]
    },
    BUILDING_COLORS: [0x1a1a2e, 0x16213e, 0x0f3460, 0x222233, 0x2a2a3e, 0x1e1e30, 0x333344],
    POOL_SIZE: 20
};

let scene, camera, renderer, playerCar, loadedCarModel, loadedNpcModel;
let buildings = [];
let gameRunning = false, distanceTraveled = 0, highScore = 0;
let speed = 0, targetSpeed = 0, lastTime = 0;
let nearMissTimeout = null;
let nitro = { available: 100, active: false, activatedAt: 0, recharging: false, cooldownStartedAt: 0 };
let keys = { w: false, s: false, a: false, d: false, space: false };
let cameraDistance = 1.0;
let interiorCam = false;          // Toggle: false = chase cam, true = cockpit cam
let gpTrianglePrev = false;       // Debounce for Triangle button
let fpsFrames = 0, fpsTime = 0, fpsDisplay = 0;

// --- Gamepad (PS5 DualSense) ---
let gamepadIndex = null;          // Index of the connected gamepad
let gpState = {                   // Polled every frame
    accel: 0,                     // R2 trigger  (0.0 – 1.0)
    brake: 0,                     // L2 trigger  (0.0 – 1.0)
    steerX: 0,                    // Right Stick X  (−1.0 – 1.0)
    nitro: false                  // X (Cross) button
};
const GP_DEADZONE = 0.12;         // Ignore stick noise below this

// --- Performance: cached references ---
let roadMesh = null;
const _playerBox = new THREE.Box3();
const _trafficBox = new THREE.Box3();
let hudThrottle = 0;

// --- Performance: object pool ---
let trafficPool = [];   // available cars
let activeTraffic = []; // in-use cars
let trafficMaterials = []; // pre-created materials per colour

// --- Performance: cached DOM elements ---
let domSpeedValue, domScoreValue, domGaugeArc, domNitroBar, domNitroStatus, domFpsCounter, domNearMiss;

// Gauge constants
const GAUGE_R = 130;
const GAUGE_C = 2 * Math.PI * GAUGE_R;
const GAUGE_ARC = 0.75 * GAUGE_C;

function init() {
    scene = new THREE.Scene();
    scene.background = new THREE.Color(0xa0d8ef);
    scene.fog = new THREE.FogExp2(0xa0d8ef, 0.008);

    camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.1, 1000);
    camera.position.set(0, 5, 10);
    camera.lookAt(0, 1, -10);

    const canvas = document.getElementById('gameCanvas');
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.5;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    // Enable shadow mapping for scene depth
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    const pmremGenerator = new THREE.PMREMGenerator(renderer);
    scene.environment = pmremGenerator.fromScene(new RoomEnvironment(), 0.04).texture;
    pmremGenerator.dispose(); // free GPU memory after generating env map

    scene.add(new THREE.HemisphereLight(0xffffff, 0x444444, 1.0));
    const dirLight = new THREE.DirectionalLight(0xfffaed, 2.0);
    dirLight.position.set(50, 60, 50);
    // Configure shadow casting for the directional light
    dirLight.castShadow = true;
    dirLight.shadow.mapSize.width = 1024;
    dirLight.shadow.mapSize.height = 1024;
    dirLight.shadow.camera.near = 1;
    dirLight.shadow.camera.far = 200;
    dirLight.shadow.camera.left = -30;
    dirLight.shadow.camera.right = 30;
    dirLight.shadow.camera.top = 30;
    dirLight.shadow.camera.bottom = -30;
    dirLight.shadow.bias = -0.002;
    scene.add(dirLight);

    createRoad();
    createEnvironment();
    createBuildings();
    setupGauge();

    // Cache DOM elements once
    domSpeedValue = document.getElementById('speed-value');
    domScoreValue = document.getElementById('score-value');
    domGaugeArc = document.getElementById('gauge-arc');
    domNitroBar = document.getElementById('nitro-bar');
    domNitroStatus = document.getElementById('nitro-status');
    domFpsCounter = document.getElementById('fps-counter');
    domNearMiss = document.getElementById('near-miss-popup');

    window.addEventListener('resize', onWindowResize);
    window.addEventListener('wheel', onMouseWheel, { passive: true });
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('keyup', onKeyUp);

    // Gamepad connection events
    window.addEventListener('gamepadconnected', (e) => {
        gamepadIndex = e.gamepad.index;
        console.log(`🎮 Gamepad connected: ${e.gamepad.id}`);
    });
    window.addEventListener('gamepaddisconnected', (e) => {
        if (e.gamepad.index === gamepadIndex) gamepadIndex = null;
        console.log('🎮 Gamepad disconnected');
    });
    document.getElementById('start-button').addEventListener('click', startGame);
    document.getElementById('restart-button').addEventListener('click', restartGame);

    loadHighScore();
    loadModels();
    animate(0);
}

function processGLTF(gltf, targetScale) {
    const carScene = gltf.scene;
    const box = new THREE.Box3().setFromObject(carScene);
    const size = new THREE.Vector3();
    box.getSize(size);
    const s = targetScale / Math.max(size.x, size.y, size.z);
    carScene.scale.set(s, s, s);
    carScene.updateMatrixWorld();
    const box2 = new THREE.Box3().setFromObject(carScene);
    carScene.position.y = -box2.min.y + 0.15;
    // Rotate 180° so the car faces forward (away from camera)
    carScene.rotation.y = Math.PI;

    // Enhance GLTF materials: metallic look + env map reflections + shadows
    carScene.traverse(n => {
        if (n.isMesh) {
            n.castShadow = true;
            n.receiveShadow = true;
            if (n.material) {
                n.material.metalness = Math.max(n.material.metalness || 0, 0.6);
                n.material.roughness = Math.min(n.material.roughness || 1, 0.35);
                n.material.envMapIntensity = 1.5;
                n.material.needsUpdate = true;
            }
        }
    });

    const group = new THREE.Group();
    group.add(carScene);
    return group;
}

function loadModels() {
    const loader = new GLTFLoader();

    // Load both models in parallel
    Promise.all([
        new Promise((resolve) => loader.load('car.glb', resolve, undefined, () => resolve(null))),
        new Promise((resolve) => loader.load('npccar.glb', resolve, undefined, () => resolve(null)))
    ]).then(([playerGltf, npcGltf]) => {
        if (playerGltf) {
            loadedCarModel = processGLTF(playerGltf, 4.5);
        } else {
            console.warn("Player car.glb failed, using procedural box.");
            loadedCarModel = null;
        }

        if (npcGltf) {
            loadedNpcModel = processGLTF(npcGltf, 4.5);
        } else {
            console.warn("Traffic npccar.glb failed, using fallback.");
            loadedNpcModel = null;
        }

        preCreateTrafficMaterials();
        createPlayer();
        initTrafficPool();
        enableStartButton();
    });
}

function preCreateTrafficMaterials() {
    // Create one metallic MeshStandardMaterial per traffic colour to share across pooled cars
    trafficMaterials = CONFIG.COLORS.TRAFFIC.map(color =>
        new THREE.MeshStandardMaterial({
            color,
            metalness: 0.6,
            roughness: 0.35,
            envMapIntensity: 1.5
        })
    );
}

function enableStartButton() {
    const btn = document.getElementById('start-button');
    if (btn) { btn.textContent = 'START RACE'; btn.disabled = false; }
}

function createCarMesh(color, isPlayer) {
    if (isPlayer) {
        if (!loadedCarModel) return createProceduralCar(color);
        return loadedCarModel.clone();
    } else {
        if (!loadedNpcModel) return createProceduralCar(color);
        const car = loadedNpcModel.clone();
        return car;
    }
}

function createPlayer() {
    playerCar = createCarMesh(CONFIG.COLORS.PLAYER, true);
    scene.add(playerCar);
}

// --- Object Pool ---
function initTrafficPool() {
    for (let i = 0; i < CONFIG.POOL_SIZE; i++) {
        const colorIndex = i % CONFIG.COLORS.TRAFFIC.length;
        const car = createCarMesh(CONFIG.COLORS.TRAFFIC[colorIndex], false);
        car.visible = false;
        car.userData = { speed: 0, colorIndex, nearMissScored: false };
        scene.add(car);
        trafficPool.push(car);
    }
}

function spawnFromPool(lane) {
    if (trafficPool.length === 0) return; // pool exhausted
    const car = trafficPool.pop();
    const colorIndex = lane % CONFIG.COLORS.TRAFFIC.length;

    car.position.set(-5 + lane * 5, 0, -100);
    car.rotation.set(0, 0, 0);
    car.userData.speed = 0.4 + Math.random() * 0.3;
    car.userData.nearMissScored = false; // Reset near miss status
    car.visible = true;
    activeTraffic.push(car);
}

function returnToPool(index) {
    const car = activeTraffic[index];
    car.visible = false;
    activeTraffic.splice(index, 1);
    trafficPool.push(car);
}

function createRoad() {
    const tex = new THREE.TextureLoader().load('road.jpg');
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(3, 20);
    tex.colorSpace = THREE.SRGBColorSpace;
    // Max anisotropic filtering to keep road sharp at grazing angles
    tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
    const road = new THREE.Mesh(
        new THREE.PlaneGeometry(CONFIG.ROAD_WIDTH, CONFIG.ROAD_LENGTH),
        new THREE.MeshStandardMaterial({ map: tex })
    );
    road.rotation.x = -Math.PI / 2;
    road.receiveShadow = true;
    road.name = "road_plane";
    scene.add(road);
    roadMesh = road; // cache reference
}

function createEnvironment() {
    const grass = new THREE.Mesh(
        new THREE.PlaneGeometry(500, CONFIG.ROAD_LENGTH),
        new THREE.MeshStandardMaterial({ color: CONFIG.COLORS.GRASS })
    );
    grass.rotation.x = -Math.PI / 2;
    grass.position.y = -0.1;
    grass.receiveShadow = true;
    scene.add(grass);
}

function createBuildings() {
    const cols = CONFIG.BUILDING_COLORS;
    for (let i = 0; i < 24; i++) {
        const side = i < 20 ? -1 : 1;
        const h = 8 + Math.random() * 35;
        const w = 4 + Math.random() * 6;
        const d = 6 + Math.random() * 12;
        const b = new THREE.Mesh(
            new THREE.BoxGeometry(w, h, d),
            new THREE.MeshLambertMaterial({ color: cols[Math.floor(Math.random() * cols.length)] })
        );
        b.position.set(
            side * (CONFIG.ROAD_WIDTH / 2 + 4 + Math.random() * 10),
            h / 2,
            -CONFIG.ROAD_LENGTH / 2 + (i % 12) * (CONFIG.ROAD_LENGTH / 12) + Math.random() * 5
        );
        b.userData.h = h;
        scene.add(b);
        buildings.push(b);
    }
}

function updateBuildings(dt60) {
    for (const b of buildings) {
        b.position.z += speed * dt60;
        if (b.position.z > 40) {
            b.position.z -= CONFIG.ROAD_LENGTH + 60;
        }
    }
}

function setupGauge() {
    const tg = document.getElementById('tick-marks');
    const lg = document.getElementById('tick-labels');
    if (!tg || !lg) return;
    const track = document.getElementById('gauge-track');
    const arc = document.getElementById('gauge-arc');
    const orange = document.getElementById('orange-ring');
    const gap = GAUGE_C - GAUGE_ARC;
    if (track) { track.setAttribute('stroke-dasharray', `${GAUGE_ARC} ${gap}`); track.setAttribute('transform', 'rotate(135,150,150)'); }
    if (arc) { arc.setAttribute('stroke-dasharray', `0 ${GAUGE_C}`); arc.setAttribute('transform', 'rotate(135,150,150)'); }
    if (orange) { const oC = 2 * Math.PI * 112; orange.setAttribute('stroke-dasharray', `${0.75 * oC} ${0.25 * oC}`); orange.setAttribute('transform', 'rotate(135,150,150)'); }
    for (let i = 0; i <= 7; i++) {
        const a = (135 + i * 270 / 7) * Math.PI / 180;
        // Major tick
        const t = document.createElementNS('http://www.w3.org/2000/svg', 'line');
        t.setAttribute('x1', 150 + 120 * Math.cos(a)); t.setAttribute('y1', 150 + 120 * Math.sin(a));
        t.setAttribute('x2', 150 + 132 * Math.cos(a)); t.setAttribute('y2', 150 + 132 * Math.sin(a));
        t.setAttribute('stroke', '#00d4ff'); t.setAttribute('stroke-width', '2'); t.setAttribute('opacity', '0.7');
        tg.appendChild(t);
        // Minor ticks
        if (i < 7) for (let j = 1; j <= 4; j++) {
            const ma = (135 + (i + j / 5) * 270 / 7) * Math.PI / 180;
            const mt = document.createElementNS('http://www.w3.org/2000/svg', 'line');
            mt.setAttribute('x1', 150 + 127 * Math.cos(ma)); mt.setAttribute('y1', 150 + 127 * Math.sin(ma));
            mt.setAttribute('x2', 150 + 132 * Math.cos(ma)); mt.setAttribute('y2', 150 + 132 * Math.sin(ma));
            mt.setAttribute('stroke', '#00d4ff'); mt.setAttribute('stroke-width', '1'); mt.setAttribute('opacity', '0.3');
            tg.appendChild(mt);
        }
        // Label
        const lb = document.createElementNS('http://www.w3.org/2000/svg', 'text');
        lb.setAttribute('x', 150 + 105 * Math.cos(a)); lb.setAttribute('y', 150 + 105 * Math.sin(a));
        lb.setAttribute('text-anchor', 'middle'); lb.setAttribute('dominant-baseline', 'central');
        lb.setAttribute('fill', '#7dd3fc'); lb.setAttribute('font-size', '13'); lb.setAttribute('font-family', 'Orbitron,monospace');
        lb.textContent = i; lg.appendChild(lb);
    }
}

function startGame() {
    if (!playerCar) return;
    document.getElementById('start-screen').classList.add('hidden');
    resetGame(); gameRunning = true;
}
function restartGame() {
    document.getElementById('game-over-screen').classList.add('hidden');
    resetGame(); gameRunning = true;
}
function resetGame() {
    if (playerCar) { playerCar.position.set(0, 0, 0); playerCar.rotation.set(0, 0, 0); }
    speed = 0; targetSpeed = 0; distanceTraveled = 0;
    // Return all active traffic to pool instead of removing from scene
    for (let i = activeTraffic.length - 1; i >= 0; i--) {
        returnToPool(i);
    }
    nitro.available = 100; nitro.active = false;
}

function onKeyDown(e) {
    const k = e.key.toLowerCase();
    if (k === 'w' || k === 'arrowup') keys.w = true;
    if (k === 's' || k === 'arrowdown') keys.s = true;
    if (k === 'a' || k === 'arrowleft') keys.a = true;
    if (k === 'd' || k === 'arrowright') keys.d = true;
    if (k === ' ') keys.space = true;
    if (k === 'c') interiorCam = !interiorCam;
}
function onKeyUp(e) {
    const k = e.key.toLowerCase();
    if (k === 'w' || k === 'arrowup') keys.w = false;
    if (k === 's' || k === 'arrowdown') keys.s = false;
    if (k === 'a' || k === 'arrowleft') keys.a = false;
    if (k === 'd' || k === 'arrowright') keys.d = false;
    if (k === ' ') keys.space = false;
}
function onWindowResize() {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
}
function onMouseWheel(e) {
    cameraDistance += e.deltaY * 0.001;
    cameraDistance = Math.max(0.5, Math.min(2.0, cameraDistance));
}

// --- Gamepad Polling (called every frame) ---
function pollGamepad() {
    if (gamepadIndex === null) return;
    const gp = navigator.getGamepads()[gamepadIndex];
    if (!gp) return;

    // R2 = accelerate (analog float 0.0 – 1.0)
    gpState.accel = gp.buttons[7].value;

    // L2 = brake (analog float 0.0 – 1.0)
    gpState.brake = gp.buttons[6].value;

    // Left Stick X = steering (with deadzone)
    const rawX = gp.axes[0];
    gpState.steerX = Math.abs(rawX) > GP_DEADZONE ? rawX : 0;

    // X (Cross) button = nitro (during gameplay) or start/restart (on menus)
    gpState.nitro = gp.buttons[0].pressed;
    if (gp.buttons[0].pressed && !gameRunning) {
        const startScreen = document.getElementById('start-screen');
        const gameOverScreen = document.getElementById('game-over-screen');
        if (startScreen && !startScreen.classList.contains('hidden')) startGame();
        else if (gameOverScreen && !gameOverScreen.classList.contains('hidden')) restartGame();
    }

    // Triangle button = toggle interior camera (with debounce)
    const triNow = gp.buttons[3].pressed;
    if (triNow && !gpTrianglePrev) interiorCam = !interiorCam;
    gpTrianglePrev = triNow;
}

function animate(time) {
    requestAnimationFrame(animate);
    if (!playerCar) return;

    // Delta time (capped at ~30 fps equivalent to avoid spiral-of-death)
    const rawDt = (time - lastTime) / 1000;
    const dt = Math.min(rawDt, 0.033);
    const dt60 = dt * 60; // scale factor to match original 60fps behaviour

    // FPS counter
    fpsFrames++;
    if (time - fpsTime >= 1000) { fpsDisplay = fpsFrames; fpsFrames = 0; fpsTime = time; }
    lastTime = time;

    if (gameRunning) {
        pollGamepad();
        updatePhysics(dt60);
        updateTraffic(dt60);
        updateBuildings(dt60);
        updateNitro(time);
        detectCollisions();
        updateCamera(dt60);
        updateHUD();
        // Use cached road reference
        if (roadMesh) roadMesh.material.map.offset.y += speed * 0.1 * dt60;
    }
    renderer.render(scene, camera);
}

function updatePhysics(dt60) {
    let maxS = CONFIG.MAX_SPEED;
    if (nitro.active) maxS *= CONFIG.NITRO_MULTIPLIER;

    // --- Merge inputs: keyboard OR gamepad (whichever is stronger) ---
    const accelInput = Math.max(keys.w ? 1 : 0, gpState.accel);   // 0.0 – 1.0
    const brakeInput = Math.max(keys.s ? 1 : 0, gpState.brake);   // 0.0 – 1.0
    const steerLeft = (keys.a ? 1 : 0) + Math.max(0, -gpState.steerX);
    const steerRight = (keys.d ? 1 : 0) + Math.max(0, gpState.steerX);
    const steerInput = Math.min(1, steerRight) - Math.min(1, steerLeft); // −1 … +1

    // Acceleration / braking (analog-aware)
    if (accelInput > 0.05) targetSpeed = maxS * accelInput;
    else if (brakeInput > 0.05) targetSpeed = 0;
    else targetSpeed = Math.max(0, targetSpeed - CONFIG.FRICTION * dt60);

    const lerpRate = brakeInput > 0.05 ? 0.04 : 0.02;
    speed += (targetSpeed - speed) * lerpRate * dt60;
    speed = Math.max(0, Math.min(speed, maxS));
    if (speed < 0.001) speed = 0;

    // Steering (analog-aware)
    if (speed > 0.05 && Math.abs(steerInput) > 0.01) {
        playerCar.position.x += steerInput * CONFIG.STEERING_SPEED * dt60;
        if (!interiorCam) {
            const tilt = -steerInput * CONFIG.TILT_AMOUNT;
            playerCar.rotation.z += (tilt - playerCar.rotation.z) * 0.1 * dt60;
        } else {
            playerCar.rotation.z += (0 - playerCar.rotation.z) * 0.2 * dt60;
        }
    } else if (speed > 0.05) {
        playerCar.rotation.z += (0 - playerCar.rotation.z) * 0.1 * dt60;
    }

    const edge = CONFIG.ROAD_WIDTH / 2 - 1.5;
    playerCar.position.x = Math.max(-edge, Math.min(edge, playerCar.position.x));
    distanceTraveled += speed * dt60;
}

function updateCamera(dt60) {
    if (interiorCam) {
        // Dash/Hood camera — looking straight ahead at the road
        camera.position.x = playerCar.position.x;
        camera.position.y = playerCar.position.y + 1.2;
        camera.position.z = playerCar.position.z - 2.5; // Moved far forward to hide dashboard
        camera.lookAt(playerCar.position.x, 0.5, -50);
    } else {
        // Exterior chase camera (original)
        const camY = 3 + 3 * cameraDistance;
        const camZ = 5 + 5 * cameraDistance;
        camera.position.x += (playerCar.position.x * 0.5 - camera.position.x) * 0.08 * dt60;
        camera.position.y += (camY - camera.position.y) * 0.05 * dt60;
        camera.position.z += (camZ - camera.position.z) * 0.05 * dt60;
        camera.lookAt(playerCar.position.x * 0.3, 1, -15);
    }
}

function updateTraffic(dt60) {
    // Spawn using pool
    if (Math.random() < 0.02 && activeTraffic.length < 8) {
        const lane = Math.floor(Math.random() * 3);
        spawnFromPool(lane);
    }
    // Move and recycle
    for (let i = activeTraffic.length - 1; i >= 0; i--) {
        const c = activeTraffic[i];
        c.position.z += (speed - c.userData.speed) * dt60;
        if (c.position.z > 20 || c.position.z < -200) {
            returnToPool(i);
        }
    }
}

function detectCollisions() {
    // Reuse pre-allocated Box3 objects instead of creating new ones each frame
    _playerBox.setFromObject(playerCar).expandByScalar(-0.2);
    for (const car of activeTraffic) { // Iterate activeTraffic, not trafficPool
        if (!car.visible) continue;

        // Use bounding boxes for collision detection
        _trafficBox.setFromObject(car).expandByScalar(-0.1);

        // Crash logic
        if (_playerBox.intersectsBox(_trafficBox)) {
            gameRunning = false;
            document.getElementById('game-over-screen').classList.remove('hidden');
            document.getElementById('final-score').innerText = Math.floor(distanceTraveled);
            if (distanceTraveled > highScore) {
                highScore = distanceTraveled;
                localStorage.setItem('noHesi3dHighScore', highScore);
            }
            document.getElementById('game-over-high-score').innerText = Math.floor(highScore);
            return; // Exit after first collision
        }

        // Near Miss logic
        // Z diff positive means player is ahead of traffic car. 
        // We only check once it is just slightly behind (passedZ > 4.5 means rear bumper cleared)
        const passedZ = playerCar.position.z - car.position.z;
        if (passedZ > 4.5 && passedZ < 15 && !car.userData.nearMissScored) {
            // Check if horizontal distance is very close but not crashed (between 1.8 and 3.0 units)
            const dx = Math.abs(playerCar.position.x - car.position.x);
            if (dx >= 1.8 && dx < 3.0) {
                car.userData.nearMissScored = true;
                scoreNearMiss();
            }
        }
    }
}

function scoreNearMiss() {
    distanceTraveled += 150;
    if (domNearMiss) {
        domNearMiss.classList.add('show');
        domNearMiss.classList.remove('hidden');
        if (nearMissTimeout) clearTimeout(nearMissTimeout);
        nearMissTimeout = setTimeout(() => {
            domNearMiss.classList.remove('show');
            domNearMiss.classList.add('hidden');
        }, 1000);
    }
}

function updateNitro(time) {
    if (nitro.active) {
        nitro.available = Math.max(0, 100 - ((time - nitro.activatedAt) / CONFIG.NITRO_DURATION) * 100);
        if (nitro.available <= 0) { nitro.active = false; nitro.recharging = true; nitro.cooldownStartedAt = time; }
    } else if (nitro.recharging) {
        nitro.available = Math.min(100, ((time - nitro.cooldownStartedAt) / CONFIG.NITRO_COOLDOWN) * 100);
        if (nitro.available >= 100) nitro.recharging = false;
    }
    if ((keys.space || gpState.nitro) && !nitro.active && !nitro.recharging && nitro.available >= 100) {
        nitro.active = true; nitro.activatedAt = time;
    }
}

function updateHUD() {
    // Throttle DOM writes to every 3rd frame (~20 Hz) to reduce layout thrashing
    if (++hudThrottle % 3 !== 0) return;

    const mph = Math.floor(speed * 200);
    domSpeedValue.innerText = mph;
    domScoreValue.innerText = Math.floor(distanceTraveled);
    // Gauge arc
    if (domGaugeArc) {
        const frac = Math.min(1, speed / CONFIG.MAX_SPEED);
        domGaugeArc.setAttribute('stroke-dasharray', `${frac * GAUGE_ARC} ${GAUGE_C}`);
    }
    // Nitro
    domNitroBar.style.width = `${nitro.available}%`;
    if (nitro.recharging) { domNitroStatus.innerText = "RECHARGING"; domNitroStatus.className = "recharging"; }
    else if (nitro.active) { domNitroStatus.innerText = "BOOSTING"; domNitroStatus.className = ""; }
    else { domNitroStatus.innerText = "READY"; domNitroStatus.className = ""; }
    // FPS
    if (domFpsCounter) domFpsCounter.innerText = 'FPS: ' + fpsDisplay;
}

function loadHighScore() {
    const s = localStorage.getItem('noHesi3dHighScore');
    if (s) { highScore = parseFloat(s); document.getElementById('high-score-value').innerText = Math.floor(highScore); }
}

function createProceduralCar(color) {
    const g = new THREE.Group();
    const body = new THREE.Mesh(
        new THREE.BoxGeometry(2, 1, 4),
        new THREE.MeshStandardMaterial({ color, metalness: 0.6, roughness: 0.35, envMapIntensity: 1.5 })
    );
    body.castShadow = true;
    body.receiveShadow = true;
    body.position.y = 0.5;
    g.add(body);
    return g;
}

init();