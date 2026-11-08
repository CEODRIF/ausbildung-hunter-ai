/**
 * The flying aircraft: loads the NASA Boeing 777 GLB (public domain — see
 * public/models/airliner-LICENSE.txt for provenance), which ships as a clean
 * white airframe (all NASA livery removed from the textures). The scene adds:
 *
 *   - a photorealistic German black/red/gold tail + winglet livery, applied
 *     per-fragment (onBeforeCompile) so the stripes stay crisp on the fin's
 *     sparse tessellation — NOT baked into the model,
 *   - nav lights: red starboard wingtip, green port wingtip, white strobes on
 *     both wingtips + fin top, red anti-collision beacon, white tail light,
 *   - cabin + cockpit windows that glow warm at night (the model's GlassM
 *     material),
 *   - a curved "GERMANY" wordmark hugging the port fuselage — a scene-space
 *     decal, not a fake airline.
 *
 * Model space (NASA B777, metres): nose +Z, starboard +X, port −X, up +Y.
 * The root is oriented so the nose points world +X (flying left-to-right on
 * screen); the port side (−X) then faces the camera at world +Z.
 *
 * The 777 is scaled to SCALE so it occupies the same screen size as the
 * previous aircraft, and raised by OFFSET_Y so its fuselage centreline sits at
 * the same world height the flight path (lib/flight/path.ts) was tuned for.
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

/* 777 is 63.7 m long; scaled to the previous aircraft's footprint (~38 m). */
const SCALE = 0.6;
/* NASA fuselage centreline sits at model y=0.445; the path was tuned for a
 * centreline at world 3.76, so raise the model to match. */
const FUSELAGE_CENTERLINE_MODEL_Y = 0.445;
const TARGET_CENTER_Y = 3.76;
const OFFSET_Y = TARGET_CENTER_Y - FUSELAGE_CENTERLINE_MODEL_Y * SCALE;

/* Model-space anchors, measured from the 777 geometry (metres). */
const WINGTIP_STARBOARD = new THREE.Vector3(30.49, 2.18, -10.92); // red — starboard +X
const WINGTIP_PORT = new THREE.Vector3(-30.49, 2.18, -10.92); // green — port −X
const FIN_TOP = new THREE.Vector3(0, 13.05, -29.9); // strobe
const BEACON = new THREE.Vector3(0, 12.35, -29.9);
const TAIL_CONE = new THREE.Vector3(0, 0.445, -32.0); // white tail light

const FUSELAGE_CENTER_Y = FUSELAGE_CENTERLINE_MODEL_Y; // decal sits on the centreline
const FUSELAGE_RADIUS = 3.28; // floats just clear of the ~3.15 m fuselage
const DECAL_Z = 14; // forward fuselage, behind the cockpit
/** The wordmark runs ALONG the fuselage: a short arc around it (letter
 *  height) × a longer segment along it (letter advance). */
const DECAL_ARC = 0.5; // radians around the fuselage (~1.6 m letter height)
const DECAL_LENGTH = 8.5; // metres along the fuselage

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

/**
 * German black/red/gold livery, applied per-fragment to the painted airframe.
 * The fin and winglets are sparsely tessellated (no vertices across the whole
 * fin), so a per-fragment region test — not vertex colours — is what keeps the
 * horizontal tricolour bands crisp. Object-space position + normal gate the
 * region; the bands are a function of height only.
 */
function applyGermanLivery(material: THREE.Material): void {
  const std = material as THREE.MeshStandardMaterial;
  if (!std.isMeshStandardMaterial) return;
  // A per-material cache key so the livery shader variant is distinct from any
  // unmodified program three may have cached for the same material params.
  std.customProgramCacheKey = () => `german-livery-${std.name}`;
  const LV = "varying vec3 vObjPos;\nvarying vec3 vObjNrm;\n";
  std.onBeforeCompile = (shader: THREE.WebGLProgramParametersWithUniforms) => {
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\n" + LV)
      .replace("#include <begin_vertex>", "#include <begin_vertex>\nvObjPos = position;\nvObjNrm = normal;");
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        "#include <common>\n" +
          LV +
          "vec3 liveryColor(float t){ if(t>=0.6667)return vec3(0.09,0.095,0.12); if(t>=0.3333)return vec3(0.82,0.11,0.15); return vec3(0.93,0.75,0.12); }\n",
      )
      .replace(
        "#include <color_fragment>",
        `#include <color_fragment>
        { float ax=abs(vObjPos.x);
          bool fin=(ax<3.6 && vObjPos.y>2.8 && vObjPos.z<-8.0 && vObjNrm.y<0.5);
          bool wl =(ax>23.0 && vObjPos.y>1.4 && vObjNrm.y<0.6);
          if(fin||wl){ float t= fin ? clamp((vObjPos.y-3.7)/9.35,0.0,1.0) : clamp((vObjPos.y-1.5)/4.0,0.0,1.0); diffuseColor.rgb=liveryColor(t); } }`,
      );
  };
}

