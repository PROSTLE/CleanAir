"use client";

import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import {
  blobShape,
  damp,
  discHillShape,
  glowTexture,
  gradientTexture,
  mountainShape,
  paperGeometry,
  rand,
  wavyRingShape,
} from "./three-utils";

/* ------------------------------------------------------------------ *
 * Palette — layered paper-cut greens outside, a lit landscape inside. *
 * ------------------------------------------------------------------ */

const PORTAL_OUTER = 5.0;

/**
 * Four sheets of cut paper stacked back from the camera. Only the inner hole
 * shrinks between layers, so you look down a tunnel of green and each sheet
 * drops a shadow on the one behind it.
 */
const RING_LAYERS = [
  { innerRadius: 4.28, z: 0, color: "#cfe96f", waves: 5, amplitude: 0.024, phase: 0.4 },
  { innerRadius: 3.98, z: -0.72, color: "#a3da56", waves: 6, amplitude: 0.022, phase: 2.1 },
  { innerRadius: 3.72, z: -1.44, color: "#63c34e", waves: 5, amplitude: 0.026, phase: 3.7 },
  { innerRadius: 3.5, z: -2.16, color: "#31a44f", waves: 7, amplitude: 0.02, phase: 5.2 },
];

const GROUND_Y = -1.55;
const MAX_DELTA = 0.05;

/**
 * Parallax limits. These are a geometric constraint, not a taste setting:
 * the portal tips about the front ring's plane, so every interior layer swings
 * by roughly (its depth) * sin(angle) while the ring that hides it does not.
 * Raising these makes the backdrop discs poke out past the ring's edge at the
 * corners — if you change them, re-check the layer radii in Sky and Terrain.
 */
const PARALLAX_YAW = 0.06;
const PARALLAX_PITCH = 0.045;
const PARALLAX_SHIFT_X = 0.16;
const PARALLAX_SHIFT_Y = 0.12;

/* ------------------------------------------------------------------ *
 * Reduced-motion                                                      *
 * ------------------------------------------------------------------ */

export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReduced(query.matches);
    const onChange = () => setReduced(query.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);
  return reduced;
}

/* ------------------------------------------------------------------ *
 * Paper layers                                                        *
 * ------------------------------------------------------------------ */

function PaperRing({ innerRadius, z, color, waves, amplitude, phase }: (typeof RING_LAYERS)[number]) {
  const geometry = useMemo(
    () => paperGeometry(wavyRingShape(PORTAL_OUTER, innerRadius, waves, amplitude, phase), 0.3, { curveSegments: 80 }),
    [innerRadius, waves, amplitude, phase],
  );
  useEffect(() => () => geometry.dispose(), [geometry]);

  return (
    <mesh geometry={geometry} position={[0, 0, z]} castShadow receiveShadow>
      <meshStandardMaterial color={color} roughness={0.95} metalness={0} />
    </mesh>
  );
}

/* ------------------------------------------------------------------ *
 * Interior helpers                                                    *
 *                                                                     *
 * Nothing inside the portal receives shadows — the rings would throw a *
 * hard edge right across the landscape. Depth comes from the layer     *
 * stack instead, plus these painted contact patches for grounding.     *
 * ------------------------------------------------------------------ */

function ContactShadow({ position, scale, opacity = 0.13 }: { position: [number, number, number]; scale: [number, number]; opacity?: number }) {
  return (
    <mesh position={position} scale={[scale[0], scale[1], 1]}>
      <circleGeometry args={[1, 32]} />
      <meshBasicMaterial color="#1d5b32" transparent opacity={opacity} depthWrite={false} />
    </mesh>
  );
}

function Sky() {
  const texture = useMemo(
    () =>
      gradientTexture([
        [0, "#a9dcf0"],
        [0.42, "#cbebf5"],
        [0.74, "#e8f7f1"],
        [1, "#f5fbec"],
      ]),
    [],
  );
  useEffect(() => () => texture.dispose(), [texture]);

  return (
    <mesh position={[0, 0, -7.5]}>
      <circleGeometry args={[4.65, 64]} />
      <meshBasicMaterial map={texture} toneMapped={false} />
    </mesh>
  );
}

