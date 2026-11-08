/**
 * The flying aircraft: loads the CC0 Grab3D passenger-airplane GLB (re-liveried
 * to a generic German black/red/gold scheme — see public/models/
 * airliner-LICENSE.txt for the license), then adds what the model lacks:
 *
 *   - landing gear hidden (cruise look),
 *   - nav lights: red starboard wingtip, green port wingtip, white strobes on
 *     both wingtips + fin top, red anti-collision beacon, tail light,
 *   - cabin windows that glow warm at night (the model has a dedicated
 *     windows mesh),
 *   - a curved "GERMANY" wordmark hugging the port fuselage — a scene-space
 *     decal, not a fake airline.
 *
 * Model space: nose +Z, port side +X, up +Y. The root is oriented so the nose
 * points world +X (flying left-to-right on screen); the port side then faces
 * the camera.
 */
import * as THREE from "three";
import { flightPose, staticPose, type FlightPose } from "./path";

export interface Aircraft {
  /** Position/orientation from the flight path at the given elapsed time. */
  setFlightPose(elapsed: number): void;
  /** Fixed on-screen pose for prefers-reduced-motion. */
  setStaticPose(): void;
  /**
   * Advance light blinks and apply the day/night lighting state.
   * With animated=false the strobe/beacon stay steadily lit (no flashing).
   */
  update(dt: number, dayNight: number): void;
  setAnimated(animated: boolean): void;
  dispose(): void;
}

/* Model-space anchors, measured from the GLB geometry. */
const WINGTIP_STARBOARD = new THREE.Vector3(-17.65, 6.73, -7.21); // red
const WINGTIP_PORT = new THREE.Vector3(17.65, 6.73, -7.21); // green
const FIN_TOP = new THREE.Vector3(0, 12.15, -16.2); // strobe
const BEACON = new THREE.Vector3(0, 10.55, -15.8);
const TAIL_CONE = new THREE.Vector3(0, 4.0, -19.1);

const FUSELAGE_CENTER_Y = 3.76;
const FUSELAGE_RADIUS = 2.8; // clears the model's max 2.76 m
const DECAL_Z = 7.5;
/** The wordmark runs ALONG the fuselage: a short arc around it (letter
 *  height) × a longer segment along it (letter advance). */
const DECAL_ARC = 0.42; // radians around the fuselage (~0.34 m letter height)
const DECAL_LENGTH = 4.2; // metres along the fuselage

const BASE_ORIENT = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, Math.PI / 2, 0));

function makeLight(color: number, size: number): THREE.Mesh {
  const mat = new THREE.MeshBasicMaterial({ color, toneMapped: false, transparent: true });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(size, 8, 8), mat);
  mesh.renderOrder = 6;
  return mesh;
}

function makeDecalTexture(): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  // x = letter height (maps around the fuselage), y = letter advance
  // (maps along the fuselage). Sized so the rotated drawing fits.
  canvas.width = 512;
  canvas.height = 1024;
  const ctx = canvas.getContext("2d")!;
  ctx.clearRect(0, 0, 512, 1024);
  ctx.fillStyle = "#181a20";
  ctx.font = "700 150px 'Arial Narrow', Arial, Helvetica, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  // The texture's x-axis maps around the fuselage (letter height) and its
  // y-axis along it (letter advance), so the drawing is rotated -90°:
  // advance ends up towards the nose (canvas top = v=1) and the letter tops
  // point to the top of the fuselage — upright and left-to-right when viewed
  // from the starboard side.
  ctx.translate(256, 512);
  ctx.rotate(-Math.PI / 2);
  // Manual letter spacing (Canvas letterSpacing is not universal).
  const text = "GERMANY";
  const widths = [...text].map((ch) => ctx.measureText(ch).width);
  const gap = 26;
  const total = widths.reduce((a, b) => a + b, 0) + gap * (text.length - 1);
  let x = -total / 2;
  [...text].forEach((ch, i) => {
    ctx.fillText(ch, x + widths[i] / 2, 0);
    x += widths[i] + gap;
  });
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}