export async function loadAircraft(scene: THREE.Scene, url: string): Promise<Aircraft> {
  const { GLTFLoader } = await import("three/examples/jsm/loaders/GLTFLoader.js");
  const gltf = await new GLTFLoader().loadAsync(url);

  const rig = new THREE.Group(); // flight path positions/rotates this
  const model = gltf.scene; // the 777, scaled + raised; lights & decal live here
  model.scale.setScalar(SCALE);
  model.position.y = OFFSET_Y;
  rig.add(model);

  const windowMats: THREE.MeshStandardMaterial[] = [];
  const disposables: Array<{ dispose(): void }> = [];

  model.traverse((node) => {
    const mesh = node as THREE.Mesh;
    if (!mesh.isMesh) return;
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const m of mats) {
      // Cabin + cockpit windows glow warm at night. Only the airframe glass
      // (GlassM) — NOT the engine glass (GlassPM).
      if (m.name === "GlassM") {
        const sm = m as THREE.MeshStandardMaterial;
        sm.emissive = new THREE.Color("#ffb45e");
        sm.emissiveIntensity = 0;
        windowMats.push(sm);
      }
      // German tricolor on the painted airframe (fin + winglets live in the
      // PaintM / PaintPM primitives; the region test gates the actual colour).
      if (m.name === "PaintM" || m.name === "PaintPM") applyGermanLivery(m);
    }
  });

  /* navigation lights -------------------------------------------------- */
  // Sizes are in model space; the model is scaled by SCALE, so divide by it to
  // keep the lights a consistent on-screen size.
  const INV = 1 / SCALE;
  const lights: Array<{ mesh: THREE.Mesh; kind: "steady" | "strobe" | "beacon" }> = [];
  const addLight = (pos: THREE.Vector3, color: number, kind: "steady" | "strobe" | "beacon", size = 0.18) => {
    const mesh = makeLight(color, size * INV);
    mesh.position.copy(pos);
    model.add(mesh);
    lights.push({ mesh, kind });
    disposables.push(mesh.geometry, mesh.material as THREE.Material);
  };
  addLight(WINGTIP_STARBOARD, 0xff2438, "steady"); // red — starboard
  addLight(WINGTIP_PORT, 0x22ff6a, "steady"); // green — port
  addLight(WINGTIP_STARBOARD.clone().add(new THREE.Vector3(0, 0.9, 0)), 0xffffff, "strobe", 0.2);
  addLight(WINGTIP_PORT.clone().add(new THREE.Vector3(0, 0.9, 0)), 0xffffff, "strobe", 0.2);
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
    -Math.PI / 2 - DECAL_ARC / 2, // open-ended arc centred on the -X side (port, camera)
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
  model.add(decal);
  disposables.push(decalGeo, decalMat, decalTex);

  scene.add(rig);

  /* flight state --------------------------------------------------------- */
  const orientation = new THREE.Quaternion();
  const euler = new THREE.Euler(0, 0, 0, "YZX");
  const phase = Math.random() * 20; // never start on-frame
  let animated = true;
  let strobeClock = 0;
  let beaconClock = 0;
  let disposed = false;

  function applyPose(pose: FlightPose): void {
    rig.position.set(pose.x, pose.y, pose.z);
    euler.set(pose.pitch, pose.yaw, pose.bank, "YZX");
    orientation.setFromEuler(euler).multiply(BASE_ORIENT);
    rig.quaternion.copy(orientation);
  }

  function setNight(dayNight: number): void {
    const glow = 0.85 * THREE.MathUtils.smoothstep(dayNight, 0.3, 0.8);
    for (const m of windowMats) m.emissiveIntensity = glow;
    // Steady nav lights pop against the night sky: grow them slightly.
    const scale = 1 + 0.15 * dayNight;
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
      scene.remove(rig);
      for (const d of disposables) d.dispose();
    },
  };
}
