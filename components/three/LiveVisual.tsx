"use client";

import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import Ocean from "./Ocean";
import { Cloud, Turbine, usePrefersReducedMotion, type CloudConfig } from "./HeroPortal";
import { damp, glowTexture, gradientTexture, hillShape, mountainShape, paperGeometry, rand } from "./three-utils";

export type VisualVariant = "coast" | "haze" | "wind";

const MAX_DELTA = 0.05;

/* ------------------------------------------------------------------ *
 * Shared bits                                                         *
 * ------------------------------------------------------------------ */

function CameraRig({ x, y, z, tx, ty, tz }: { x: number; y: number; z: number; tx: number; ty: number; tz: number }) {
  const { camera } = useThree();
  useEffect(() => {
    camera.position.set(x, y, z);
    camera.lookAt(tx, ty, tz);
    camera.updateProjectionMatrix();
  }, [camera, x, y, z, tx, ty, tz]);
  return null;
}

/** Gentle pointer-driven sway applied to a whole scene. */
function ParallaxGroup({ children, strength = 1, reduced }: { children: React.ReactNode; strength?: number; reduced: boolean }) {
  const ref = useRef<THREE.Group>(null);
  const { pointer } = useThree();

  useFrame((_, rawDelta) => {
    const group = ref.current;
    if (!group || reduced) return;
    const delta = Math.min(rawDelta, MAX_DELTA);
    group.rotation.y = damp(group.rotation.y, pointer.x * 0.055 * strength, 2.6, delta);
    group.rotation.x = damp(group.rotation.x, -pointer.y * 0.035 * strength, 2.6, delta);
  });

  return <group ref={ref}>{children}</group>;
}

function GradientBackdrop({ stops, position, size }: { stops: Array<[number, string]>; position: [number, number, number]; size: [number, number] }) {
  const texture = useMemo(() => gradientTexture(stops), [stops]);
  useEffect(() => () => texture.dispose(), [texture]);
  return (
    <mesh position={position}>
      <planeGeometry args={size} />
      <meshBasicMaterial map={texture} toneMapped={false} depthWrite={false} />
    </mesh>
  );
}

function SunGlow({ position, scale, inner, outer, reduced }: { position: [number, number, number]; scale: number; inner: string; outer: string; reduced: boolean }) {
  const ref = useRef<THREE.Sprite>(null);
  const texture = useMemo(() => glowTexture(inner, outer), [inner, outer]);
  useEffect(() => () => texture.dispose(), [texture]);

  useFrame((state) => {
    if (!ref.current || reduced) return;
    ref.current.scale.setScalar(scale * (1 + Math.sin(state.clock.elapsedTime * 0.5) * 0.03));
  });

  return (
    <sprite ref={ref} position={position} scale={scale}>
      <spriteMaterial map={texture} transparent depthWrite={false} toneMapped={false} />
    </sprite>
  );
}

/* ------------------------------------------------------------------ *
 * Coast — the moving-water scene                                      *
 * ------------------------------------------------------------------ */

const COAST_SKY: Array<[number, string]> = [
  [0, "#8fd0e8"],
  [0.42, "#bfe6ee"],
  [0.72, "#e6f5f2"],
  [1, "#fdf6e3"],
];

function Headland({ position, color, scale }: { position: [number, number, number]; color: string; scale: number }) {
  const geometry = useMemo(
    () =>
      paperGeometry(
        mountainShape(
          [
            [-7, 1.2],
            [-4.2, 3.4],
            [-1.6, 1.9],
            [1.4, 3.9],
            [4.6, 1.4],
          ],
          -3,
          20,
        ),
        0.4,
      ),
    [],
  );
  useEffect(() => () => geometry.dispose(), [geometry]);
  return (
    <mesh geometry={geometry} position={position} scale={scale}>
      <meshBasicMaterial color={color} toneMapped={false} />
    </mesh>
  );
}

function CoastScene({ reduced }: { reduced: boolean }) {
  return (
    <>
      <CameraRig x={0} y={2.6} z={9} tx={0} ty={1.4} tz={-30} />
      <ParallaxGroup reduced={reduced} strength={0.6}>
        <GradientBackdrop stops={COAST_SKY} position={[0, 14, -95]} size={[240, 90]} />
        <SunGlow position={[7, 5.4, -80]} scale={34} inner="rgba(255,246,214,0.95)" outer="rgba(255,224,150,0.32)" reduced={reduced} />
        <Headland position={[-16, -0.4, -66]} color="#3d6f70" scale={1.5} />
        <Headland position={[19, -0.6, -74]} color="#4a7d78" scale={1.2} />
        <Ocean reduced={reduced} />
      </ParallaxGroup>
    </>
  );
}