export async function loadAircraft(scene: THREE.Scene, url: string): Promise<Aircraft> {
  const { GLTFLoader } = await import("three/examples/jsm/loaders/GLTFLoader.js");
  const gltf = await new GLTFLoader().loadAsync(url);

  const group = gltf.scene;
  const windowMats: THREE.MeshStandardMaterial[] = [];
  const disposables: Array<{ dispose(): void }> = [];

  group.traverse((node) => {
    // The landing gear stays in its modelled (down) position — struts alone
    // read as antennas, a gear-down airliner reads as an approaching one.
    const mesh = node as THREE.Mesh;
    if (!mesh.isMesh) return;
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const m of mats) {
      if (m.name.includes("window_glass")) {
        const sm = m as THREE.MeshStandardMaterial;
        sm.emissive = new THREE.Color("#ffb45e");
        sm.emissiveIntensity = 0;
        windowMats.push(sm);
      }
    }
  });

  /* navigation lights -------------------------------------------------- */
  const lights: Array<{ mesh: THREE.Mesh; kind: "steady" | "strobe" | "beacon" }> = [];
  const addLight = (pos: THREE.Vector3, color: number, kind: "steady" | "strobe" | "beacon", size = 0.24) => {
    const mesh = makeLight(color, size);
    mesh.position.copy(pos);
    group.add(mesh);
    lights.push({ mesh, kind });
    disposables.push(mesh.geometry, mesh.material as THREE.Material);
  };
  addLight(WINGTIP_STARBOARD, 0xff2438, "steady"); // red — starboard
  addLight(WINGTIP_PORT, 0x22ff6a, "steady"); // green — port
  addLight(WINGTIP_STARBOARD.clone().add(new THREE.Vector3(0, 0.55, 0)), 0xffffff, "strobe", 0.2);
  addLight(WINGTIP_PORT.clone().add(new THREE.Vector3(0, 0.55, 0)), 0xffffff, "strobe", 0.2);
  addLight(FIN_TOP, 0xffffff, "strobe", 0.2);
  addLight(BEACON, 0xff2438, "beacon", 0.18);
  addLight(TAIL_CONE, 0xffffff, "steady", 0.18);

  /* "GERMANY" wordmark on the port side --------------------------------- */
  const decalTex = makeDecalTexture();
  const decalGeo = new THREE.CylinderGeometry(
    FUSELAGE_RADIUS,
    FUSELAGE_RADIUS,
    DECAL_LENGTH,
    24,
    1,
    true,
    -Math.PI / 2 - DECAL_ARC / 2, // open-ended arc centred on the -X side
    DECAL_ARC,
  );
  const decalMat = new THREE.MeshBasicMaterial({
    map: decalTex,
    transparent: true,
    opacity: 0.96,
    side: THREE.FrontSide,
    depthWrite: false,
  });
  const decal = new THREE.Mesh(decalGeo, decalMat);
  decal.position.set(0, FUSELAGE_CENTER_Y, DECAL_Z);
  decal.rotation.x = Math.PI / 2; // cylinder axis along the fuselage (Z)
  decal.renderOrder = 5;
  group.add(decal);
  disposables.push(decalGeo, decalMat, decalTex);

  scene.add(group);

  /* flight state --------------------------------------------------------- */
  const orientation = new THREE.Quaternion();
  const euler = new THREE.Euler(0, 0, 0, "YZX");
  const phase = Math.random() * 20; // never start on-frame
  let animated = true;
  let strobeClock = 0;
  let beaconClock = 0;
  let disposed = false;

  function applyPose(pose: FlightPose): void {
    group.position.set(pose.x, pose.y, pose.z);
    euler.set(pose.pitch, pose.yaw, pose.bank, "YZX");
    orientation.setFromEuler(euler).multiply(BASE_ORIENT);
    group.quaternion.copy(orientation);
  }

  function setNight(dayNight: number): void {
    const glow = 0.85 * THREE.MathUtils.smoothstep(dayNight, 0.3, 0.8);
    for (const m of windowMats) m.emissiveIntensity = glow;
    // Steady nav lights pop against the night sky: grow them slightly.
    const scale = 1 + 0.25 * dayNight;
    for (const { mesh, kind } of lights) if (kind === "steady") mesh.scale.setScalar(scale);
  }

  return {
    setFlightPose(elapsed: number) {
      applyPose(flightPose(elapsed, phase));
    },
    setStaticPose() {
      applyPose(staticPose());
    },
    update(dt: number, dayNight: number) {
      if (disposed) return;
      if (animated) {
        strobeClock = (strobeClock + dt) % 1.1;
        beaconClock = (beaconClock + dt) % 1.25;
        const strobeOn = strobeClock < 0.06 || (strobeClock > 0.14 && strobeClock < 0.2);
        const beaconOn = beaconClock < 0.09;
        for (const { mesh, kind } of lights) {
          if (kind === "strobe") (mesh.material as THREE.MeshBasicMaterial).opacity = strobeOn ? 1 : 0;
          if (kind === "beacon") (mesh.material as THREE.MeshBasicMaterial).opacity = beaconOn ? 1 : 0;
        }
      } else {
        for (const { mesh, kind } of lights) {
          if (kind === "strobe") (mesh.material as THREE.MeshBasicMaterial).opacity = 0.8;
          if (kind === "beacon") (mesh.material as THREE.MeshBasicMaterial).opacity = 0.7;
        }
      }
      setNight(dayNight);
    },
    setAnimated(value: boolean) {
      animated = value;
    },
    dispose() {
      disposed = true;
      scene.remove(group);
      for (const d of disposables) d.dispose();
    },
  };
}
