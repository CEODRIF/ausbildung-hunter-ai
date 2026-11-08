/**
 * The 3D sky environment behind the hero aircraft.
 *
 * Everything day/night is a pure function of `t` (0 = full day, 1 = full
 * night) applied every frame, so the ~2 s theme transition is just a tween of
 * t — the theme system (the `dark` class on <html>) is the single source of
 * truth, and the aircraft keeps flying throughout.
 *
 * Depth stack (back to front):
 *   sky dome (z=-150 shell) > stars > sun/moon (z=-95) > far clouds (z=-48)
 *   > mid clouds (z=-18) > AIRCRAFT (z≈0) > near clouds (z=+9) > close
 *   clouds (z=+16). Two cloud planes pass in FRONT of the aircraft, two BEHIND,
 *   each drifting at its own speed — clouds and aircraft move independently.
 */
import * as THREE from "three";

export interface Environment {
  /** Apply a full day/night state (dayNight: 0 = day, 1 = night). */
  apply(dayNight: number): void;
  /** Advance continuous motion (cloud drift, star shimmer). */
  update(dt: number, dayNight: number, elapsed: number): void;
  dispose(): void;
}

interface Palette {
  skyTop: THREE.Color;
  skyBottom: THREE.Color;
  horizonGlow: THREE.Color;
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
}

const DAY: Palette = {
  skyTop: new THREE.Color("#2f7fd6"),
  skyBottom: new THREE.Color("#cfe9f8"),
  horizonGlow: new THREE.Color("#fff6df").multiplyScalar(0.38),
  fog: new THREE.Color("#b9d7ee"),
  fogNear: 70,
  fogFar: 175,
  hemiSky: new THREE.Color("#bfdcf5"),
  hemiGround: new THREE.Color("#e3ecf2"),
  hemiIntensity: 1.05,
  sunIntensity: 1.75,
  fillIntensity: 0.5,
  moonIntensity: 0,
  cloud: new THREE.Color("#ffffff"),
  cloudOpacity: 0.85,
};

const NIGHT: Palette = {
  skyTop: new THREE.Color("#050b1c"),
  skyBottom: new THREE.Color("#182741"),
  horizonGlow: new THREE.Color("#7896d2").multiplyScalar(0.1),
  fog: new THREE.Color("#0a1424"),
  fogNear: 55,
  fogFar: 145,
  hemiSky: new THREE.Color("#25375f"),
  hemiGround: new THREE.Color("#0d1420"),
  hemiIntensity: 0.4,
  sunIntensity: 0,
  fillIntensity: 0.18,
  moonIntensity: 0.55,
  cloud: new THREE.Color("#42537a"),
  cloudOpacity: 0.5,
};

