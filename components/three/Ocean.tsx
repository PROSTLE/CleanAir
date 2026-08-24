"use client";

import { useFrame } from "@react-three/fiber";
import { useMemo, useRef } from "react";
import * as THREE from "three";

/**
 * Open-water surface built from four summed Gerstner waves.
 *
 * Gerstner (trochoidal) waves displace vertices horizontally as well as
 * vertically, so crests sharpen and troughs flatten the way real swell does —
 * a plain sine heightfield always reads as rubber. Normals are accumulated
 * analytically from each wave's tangent/binormal contribution rather than
 * recomputed from geometry, which keeps the lighting stable at any tessellation.
 */

const vertexShader = /* glsl */ `
  uniform float uTime;
  uniform vec4 uWaveA;
  uniform vec4 uWaveB;
  uniform vec4 uWaveC;
  uniform vec4 uWaveD;

  varying vec3 vWorldPos;
  varying vec3 vNormal;
  varying float vHeight;

  // wave = (dirX, dirZ, steepness, wavelength)
  vec3 gerstner(vec4 wave, vec3 p, inout vec3 tangent, inout vec3 binormal) {
    float steepness = wave.z;
    float wavelength = wave.w;
    float k = 6.283185 / wavelength;
    float c = sqrt(9.81 / k);
    vec2 d = normalize(wave.xy);
    float f = k * (dot(d, p.xz) - c * uTime);
    float a = steepness / k;

    float sinF = sin(f);
    float cosF = cos(f);

    tangent += vec3(
      -d.x * d.x * (steepness * sinF),
       d.x * (steepness * cosF),
      -d.x * d.y * (steepness * sinF)
    );
    binormal += vec3(
      -d.x * d.y * (steepness * sinF),
       d.y * (steepness * cosF),
      -d.y * d.y * (steepness * sinF)
    );

    return vec3(
      d.x * (a * cosF),
      a * sinF,
      d.y * (a * cosF)
    );
  }

  void main() {
    vec3 gridPoint = position;
    vec3 tangent = vec3(1.0, 0.0, 0.0);
    vec3 binormal = vec3(0.0, 0.0, 1.0);

    vec3 p = gridPoint;
    p += gerstner(uWaveA, gridPoint, tangent, binormal);
    p += gerstner(uWaveB, gridPoint, tangent, binormal);
    p += gerstner(uWaveC, gridPoint, tangent, binormal);
    p += gerstner(uWaveD, gridPoint, tangent, binormal);

    // Fine chop riding on the swell — adds sparkle without more Gerstner passes.
    float chop =
      sin(gridPoint.x * 1.9 + uTime * 1.7) * 0.035 +
      sin(gridPoint.z * 2.4 - uTime * 1.3) * 0.028;
    p.y += chop;

    vec3 n = normalize(cross(binormal, tangent));

    vHeight = p.y;
    vNormal = normalize(mat3(modelMatrix) * n);

    vec4 worldPos = modelMatrix * vec4(p, 1.0);
    vWorldPos = worldPos.xyz;
    gl_Position = projectionMatrix * viewMatrix * worldPos;
  }
`;

const fragmentShader = /* glsl */ `
  uniform vec3 uSunDir;
  uniform vec3 uDeep;
  uniform vec3 uShallow;
  uniform vec3 uFoam;
  uniform vec3 uHorizon;
  uniform float uTime;

  varying vec3 vWorldPos;
  varying vec3 vNormal;
  varying float vHeight;

  void main() {
    vec3 N = normalize(vNormal);
    vec3 V = normalize(cameraPosition - vWorldPos);
    vec3 L = normalize(uSunDir);

    // How far this fragment is toward the horizon, 0 near camera → 1 far away.
    float dist = clamp((-vWorldPos.z + 6.0) / 70.0, 0.0, 1.0);

    // Depth colour: turquoise in the shallows, deep teal further out.
    vec3 base = mix(uShallow, uDeep, smoothstep(0.0, 0.5, dist));

    // Soft wrap lighting — full Lambert makes stylised water look plastic.
    float ndl = clamp(dot(N, L) * 0.5 + 0.5, 0.0, 1.0);
    base *= 0.70 + 0.44 * ndl;

    vec3 H = normalize(L + V);
    float nh = clamp(dot(N, H), 0.0, 1.0);
    float spec = pow(nh, 240.0) * 2.2;   // tight sun glitter
    float sheen = pow(nh, 26.0) * 0.14;  // broad sheen along the glint path

    // Foam collects on the steepest crests.
    float foam = smoothstep(0.26, 0.52, vHeight);
    base = mix(base, uFoam, foam * 0.55);

    // Fresnel sky reflection at grazing angles.
    float fresnel = pow(1.0 - clamp(dot(N, V), 0.0, 1.0), 4.0);
    base = mix(base, uHorizon, fresnel * 0.6);

    // Atmospheric haze so the plane dissolves into the sky at the horizon.
    base = mix(base, uHorizon, smoothstep(0.62, 1.0, dist));

    gl_FragColor = vec4(base + spec + sheen, 1.0);
    #include <colorspace_fragment>
  }
`;

export default function Ocean({ reduced }: { reduced: boolean }) {
  const materialRef = useRef<THREE.ShaderMaterial>(null);

  const geometry = useMemo(() => {
    const geo = new THREE.PlaneGeometry(160, 150, 140, 140);
    geo.rotateX(-Math.PI / 2);
    return geo;
  }, []);

  const uniforms = useMemo(
    () => ({
      uTime: { value: 0 },
      // (dirX, dirZ, steepness, wavelength)
      uWaveA: { value: new THREE.Vector4(1.0, 0.32, 0.30, 14.0) },
      uWaveB: { value: new THREE.Vector4(0.72, -0.9, 0.22, 8.5) },
      uWaveC: { value: new THREE.Vector4(-0.45, 0.85, 0.16, 5.2) },
      uWaveD: { value: new THREE.Vector4(1.0, -0.28, 0.11, 3.1) },
      uSunDir: { value: new THREE.Vector3(0.18, 0.38, -1.0).normalize() },
      uDeep: { value: new THREE.Color("#0b4f5c") },
      uShallow: { value: new THREE.Color("#27a496") },
      uFoam: { value: new THREE.Color("#eafcf7") },
      uHorizon: { value: new THREE.Color("#cfe9ec") },
    }),
    [],
  );

  useFrame((state, rawDelta) => {
    if (!materialRef.current) return;
    // Water keeps a slow drift even under reduced-motion; freezing an ocean
    // mid-swell looks broken, so we just take the energy out of it.
    const delta = Math.min(rawDelta, 0.05) * (reduced ? 0.18 : 1);
    materialRef.current.uniforms.uTime.value += delta;
    void state;
  });

  return (
    <mesh geometry={geometry} position={[0, 0, -46]}>
      <shaderMaterial
        ref={materialRef}
        vertexShader={vertexShader}
        fragmentShader={fragmentShader}
        uniforms={uniforms}
      />
    </mesh>
  );
}
