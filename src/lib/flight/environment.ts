/**
 * The 3D sky environment behind the hero aircraft.
 *
 * Everything day/night is a pure function of `t` (0 = full day, 1 = full
 * night) applied every frame, so the ~2 s theme transition is just a tween of
 * t — the theme system (the `dark` class on <html>) is the single source of
 * truth, and the aircraft keeps flying throughout.
 *
 * Sky stack (back to front):
 *   Preetham atmospheric sky (three Sky, scale 500) — physically-based
 *   scattering with a NATURAL sun (no sprite) by day
 *   > deep-blue night dome (r=150) — transparent, cross-fades IN over the
 *     atmospheric sky as the sun sets, so the transition is a real dusk
 *   > stars > moon (z=-95) > far clouds (z=-48) > mid clouds (z=-18)
 *   > AIRCRAFT (z≈0) > near clouds (z=+9) > close clouds (z=+16).
 *
 * Lighting:
 *   - the directional sunLight comes from the same direction as the visible
 *     Preetham sun (upper right of the frame), raking the airframe warm,
 *   - scene.environment is a PMREM of the day sky — image-based lighting gives
 *     the painted airframe its realistic reflections instead of a flat look;
 *     its intensity is tweened down for night (subtle, never overexposed),
 *   - clouds are lit (Lambert), so their brightness follows the real sun.
 */
import * as THREE from "three";
import { Sky } from "three/examples/jsm/objects/Sky.js";

export interface Environment {
  /** Apply a full day/night state (dayNight: 0 = day, 1 = night). */
  apply(dayNight: number): void;
  /** Advance continuous motion (cloud drift, star shimmer). */
  update(dt: number, dayNight: number, elapsed: number): void;
  dispose(): void;
}

interface Palette {
  fog: THREE.Color;
  fogNear: number;
  fogFar: number;
  hemiSky: THREE.Color;
  hemiGround: THREE.Color;
  hemiIntensity: number;
  sunIntensity: number;
  fillIntensity: number;
  moonIntensity: number;
  cloud: THREE.Color;
  cloudOpacity: number;
  envIntensity: number;
}

const DAY: Palette = {
  fog: new THREE.Color("#b9d7ee"),
  fogNear: 70,
  fogFar: 175,
  hemiSky: new THREE.Color("#bfdcf5"),
  hemiGround: new THREE.Color("#e3ecf2"),
  hemiIntensity: 1.0,
  sunIntensity: 2.1,
  fillIntensity: 0.45,
  moonIntensity: 0,
  cloud: new THREE.Color("#ffffff"),
  cloudOpacity: 0.85,
  envIntensity: 1.0,
};

const NIGHT: Palette = {
  fog: new THREE.Color("#0a1424"),
  fogNear: 55,
  fogFar: 145,
  hemiSky: new THREE.Color("#25375f"),
  hemiGround: new THREE.Color("#0d1420"),
  hemiIntensity: 0.35,
  sunIntensity: 0,
  fillIntensity: 0.15,
  moonIntensity: 0.5,
  cloud: new THREE.Color("#42537a"),
  cloudOpacity: 0.5,
  envIntensity: 0.12,
};

/* Deep-blue night dome colours (fixed — the dome only ever appears at night). */
const NIGHT_SKY_TOP = new THREE.Color("#050b1c");
const NIGHT_SKY_BOTTOM = new THREE.Color("#182741");
const NIGHT_HORIZON_GLOW = new THREE.Color("#7896d2").multiplyScalar(0.1);