function Sun({ reduced }: { reduced: boolean }) {
  const glowRef = useRef<THREE.Sprite>(null);
  const texture = useMemo(() => glowTexture("rgba(255,233,150,0.95)", "rgba(255,216,95,0.34)"), []);
  useEffect(() => () => texture.dispose(), [texture]);

  useFrame((state) => {
    if (reduced || !glowRef.current) return;
    // Barely-there breathing so the sun feels warm rather than pasted on.
    glowRef.current.scale.setScalar(3.4 * (1 + Math.sin(state.clock.elapsedTime * 0.55) * 0.035));
  });

  return (
    <group position={[-1.2, 1.7, -7.2]}>
      <sprite ref={glowRef} scale={3.4}>
        <spriteMaterial map={texture} transparent depthWrite={false} opacity={0.92} toneMapped={false} />
      </sprite>
      <mesh>
        <circleGeometry args={[0.65, 48]} />
        <meshBasicMaterial color="#ffdc55" toneMapped={false} />
      </mesh>
    </group>
  );
}

export type CloudConfig = {
  seed: number;
  y: number;
  z: number;
  scale: number;
  speed: number;
  opacity: number;
};

export function Cloud({ config, reduced }: { config: CloudConfig; reduced: boolean }) {
  const ref = useRef<THREE.Group>(null);
  const { seed, y, z, scale, speed, opacity } = config;

  // Four overlapping puffs of different size — reads as one soft cloud.
  const puffs = useMemo(
    () =>
      [0, 1, 2, 3].map((i) => ({
        x: (i - 1.5) * 0.34 + (rand(seed + i) - 0.5) * 0.14,
        y: (rand(seed + i * 7) - 0.5) * 0.16,
        r: 0.3 + rand(seed + i * 13) * 0.19 - Math.abs(i - 1.5) * 0.055,
      })),
    [seed],
  );

  const startX = useMemo(() => -3.2 + rand(seed * 3) * 6.4, [seed]);

  useFrame((state, rawDelta) => {
    const group = ref.current;
    if (!group) return;
    if (reduced) {
      group.position.x = startX;
      return;
    }
    const delta = Math.min(rawDelta, MAX_DELTA);
    group.position.x += delta * speed;
    if (group.position.x > 3.2) group.position.x = -3.2;
    // Faint vertical drift — clouds never track perfectly level.
    group.position.y = y + Math.sin(state.clock.elapsedTime * 0.32 + seed) * 0.045;
  });

  return (
    <group ref={ref} position={[startX, y, z]} scale={scale}>
      {puffs.map((puff, i) => (
        <mesh key={i} position={[puff.x, puff.y, i * 0.002]} rotation={[Math.PI / 2, 0, 0]}>
          <cylinderGeometry args={[puff.r, puff.r, 0.12, 26]} />
          <meshStandardMaterial color="#ffffff" roughness={1} metalness={0} transparent opacity={opacity} />
        </mesh>
      ))}
    </group>
  );
}

/* ------------------------------------------------------------------ *
 * Terrain                                                             *
 * ------------------------------------------------------------------ */