/* ------------------------------------------------------------------ *
 * Haze — smog drifting over a skyline                                 *
 * ------------------------------------------------------------------ */

const HAZE_SKY: Array<[number, string]> = [
  [0, "#6f7d8c"],
  [0.35, "#9aa2a3"],
  [0.62, "#c9b89a"],
  [0.85, "#e0c79c"],
  [1, "#eddcb4"],
];

function Skyline({ z, color, seedBase, count, maxHeight, spread }: { z: number; color: string; seedBase: number; count: number; maxHeight: number; spread: number }) {
  const buildings = useMemo(
    () =>
      Array.from({ length: count }, (_, i) => {
        const seed = seedBase + i * 3.13;
        const width = 0.7 + rand(seed) * 1.5;
        const height = 1.1 + rand(seed * 1.7) * maxHeight;
        const x = -spread / 2 + (i / (count - 1)) * spread + (rand(seed * 2.3) - 0.5) * 0.8;
        return { x, width, height, seed };
      }),
    [count, seedBase, maxHeight, spread],
  );

  return (
    <group position={[0, 0, z]}>
      {buildings.map((b) => (
        <mesh key={b.seed} position={[b.x, b.height / 2 - 2, 0]}>
          <boxGeometry args={[b.width, b.height, 0.6]} />
          <meshBasicMaterial color={color} toneMapped={false} />
        </mesh>
      ))}
    </group>
  );
}

/** Soft translucent slabs of particulate that slide across the skyline. */
function SmogBank({ seed, y, z, scale, speed, opacity, tint, reduced }: { seed: number; y: number; z: number; scale: number; speed: number; opacity: number; tint: string; reduced: boolean }) {
  const ref = useRef<THREE.Sprite>(null);
  const texture = useMemo(() => glowTexture(tint, tint.replace(/[\d.]+\)$/, "0.18)")), [tint]);
  useEffect(() => () => texture.dispose(), [texture]);
  const startX = useMemo(() => -14 + rand(seed) * 28, [seed]);

  useFrame((state, rawDelta) => {
    const sprite = ref.current;
    if (!sprite) return;
    if (reduced) return;
    const delta = Math.min(rawDelta, MAX_DELTA);
    sprite.position.x += delta * speed;
    if (sprite.position.x > 17) sprite.position.x = -17;
    sprite.position.y = y + Math.sin(state.clock.elapsedTime * 0.22 + seed) * 0.22;
  });

  return (
    <sprite ref={ref} position={[startX, y, z]} scale={[scale * 2.4, scale, 1]}>
      <spriteMaterial map={texture} transparent opacity={opacity} depthWrite={false} toneMapped={false} />
    </sprite>
  );
}

function HazeScene({ reduced }: { reduced: boolean }) {
  return (
    <>
      <CameraRig x={0} y={1.2} z={13} tx={0} ty={1.2} tz={-10} />
      <ParallaxGroup reduced={reduced} strength={0.8}>
        <GradientBackdrop stops={HAZE_SKY} position={[0, 2, -30]} size={[90, 46]} />
        <SunGlow position={[-4.5, 3.2, -26]} scale={13} inner="rgba(255,214,140,0.85)" outer="rgba(233,170,96,0.3)" reduced={reduced} />

        {/* Dust-laden ground so the towers stand on something. */}
        <mesh position={[0, -6.1, -6]}>
          <planeGeometry args={[120, 9]} />
          <meshBasicMaterial color="#cbb489" toneMapped={false} />
        </mesh>

        <Skyline z={-20} color="#8d949b" seedBase={2} count={13} maxHeight={5.2} spread={34} />
        <SmogBank seed={4} y={2.6} z={-17} scale={7} speed={0.42} opacity={0.5} tint="rgba(214,203,182,0.9)" reduced={reduced} />
        <Skyline z={-13} color="#69737d" seedBase={31} count={11} maxHeight={4.4} spread={28} />
        <SmogBank seed={9} y={1.4} z={-10} scale={6} speed={0.6} opacity={0.55} tint="rgba(203,190,170,0.9)" reduced={reduced} />
        <Skyline z={-7} color="#48525d" seedBase={57} count={9} maxHeight={3.4} spread={24} />
        <SmogBank seed={15} y={0.4} z={-4} scale={5.5} speed={0.85} opacity={0.45} tint="rgba(190,178,160,0.9)" reduced={reduced} />
      </ParallaxGroup>
    </>
  );
}