function lerpPalette(t: number): Palette {
  return {
    fog: DAY.fog.clone().lerp(NIGHT.fog, t),
    fogNear: THREE.MathUtils.lerp(DAY.fogNear, NIGHT.fogNear, t),
    fogFar: THREE.MathUtils.lerp(DAY.fogFar, NIGHT.fogFar, t),
    hemiSky: DAY.hemiSky.clone().lerp(NIGHT.hemiSky, t),
    hemiGround: DAY.hemiGround.clone().lerp(NIGHT.hemiGround, t),
    hemiIntensity: THREE.MathUtils.lerp(DAY.hemiIntensity, NIGHT.hemiIntensity, t),
    sunIntensity: THREE.MathUtils.lerp(DAY.sunIntensity, NIGHT.sunIntensity, t),
    fillIntensity: THREE.MathUtils.lerp(DAY.fillIntensity, NIGHT.fillIntensity, t),
    moonIntensity: THREE.MathUtils.lerp(DAY.moonIntensity, NIGHT.moonIntensity, t),
    cloud: DAY.cloud.clone().lerp(NIGHT.cloud, t),
    cloudOpacity: THREE.MathUtils.lerp(DAY.cloudOpacity, NIGHT.cloudOpacity, t),
    envIntensity: THREE.MathUtils.lerp(DAY.envIntensity, NIGHT.envIntensity, t),
  };
}

/* Sun path: a warm sun in the upper RIGHT corner of the visible (front) sky
 * by day — the classic in-flight photograph light — and below the horizon by
 * night. Azimuth 166.5° / elevation 18° → direction ≈ (+0.22, +0.31, −0.92):
 * the sun lands in the upper-right corner of the frame (≈1206,121 at 1440×900),
 * clear of the headline's right edge and the header even under pointer
 * parallax (±~30 px), rakes the fuselage top and wing edges warm, and its
 * ray passes ABOVE the front cloud bands. The camera-facing flank stays in
 * soft sky light (fill + IBL). */
const SUN_AZIMUTH = THREE.MathUtils.degToRad(166.5);
const SUN_ELEV_DAY = THREE.MathUtils.degToRad(18);
const SUN_ELEV_NIGHT = THREE.MathUtils.degToRad(-12);

function sunDirection(elev: number, target: THREE.Vector3): THREE.Vector3 {
  const phi = Math.PI / 2 - elev;
  target.setFromSphericalCoords(1, phi, SUN_AZIMUTH);
  return target;
}

/* ---------------------------------------------------------------- helpers */

