/**
 * Original explanatory illustration inspired by the OpenFlexure microscope:
 * https://openflexure.org/projects/microscope/
 * A printed flexure stage, illumination above the specimen, inverted objective
 * and Raspberry Pi camera below it. NOT project CAD, manufacturing geometry,
 * an assembly guide, or a dimensionally accurate reproduction of any version.
 * Bundle as a browser ES module; Three.js and OrbitControls remain build imports.
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const host = document.getElementById('hardware-viewer');
if (host) initializeViewer(host);

function initializeViewer(host) {
  const range = document.getElementById('hardware-explode');
  const reset = document.getElementById('hardware-reset');
  const rotate = document.getElementById('hardware-rotate');
  const label = document.getElementById('hardware-part');
  const fallback = document.getElementById('hardware-fallback');
  const motion = matchMedia('(prefers-reduced-motion: reduce)');
  const cleanups = [];
  const geometries = new Set();
  const materials = new Set();
  const textures = new Set();
  const parts = [];
  const pickables = [];
  let renderer;
  let controls;
  let resizeObserver;
  let intersectionObserver;
  let frame = 0;
  let lastTime = 0;
  let disposed = false;
  let contextLost = false;
  let inView = !('IntersectionObserver' in window);
  let hasSize = false;
  let dragging = false;
  let pointerStart = null;
  let selected = null;
  let hovered = null;
  let reduced = motion.matches;
  let spinning = !reduced && Boolean(rotate) && rotate.getAttribute('aria-pressed') !== 'false';
  const initialExplosion = 0.78;
  let targetExplosion = readExplosion();
  let explosion = targetExplosion;
  let needsFit = true;
  const defaultLabel = 'Inverted optics · light above, objective and camera below the specimen';
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(34, 1, 0.1, 100);
  const assembly = new THREE.Group();
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  const viewDirection = new THREE.Vector3(8, 5, 12).normalize();
  scene.add(assembly);

  function listen(target, name, callback, options) {
    if (!target) return;
    target.addEventListener(name, callback, options);
    cleanups.push(() => target.removeEventListener(name, callback, options));
  }

  function readExplosion() {
    const value = range ? Number(range.value) : 78;
    return Number.isFinite(value) ? THREE.MathUtils.clamp(value / 100, 0, 1) : initialExplosion;
  }

  function material(parameters) {
    const result = new THREE.MeshStandardMaterial(parameters);
    materials.add(result);
    return result;
  }

  function mesh(parent, geometry, surface, x = 0, y = 0, z = 0) {
    geometries.add(geometry);
    const result = new THREE.Mesh(geometry, surface);
    result.position.set(x, y, z);
    result.castShadow = true;
    result.receiveShadow = true;
    parent.add(result);
    return result;
  }

  function box(parent, dimensions, surface, x = 0, y = 0, z = 0) {
    return mesh(parent, new THREE.BoxGeometry(...dimensions), surface, x, y, z);
  }

  function cylinder(parent, radius, height, surface, x = 0, y = 0, z = 0, top = radius) {
    return mesh(parent, new THREE.CylinderGeometry(top, radius, height, 48), surface, x, y, z);
  }

  function ring(parent, outer, inner, height, surface, x = 0, y = 0, z = 0) {
    const shape = new THREE.Shape();
    shape.absarc(0, 0, outer, 0, Math.PI * 2, false);
    const hole = new THREE.Path();
    hole.absarc(0, 0, inner, 0, Math.PI * 2, true);
    shape.holes.push(hole);
    const geometry = new THREE.ExtrudeGeometry(shape, {
      depth: height, bevelEnabled: true, bevelSegments: 2,
      steps: 1, bevelSize: 0.012, bevelThickness: 0.012, curveSegments: 40,
    });
    geometry.rotateX(-Math.PI / 2);
    geometry.translate(0, -height / 2, 0);
    return mesh(parent, geometry, surface, x, y, z);
  }

  // Rounded horizontal plates with real through-bores, not painted-on holes.
  function plate(parent, width, depth, height, radius, holes, surface, y = 0) {
    const x = -width / 2;
    const z = -depth / 2;
    const shape = new THREE.Shape();
    shape.moveTo(x + radius, z);
    shape.lineTo(x + width - radius, z);
    shape.quadraticCurveTo(x + width, z, x + width, z + radius);
    shape.lineTo(x + width, z + depth - radius);
    shape.quadraticCurveTo(x + width, z + depth, x + width - radius, z + depth);
    shape.lineTo(x + radius, z + depth);
    shape.quadraticCurveTo(x, z + depth, x, z + depth - radius);
    shape.lineTo(x, z + radius);
    shape.quadraticCurveTo(x, z, x + radius, z);
    for (const [hx, hz, r] of holes) {
      const hole = new THREE.Path();
      hole.absarc(hx, hz, r, 0, Math.PI * 2, true);
      shape.holes.push(hole);
    }
    const geometry = new THREE.ExtrudeGeometry(shape, {
      depth: height, bevelEnabled: true, bevelSegments: 2, steps: 1,
      bevelSize: Math.min(0.035, height / 5), bevelThickness: Math.min(0.025, height / 5),
      curveSegments: 20,
    });
    geometry.rotateX(-Math.PI / 2);
    geometry.translate(0, -height / 2, 0);
    return mesh(parent, geometry, surface, 0, y, 0);
  }

  function strut(parent, start, end, radius, surface) {
    const a = new THREE.Vector3(...start);
    const b = new THREE.Vector3(...end);
    const result = cylinder(parent, radius, a.distanceTo(b), surface);
    result.position.copy(a).add(b).multiplyScalar(0.5);
    result.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.sub(a).normalize());
    return result;
  }

  function part(name, description, position, offset) {
    const group = new THREE.Group();
    group.position.set(...position);
    group.userData = { name, description, assembled: new THREE.Vector3(...position), offset: new THREE.Vector3(...offset) };
    parts.push(group);
    assembly.add(group);
    return group;
  }

  try {
    renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, powerPreference: 'low-power' });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
    renderer.setClearColor(0xffffff, 0);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.18;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    const canvas = renderer.domElement;
    canvas.className = 'hardware-viewer__canvas';
    canvas.setAttribute('role', 'img');
    canvas.setAttribute('aria-label', 'Interactive illustrative OpenFlexure-inspired microscope. Illumination above a glass slide; a flexure stage, inverted objective, camera, and control board below. Drag to orbit. Use the separate explosion, reset and rotation controls.');
    host.appendChild(canvas);

    controls = new OrbitControls(camera, canvas);
    controls.enableZoom = false;
    controls.enablePan = false;
    controls.enableDamping = !reduced;
    controls.dampingFactor = 0.09;
    controls.rotateSpeed = 0.65;
    controls.autoRotateSpeed = 0.42;
    controls.minPolarAngle = Math.PI * 0.24;
    controls.maxPolarAngle = Math.PI * 0.65;
    // OrbitControls sets touch-action:none. Restore vertical page scrolling:
    // horizontal one-finger gestures orbit; vertical gestures belong to the page.
    canvas.style.touchAction = 'pan-y';
    controls.touches.ONE = THREE.TOUCH.ROTATE;
    controls.touches.TWO = THREE.TOUCH.DOLLY_PAN;

    const charcoal = material({ color: 0x30353b, roughness: 0.77, metalness: 0.08 });
    const edge = material({ color: 0x474f57, roughness: 0.7, metalness: 0.12 });
    const black = material({ color: 0x151a20, roughness: 0.46, metalness: 0.18 });
    const rubber = material({ color: 0x23282c, roughness: 0.96 });
    const aluminum = material({ color: 0xc9d1da, metalness: 0.82, roughness: 0.26 });
    const brushed = material({ color: 0x8e9aa8, metalness: 0.7, roughness: 0.39 });
    const brass = material({ color: 0xc4a466, metalness: 0.73, roughness: 0.3 });
    const green = material({ color: 0x176346, roughness: 0.57, metalness: 0.17 });
    const trace = material({ color: 0x79aa73, roughness: 0.57, metalness: 0.35 });
    const ceramic = material({ color: 0xdedbcf, roughness: 0.66 });
    const accent = material({ color: 0xd19242, metalness: 0.55, roughness: 0.3 });
    const glass = new THREE.MeshPhysicalMaterial({
      color: 0xb9e0e0, metalness: 0, roughness: 0.1, transmission: 0.65,
      thickness: 0.07, transparent: true, opacity: 0.65, ior: 1.5,
      clearcoat: 1, side: THREE.DoubleSide, depthWrite: false,
    });
    materials.add(glass);
    const opticalGlass = new THREE.MeshPhysicalMaterial({
      color: 0x72bfc1, metalness: 0.25, roughness: 0.08,
      clearcoat: 1, transparent: true, opacity: 0.8,
    });
    materials.add(opticalGlass);

    // Subtle deterministic print-layer bump texture (no assets or network I/O).
    const bumpData = new Uint8Array(64 * 64 * 4);
    for (let i = 0; i < 64 * 64; i++) {
      const value = 148 + (Math.floor(i / 64) % 4 === 0 ? 35 : 0) + (i * 17 % 13);
      bumpData.set([value, value, value, 255], i * 4);
    }
    const bump = new THREE.DataTexture(bumpData, 64, 64);
    bump.wrapS = bump.wrapT = THREE.RepeatWrapping;
    bump.repeat.set(3, 8);
    bump.needsUpdate = true;
    textures.add(bump);
    charcoal.bumpMap = bump;
    charcoal.bumpScale = 0.018;

    function screw(parent, x, y, z, scale = 1) {
      cylinder(parent, 0.064 * scale, 0.07 * scale, aluminum, x, y, z);
      const socket = mesh(parent, new THREE.CylinderGeometry(0.032 * scale, 0.032 * scale, 0.006, 6), black, x, y + 0.036 * scale, z);
      socket.castShadow = false;
      ring(parent, 0.087 * scale, 0.045 * scale, 0.012, brushed, x, y - 0.035 * scale, z);
    }

    function chip(parent, x, z, width, depth, y = 0.12) {
      box(parent, [width, 0.11, depth], black, x, y, z);
      for (let i = 0; i < 6; i++) {
        const p = (i / 5 - 0.5) * depth * 0.8;
        box(parent, [0.08, 0.025, 0.025], aluminum, x - width / 2 - 0.025, y - 0.035, z + p);
        box(parent, [0.08, 0.025, 0.025], aluminum, x + width / 2 + 0.025, y - 0.035, z + p);
      }
    }

    const base = part('Instrument base', 'Printed foundation with isolation feet and mounting bores.', [0, 0.23, 0], [0, 0, 0]);
    const mountHoles = [[-1.25, -0.95, 0.1], [1.25, -0.95, 0.1], [-1.25, 0.95, 0.1], [1.25, 0.95, 0.1]];
    plate(base, 3.25, 2.65, 0.24, 0.3, mountHoles, charcoal);
    plate(base, 2.85, 2.3, 0.065, 0.25, [[0, 0, 0.65]], edge, 0.16);
    for (const [x, z] of mountHoles) {
      cylinder(base, 0.19, 0.15, rubber, x, -0.18, z);
      screw(base, x, 0.15, z);
    }
    for (let i = 0; i < 7; i++) box(base, [0.055, 0.045, 0.4], black, -0.45 + i * 0.15, 0.205, 0.86);

    const board = part('Raspberry Pi / control electronics', 'Illustrative single-board computer, GPIO header and motor-control connections.', [0, 0.7, 0], [0, 0.5, 0]);
    const boardHoles = [[-1.03, -0.73, 0.06], [1.03, -0.73, 0.06], [-1.03, 0.73, 0.06], [1.03, 0.73, 0.06]];
    plate(board, 2.35, 1.75, 0.065, 0.12, boardHoles, green);
    for (const [x, z] of boardHoles) {
      ring(board, 0.1, 0.06, 0.012, brass, x, 0.042, z);
      cylinder(board, 0.075, 0.24, brass, x, -0.15, z);
      screw(board, x, 0.09, z, 0.65);
    }
    chip(board, -0.2, -0.08, 0.58, 0.55);
    box(board, [0.39, 0.025, 0.37], brushed, -0.2, 0.19, -0.08);
    chip(board, 0.52, 0.1, 0.28, 0.32);
    chip(board, -0.52, 0.49, 0.25, 0.2);
    for (let i = 0; i < 13; i++) {
      const x = -0.9 + i * 0.13;
      box(board, [0.018, 0.009, 0.25 + (i % 3) * 0.06], trace, x, 0.041, -0.31);
      box(board, [0.10, 0.009, 0.018], trace, x + 0.043, 0.042, -0.18);
      box(board, [0.065, 0.05, 0.034], i % 3 ? ceramic : black, x, 0.072, 0.36);
    }
    box(board, [1.45, 0.12, 0.19], black, -0.12, 0.105, -0.69);
    for (let i = 0; i < 16; i++) {
      for (const z of [-0.735, -0.65]) cylinder(board, 0.016, 0.19, brass, -0.77 + i * 0.087, 0.21, z);
    }
    for (const z of [-0.33, 0.24]) {
      box(board, [0.38, 0.32, 0.43], aluminum, 1.06, 0.19, z);
      box(board, [0.014, 0.2, 0.32], black, 1.258, 0.19, z);
      box(board, [0.016, 0.045, 0.27], ceramic, 1.269, 0.19, z);
    }
    box(board, [0.36, 0.1, 0.17], ceramic, -0.78, 0.1, 0.7);
    const led = material({ color: 0x9adc6c, emissive: 0x639d31, emissiveIntensity: 0.5, roughness: 0.4 });
    box(board, [0.055, 0.04, 0.04], led, 0.8, 0.065, 0.67);

    const cameraPart = part('Camera module', 'Image sensor beneath the inverted optics; ribbon connection to the control board.', [0, 1.35, 0], [0, 1.15, 0]);
    plate(cameraPart, 1.13, 0.98, 0.06, 0.09, [[-0.43, -0.34, 0.05], [0.43, 0.34, 0.05]], green);
    box(cameraPart, [0.57, 0.14, 0.57], black, 0, 0.11, 0);
    box(cameraPart, [0.34, 0.024, 0.29], opticalGlass, 0, 0.19, 0);
    ring(cameraPart, 0.34, 0.235, 0.095, brushed, 0, 0.22, 0);
    for (const x of [-0.43, 0.43]) screw(cameraPart, x, 0.08, x > 0 ? -0.34 : 0.34, 0.65);
    box(cameraPart, [0.48, 0.09, 0.13], ceramic, 0, 0.075, 0.43);
    const ribbonCurve = new THREE.CatmullRomCurve3([
      new THREE.Vector3(0, 0.07, 0.48), new THREE.Vector3(0, -0.06, 0.67),
      new THREE.Vector3(0, -0.36, 0.72), new THREE.Vector3(0, -0.48, 0.84),
    ]);
    // Flat flexible ribbon with visible parallel copper conductors.
    for (let i = 0; i < 12; i++) {
      const points = ribbonCurve.getPoints(16).map(p => p.add(new THREE.Vector3((i - 5.5) * 0.029, 0, 0)));
      mesh(cameraPart, new THREE.TubeGeometry(new THREE.CatmullRomCurve3(points), 20, 0.014, 4, false), i % 3 === 0 ? brass : ceramic);
    }

    const objective = part('Precision objective · inverted', 'The objective sits BELOW the slide, collecting transmitted light down toward the camera.', [0, 2.15, 0], [0, 1.9, 0]);
    ring(objective, 0.57, 0.3, 0.15, charcoal, 0, -0.45);
    ring(objective, 0.47, 0.265, 0.2, aluminum, 0, -0.28);
    ring(objective, 0.41, 0.225, 0.52, brushed, 0, 0.02);
    ring(objective, 0.34, 0.2, 0.22, aluminum, 0, 0.38);
    ring(objective, 0.28, 0.175, 0.1, black, 0, 0.55);
    cylinder(objective, 0.17, 0.035, opticalGlass, 0, 0.6);
    ring(objective, 0.421, 0.39, 0.06, accent, 0, 0.18);
    for (let i = 0; i < 6; i++) ring(objective, 0.476, 0.44, 0.015, brushed, 0, -0.36 + i * 0.031);
    for (let i = 0; i < 36; i++) {
      const angle = i * Math.PI / 18;
      const ridge = box(objective, [0.022, 0.19, 0.025], aluminum, Math.sin(angle) * 0.413, -0.04, Math.cos(angle) * 0.413);
      ridge.rotation.y = angle;
    }

    const stage = part('Printed flexure stage', 'Compliant leaf struts guide fine specimen motion without conventional sliding bearings.', [0, 3.08, 0], [0, 2.7, 0]);
    plate(stage, 2.65, 2.38, 0.23, 0.3, [[0, 0, 0.58], [-0.98, -0.81, 0.08], [0.98, -0.81, 0.08], [-0.98, 0.81, 0.08], [0.98, 0.81, 0.08]], charcoal);
    ring(stage, 0.72, 0.58, 0.045, edge, 0, 0.14);
    plate(stage, 2.74, 2.48, 0.16, 0.26, [[0, 0, 0.85]], charcoal, -0.95);
    // Three pairs of folded compliant leaves around an open optical aperture.
    for (let i = 0; i < 3; i++) {
      const arm = new THREE.Group();
      arm.rotation.y = i * Math.PI * 2 / 3;
      stage.add(arm);
      for (const x of [-0.26, 0.26]) {
        box(arm, [0.09, 0.76, 0.12], edge, x, -0.51, 0.96);
        box(arm, [0.09, 0.7, 0.12], charcoal, x, -0.47, 1.18);
        box(arm, [0.14, 0.1, 0.38], charcoal, x, -0.83, 1.08);
      }
      box(arm, [0.77, 0.15, 0.36], charcoal, 0, -0.16, 1.08);
      ring(arm, 0.145, 0.065, 0.19, brass, 0, -0.23, 1.16);
    }
    for (const x of [-0.99, 0.99]) {
      for (const z of [-0.8, 0.8]) screw(stage, x, 0.15, z);
      box(stage, [0.13, 0.055, 0.65], aluminum, x, 0.22, 0);
      screw(stage, x, 0.265, 0.25, 0.7);
    }
    for (let i = 0; i < 6; i++) {
      box(stage, [0.55, 0.013, 0.007], edge, -0.68, -0.075 + i * 0.03, 1.208);
      box(stage, [0.55, 0.013, 0.007], edge, 0.68, -0.075 + i * 0.03, 1.208);
    }

    const slide = part('Specimen slide', 'Transparent slide over the stage aperture; the specimen is illuminated from above.', [0, 3.4, 0], [0, 3.42, 0]);
    const slideMesh = plate(slide, 2.23, 0.85, 0.045, 0.045, [], glass);
    slideMesh.castShadow = false;
    box(slide, [0.4, 0.012, 0.78], ceramic, -0.84, 0.035, 0);
    box(slide, [0.24, 0.006, 0.021], brushed, -0.84, 0.045, -0.15);
    box(slide, [0.18, 0.006, 0.021], brushed, -0.87, 0.045, -0.06);
    const specimen = material({ color: 0xb87788, transparent: true, opacity: 0.55, roughness: 0.54 });
    const sample = cylinder(slide, 0.16, 0.009, specimen, 0, 0.035);
    sample.scale.z = 0.72;
    const cover = box(slide, [0.5, 0.012, 0.49], glass, 0, 0.06, 0);
    cover.rotation.y = 0.08;
    cover.castShadow = false;

    const illuminator = part('Top illuminator', 'LED and condenser above the specimen establish the transmitted-light path.', [0, 4.55, 0], [0, 4.3, 0]);
    ring(illuminator, 0.57, 0.32, 0.28, charcoal);
    ring(illuminator, 0.46, 0.29, 0.13, aluminum, 0, -0.22);
    cylinder(illuminator, 0.28, 0.04, opticalGlass, 0, -0.3);
    ring(illuminator, 0.5, 0.35, 0.06, brushed, 0, 0.19);
    plate(illuminator, 0.65, 0.65, 0.05, 0.09, [[-0.23, -0.23, 0.04], [0.23, 0.23, 0.04]], green, 0.25);
    cylinder(illuminator, 0.12, 0.05, ceramic, 0, 0.3);
    for (let i = 0; i < 8; i++) {
      box(illuminator, [0.035, 0.17, 0.38], brushed, -0.25 + i * 0.071, 0.4, 0);
    }
    box(illuminator, [0.29, 0.22, 0.7], charcoal, 0, 0.04, -0.63);
    strut(illuminator, [0, 0.04, -0.94], [0, -0.9, -1.08], 0.12, charcoal);
    screw(illuminator, 0, 0.19, -0.79);

    const motorPositions = [[-1.92, 2.18, 0.24], [1.92, 2.18, 0.24], [0, 2.18, -1.93]];
    motorPositions.forEach((position, index) => {
      const radial = new THREE.Vector3(position[0], 0, position[2]).normalize();
      const motor = part(`Motor actuator ${index + 1}`, 'Geared motor and fine-pitch drive act on the printed flexure mechanism; illustrative routing.', position, [radial.x * 0.65, 2.52, radial.z * 0.65]);
      const body = cylinder(motor, 0.32, 0.55, brushed, 0, -0.05);
      body.rotation.x = Math.PI / 2;
      const cap = cylinder(motor, 0.325, 0.095, black, 0, -0.05, 0.31);
      cap.rotation.x = Math.PI / 2;
      box(motor, [0.64, 0.15, 0.52], charcoal, 0, -0.38, 0);
      box(motor, [0.64, 0.085, 0.25], aluminum, 0, 0.26, 0);
      cylinder(motor, 0.12, 0.15, brass, 0, 0.36);
      cylinder(motor, 0.055, 0.54, aluminum, 0, 0.67);
      for (let i = 0; i < 12; i++) ring(motor, 0.073, 0.05, 0.012, brushed, 0, 0.42 + i * 0.039);
      for (const x of [-0.24, 0.24]) screw(motor, x, 0.32, 0, 0.7);
      const cableCurve = new THREE.CatmullRomCurve3([
        new THREE.Vector3(0.2, -0.08, -0.3), new THREE.Vector3(0.4, -0.2, -0.38),
        new THREE.Vector3(0.42, -0.57, -0.32), new THREE.Vector3(0.23, -0.7, -0.21),
      ]);
      mesh(motor, new THREE.TubeGeometry(cableCurve, 20, 0.027, 6, false), black);
      motor.rotation.y = index === 0 ? -0.5 : index === 1 ? 0.5 : Math.PI;
    });

    // Mesh-derived contact shading plus a wide, soft studio footprint.
    const shadowCanvas = document.createElement('canvas');
    shadowCanvas.width = shadowCanvas.height = 128;
    const ctx = shadowCanvas.getContext('2d');
    if (ctx) {
      const gradient = ctx.createRadialGradient(64, 64, 5, 64, 64, 64);
      gradient.addColorStop(0, 'rgba(30,40,50,0.27)');
      gradient.addColorStop(0.45, 'rgba(30,40,50,0.12)');
      gradient.addColorStop(1, 'rgba(30,40,50,0)');
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, 128, 128);
      const texture = new THREE.CanvasTexture(shadowCanvas);
      textures.add(texture);
      const shadowMaterial = new THREE.MeshBasicMaterial({ map: texture, transparent: true, depthWrite: false });
      materials.add(shadowMaterial);
      const contact = mesh(scene, new THREE.PlaneGeometry(6.8, 5.4), shadowMaterial, 0, -0.009);
      contact.rotation.x = -Math.PI / 2;
      contact.castShadow = contact.receiveShadow = false;
    }
    const shadowMaterial = new THREE.ShadowMaterial({ opacity: 0.12 });
    materials.add(shadowMaterial);
    const floor = mesh(scene, new THREE.PlaneGeometry(200, 200), shadowMaterial, 0, -0.015);
    floor.rotation.x = -Math.PI / 2;
    floor.castShadow = false;

    scene.add(new THREE.HemisphereLight(0xf2f6ff, 0x909388, 2.8));
    const key = new THREE.DirectionalLight(0xfff4df, 4.2);
    key.position.set(5, 11, 7);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    Object.assign(key.shadow.camera, { left: -7, right: 7, top: 11, bottom: -7, near: 0.5, far: 35 });
    key.shadow.normalBias = 0.035;
    key.shadow.bias = -0.00015;
    key.shadow.radius = 3;
    key.target.position.set(0, 4, 0);
    scene.add(key, key.target);
    const fill = new THREE.DirectionalLight(0xdceaff, 2.3);
    fill.position.set(-6, 6, -4);
    scene.add(fill);
    const rim = new THREE.DirectionalLight(0xffffff, 2.8);
    rim.position.set(2, 9, -6);
    scene.add(rim);

    for (const group of parts) {
      group.traverse(object => {
        if (object.isMesh) {
          object.userData.part = group;
          pickables.push(object);
        }
      });
    }
    // The outline is a fine technical selection aid, never manufacturing CAD.
    const outlineMaterial = new THREE.LineBasicMaterial({ color: 0xa57538, transparent: true, opacity: 0.45, depthTest: false });
    materials.add(outlineMaterial);
    const outline = new THREE.Box3Helper(new THREE.Box3(), 0xa57538);
    outline.material.dispose();
    outline.material = outlineMaterial;
    geometries.add(outline.geometry);
    outline.visible = false;
    scene.add(outline);

    function updateLabel() {
      const active = hovered || selected;
      if (label) {
        const text = active ? `${active.userData.name} — ${active.userData.description}` : defaultLabel;
        if (label.textContent !== text) label.textContent = text;
      }
      host.dataset.activePart = active?.userData.name || '';
      host.classList.toggle('hardware-viewer--hover', Boolean(hovered));
      outline.visible = Boolean(active);
      if (active) outline.box.setFromObject(active).expandByScalar(0.055);
    }

    function setPositions() {
      for (const group of parts) group.position.copy(group.userData.assembled).addScaledVector(group.userData.offset, explosion);
      assembly.updateMatrixWorld(true);
      host.dataset.explosion = (explosion * 100).toFixed(1);
      updateLabel();
    }

    function fitCamera() {
      if (!hasSize) return;
      // Fit all eight corners in the CURRENT viewing direction, including motors.
      // A cylinder-enclosing box also keeps every yaw angle safe during auto-spin.
      const bounds = new THREE.Box3().setFromObject(assembly);
      const center = bounds.getCenter(new THREE.Vector3());
      const radius = Math.max(Math.abs(bounds.min.x), Math.abs(bounds.max.x), Math.abs(bounds.min.z), Math.abs(bounds.max.z)) * 1.15;
      bounds.min.x = bounds.min.z = -radius;
      bounds.max.x = bounds.max.z = radius;
      const direction = camera.position.clone().sub(controls.target).normalize();
      if (direction.lengthSq() === 0) direction.copy(viewDirection);
      const right = new THREE.Vector3().crossVectors(camera.up, direction).normalize();
      const up = new THREE.Vector3().crossVectors(direction, right).normalize();
      const tanY = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
      const tanX = tanY * camera.aspect;
      let distance = 1;
      for (const x of [bounds.min.x, bounds.max.x]) {
        for (const y of [bounds.min.y, bounds.max.y]) {
          for (const z of [bounds.min.z, bounds.max.z]) {
            const p = new THREE.Vector3(x, y, z).sub(center);
            distance = Math.max(distance, Math.abs(p.dot(right)) / tanX + p.dot(direction), Math.abs(p.dot(up)) / tanY + p.dot(direction));
          }
        }
      }
      controls.target.copy(center);
      camera.position.copy(center).addScaledVector(direction, distance * 1.09);
      camera.lookAt(center);
      camera.updateProjectionMatrix();
      needsFit = false;
    }

    function hit(event) {
      const rect = canvas.getBoundingClientRect();
      if (!rect.width || !rect.height) return null;
      pointer.set((event.clientX - rect.left) / rect.width * 2 - 1, -(event.clientY - rect.top) / rect.height * 2 + 1);
      scene.updateMatrixWorld(true);
      camera.updateMatrixWorld(true);
      raycaster.setFromCamera(pointer, camera);
      return raycaster.intersectObjects(pickables, false)[0]?.object.userData.part || null;
    }

    function updateButtons() {
      if (rotate) {
        rotate.setAttribute('aria-pressed', String(spinning));
        rotate.setAttribute('aria-label', spinning ? 'Pause microscope rotation' : 'Rotate microscope automatically');
        rotate.disabled = reduced || contextLost;
        rotate.title = reduced ? 'Automatic rotation is off while reduced motion is enabled' : '';
      }
    }

    function resetView() {
      controls.reset();
      selected = hovered = null;
      targetExplosion = initialExplosion;
      if (range) range.value = String(initialExplosion * 100);
      if (reduced) explosion = targetExplosion;
      camera.position.copy(controls.target).add(viewDirection);
      needsFit = true;
      setPositions();
      updateRangeText();
      requestFrame();
    }

    function updateRangeText() {
      range?.setAttribute('aria-valuetext', `${Math.round(targetExplosion * 100)} percent exploded`);
    }

    function render(time) {
      frame = 0;
      if (!canRender()) return;
      const delta = lastTime ? Math.min((time - lastTime) / 1000, 0.05) : 1 / 60;
      lastTime = time;
      const moving = Math.abs(targetExplosion - explosion) > 0.0002;
      if (moving) {
        explosion = reduced ? targetExplosion : THREE.MathUtils.damp(explosion, targetExplosion, 10, delta);
        if (Math.abs(targetExplosion - explosion) <= 0.0002) explosion = targetExplosion;
        needsFit = true;
      }
      setPositions();
      controls.autoRotate = spinning && !reduced && !dragging;
      const controlsChanged = controls.update(delta);
      if (needsFit || controlsChanged) fitCamera();
      try {
        renderer.render(scene, camera);
        if (host.dataset.renderer !== 'ready') {
          host.dataset.renderer = 'ready';
          if (fallback) fallback.hidden = true;
        }
      } catch (error) {
        fail('The interactive model could not be rendered. The illustration is unavailable in this browser.');
        dispose();
        return;
      }
      if (moving || controlsChanged || controls.autoRotate) requestFrame();
    }

    function canRender() {
      return !disposed && !contextLost && !document.hidden && inView && hasSize;
    }

    function requestFrame() {
      if (!frame && canRender()) frame = requestAnimationFrame(render);
    }

    function suspendOrResume() {
      if (!canRender()) {
        cancelAnimationFrame(frame);
        frame = 0;
        lastTime = 0;
      } else requestFrame();
    }

    function resize() {
      const width = host.clientWidth;
      const height = host.clientHeight;
      hasSize = width > 0 && height > 0;
      if (hasSize) {
        renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
        renderer.setSize(width, height, false);
        camera.aspect = width / height;
        needsFit = true;
      }
      suspendOrResume();
    }

    listen(range, 'input', () => {
      targetExplosion = readExplosion();
      if (reduced) explosion = targetExplosion;
      needsFit = true;
      updateRangeText();
      requestFrame();
    });
    listen(reset, 'click', resetView);
    listen(canvas, 'dblclick', resetView);
    listen(rotate, 'click', () => {
      spinning = !reduced && !spinning;
      updateButtons();
      requestFrame();
    });
    listen(controls, 'change', requestFrame);
    listen(controls, 'start', () => { dragging = true; hovered = null; updateLabel(); requestFrame(); });
    listen(controls, 'end', () => { dragging = false; requestFrame(); });
    listen(canvas, 'pointerdown', event => { pointerStart = { x: event.clientX, y: event.clientY, id: event.pointerId }; });
    listen(canvas, 'pointermove', event => {
      if (event.buttons || event.pointerType === 'touch') return;
      const next = hit(event);
      if (next !== hovered) { hovered = next; updateLabel(); requestFrame(); }
    });
    listen(canvas, 'pointerleave', () => { hovered = null; updateLabel(); requestFrame(); });
    listen(canvas, 'pointercancel', () => { pointerStart = null; dragging = false; });
    listen(canvas, 'pointerup', event => {
      if (pointerStart?.id === event.pointerId && Math.hypot(event.clientX - pointerStart.x, event.clientY - pointerStart.y) < 6) {
        selected = hit(event);
        hovered = null;
        updateLabel();
        requestFrame();
      }
      pointerStart = null;
    });
    listen(document, 'visibilitychange', suspendOrResume);
    listen(motion, 'change', event => {
      reduced = event.matches;
      if (reduced) { spinning = false; explosion = targetExplosion; needsFit = true; }
      controls.enableDamping = !reduced;
      updateButtons();
      requestFrame();
    });
    listen(canvas, 'webglcontextlost', event => {
      event.preventDefault();
      contextLost = true;
      controls.enabled = false;
      updateButtons();
      suspendOrResume();
      fail('The 3D graphics context was interrupted. Waiting for the browser to restore it…');
      host.dataset.renderer = 'context-lost';
    });
    listen(canvas, 'webglcontextrestored', () => {
      contextLost = false;
      controls.enabled = true;
      updateButtons();
      resize();
      requestFrame();
    });
    listen(window, 'pagehide', dispose);
    // A bfcache restore gets a fresh renderer; the old pagehide releases all GPU resources.
    listen(window, 'resize', resize, { passive: true });
    if ('ResizeObserver' in window) {
      resizeObserver = new ResizeObserver(resize);
      resizeObserver.observe(host);
    }
    if ('IntersectionObserver' in window) {
      intersectionObserver = new IntersectionObserver(entries => {
        inView = entries.some(entry => entry.isIntersecting);
        suspendOrResume();
      }, { threshold: 0 });
      intersectionObserver.observe(host);
    }
    if (range && !range.getAttribute('aria-label') && !range.labels?.length) range.setAttribute('aria-label', 'Explode microscope assembly');
    if (reset && !reset.getAttribute('aria-label')) reset.setAttribute('aria-label', 'Reset microscope view');
    if (label) { label.setAttribute('aria-live', 'polite'); label.setAttribute('aria-atomic', 'true'); }
    setPositions();
    camera.position.copy(viewDirection);
    updateButtons();
    updateRangeText();
    resize();
  } catch (error) {
    fail('Interactive 3D requires WebGL. The microscope has illumination above the slide, with its objective and camera below.');
    dispose();
  }

  function fail(message) {
    host.dataset.renderer = 'unavailable';
    if (fallback) { fallback.hidden = false; fallback.textContent = message; }
    else if (label) label.textContent = message;
  }

  function dispose(event) {
    if (disposed) return;
    disposed = true;
    cancelAnimationFrame(frame);
    frame = 0;
    resizeObserver?.disconnect();
    intersectionObserver?.disconnect();
    cleanups.splice(0).forEach(cleanup => cleanup());
    controls?.dispose();
    scene.traverse(object => { if (object.isLight) object.shadow?.dispose(); });
    geometries.forEach(geometry => geometry.dispose());
    materials.forEach(surface => surface.dispose());
    textures.forEach(texture => texture.dispose());
    renderer?.dispose();
    renderer?.domElement.remove();
    if (event?.persisted) {
      window.addEventListener('pageshow', () => initializeViewer(host), { once: true });
    }
  }
}