function Terrain() {
  const backRidge = useMemo(
    () =>
      paperGeometry(
        mountainShape(
          [
            [-2.2, -0.4],
            [-1.0, 1.15],
            [0.1, 0.0],
            [1.15, 1.62],
            [2.5, -0.3],
          ],
          -2.8,
          6.5,
        ),
        0.26,
      ),
    [],
  );

  const frontRidge = useMemo(
    () =>
      paperGeometry(
        mountainShape(
          [
            [-1.1, -0.5],
            [-0.1, 0.72],
            [0.9, -0.1],
            [1.9, 0.95],
            [2.8, -0.4],
          ],
          -2.8,
          6.5,
        ),
        0.26,
      ),
    [],
  );

  // Radii sized to the cone each layer sits in — see discHillShape.
  const farHills = useMemo(() => paperGeometry(discHillShape(4.6, -0.62, 3, 0.24, 0.8), 0.24), []);
  const midHills = useMemo(() => paperGeometry(discHillShape(4.4, -1.02, 4, 0.2, 2.4), 0.24), []);
  const ground = useMemo(() => paperGeometry(discHillShape(4.2, GROUND_Y, 2.5, 0.22, 4.1), 0.34), []);

  useEffect(
    () => () => {
      [backRidge, frontRidge, farHills, midHills, ground].forEach((geometry) => geometry.dispose());
    },
    [backRidge, frontRidge, farHills, midHills, ground],
  );

  return (
    <group>
      <mesh geometry={backRidge} position={[0.35, 0, -6.1]}>
        <meshStandardMaterial color="#4a8a86" roughness={0.95} metalness={0} />
      </mesh>
      <mesh geometry={frontRidge} position={[0.05, 0, -5.7]}>
        <meshStandardMaterial color="#356e6e" roughness={0.95} metalness={0} />
      </mesh>
      <mesh geometry={farHills} position={[0, 0, -5.3]}>
        <meshStandardMaterial color="#5fae72" roughness={0.95} metalness={0} />
      </mesh>
      <mesh geometry={midHills} position={[0, 0, -4.6]}>
        <meshStandardMaterial color="#7cc853" roughness={0.95} metalness={0} />
      </mesh>
      <mesh geometry={ground} position={[0, 0, -3.9]}>
        <meshStandardMaterial color="#95d556" roughness={0.95} metalness={0} />
      </mesh>
    </group>
  );
}

/* ------------------------------------------------------------------ *
 * Wind turbine — the headline motion of the scene                     *
 * ------------------------------------------------------------------ */

export function Turbine({
  position,
  scale = 1,
  speed = 0.85,
  seed = 1,
  reduced,
  shadows = false,
}: {
  position: [number, number, number];
  scale?: number;
  speed?: number;
  seed?: number;
  reduced: boolean;
  shadows?: boolean;
}) {
  const bladesRef = useRef<THREE.Group>(null);

  const bladeGeometry = useMemo(() => {
    // Tapered blade with a rounded root, extruded thin like cut card.
    const shape = new THREE.Shape();
    shape.moveTo(-0.035, 0);
    shape.quadraticCurveTo(-0.055, 0.28, -0.022, 0.62);
    shape.quadraticCurveTo(-0.008, 0.78, 0, 0.84);
    shape.quadraticCurveTo(0.012, 0.78, 0.026, 0.62);
    shape.quadraticCurveTo(0.055, 0.28, 0.035, 0);
    shape.closePath();
    return paperGeometry(shape, 0.035, { bevelThickness: 0.008, bevelSize: 0.008 });
  }, []);

  useEffect(() => () => bladeGeometry.dispose(), [bladeGeometry]);

  useFrame((state, rawDelta) => {
    if (reduced || !bladesRef.current) return;
    const delta = Math.min(rawDelta, MAX_DELTA);
    // Gusting: the rotor speeds up and eases off instead of spinning uniformly.
    const gust =
      1 +
      Math.sin(state.clock.elapsedTime * 0.41 + seed) * 0.26 +
      Math.sin(state.clock.elapsedTime * 0.13 + seed * 2) * 0.12;
    bladesRef.current.rotation.z -= delta * speed * gust;
  });

  return (
    <group position={position} scale={scale}>
      <mesh position={[0, 0.62, 0]} castShadow={shadows}>
        <cylinderGeometry args={[0.028, 0.055, 1.24, 14]} />
        <meshStandardMaterial color="#fdfefb" roughness={0.72} metalness={0} />
      </mesh>
      <mesh position={[0, 1.24, 0.045]} castShadow={shadows}>
        <boxGeometry args={[0.14, 0.1, 0.13]} />
        <meshStandardMaterial color="#f4f8f1" roughness={0.68} metalness={0} />
      </mesh>
      <group ref={bladesRef} position={[0, 1.24, 0.13]}>
        {[0, 1, 2].map((i) => (
          <mesh key={i} geometry={bladeGeometry} rotation={[0, 0, (i * Math.PI * 2) / 3]} castShadow={shadows}>
            <meshStandardMaterial color="#ffffff" roughness={0.58} metalness={0} />
          </mesh>
        ))}
        <mesh position={[0, 0, 0.03]}>
          <sphereGeometry args={[0.045, 16, 16]} />
          <meshStandardMaterial color="#e8f0e4" roughness={0.6} />
        </mesh>
      </group>
    </group>
  );
}