function radialSprite(size: number, stops: Array<[number, string]>): THREE.Texture {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  for (const [offset, color] of stops) g.addColorStop(offset, color);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** A subtly shaded moon disc: limb darkening + soft mare patches, so it
 *  reads as a real moon instead of a flat grey circle. */
function moonTexture(): THREE.Texture {
  const size = 128;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const g = ctx.createRadialGradient(size * 0.44, size * 0.42, size * 0.05, size / 2, size / 2, size / 2);
  g.addColorStop(0, "#e9eef8");
  g.addColorStop(0.7, "#ccd7ea");
  g.addColorStop(1, "#a9b6d0");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const patches: Array<[number, number, number, number]> = [
    [0.42, 0.38, 0.16, 0.35],
    [0.6, 0.55, 0.13, 0.3],
    [0.35, 0.62, 0.11, 0.25],
    [0.55, 0.3, 0.09, 0.22],
  ];
  for (const [x, y, r, a] of patches) {
    const pg = ctx.createRadialGradient(size * x, size * y, 0, size * x, size * y, size * r);
    pg.addColorStop(0, `rgba(148,162,190,${a})`);
    pg.addColorStop(1, "rgba(148,162,190,0)");
    ctx.fillStyle = pg;
    ctx.fillRect(0, 0, size, size);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function cloudTexture(): THREE.Texture {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 256;
  const ctx = canvas.getContext("2d")!;
  const blobs: Array<[number, number, number]> = [
    [128, 152, 96],
    [74, 166, 70],
    [186, 160, 76],
    [128, 118, 82],
    [52, 140, 48],
    [204, 134, 50],
  ];
  for (const [x, y, r] of blobs) {
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, "rgba(255,255,255,0.62)");
    g.addColorStop(0.55, "rgba(255,255,255,0.26)");
    g.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 256, 256);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** Four cloud depth bands: two BEHIND and two IN FRONT of the aircraft path.
 *  Counts are tuned for weak (software) rasterisers — each sprite is a
 *  transparent overdraw plane.
 *
 *  The two FRONT bands sit LOW (below the fuselage line on screen): their
 *  tops must stay under the sun's line of sight (the 18°-elevation sun ray
 *  crosses z=16 at y≈12.3 and z=9 at y≈14.6). A cloud in front of the sun
 *  reads exactly as bright as the hazy sky — invisible as a cloud, but it
 *  dilutes the white sun disc into nothing (verified in QA). ≥2 u margin
 *  keeps the natural sun always clear. */
const CLOUD_BANDS = [
  { z: -48, count: 7, wMin: 20, wMax: 34, yMin: 1.5, yMax: 9.5, speed: 0.55, opacity: 0.9 },
  { z: -18, count: 6, wMin: 16, wMax: 26, yMin: 0.5, yMax: 11, speed: 1.2, opacity: 1.0 },
  { z: 9, count: 5, wMin: 20, wMax: 32, yMin: 0, yMax: 1.5, speed: 2.1, opacity: 0.8 },
  { z: 16, count: 5, wMin: 26, wMax: 42, yMin: -6, yMax: -3, speed: 3.1, opacity: 0.6 },
] as const;

const CLOUD_RANGE = 200;

interface CloudSprite {
  mesh: THREE.Mesh;
  speed: number;
}

/* ------------------------------------------------------------------ build */

export function createEnvironment(scene: THREE.Scene, renderer: THREE.WebGLRenderer): Environment {
  const disposables: Array<{ dispose(): void }> = [];
  const track = <T extends { dispose(): void }>(d: T): T => {
    disposables.push(d);
    return d;
  };

  /* atmospheric sky (Preetham) — the day sky and the natural sun ---------- */
  const sunDir = new THREE.Vector3();
  const sky = new Sky();
  sky.scale.setScalar(500);
  const skyUniforms = sky.material.uniforms;
  // Tuned on the QA SwiftShader stack: high turbidity/mie blows the in-frame
  // sky (everything within ~80° of a 17°-elevation sun) to pure white, which
  // hides the disc and reads as "flat paper". t2 / rayleigh 1.0 / mie 0.0005
  // keeps a blue zenith + warm horizon gradient while the disc and its narrow
  // halo stay crisp (contrast 28 vs 8) — verified in qa-tooling/sun-test/.
  skyUniforms.turbidity.value = 2;
  skyUniforms.rayleigh.value = 1.0;
  skyUniforms.mieCoefficient.value = 0.0005;
  skyUniforms.mieDirectionalG.value = 0.7;
  // Sky.js (three >= 0.180) ships built-in procedural clouds (coverage 0.4 by
  // default) that mix grey over the whole sky and paint OUT the sun disc.
  // This scene has its own 3D cloud sprites at tuned depths — keep the sky
  // a clean Preetham dome so the natural sun reads.
  skyUniforms.cloudCoverage.value = 0;
  // The stock disc test compares cosTheta against 0.9999567 — a ~4e-5
  // difference that silently fails on this software-GL QA stack, so the
  // natural sun disc never draws. acos() is well-conditioned there; patch
  // it in (same 0.53° angular radius). Verified in qa-tooling/sun-test/.
  sky.material.onBeforeCompile = (shader: THREE.WebGLProgramParametersWithUniforms) => {
    shader.fragmentShader = shader.fragmentShader.replace(
      "float sundisc = clamp( ( cosTheta - sunAngularDiameterCos ) * 50000.0, 0.0, 1.0 ) * showSunDisc;",
      "float sunAngleRad = acos( clamp( cosTheta, -1.0, 1.0 ) );\nfloat sundisc = clamp( ( 0.00923 - sunAngleRad ) / 0.00923, 0.0, 1.0 ) * showSunDisc;",
    );
  };
  sunDirection(SUN_ELEV_DAY, sunDir);
  skyUniforms.sunPosition.value.copy(sunDir);
  sky.renderOrder = -12;
  scene.add(sky);

  /* deep-blue night dome — cross-fades in over the atmospheric sky -------- */
  const nightUniforms = {
    uTop: { value: NIGHT_SKY_TOP.clone() },
    uBottom: { value: NIGHT_SKY_BOTTOM.clone() },
    uGlow: { value: NIGHT_HORIZON_GLOW.clone() },
    uOpacity: { value: 0 },
  };
  const nightMat = track(
    new THREE.ShaderMaterial({
      uniforms: nightUniforms,
      side: THREE.BackSide,
      transparent: true,
      depthWrite: false,
      fog: false,
      vertexShader: `
        varying vec3 vDir;
        void main() {
          vDir = normalize(position);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform vec3 uTop;
        uniform vec3 uBottom;
        uniform vec3 uGlow;
        uniform float uOpacity;
        varying vec3 vDir;
        void main() {
          float h = clamp(vDir.y, -0.05, 1.0);
          vec3 col = mix(uBottom, uTop, smoothstep(0.02, 0.62, h));
          col += uGlow * exp(-abs(h - 0.02) * 8.0);
          gl_FragColor = vec4(col, uOpacity);
        }
      `,
    }),
  );
  const nightGeo = track(new THREE.SphereGeometry(150, 24, 12));
  const nightDome = new THREE.Mesh(nightGeo, nightMat);
  nightDome.renderOrder = -11;
  scene.add(nightDome);

  /* PMREM image-based lighting — a CHEAP procedural sky (vertical gradient +
   * a tight sun disc), not the full Preetham shader: fromScene runs on the
   * main thread before the first frame, and the scattering shader is far too
   * slow for weak/software GPUs. A gradient + sun disc still gives the paint
   * realistic sky-coloured ambient reflections and a sun specular glint. */
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envScene = new THREE.Scene();
  const envGeo = track(new THREE.SphereGeometry(50, 32, 16));
  const envMat = track(
    new THREE.ShaderMaterial({
      side: THREE.BackSide,
      fog: false,
      uniforms: {
        uTop: { value: new THREE.Color("#2f7fd6") },
        uHorizon: { value: new THREE.Color("#cfe9f8") },
        uGround: { value: new THREE.Color("#7f8b98") },
        uSunDir: { value: sunDir.clone() },
      },
      vertexShader: `
        varying vec3 vDir;
        void main() { vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
      `,
      fragmentShader: `
        uniform vec3 uTop; uniform vec3 uHorizon; uniform vec3 uGround; uniform vec3 uSunDir;
        varying vec3 vDir;
        void main() {
          vec3 d = normalize(vDir);
          vec3 col = d.y >= 0.0
            ? mix(uHorizon, uTop, pow(clamp(d.y, 0.0, 1.0), 0.55))
            : mix(uHorizon, uGround, clamp(-d.y * 2.2, 0.0, 1.0));
          col += vec3(1.0, 0.95, 0.82) * pow(max(dot(d, uSunDir), 0.0), 700.0) * 10.0;
          gl_FragColor = vec4(col, 1.0);
        }
      `,
    }),
  );
  envScene.add(new THREE.Mesh(envGeo, envMat));
  const envRT = pmrem.fromScene(envScene, 0, 0.1, 100);
  pmrem.dispose();
  scene.environment = envRT.texture;
  track(envRT);

  /* moon — a small shaded disc (upper right, clear of the headline) with a
   * soft (non-neon) halo ---------------------------------------------------- */
  const moonGeo = track(new THREE.CircleGeometry(2.8, 40));
  const moonTex = track(moonTexture());
  const moonMat = track(
    new THREE.MeshBasicMaterial({ map: moonTex, transparent: true, fog: false }),
  );
  const moon = new THREE.Mesh(moonGeo, moonMat);
  moon.position.set(17, -9, -98);
  scene.add(moon);

  const moonGlowTex = track(
    radialSprite(256, [
      [0, "rgba(206,220,250,0.5)"],
      [0.35, "rgba(190,208,246,0.16)"],
      [1, "rgba(190,208,246,0)"],
    ]),
  );
  const moonGlowMat = track(
    new THREE.SpriteMaterial({
      map: moonGlowTex,
      transparent: true,
      depthWrite: false,
      fog: false,
      blending: THREE.AdditiveBlending,
    }),
  );
  const moonGlow = new THREE.Sprite(moonGlowMat);
  moonGlow.scale.setScalar(14);
  moon.add(moonGlow);

  /* stars — two groups with staggered fade-in -------------------------- */
  function starGroup(count: number, size: number, color: string): THREE.Points {
    const pos = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(1 - Math.random() * 0.86); // upper hemisphere bias
      const r = 132 + Math.random() * 14;
      pos[i * 3] = r * Math.sin(phi) * Math.cos(theta);
      pos[i * 3 + 1] = Math.max(8, r * Math.cos(phi));
      pos[i * 3 + 2] = r * Math.sin(phi) * Math.sin(theta);
    }
    const geo = track(new THREE.BufferGeometry());
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    const mat = track(
      new THREE.PointsMaterial({
        color: new THREE.Color(color),
        size,
        sizeAttenuation: true,
        transparent: true,
        opacity: 0,
        depthWrite: false,
        fog: false,
        blending: THREE.AdditiveBlending,
      }),
    );
    const points = new THREE.Points(geo, mat);
    points.renderOrder = -5;
    scene.add(points);
    return points;
  }
  const starsBright = starGroup(240, 0.9, "#ffffff");
  const starsFaint = starGroup(160, 0.5, "#c9d6ff");

  /* fog ---------------------------------------------------------------- */
  const fog = new THREE.Fog(DAY.fog.clone(), DAY.fogNear, DAY.fogFar); // no dispose()
  scene.fog = fog;

  /* lights -------------------------------------------------------------- */
  const hemi = track(new THREE.HemisphereLight(DAY.hemiSky, DAY.hemiGround, DAY.hemiIntensity));
  scene.add(hemi);
  // Key light from the visible Preetham sun (same direction, upper right of
  // the frame): warm light raking the fuselage top and wing leading edges.
  const sunLight = track(new THREE.DirectionalLight(new THREE.Color("#fff2d8"), DAY.sunIntensity));
  sunLight.position.set(13.3, 18.5, -55.5);
  scene.add(sunLight);
  // Cool fill from the front-left: keeps the far flank and panel details out
  // of pure shadow without flattening the livery (deliberately low).
  const fillLight = track(new THREE.DirectionalLight(new THREE.Color("#dce9f7"), DAY.fillIntensity));
  fillLight.position.set(-30, 12, 34);
  scene.add(fillLight);
  // Moonlight also from the camera side so the night airframe reads.
  const moonLight = track(new THREE.DirectionalLight(new THREE.Color("#bcd0ff"), 0));
  moonLight.position.set(24, 26, 32);
  scene.add(moonLight);

  /* cloud fields — lit, so their brightness follows the real sun ---------- */
  const cloudTex = track(cloudTexture());
  const cloudGeo = track(new THREE.PlaneGeometry(1, 1));
  const cloudSprites: CloudSprite[] = [];
  const cloudMats: THREE.MeshLambertMaterial[] = [];

  for (const band of CLOUD_BANDS) {
    const mat = track(
      new THREE.MeshLambertMaterial({
        map: cloudTex,
        transparent: true,
        depthWrite: false,
        opacity: band.opacity,
      }),
    );
    cloudMats.push(mat);
    for (let i = 0; i < band.count; i++) {
      const mesh = new THREE.Mesh(cloudGeo, mat);
      const w = band.wMin + Math.random() * (band.wMax - band.wMin);
      mesh.scale.set(w, w * 0.52, 1);
      mesh.position.set(
        (Math.random() - 0.5) * CLOUD_RANGE,
        band.yMin + Math.random() * (band.yMax - band.yMin),
        band.z + (Math.random() - 0.5) * 3,
      );
      mesh.renderOrder = band.z < 0 ? 1 : 4;
      scene.add(mesh);
      cloudSprites.push({ mesh, speed: band.speed * (0.8 + Math.random() * 0.4) });
    }
  }

  /* day/night application ------------------------------------------------ */
  const cloudColorTmp = new THREE.Color();
  const sunDirTmp = new THREE.Vector3();

  function apply(t: number): void {
    // Allocations per frame are fine at 60 fps here, but avoid them anyway:
    // lerpPalette clones a handful of colors per call — acceptable (hero only).
    const p = lerpPalette(t);

    // The sun sets over the first 60 % of the transition; below the horizon
    // the Preetham sky darkens on its own, then the night dome takes over.
    const sunT = THREE.MathUtils.clamp(t / 0.6, 0, 1);
    const elev = THREE.MathUtils.lerp(SUN_ELEV_DAY, SUN_ELEV_NIGHT, sunT);
    sunDirection(elev, sunDirTmp);
    skyUniforms.sunPosition.value.copy(sunDirTmp);
    // A little extra rayleigh as the sun drops: warmer, denser dusk.
    skyUniforms.rayleigh.value = 2.0 + 0.8 * sunT;

    // Night dome cross-fade: in over the second half of the transition.
    const nightOp = THREE.MathUtils.smoothstep(t, 0.35, 0.85);
    nightUniforms.uOpacity.value = nightOp;
    sky.visible = nightOp < 0.995; // skip the atmospheric draw once covered

    const moonIn = THREE.MathUtils.clamp((t - 0.28) / 0.55, 0, 1);
    const moonEase = moonIn * moonIn * (3 - 2 * moonIn);
    moon.position.y = -9 + moonEase * 41.5;
    moonMat.opacity = moonIn;
    moonGlowMat.opacity = 0.45 * moonIn;
    moon.visible = moonIn > 0.01;

    const starsA = THREE.MathUtils.clamp((t - 0.12) / 0.5, 0, 1);
    const starsB = THREE.MathUtils.clamp((t - 0.42) / 0.5, 0, 1);
    (starsBright.material as THREE.PointsMaterial).opacity = 0.95 * starsB;
    (starsFaint.material as THREE.PointsMaterial).opacity = 0.8 * starsA;
    starsBright.visible = starsB > 0.01;
    starsFaint.visible = starsA > 0.01;

    fog.color.copy(p.fog);
    fog.near = p.fogNear;
    fog.far = p.fogFar;

    hemi.color.copy(p.hemiSky);
    hemi.groundColor.copy(p.hemiGround);
    hemi.intensity = p.hemiIntensity;
    sunLight.intensity = p.sunIntensity;
    fillLight.intensity = p.fillIntensity;
    moonLight.intensity = p.moonIntensity;
    scene.environmentIntensity = p.envIntensity;

    cloudColorTmp.copy(p.cloud);
    for (let i = 0; i < cloudMats.length; i++) {
      cloudMats[i].color.copy(cloudColorTmp);
      const band = CLOUD_BANDS[i];
      cloudMats[i].opacity = band.opacity * p.cloudOpacity / DAY.cloudOpacity;
    }
  }

  function update(dt: number, dayNight: number, elapsed: number): void {
    apply(dayNight);
    for (const c of cloudSprites) {
      c.mesh.position.x -= c.speed * dt; // drift against the flight direction
      if (c.mesh.position.x < -CLOUD_RANGE / 2) c.mesh.position.x += CLOUD_RANGE;
    }
    // Gentle twinkle on the brighter group (only matters at night).
    const tw = 0.88 + 0.12 * Math.sin(elapsed * 53.1);
    (starsBright.material as THREE.PointsMaterial).opacity *= tw;
  }

  function dispose(): void {
    scene.remove(sky, nightDome, moon, starsBright, starsFaint, hemi, sunLight, fillLight, moonLight);
    for (const c of cloudSprites) scene.remove(c.mesh);
    scene.environment = null;
    for (const d of disposables) d.dispose();
  }

  return { apply, update, dispose };
}