function lerpPalette(t: number): Palette {
  return {
    skyTop: DAY.skyTop.clone().lerp(NIGHT.skyTop, t),
    skyBottom: DAY.skyBottom.clone().lerp(NIGHT.skyBottom, t),
    horizonGlow: DAY.horizonGlow.clone().lerp(NIGHT.horizonGlow, t),
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
  };
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
 *  transparent overdraw plane. */
const CLOUD_BANDS = [
  { z: -48, count: 7, wMin: 20, wMax: 34, yMin: 1.5, yMax: 9.5, speed: 0.55, opacity: 0.9 },
  { z: -18, count: 6, wMin: 16, wMax: 26, yMin: 0.5, yMax: 11, speed: 1.2, opacity: 1.0 },
  { z: 9, count: 5, wMin: 20, wMax: 32, yMin: 1, yMax: 12.5, speed: 2.1, opacity: 0.8 },
  { z: 16, count: 5, wMin: 26, wMax: 42, yMin: -3, yMax: 7, speed: 3.1, opacity: 0.6 },
] as const;

const CLOUD_RANGE = 200;

interface CloudSprite {
  mesh: THREE.Mesh;
  speed: number;
}

/* ------------------------------------------------------------------ build */

export function createEnvironment(scene: THREE.Scene): Environment {
  const disposables: Array<{ dispose(): void }> = [];
  const track = <T extends { dispose(): void }>(d: T): T => {
    disposables.push(d);
    return d;
  };

  /* sky dome --------------------------------------------------------- */
  const skyUniforms = {
    uTop: { value: DAY.skyTop.clone() },
    uBottom: { value: DAY.skyBottom.clone() },
    uGlow: { value: DAY.horizonGlow.clone() },
  };
  const skyMat = track(
    new THREE.ShaderMaterial({
      uniforms: skyUniforms,
      side: THREE.BackSide,
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
        varying vec3 vDir;
        void main() {
          float h = clamp(vDir.y, -0.05, 1.0);
          vec3 col = mix(uBottom, uTop, smoothstep(0.02, 0.62, h));
          col += uGlow * exp(-abs(h - 0.02) * 8.0);
          gl_FragColor = vec4(col, 1.0);
        }
      `,
    }),
  );
  const skyGeo = track(new THREE.SphereGeometry(150, 24, 12));
  const sky = new THREE.Mesh(skyGeo, skyMat);
  sky.renderOrder = -10;
  scene.add(sky);

  /* sun --------------------------------------------------------------- */
  const sunTex = track(
    radialSprite(256, [
      [0, "rgba(255,250,232,1)"],
      [0.18, "rgba(255,244,214,0.9)"],
      [0.42, "rgba(255,238,190,0.32)"],
      [1, "rgba(255,238,190,0)"],
    ]),
  );
  const sunMat = track(
    new THREE.SpriteMaterial({
      map: sunTex,
      transparent: true,
      depthWrite: false,
      fog: false,
      blending: THREE.AdditiveBlending,
    }),
  );
  const sun = new THREE.Sprite(sunMat);
  sun.position.set(44, 30, -95);
  sun.scale.setScalar(40);
  scene.add(sun);

  /* moon -------------------------------------------------------------- */
  const moonGeo = track(new THREE.CircleGeometry(3.8, 40));
  const moonMat = track(
    new THREE.MeshBasicMaterial({ color: new THREE.Color("#e9effc"), transparent: true, fog: false }),
  );
  const moon = new THREE.Mesh(moonGeo, moonMat);
  moon.position.set(34, -9, -95);
  scene.add(moon);

  const moonGlowTex = track(
    radialSprite(256, [
      [0, "rgba(214,228,255,0.85)"],
      [0.3, "rgba(196,214,250,0.28)"],
      [1, "rgba(196,214,250,0)"],
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
  moonGlow.scale.setScalar(30);
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
  // Key light from the upper FRONT-right — on the camera side (+Z) so the
  // fuselage face we actually see is lit instead of shadowed.
  const sunLight = track(new THREE.DirectionalLight(new THREE.Color("#fff2d8"), DAY.sunIntensity));
  sunLight.position.set(26, 34, 38);
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

  /* cloud fields --------------------------------------------------------- */
  const cloudTex = track(cloudTexture());
  const cloudGeo = track(new THREE.PlaneGeometry(1, 1));
  const cloudSprites: CloudSprite[] = [];
  const cloudMats: THREE.MeshBasicMaterial[] = [];

  for (const band of CLOUD_BANDS) {
    const mat = track(
      new THREE.MeshBasicMaterial({
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

  function apply(t: number): void {
    // Allocations per frame are fine at 60 fps here, but avoid them anyway:
    // lerpPalette clones 10 colors per call — acceptable (hero only).
    const p = lerpPalette(t);
    skyUniforms.uTop.value.copy(p.skyTop);
    skyUniforms.uBottom.value.copy(p.skyBottom);
    skyUniforms.uGlow.value.copy(p.horizonGlow);

    // Sun sets over the first half of the transition; the moon rises over
    // the second half, so they never cross on screen.
    const sunOut = THREE.MathUtils.clamp(1 - t / 0.45, 0, 1);
    sunMat.opacity = 0.95 * sunOut;
    sun.visible = sunOut > 0.01;
    sun.position.y = 30 - t * 26;

    const moonIn = THREE.MathUtils.clamp((t - 0.28) / 0.55, 0, 1);
    const moonEase = moonIn * moonIn * (3 - 2 * moonIn);
    moon.position.y = -9 + moonEase * 38;
    moonMat.opacity = moonIn;
    moonGlowMat.opacity = 0.9 * moonIn;
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
    scene.remove(sky, sun, moon, starsBright, starsFaint, hemi, sunLight, fillLight, moonLight);
    for (const c of cloudSprites) scene.remove(c.mesh);
    for (const d of disposables) d.dispose();
  }

  return { apply, update, dispose };
}