/* ------------------------------------------------------------------ *
 * Village                                                             *
 * ------------------------------------------------------------------ */

function House({ position, scale = 1, roof = "#3fa856" }: { position: [number, number, number]; scale?: number; roof?: string }) {
  const roofGeometry = useMemo(() => {
    const shape = new THREE.Shape();
    shape.moveTo(-0.33, 0);
    shape.lineTo(0.33, 0);
    shape.lineTo(0, 0.3);
    shape.closePath();
    return paperGeometry(shape, 0.36, { bevelThickness: 0.01, bevelSize: 0.01 });
  }, []);
  useEffect(() => () => roofGeometry.dispose(), [roofGeometry]);

  return (
    <group position={position} scale={scale}>
      <mesh position={[0, 0.2, 0]}>
        <boxGeometry args={[0.5, 0.4, 0.34]} />
        <meshStandardMaterial color="#fdfefb" roughness={0.85} metalness={0} />
      </mesh>
      <mesh geometry={roofGeometry} position={[0, 0.4, 0.18]}>
        <meshStandardMaterial color={roof} roughness={0.9} metalness={0} />
      </mesh>
      {[-0.13, 0.13].map((x) => (
        <mesh key={x} position={[x, 0.21, 0.172]}>
          <planeGeometry args={[0.11, 0.12]} />
          <meshBasicMaterial color="#4f9f96" toneMapped={false} />
        </mesh>
      ))}
    </group>
  );
}

/* ------------------------------------------------------------------ *
 * Tree                                                                *
 * ------------------------------------------------------------------ */

function Tree({ reduced }: { reduced: boolean }) {
  const canopyRef = useRef<THREE.Group>(null);

  const canopies = useMemo(
    () => [
      { geometry: paperGeometry(blobShape(1.3, 7, 0.075, 0.6), 0.34), color: "#2f9448", pos: [-0.36, 0.24, -0.16] as const },
      { geometry: paperGeometry(blobShape(1.18, 6, 0.085, 2.9), 0.36), color: "#4bb251", pos: [0.44, 0.52, 0.02] as const },
      { geometry: paperGeometry(blobShape(0.94, 8, 0.09, 4.4), 0.36), color: "#6ccd5c", pos: [-0.06, 1.0, 0.2] as const },
      { geometry: paperGeometry(blobShape(0.64, 7, 0.1, 1.7), 0.3), color: "#8fdf66", pos: [0.57, 1.14, 0.36] as const },
    ],
    [],
  );

  useEffect(() => () => canopies.forEach((canopy) => canopy.geometry.dispose()), [canopies]);

  useFrame((state) => {
    if (reduced || !canopyRef.current) return;
    const t = state.clock.elapsedTime;
    // Two out-of-phase sines: a slow lean plus a lighter shiver.
    canopyRef.current.rotation.z = Math.sin(t * 0.52) * 0.021 + Math.sin(t * 1.31) * 0.006;
    canopyRef.current.position.x = Math.sin(t * 0.43) * 0.026;
  });

  return (
    <group position={[1.85, GROUND_Y - 0.05, -3.2]}>
      <ContactShadow position={[0.05, 0.04, 0.02]} scale={[0.62, 0.16]} opacity={0.16} />
      <mesh position={[0, 0.76, 0]}>
        <cylinderGeometry args={[0.08, 0.17, 1.58, 12]} />
        <meshStandardMaterial color="#7f5636" roughness={0.95} metalness={0} />
      </mesh>
      <mesh position={[-0.23, 1.3, 0.02]} rotation={[0, 0, 0.72]}>
        <cylinderGeometry args={[0.037, 0.064, 0.62, 10]} />
        <meshStandardMaterial color="#7f5636" roughness={0.95} />
      </mesh>
      <mesh position={[0.25, 1.4, 0.02]} rotation={[0, 0, -0.66]}>
        <cylinderGeometry args={[0.033, 0.057, 0.54, 10]} />
        <meshStandardMaterial color="#7f5636" roughness={0.95} />
      </mesh>

      <group ref={canopyRef} position={[0, 2.0, 0]}>
        {canopies.map((canopy, i) => (
          <mesh key={i} geometry={canopy.geometry} position={[...canopy.pos]}>
            <meshStandardMaterial color={canopy.color} roughness={0.94} metalness={0} />
          </mesh>
        ))}
      </group>
    </group>
  );
}

