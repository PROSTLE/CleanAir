import * as THREE from "three";

/**
 * Shared helpers for the landing-page WebGL scenes.
 *
 * Everything here is deterministic — no Math.random() — so a remount produces
 * an identical scene and the paper-cut layers never re-shuffle between frames.
 */

/** Cheap deterministic hash → [0, 1). Used wherever we'd otherwise reach for Math.random. */
export function rand(seed: number): number {
  const x = Math.sin(seed * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}

/** Deterministic value in [min, max). */
export function randRange(seed: number, min: number, max: number): number {
  return min + rand(seed) * (max - min);
}

/**
 * A disc with an organic, hand-cut hole in the middle — the building block of
 * the layered paper-cut portal. Two summed sine terms keep the inner edge
 * irregular so it reads as torn paper rather than a mathematical ring.
 */
export function wavyRingShape(
  outerRadius: number,
  innerRadius: number,
  waves: number,
  amplitude: number,
  phase: number,
): THREE.Shape {
  const shape = new THREE.Shape();
  shape.absarc(0, 0, outerRadius, 0, Math.PI * 2, false);

  const hole = new THREE.Path();
  const segments = 180;
  for (let i = 0; i <= segments; i += 1) {
    const angle = (i / segments) * Math.PI * 2;
    const wobble =
      1 +
      amplitude * Math.sin(waves * angle + phase) +
      amplitude * 0.42 * Math.sin(waves * 1.73 * angle + phase * 1.37);
    const radius = innerRadius * wobble;
    const x = Math.cos(angle) * radius;
    const y = Math.sin(angle) * radius;
    if (i === 0) hole.moveTo(x, y);
    else hole.lineTo(x, y);
  }
  hole.closePath();
  shape.holes.push(hole);
  return shape;
}

/** An irregular closed blob — tree canopies, cloud bodies, hill crowns. */
export function blobShape(
  radius: number,
  waves: number,
  amplitude: number,
  phase: number,
  segments = 96,
): THREE.Shape {
  const shape = new THREE.Shape();
  for (let i = 0; i <= segments; i += 1) {
    const angle = (i / segments) * Math.PI * 2;
    const wobble =
      1 +
      amplitude * Math.sin(waves * angle + phase) +
      amplitude * 0.5 * Math.sin(waves * 2.1 * angle + phase * 0.7);
    const r = radius * wobble;
    const x = Math.cos(angle) * r;
    const y = Math.sin(angle) * r;
    if (i === 0) shape.moveTo(x, y);
    else shape.lineTo(x, y);
  }
  shape.closePath();
  return shape;
}

/**
 * A rolling hill: flat-bottomed slab whose top edge is a low-frequency wave.
 * Used for the ground plane and the mid-distance ridges.
 */
export function hillShape(
  width: number,
  baseY: number,
  crestY: number,
  waves: number,
  phase: number,
): THREE.Shape {
  const shape = new THREE.Shape();
  const half = width / 2;
  const segments = 120;
  shape.moveTo(-half, baseY);
  for (let i = 0; i <= segments; i += 1) {
    const t = i / segments;
    const x = -half + t * width;
    const y =
      crestY +
      Math.sin(t * Math.PI * waves + phase) * 0.22 +
      Math.sin(t * Math.PI * waves * 2.3 + phase * 1.6) * 0.09;
    shape.lineTo(x, y);
  }
  shape.lineTo(half, baseY);
  shape.closePath();
  return shape;
}

/**
 * A rolling hill clipped to a disc: wavy crest on top, circular arc underneath.
 *
 * Inside the paper portal every backdrop layer has to stay within the cone the
 * innermost hole opens onto — a plain rectangular slab pokes out past the rings
 * and reads as a stray green box. Bounding the slab by a circle keeps it hidden
 * whatever the parallax does. The crest wobble tapers to zero at both ends so
 * the seam always lands exactly on the arc.
 */
export function discHillShape(
  radius: number,
  crestY: number,
  waves: number,
  amplitude: number,
  phase: number,
): THREE.Shape {
  const shape = new THREE.Shape();
  const halfWidth = Math.sqrt(Math.max(radius * radius - crestY * crestY, 0.04));
  const segments = 120;

  for (let i = 0; i <= segments; i += 1) {
    const t = i / segments;
    const x = -halfWidth + t * halfWidth * 2;
    const taper = Math.sin(Math.PI * t);
    const y =
      crestY +
      taper *
        (Math.sin(t * Math.PI * waves + phase) * amplitude +
          Math.sin(t * Math.PI * waves * 2.3 + phase * 1.6) * amplitude * 0.4);
    if (i === 0) shape.moveTo(x, y);
    else shape.lineTo(x, y);
  }

  // Close along the bottom of the circle, right endpoint back round to the left.
  shape.absarc(0, 0, radius, Math.atan2(crestY, halfWidth), Math.atan2(crestY, -halfWidth), true);
  shape.closePath();
  return shape;
}

/** Sharp mountain silhouette with a couple of peaks. */
export function mountainShape(peaks: Array<[number, number]>, baseY: number, width: number): THREE.Shape {
  const shape = new THREE.Shape();
  const half = width / 2;
  shape.moveTo(-half, baseY);
  peaks.forEach(([x, y]) => shape.lineTo(x, y));
  shape.lineTo(half, baseY);
  shape.closePath();
  return shape;
}

const DEFAULT_EXTRUDE: THREE.ExtrudeGeometryOptions = {
  depth: 0.2,
  bevelEnabled: true,
  bevelThickness: 0.025,
  bevelSize: 0.025,
  bevelSegments: 2,
  curveSegments: 48,
};

/**
 * Extrude a shape into a "sheet of paper" and shift it so its *front* face
 * lands on the local z origin — makes stacking layers by z position intuitive.
 */
export function paperGeometry(
  shape: THREE.Shape,
  depth = 0.2,
  options: Partial<THREE.ExtrudeGeometryOptions> = {},
): THREE.ExtrudeGeometry {
  const geometry = new THREE.ExtrudeGeometry(shape, {
    ...DEFAULT_EXTRUDE,
    depth,
    ...options,
  });
  geometry.translate(0, 0, -depth);
  geometry.computeVertexNormals();
  return geometry;
}

/** Vertical gradient texture painted on a 2D canvas — used for skies and water depth. */
export function gradientTexture(stops: Array<[number, string]>): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = 8;
  canvas.height = 256;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    const gradient = ctx.createLinearGradient(0, 0, 0, 256);
    stops.forEach(([offset, color]) => gradient.addColorStop(offset, color));
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, 8, 256);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  return texture;
}

/** Radial glow sprite, for the sun's halo. */
export function glowTexture(inner: string, outer: string): THREE.CanvasTexture {
  const size = 128;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    const gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    gradient.addColorStop(0, inner);
    gradient.addColorStop(0.45, outer);
    gradient.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, size, size);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/** Frame-rate independent easing towards a target — keeps parallax buttery. */
export function damp(current: number, target: number, lambda: number, delta: number): number {
  return THREE.MathUtils.damp(current, target, lambda, delta);
}