/* ------------------------------------------------------------------ *
 * Wind — turbines on clean hills                                      *
 * ------------------------------------------------------------------ */

const WIND_SKY: Array<[number, string]> = [
  [0, "#9fd8ee"],
  [0.45, "#c9ecf3"],
  [0.8, "#e8f7ef"],
  [1, "#f3fbe9"],
];

const WIND_CLOUDS: CloudConfig[] = [
  { seed: 41, y: 2.9, z: -6, scale: 1.5, speed: 0.16, opacity: 0.95 },
  { seed: 53, y: 2.0, z: -4.5, scale: 1.0, speed: 0.24, opacity: 0.92 },
  { seed: 67, y: 3.5, z: -8, scale: 1.9, speed: 0.1, opacity: 0.85 },
];

function WindHills() {
  const far = useMemo(() => paperGeometry(hillShape(30, -8, 0.1, 3, 1.2), 0.3), []);
  const mid = useMemo(() => paperGeometry(hillShape(30, -8, -0.7, 4, 3.3), 0.3), []);
  const near = useMemo(() => paperGeometry(hillShape(30, -8, -1.6, 2.5, 5.1), 0.4), []);

  useEffect(
    () => () => {
      far.dispose();
      mid.dispose();
      near.dispose();
    },
    [far, mid, near],
  );

  return (
    <group>
      <mesh geometry={far} position={[0, 0, -7]} receiveShadow>
        <meshStandardMaterial color="#5aa876" roughness={0.95} />
      </mesh>
      <mesh geometry={mid} position={[0, 0, -4.5]} receiveShadow>
        <meshStandardMaterial color="#74c057" roughness={0.95} />
      </mesh>
      <mesh geometry={near} position={[0, 0, -2]} receiveShadow>
        <meshStandardMaterial color="#93d155" roughness={0.95} />
      </mesh>
    </group>
  );
}

function WindScene({ reduced }: { reduced: boolean }) {
  return (
    <>
      <CameraRig x={0} y={1.5} z={11.5} tx={0} ty={1.1} tz={-6} />
      {/* r155+ physical light units — see the note in HeroPortal. */}
      <ambientLight intensity={1.9} />
      <directionalLight position={[4, 7, 8]} intensity={2.2} />
      <hemisphereLight args={["#e8f7ff", "#6f9a52", 0.9]} />
      <ParallaxGroup reduced={reduced} strength={0.7}>
        <GradientBackdrop stops={WIND_SKY} position={[0, 3, -18]} size={[60, 34]} />
        {WIND_CLOUDS.map((cloud) => (
          <Cloud key={cloud.seed} config={cloud} reduced={reduced} />
        ))}
        <WindHills />
        <Turbine position={[-3.4, -0.9, -5.2]} scale={1.5} speed={0.75} seed={2} reduced={reduced} />
        <Turbine position={[-0.6, -1.5, -3.4]} scale={2.1} speed={0.62} seed={6} reduced={reduced} />
        <Turbine position={[2.6, -1.1, -4.6]} scale={1.7} speed={0.88} seed={11} reduced={reduced} />
        <Turbine position={[4.6, -0.7, -6]} scale={1.2} speed={1.1} seed={17} reduced={reduced} />
      </ParallaxGroup>
    </>
  );
}

/* ------------------------------------------------------------------ *
 * Wrapper — only renders frames while the visual is on screen         *
 * ------------------------------------------------------------------ */

export default function LiveVisual({ variant, className }: { variant: VisualVariant; className?: string }) {
  const reduced = usePrefersReducedMotion();
  const containerRef = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const node = containerRef.current;
    if (!node) return;
    const observer = new IntersectionObserver(
      ([entry]) => setVisible(entry.isIntersecting),
      { rootMargin: "120px" },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  return (
    <div ref={containerRef} className={className}>
      <Canvas
        flat
        dpr={[1, 1.6]}
        frameloop={visible ? "always" : "never"}
        gl={{ antialias: true, alpha: false, powerPreference: "high-performance" }}
        camera={{ fov: 42, near: 0.1, far: 300 }}
        style={{ width: "100%", height: "100%" }}
      >
        {variant === "coast" && <CoastScene reduced={reduced} />}
        {variant === "haze" && <HazeScene reduced={reduced} />}
        {variant === "wind" && <WindScene reduced={reduced} />}
      </Canvas>
    </div>
  );
}