/* ------------------------------------------------------------------ *
 * Birds                                                               *
 * ------------------------------------------------------------------ */

function Bird({ seed, y, z, speed, scale, reduced }: { seed: number; y: number; z: number; speed: number; scale: number; reduced: boolean }) {
  const groupRef = useRef<THREE.Group>(null);
  const leftWing = useRef<THREE.Mesh>(null);
  const rightWing = useRef<THREE.Mesh>(null);
  const startX = useMemo(() => -4 + rand(seed) * 8, [seed]);

  useFrame((state, rawDelta) => {
    const group = groupRef.current;
    if (!group || reduced) return;
    const delta = Math.min(rawDelta, MAX_DELTA);
    group.position.x += delta * speed;
    if (group.position.x > 3.2) group.position.x = -3.2;

    const t = state.clock.elapsedTime;
    group.position.y = y + Math.sin(t * 0.9 + seed) * 0.12;
    const flap = Math.sin(t * 7 + seed * 3) * 0.5;
    if (leftWing.current) leftWing.current.rotation.z = 0.42 + flap;
    if (rightWing.current) rightWing.current.rotation.z = -0.42 - flap;
  });

  return (
    <group ref={groupRef} position={[startX, y, z]} scale={scale}>
      <mesh ref={leftWing} position={[-0.01, 0, 0]} rotation={[0, 0, 0.42]}>
        <boxGeometry args={[0.22, 0.018, 0.018]} />
        <meshBasicMaterial color="#54685a" toneMapped={false} />
      </mesh>
      <mesh ref={rightWing} position={[0.01, 0, 0]} rotation={[0, 0, -0.42]}>
        <boxGeometry args={[0.22, 0.018, 0.018]} />
        <meshBasicMaterial color="#54685a" toneMapped={false} />
      </mesh>
    </group>
  );
}

/* ------------------------------------------------------------------ *
 * Scene composition                                                   *
 * ------------------------------------------------------------------ */

const CLOUDS: CloudConfig[] = [
  { seed: 3, y: 2.1, z: -5.6, scale: 0.88, speed: 0.14, opacity: 0.97 },
  { seed: 11, y: 1.45, z: -4.9, scale: 0.65, speed: 0.21, opacity: 0.95 },
  { seed: 19, y: 2.3, z: -6.4, scale: 0.92, speed: 0.09, opacity: 0.9 },
  { seed: 27, y: 0.9, z: -5.8, scale: 0.55, speed: 0.17, opacity: 0.88 },
];

const HOUSES: Array<{ x: number; z: number; scale: number; roof: string }> = [
  { x: -0.72, z: -3.5, scale: 1.0, roof: "#3fa856" },
  { x: 0.3, z: -3.42, scale: 1.18, roof: "#2f8f46" },
  { x: 1.18, z: -3.56, scale: 0.86, roof: "#4cb85f" },
];

