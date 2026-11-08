/**
 * Flight path for the hero aircraft.
 *
 * The aircraft (model space: nose +Z, port side +X, up +Y) flies left-to-right
 * across the screen (world +X) on a slow S-curve, wrapping off-frame so the
 * loop point is never visible. Position and orientation are pure functions of
 * elapsed time, so the flight is deterministic and trivially pausable.
 */

export interface FlightPose {
  x: number;
  y: number;
  z: number;
  /** YZX euler angles for an object already facing world +X. */
  pitch: number;
  yaw: number;
  bank: number;
}

/** Cruise speed in metres/second (model units are metres). */
const SPEED = 4.0;
/** The aircraft wraps while fully off-frame at both ends. */
const SPAN = 68;
const MIN_X = -34;

/**
 * Altitude: the model spans 0.3–12.3 m from its origin (fuselage centreline
 * at 3.8 m, fin top at 12.3 m). With the camera at z=40 the frame at z=0
 * spans ~[-10.4, +20.4] m, so a root altitude of ~5 m keeps the fin top at
 * 8–13 % from the frame top — fully visible, clear of the header — while the
 * fuselage sweeps the band just above the headline.
 */
const ALTITUDE = 4.9;
const WOBBLE = 0.6;

/**
 * @param t elapsed seconds
 * @param phase seed so successive loads don't start mid-screen
 */
export function flightPose(t: number, phase = 0): FlightPose {
  const p = t + phase;
  // x(0) = MIN_X (off-frame left); wraps back once SPEED*p covers SPAN.
  const x = MIN_X + ((((SPEED * p) % SPAN) + SPAN) % SPAN);

  const z = 2.4 * Math.sin(0.05 * p + 0.6);
  const y = ALTITUDE + WOBBLE * Math.sin(0.09 * p + 1.7) + 0.15 * Math.sin(0.23 * p);

  const dz = 2.4 * 0.05 * Math.cos(0.05 * p + 0.6);
  const dy = WOBBLE * 0.09 * Math.cos(0.09 * p + 1.7) + 0.15 * 0.23 * Math.cos(0.23 * p);

  // Heading follows the path tangent (lazy: 90% of the tangent angle).
  const yaw = -0.9 * Math.atan2(dz, 1);
  const pitch = Math.atan2(dy, 1);
  // Bank into the S-curve turn plus a small high-frequency flutter.
  const bank = -0.052 * Math.cos(0.05 * p + 0.6) - 0.02 * Math.sin(0.13 * p + 0.4);

  return { x, y, z, pitch, yaw, bank };
}

/** A pleasing fixed pose for prefers-reduced-motion (no continuous flight). */
export function staticPose(): FlightPose {
  return { x: 9.0, y: ALTITUDE, z: 0.3, pitch: 0.015, yaw: 0, bank: 0.03 };
}