function PortalScene({ reduced }: { reduced: boolean }) {
  const rootRef = useRef<THREE.Group>(null);
  const landscapeRef = useRef<THREE.Group>(null);
  const { pointer } = useThree();

  useFrame((state, rawDelta) => {
    const delta = Math.min(rawDelta, MAX_DELTA);
    const root = rootRef.current;
    if (!root) return;

    if (reduced) {
      root.rotation.set(0, 0, 0);
      return;
    }

    // Pointer parallax: the whole portal tips a few degrees, and the landscape
    // inside counter-shifts so you feel the depth of the cut-out layers.
    root.rotation.y = damp(root.rotation.y, pointer.x * PARALLAX_YAW, 3, delta);
    root.rotation.x = damp(root.rotation.x, -pointer.y * PARALLAX_PITCH, 3, delta);
    root.scale.setScalar(1 + Math.sin(state.clock.elapsedTime * 0.42) * 0.004);

    if (landscapeRef.current) {
      landscapeRef.current.position.x = damp(landscapeRef.current.position.x, -pointer.x * PARALLAX_SHIFT_X, 3, delta);
      landscapeRef.current.position.y = damp(landscapeRef.current.position.y, -pointer.y * PARALLAX_SHIFT_Y, 3, delta);
    }
  });

  return (
    <group ref={rootRef}>
      <group ref={landscapeRef}>
        <Sky />
        <Sun reduced={reduced} />

        {CLOUDS.map((cloud) => (
          <Cloud key={cloud.seed} config={cloud} reduced={reduced} />
        ))}

        <Bird seed={5} y={2.35} z={-5.4} speed={0.34} scale={0.9} reduced={reduced} />
        <Bird seed={13} y={1.95} z={-5.8} speed={0.27} scale={0.75} reduced={reduced} />
        <Bird seed={23} y={2.55} z={-6.2} speed={0.4} scale={0.6} reduced={reduced} />

        <Terrain />

        <Turbine position={[-2.5, GROUND_Y - 0.12, -4.0]} scale={1.05} speed={0.9} seed={1} reduced={reduced} />
        <Turbine position={[-1.45, GROUND_Y - 0.06, -3.55]} scale={0.8} speed={1.15} seed={4} reduced={reduced} />
        <Turbine position={[-3.15, GROUND_Y - 0.02, -3.4]} scale={0.64} speed={1.35} seed={9} reduced={reduced} />

        {HOUSES.map((house) => (
          <group key={house.x} position={[house.x, GROUND_Y - 0.02, house.z]}>
            <ContactShadow position={[0.03, 0.02, -0.02]} scale={[0.34 * house.scale, 0.09 * house.scale]} />
            <House position={[0, 0, 0]} scale={house.scale} roof={house.roof} />
          </group>
        ))}

        <Tree reduced={reduced} />
      </group>

      {RING_LAYERS.map((layer) => (
        <PaperRing key={layer.z} {...layer} />
      ))}
    </group>
  );
}

/* ------------------------------------------------------------------ *
 * Canvas                                                              *
 * ------------------------------------------------------------------ */

export default function HeroPortal() {
  const reduced = usePrefersReducedMotion();

  return (
    <Canvas
      flat
      shadows="percentage"
      dpr={[1, 1.8]}
      // Default resize config re-measures on every scroll via
      // getBoundingClientRect; a mid-scroll measurement could land stale and
      // leave the drawing buffer sized wrong (canvas rendered small, then CSS
      // stretched it — the magnified/blurry overflow). offsetSize reads
      // offsetWidth/Height, which is immune to that.
      resize={{ scroll: false, offsetSize: true }}
      gl={{ antialias: true, alpha: true, powerPreference: "high-performance" }}
      camera={{ fov: 34, position: [0, 0, 19], near: 0.1, far: 60 }}
      style={{ width: "100%", height: "100%" }}
    >
      {/* three r155+ lights are physically scaled — intensities run ~PI higher
          than the pre-r155 values these scenes were first tuned at. */}
      <ambientLight intensity={1.5} />
      <hemisphereLight args={["#e8f7ff", "#6f9a52", 1.0]} />
      <directionalLight
        position={[5, 8, 14]}
        intensity={2.0}
        castShadow
        shadow-mapSize={[1024, 1024]}
        shadow-camera-left={-7}
        shadow-camera-right={7}
        shadow-camera-top={7}
        shadow-camera-bottom={-7}
        shadow-camera-near={0.5}
        shadow-camera-far={45}
        shadow-bias={-0.0012}
        shadow-normalBias={0.022}
      />
      <directionalLight position={[-6, 2, 8]} intensity={0.55} color="#cfe9ff" />

      <PortalScene reduced={reduced} />
    </Canvas>
  );
}
