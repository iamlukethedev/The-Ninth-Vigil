/**
 * THE NINTH VIGIL — Weather & airborne particulate.
 *
 * Every system here is a single InstancedMesh whose motion is evaluated entirely
 * in the vertex shader from `uTime` plus static per-instance attributes, so the
 * CPU cost per frame is a handful of uniform writes regardless of particle
 * count, and two runs of the same scenario are bit-identical.
 *
 * Systems
 * -------
 *  rain    velocity-stretched streaks in three parallax shells, tinted by the
 *          nearest practical lights so a torch actually catches the rain.
 *  splash  expanding ground rings where drops land (CPU-placed on the real
 *          heightfield, GPU-animated).
 *  snow    slower tumbling size-varied flakes with lateral sway + drift.
 *  ash     the same flake shader, grey, slower, heavier drift — hell/ashfall.
 *  ember   rising sparks with turbulence, cooling from white-hot to blood red,
 *          emissive well past the bloom threshold.
 *  dust    interior motes whose brightness comes *only* from the light rig, so
 *          they exist exclusively inside light pools and cones.
 *  fog     low-lying ground slabs, domain-warped fbm, depth-softened, lit by
 *          the practicals so the murk glows where the fire is.
 *
 * Everything transparent samples the RenderPipeline's shared depth prepass and
 * fades out as it approaches geometry (soft particles). If that depth texture is
 * unavailable — low quality tier, pipeline disabled — the fade is switched off
 * by a uniform and the systems keep rendering.
 *
 * Contract
 * --------
 *   weather.windAt(pos, t?, out?) -> THREE.Vector3   shared wind field
 *   weather.setWeather(kind, intensity)
 *   bus 'weather:set'   {kind, intensity}   emitted AND consumed
 *   bus 'weather:wet'   {amount}            0..1 surface wetness
 *   bus 'weather:snow'  {amount}            0..1 snow accumulation
 *   bus 'weather:flash' {intensity, delay}  lightning strike
 *   bus 'audio:cue' / 'audio:sfx' {id:'thunder'|'rain'|'wind', gain}
 */

import * as THREE from 'three';
import { fbm2, perlin2, hash2 } from '../core/Rand.js';

/* ------------------------------------------------------------------ *
 * tuning
 * ------------------------------------------------------------------ */

const LIGHTS = 8;                 // practical lights fed to the particle shaders
const LIGHT_UNIT = 0.05;          // candela -> particle irradiance
const TIER_SCALE = { low: 0.28, med: 0.55, high: 0.8, ultra: 1.0 };

/** Max instances per system at `ultra`; scaled down by tier and intensity. */
/**
 * `dust` was 1700. At that count a crypt close-up carried several hundred motes
 * inside the frame, which is what made them read as sensor dirt or falling snow
 * rather than as air: hundreds of anything, all the same brightness, stops being
 * particulate and becomes a pattern. Air needs a handful of visible specks and a
 * lot of nothing, so the count is cut to 480 and the survivors are gated, dim
 * and size-varied (see DUST_VERT).
 */
const MAXC = { rain: 3200, splash: 160, snow: 2400, ash: 1200, ember: 560, dust: 480, fog: 14 };

/**
 * Rain shells. Near shells are shorter-lived on screen but larger and brighter;
 * far shells are dense and faint. Streak length is derived from fall speed
 * (len ≈ v * 1/20 s) so the stretch reads as a real exposure smear.
 */
const RAIN_SHELLS = [
  { frac: 0.26, half: [15, 13, 15], fall: [7.5, 10.5], width: [0.030, 0.046], alpha: [0.115, 0.190] },
  { frac: 0.38, half: [26, 13, 26], fall: [8.5, 12.0], width: [0.020, 0.030], alpha: [0.080, 0.130] },
  { frac: 0.36, half: [40, 14, 40], fall: [9.5, 13.0], width: [0.013, 0.021], alpha: [0.045, 0.085] },
];

/** Half-extents of the wrap cell and how far its centre sits above the ground. */
const VOL = {
  snow:  { half: [30, 13, 30], lift: 7.5 },
  ash:   { half: [28, 12, 28], lift: 6.5 },
  ember: { half: [24, 9.5, 24], lift: 4.6 },
  dust:  { half: [15, 4.6, 15], lift: 2.7 },
};

/**
 * Weather kinds. `fog` is a multiplier on the scenario's own fog amount, not an
 * absolute — an overcast moor and an overcast crypt want very different murk.
 */
const KINDS = {
  none:     { rain: 0.00, snow: 0, ash: 0.00, ember: 0.00, fog: 0.85, wet: 0.06, snowAcc: 0, lightning: 0.0, wind: 0.55, dir: 0.35 },
  clear:    { rain: 0.00, snow: 0, ash: 0.00, ember: 0.00, fog: 0.75, wet: 0.05, snowAcc: 0, lightning: 0.0, wind: 1.05, dir: 0.20 },
  fair:     { rain: 0.00, snow: 0, ash: 0.00, ember: 0.00, fog: 0.80, wet: 0.06, snowAcc: 0, lightning: 0.0, wind: 1.30, dir: 0.55 },
  overcast: { rain: 0.00, snow: 0, ash: 0.06, ember: 0.00, fog: 1.25, wet: 0.30, snowAcc: 0, lightning: 0.0, wind: 2.20, dir: 0.80 },
  mist:     { rain: 0.00, snow: 0, ash: 0.00, ember: 0.00, fog: 1.70, wet: 0.42, snowAcc: 0, lightning: 0.0, wind: 0.70, dir: 0.10 },
  rain:     { rain: 0.80, snow: 0, ash: 0.00, ember: 0.00, fog: 1.15, wet: 1.00, snowAcc: 0, lightning: 0.7, wind: 2.60, dir: 1.10 },
  storm:    { rain: 1.00, snow: 0, ash: 0.00, ember: 0.00, fog: 1.30, wet: 1.00, snowAcc: 0, lightning: 1.0, wind: 4.10, dir: 1.55 },
  snow:     { rain: 0.00, snow: 0.9, ash: 0.00, ember: 0.00, fog: 1.10, wet: 0.28, snowAcc: 1, lightning: 0.0, wind: 1.60, dir: 0.75 },
  ember:    { rain: 0.00, snow: 0, ash: 0.85, ember: 0.90, fog: 1.05, wet: 0.00, snowAcc: 0, lightning: 0.0, wind: 1.35, dir: 0.30 },
  ash:      { rain: 0.00, snow: 0, ash: 1.00, ember: 0.22, fog: 1.00, wet: 0.00, snowAcc: 0, lightning: 0.0, wind: 1.20, dir: 0.30 },
};
const KIND_ALIAS = {
  thunder: 'storm', drizzle: 'rain', showers: 'rain', sleet: 'snow',
  blizzard: 'snow', fog: 'mist', haze: 'mist', cloudy: 'overcast',
  sunny: 'clear', ashfall: 'ash', hellfire: 'ember', off: 'none',
};

/* scratch — module scope so the hot path never allocates */
const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _col = new THREE.Color();

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const lerp = (a, b, t) => a + (b - a) * t;

/* ------------------------------------------------------------------ *
 * shared GLSL
 * ------------------------------------------------------------------ */

/**
 * Declarations + helpers every system shares. `uLight*` is a small fixed array
 * so adding or losing a torch never recompiles anything; unused slots carry a
 * black colour and contribute nothing.
 */
const COMMON = /* glsl */`
#define WLIGHTS ${LIGHTS}
uniform float uTime;
uniform vec3  uCentre;
uniform vec3  uCamPos;
uniform vec2  uResolution;
uniform vec2  uNearFar;
uniform vec3  uWind;
uniform float uFlash;
uniform float uSoftOn;
uniform sampler2D uDepth;
uniform vec4  uLightPos[WLIGHTS];   // xyz world position, w cutoff radius
uniform vec3  uLightCol[WLIGHTS];   // linear colour * intensity * LIGHT_UNIT
uniform vec4  uLightDir[WLIGHTS];   // xyz cone axis, w cos(outer) (< -0.5 = omni)

/* integer-free float hash: no transcendentals, identical on every driver */
float wHash(float n){ n = fract(n * 0.1031); n *= n + 33.33; n *= n + n; return fract(n); }

/* Anchor a world-space path into the cell surrounding the camera. The particle
   keeps a real world trajectory; only its cell image jumps, one cell at a time,
   outside the visible region. */
vec3 wrapCell(vec3 world, vec3 centre, vec3 halfExt){
  vec3 d = world - centre;
  d = mod(d + halfExt, 2.0 * halfExt) - halfExt;
  return centre + d;
}

vec3 gatherLight(vec3 p, int count){
  vec3 sum = vec3(0.0);
  for (int i = 0; i < WLIGHTS; i++){
    if (i >= count) break;
    vec3 dl = uLightPos[i].xyz - p;
    float d2 = dot(dl, dl);
    float r = uLightPos[i].w;
    float att = 1.0 / (1.0 + d2 * 0.55);
    att *= 1.0 - smoothstep(r * r * 0.30, r * r, d2);
    float cone = 1.0;
    if (uLightDir[i].w > -0.5){
      float cd = dot(uLightDir[i].xyz, -normalize(dl + vec3(1e-5)));
      cone = smoothstep(uLightDir[i].w, mix(uLightDir[i].w, 1.0, 0.42), cd);
    }
    sum += uLightCol[i] * (att * cone);
  }
  return sum;
}

/* camera basis straight out of the view matrix — no extra uniforms */
vec3 camRight(){ return vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]); }
vec3 camUp(){    return vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]); }
`;

/** Soft-particle fade against the shared depth prepass. */
const SOFT = /* glsl */`
uniform float uSoftK;              // 1 / soft distance in metres
float softFade(float viewDist){
  if (uSoftOn < 0.5) return 1.0;
  vec2 duv = gl_FragCoord.xy / uResolution;
  float dz = texture2D(uDepth, duv).x;
  if (dz >= 0.999999) return 1.0;
  float vz = (uNearFar.x * uNearFar.y) / ((uNearFar.y - uNearFar.x) * dz - uNearFar.y);
  return clamp((-vz - viewDist) * uSoftK, 0.0, 1.0);
}
`;

/* ------------------------------------------------------------------ *
 * RAIN
 * ------------------------------------------------------------------ */

const RAIN_VERT = /* glsl */`
${COMMON}
attribute vec4 aBase;    // xyz world seed position, w phase
attribute vec4 aParam;   // fall speed, streak length, width, alpha
attribute vec4 aVol;     // wrap half-extents, w shell index
uniform float uFall;
uniform float uSlant;
uniform float uYLift;
varying vec2  vUv;
varying float vAlpha;
varying vec3  vLit;
varying float vDist;

void main(){
  vec3 vel = vec3(uWind.x * uSlant, -aParam.x * uFall, uWind.z * uSlant);
  vec3 path = aBase.xyz + vel * uTime;
  vec3 centre = vec3(uCentre.x, uCentre.y + uYLift, uCentre.z);
  vec3 wp = wrapCell(path, centre, aVol.xyz);

  vec3 toCam = uCamPos - wp;
  float dist = length(toCam);
  toCam /= max(dist, 1e-4);
  vec3 dir = normalize(vel);
  vec3 side = cross(dir, toCam);
  float sl = length(side);
  side = sl > 1e-4 ? side / sl : camRight();

  /* stretch along velocity: uv.y 0 = leading head, 1 = trailing tail */
  vec3 offset = side * (position.x * aParam.z) - dir * ((uv.y - 0.5) * aParam.y);
  vec3 world = wp + offset;

  vUv = uv;
  vLit = gatherLight(wp, WLIGHTS);
  /* thin out the very near field so drops never smear across the lens */
  float near = smoothstep(1.2, 4.0, dist);
  float far = 1.0 - smoothstep(aVol.x * 1.35, aVol.x * 2.0, dist);
  vAlpha = aParam.w * near * far;

  vec4 mv = viewMatrix * vec4(world, 1.0);
  vDist = -mv.z;
  gl_Position = projectionMatrix * mv;
}
`;

const RAIN_FRAG = /* glsl */`
${COMMON}
${SOFT}
uniform vec3  uTint;
uniform float uOpacity;
varying vec2  vUv;
varying float vAlpha;
varying vec3  vLit;
varying float vDist;

void main(){
  /* rounded cross-section: a hard-edged rectangle is what makes cheap rain read
     as a screensaver, so the width falls off like a cylinder */
  float across = 1.0 - abs(vUv.x - 0.5) * 2.0;
  float shape = pow(max(across, 0.0), 1.35);
  float along = pow(1.0 - vUv.y, 1.25);
  float a = shape * along * vAlpha * uOpacity * softFade(vDist);
  if (a <= 0.0015) discard;
  vec3 col = uTint * (1.0 + uFlash * 3.5) + vLit * 1.25;
  gl_FragColor = vec4(col, a);
}
`;

/* ------------------------------------------------------------------ *
 * SPLASH RIPPLES
 * ------------------------------------------------------------------ */

const SPLASH_VERT = /* glsl */`
${COMMON}
attribute vec4 aRip;     // xyz ground point, w start time
attribute vec4 aRipN;    // xyz surface normal, w size scale
uniform float uLife;
uniform float uMaxR;
varying vec2  vQ;
varying float vAge;
varying vec3  vLit;
varying float vDist;

void main(){
  vAge = (uTime - aRip.w) / uLife;
  if (aRip.w < -0.5 || vAge < 0.0 || vAge > 1.0){
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);   // clipped
    vQ = vec2(0.0); vLit = vec3(0.0); vDist = 1.0;
    return;
  }
  vec3 n = normalize(aRipN.xyz);
  vec3 t = cross(vec3(1.0, 0.0, 0.0), n);
  float tl = length(t);
  t = tl > 1e-3 ? t / tl : vec3(0.0, 0.0, 1.0);
  vec3 b = cross(n, t);

  float R = uMaxR * aRipN.w;
  vQ = position.xy * 2.0;
  vec3 world = aRip.xyz + n * 0.012 + (t * position.x + b * position.y) * (R * 2.2);
  vLit = gatherLight(aRip.xyz, WLIGHTS);
  vec4 mv = viewMatrix * vec4(world, 1.0);
  vDist = -mv.z;
  gl_Position = projectionMatrix * mv;
}
`;

const SPLASH_FRAG = /* glsl */`
${COMMON}
${SOFT}
uniform vec3  uTint;
uniform float uOpacity;
varying vec2  vQ;
varying float vAge;
varying vec3  vLit;
varying float vDist;

void main(){
  float r = length(vQ);
  if (r > 1.0) discard;
  float u = clamp(vAge, 0.0, 1.0);
  float ring = sqrt(u) * 0.92;
  float w = 0.055 + 0.16 * u;
  float d = (r - ring) / w;
  float crest = exp(-d * d);
  /* the impact itself: a tight bright kick in the first few frames */
  float pop = exp(-r * r * 26.0) * (1.0 - smoothstep(0.0, 0.16, u));
  float fade = (1.0 - u) * (1.0 - u);
  float a = (crest * fade * 0.85 + pop * 0.9) * uOpacity * softFade(vDist);
  if (a <= 0.0015) discard;
  vec3 col = uTint * (1.0 + uFlash * 2.5) + vLit * 1.9;
  gl_FragColor = vec4(col, a);
}
`;

/* ------------------------------------------------------------------ *
 * FLAKES  (snow + ash share one program; only uniforms differ)
 * ------------------------------------------------------------------ */

const FLAKE_VERT = /* glsl */`
${COMMON}
attribute vec4 aBase;    // xyz world seed position, w phase
attribute vec4 aParam;   // fall speed, size, spin, alpha
uniform vec3  uHalf;
uniform float uYLift;
uniform float uSway;
uniform float uSpin;
uniform float uDrift;
varying vec2  vUv;
varying float vAlpha;
varying vec3  vLit;
varying float vDist;

void main(){
  float ph = aBase.w * 6.2831853;
  vec3 vel = vec3(uWind.x * uDrift, -aParam.x, uWind.z * uDrift);
  vec3 path = aBase.xyz + vel * uTime;
  /* lateral sway: a flake never falls straight, it slides off its own edges */
  path.x += sin(uTime * (0.55 + aParam.z * 0.6) + ph) * uSway;
  path.z += cos(uTime * (0.47 + aParam.z * 0.5) + ph * 1.7) * uSway * 0.85;
  path.y += sin(uTime * (0.9 + aParam.z) + ph * 2.3) * uSway * 0.12;

  vec3 centre = vec3(uCentre.x, uCentre.y + uYLift, uCentre.z);
  vec3 wp = wrapCell(path, centre, uHalf);

  float ang = uTime * aParam.z * uSpin + ph;
  vec2 q = position.xy * aParam.y;
  q.y *= mix(0.22, 1.0, abs(cos(ang * 0.77)));      // tumbling edge-on squash
  float c = cos(ang), s = sin(ang);
  q = mat2(c, -s, s, c) * q;
  vec3 world = wp + camRight() * q.x + camUp() * q.y;

  vUv = uv;
  vLit = gatherLight(wp, WLIGHTS);
  float dist = length(uCamPos - wp);
  vAlpha = aParam.w * smoothstep(0.8, 3.0, dist) * (1.0 - smoothstep(uHalf.x * 1.3, uHalf.x * 1.9, dist));

  vec4 mv = viewMatrix * vec4(world, 1.0);
  vDist = -mv.z;
  gl_Position = projectionMatrix * mv;
}
`;

const FLAKE_FRAG = /* glsl */`
${COMMON}
${SOFT}
uniform vec3  uTint;
uniform float uOpacity;
uniform float uLightMul;
uniform float uStar;
varying vec2  vUv;
varying float vAlpha;
varying vec3  vLit;
varying float vDist;

void main(){
  vec2 c = vUv * 2.0 - 1.0;
  float r = length(c);
  if (r > 1.0) discard;
  float body = 1.0 - smoothstep(0.18, 1.0, r);
  if (uStar > 0.001){
    float lob = 1.0 + uStar * cos(atan(c.y, c.x) * 6.0);
    body *= mix(1.0, lob, 0.55);
  }
  float a = body * vAlpha * uOpacity * softFade(vDist);
  if (a <= 0.0015) discard;
  vec3 col = uTint * (0.55 + uFlash * 2.0) + vLit * uLightMul;
  gl_FragColor = vec4(col * a, a);   // premultiplied: flakes occlude as well as glow
}
`;

/* ------------------------------------------------------------------ *
 * EMBERS
 * ------------------------------------------------------------------ */

const EMBER_VERT = /* glsl */`
${COMMON}
attribute vec4 aBase;    // xyz world seed position, w phase
attribute vec4 aParam;   // rise speed, size, 1/life, turbulence
uniform vec3  uHalf;
uniform float uYLift;
varying vec2  vUv;
varying float vAge;
varying float vHeat;
varying float vDist;

void main(){
  float tt = uTime * aParam.z + aBase.w;
  float cyc = floor(tt);
  vAge = fract(tt);

  /* re-roll the launch offset every life so the same spark never retraces */
  float h1 = wHash(cyc * 1.73 + aBase.w * 37.1);
  float h2 = wHash(cyc * 2.19 + aBase.w * 61.7 + 9.3);
  vec3 jitter = (vec3(h1, 0.0, h2) - 0.5) * 7.0;

  float rise = aParam.x * vAge / max(aParam.z, 1e-4);
  vec3 path = aBase.xyz + jitter + vec3(uWind.x * 0.35, 0.0, uWind.z * 0.35) * (vAge / max(aParam.z, 1e-4));
  /* turbulence: two decorrelated lobes, amplitude growing as the spark climbs */
  float turb = aParam.w * (0.35 + vAge);
  float ph = aBase.w * 6.2831853 + cyc;
  path.x += sin(uTime * 1.9 + ph) * turb + sin(uTime * 4.3 + ph * 2.7) * turb * 0.4;
  path.z += cos(uTime * 1.7 + ph * 1.3) * turb + cos(uTime * 3.9 + ph * 3.1) * turb * 0.4;

  vec3 centre = vec3(uCentre.x, uCentre.y + uYLift, uCentre.z);
  vec3 wp = wrapCell(vec3(path.x, path.y, path.z), centre, uHalf);
  wp.y += rise;

  /* cooling: white-hot at birth, blood red at death */
  vHeat = 1.0 - pow(vAge, 0.65);

  float sz = aParam.y * (0.55 + 0.45 * sin(vAge * 3.14159));
  vec3 right = camRight() * (position.x * sz);
  vec3 up = camUp() * (position.y * sz * (1.0 + aParam.x * 0.16));
  vec3 world = wp + right + up;

  vUv = uv;
  vec4 mv = viewMatrix * vec4(world, 1.0);
  vDist = -mv.z;
  gl_Position = projectionMatrix * mv;
}
`;

const EMBER_FRAG = /* glsl */`
${COMMON}
${SOFT}
uniform vec3  uHot;
uniform vec3  uCool;
uniform float uOpacity;
uniform float uGlow;
varying vec2  vUv;
varying float vAge;
varying float vHeat;
varying float vDist;

void main(){
  vec2 c = vUv * 2.0 - 1.0;
  float r2 = dot(c, c);
  if (r2 > 1.0) discard;
  float core = exp(-r2 * 26.0);
  float halo = exp(-r2 * 4.2);
  float life = smoothstep(0.0, 0.07, vAge) * (1.0 - smoothstep(0.55, 1.0, vAge));
  float a = (core * 1.0 + halo * 0.30) * life * uOpacity * softFade(vDist);
  if (a <= 0.0015) discard;
  vec3 col = mix(uCool, uHot, vHeat) * (uGlow * (0.45 + 0.55 * vHeat));
  gl_FragColor = vec4(col, a);
}
`;

/* ------------------------------------------------------------------ *
 * DUST MOTES
 * ------------------------------------------------------------------ */

/*
 * A mote is not a particle of light. It is a 40-micron flake of stone dust that
 * REFLECTS a few percent of whatever irradiance reaches it, seen against a
 * surface that is reflecting far more. Five properties follow from that, and
 * every one of them was violated by the frame that shipped — hundreds of crisp
 * white specks across the crypt close-up, reading as dirt on the lens.
 *
 *   1. It is DIM. The additive contribution at a mote's centre is `uPeak * alpha`
 *      ≈ 0.03 linear — a few percent of a firelit floor. Motes therefore read
 *      against shadow and effectively vanish against a lit surface, which is the
 *      correct behaviour and the opposite of a clipped white disc.
 *   2. It is GATED. `uGate` is the irradiance below which the air is simply
 *      empty. Motes exist inside light cones and pools and nowhere else — that
 *      is what makes them read as volume rather than as snow or sensor dirt.
 *   3. It is TINTED BY ITS LIGHT. The hue is taken from the practicals that
 *      reach it, so a mote near a torch is amber and a mote in the cold shaft is
 *      slate. Never white.
 *   4. It has NO EDGE. The falloff is a gaussian multiplied by a cubed
 *      distance-to-rim term, so value, slope AND curvature all reach zero at the
 *      rim. A hard-edged dot is what makes cheap dust read as lens dirt.
 *   5. It is SMALL AND SIZE-VARIED, with a constant *angular* ceiling so a 6 m
 *      portrait framing cannot inflate a 40-micron flake into a 20 px blob.
 *
 * NOTE: uGate / uPeak / uAngular were declared here but never added to the
 * material's uniform block, so all three uploaded as 0 — `uPeak = 0` made every
 * mote additively black (invisible) while `uGate = 0` disabled the light gate
 * entirely. They are wired in `_buildDust` now.
 */
const DUST_VERT = /* glsl */`
${COMMON}
attribute vec4 aBase;    // xyz world seed position, w phase
attribute vec4 aParam;   // size, orbit radius, orbit rate, alpha
uniform vec3  uHalf;
uniform float uYLift;
uniform float uGate;
uniform float uPeak;
uniform float uLightMul;
uniform float uAngular;
varying vec2  vUv;
varying float vAlpha;
varying vec3  vCol;
varying float vDist;

void main(){
  float ph = aBase.w * 6.2831853;
  float k = aParam.z;
  /* three decorrelated slow orbits read as convection, not as a scroll */
  vec3 wob = vec3(
    sin(uTime * 0.31 * k + ph) + 0.45 * sin(uTime * 0.83 * k + ph * 2.3),
    0.55 * sin(uTime * 0.24 * k + ph * 1.7) + 0.35 * sin(uTime * 0.61 * k + ph),
    cos(uTime * 0.27 * k + ph * 0.7) + 0.45 * cos(uTime * 0.91 * k + ph * 3.1)
  ) * aParam.y;
  vec3 path = aBase.xyz + wob + uWind * (uTime * 0.05);
  vec3 centre = vec3(uCentre.x, uCentre.y + uYLift, uCentre.z);
  vec3 wp = wrapCell(path, centre, uHalf);

  vec3 lit = gatherLight(wp, WLIGHTS) * uLightMul;
  float b = max(lit.r, max(lit.g, lit.b));

  /* --- 2. gate: no light, no mote.  Squared so the gate's own falloff is soft
     at the top and hard at the bottom: the pool of visible motes has a fuzzy
     interior and a decisive outer edge, exactly like a light cone. --- */
  float gate = smoothstep(uGate, uGate * 6.0, b);
  gate *= gate;

  /* --- 3. hue from the light, value from uPeak alone.  Pulled a little toward
     the light's own chroma so a torch mote is amber rather than a white speck
     that happens to sit near a torch. --- */
  vec3 hue = lit / max(b, 1.0e-4);
  hue = mix(hue, hue * hue, 0.35);
  vCol = hue * (uPeak * (0.22 + 0.78 * gate));

  float dist = max(0.3, length(uCamPos - wp));
  /* Never right on the lens, and gone before the wrap boundary shows. */
  vAlpha = aParam.w * gate
         * smoothstep(1.4, 4.2, dist)
         * (1.0 - smoothstep(uHalf.x * 1.05, uHalf.x * 1.6, dist));

  /* Constant-angular-size cap: uAngular radians, whatever the framing. A mote
     that subtends more than a few pixels has stopped being dust. */
  float sz = aParam.x * (1.0 + 0.22 * sin(uTime * 1.7 + ph));
  sz = min(sz, dist * uAngular);
  vec3 world = wp + camRight() * (position.x * sz) + camUp() * (position.y * sz);
  vUv = uv;
  vec4 mv = viewMatrix * vec4(world, 1.0);
  vDist = -mv.z;
  gl_Position = projectionMatrix * mv;
}
`;

const DUST_FRAG = /* glsl */`
${COMMON}
${SOFT}
uniform float uOpacity;
varying vec2  vUv;
varying float vAlpha;
varying vec3  vCol;
varying float vDist;

void main(){
  vec2 c = vUv * 2.0 - 1.0;
  float r2 = dot(c, c);
  if (r2 > 1.0) discard;
  /* --- 4. C2-continuous profile: value, slope AND curvature reach zero at the
     rim, so there is no edge to alias and nothing that can read as a dot. The
     gaussian is deliberately loose (2.0, not 3.1) so most of the sprite is a
     gradient rather than a core. --- */
  float rim = 1.0 - r2;
  float body = exp(-r2 * 2.0) * rim * rim * rim;
  float a = body * vAlpha * uOpacity * softFade(vDist);
  if (a <= 0.0008) discard;
  gl_FragColor = vec4(vCol * (1.0 + uFlash * 0.5), a);
}
`;

/* ------------------------------------------------------------------ *
 * GROUND FOG SLABS
 * ------------------------------------------------------------------ */

const FOG_VERT = /* glsl */`
${COMMON}
attribute vec4 aSlab;    // xyz world centre (CPU placed on the heightfield), w size
attribute vec4 aSlab2;   // alpha, noise scale, rotation, phase
varying vec2  vQ;
varying vec3  vWorld;
varying float vAlpha;
varying float vNoise;
varying float vDist;

void main(){
  float c = cos(aSlab2.z), s = sin(aSlab2.z);
  vec2 q = position.xy * aSlab.w;
  q = mat2(c, -s, s, c) * q;
  vec3 world = aSlab.xyz + vec3(q.x, 0.0, q.y);
  vQ = position.xy * 2.0;
  vWorld = world;
  vAlpha = aSlab2.x;
  vNoise = aSlab2.y;
  vec4 mv = viewMatrix * vec4(world, 1.0);
  vDist = -mv.z;
  gl_Position = projectionMatrix * mv;
}
`;

const FOG_FRAG = /* glsl */`
${COMMON}
${SOFT}
uniform sampler2D uNoise;
uniform vec3  uTint;
uniform vec3  uWarm;
uniform float uOpacity;
uniform float uContrast;
uniform float uLightMul;
uniform vec2  uScroll;
varying vec2  vQ;
varying vec3  vWorld;
varying float vAlpha;
varying float vNoise;
varying float vDist;

void main(){
  /* domain-warped fbm: one low-frequency fetch warps a higher one, which is
     what stops a fog card reading as a texture on a quad */
  vec2 p = vWorld.xz * vNoise;
  vec2 w = texture2D(uNoise, p * 0.35 + uScroll * 0.55).rg - 0.5;
  float n1 = texture2D(uNoise, p + uScroll + w * 0.45).r;
  float n2 = texture2D(uNoise, p * 2.7 - uScroll * 1.6 + w * 0.30).g;
  float d = clamp(n1 * 1.45 - 0.30 + (n2 - 0.5) * 0.55, 0.0, 1.0);
  d = pow(d, uContrast);

  float radial = 1.0 - smoothstep(0.42, 1.0, length(vQ));
  float soft = softFade(vDist);
  /* thin the bank out at grazing distance so it never reads as a hard sheet */
  float depth = 1.0 - smoothstep(58.0, 105.0, vDist);
  float a = d * radial * vAlpha * uOpacity * soft * depth;
  if (a <= 0.0015) discard;

  vec3 lit = gatherLight(vWorld + vec3(0.0, 0.45, 0.0), 4);
  vec3 col = uTint + uWarm * (1.0 + uFlash * 2.0) * 0.35 + lit * uLightMul;
  gl_FragColor = vec4(col * a, a);   // premultiplied
}
`;

/* ================================================================== *
 * MODULE
 * ================================================================== */

export class Weather {
  static id = 'weather';

  /** @param {import('../core/Engine.js').Engine} engine */
  constructor(engine) {
    this.engine = engine;
    this.__dead = false;
    this.ready = false;

    this.kind = 'clear';
    this.intensity = 1;
    this.interior = false;
    this.fogAmount = 0.4;
    this.biome = 'moor';

    /** 0..1 surface wetness — broadcast as 'weather:wet'. */
    this.wetness = 0.05;
    /** 0..1 snow accumulation — broadcast as 'weather:snow'. */
    this.snowAmount = 0;
    /** Current lightning flash, 0..1. */
    this.flash = 0;
    this._flashPower = 1;
    this._wetTarget = 0.05;
    this._snowTarget = 0;
    this._camDist = 26;
    this._lightCount = 0;

    /* --- wind field --- */
    this.wind = new THREE.Vector3(0.94, 0, 0.34);
    this.windSpeed = 1.1;
    this.gust = 1;
    this._windAngle = 0.34;
    this._windSeed = 90210;

    /* --- system levels (target + smoothed) --- */
    this.level = { rain: 0, splash: 0, snow: 0, ash: 0, ember: 0, dust: 0.25, fog: 0.5 };
    this._target = { ...this.level };

    this.group = new THREE.Group();
    this.group.name = 'Weather';
    this.group.matrixAutoUpdate = false;
    this.group.userData.skyNoFog = true;
    this.group.userData.noGBuffer = true;

    this.systems = {};
    this._focus = new THREE.Vector3();
    this._centre = new THREE.Vector3();
    this._lights = [];
    this._sceneLights = [];
    this._sceneScanAt = -999;
    this._softOn = 0;
    this._depthTex = null;
    this._dummyDepth = null;
    this._noiseTex = null;
    this._ownsNoise = false;

    /* --- lightning --- */
    this._strikeIndex = 0;
    this._nextStrike = 1e9;
    this._flashAt = -1e9;
    this._thunder = [];
    this._flashBase = null;

    this._offs = [];
    this._muteBus = false;
    this._lastWetEmit = -1;
    this._lastSnowEmit = -1;
    this._pendingScenario = null;
    this._rippleCycle = null;
    this._rippleDirty = false;

    /* Shared uniform objects — every material references these very objects, so
       one write per frame reaches all seven programs. */
    this.U = {
      uTime: { value: 0 },
      uCentre: { value: new THREE.Vector3() },
      uCamPos: { value: new THREE.Vector3() },
      uResolution: { value: new THREE.Vector2(1280, 720) },
      uNearFar: { value: new THREE.Vector2(0.25, 900) },
      uWind: { value: new THREE.Vector3() },
      uFlash: { value: 0 },
      uSoftOn: { value: 0 },
      uDepth: { value: null },
      uLightPos: { value: [] },
      uLightCol: { value: [] },
      uLightDir: { value: [] },
    };
    for (let i = 0; i < LIGHTS; i++) {
      this.U.uLightPos.value.push(new THREE.Vector4(0, -9999, 0, 1));
      this.U.uLightCol.value.push(new THREE.Vector3(0, 0, 0));
      this.U.uLightDir.value.push(new THREE.Vector4(0, -1, 0, -1));
    }
  }

  /* ================================================================ *
   * lifecycle
   * ================================================================ */

  async init() {
    const engine = this.engine;
    try {
      this._dummyDepth = new THREE.DataTexture(
        new Uint8Array([255, 255, 255, 255]), 1, 1, THREE.RGBAFormat, THREE.UnsignedByteType
      );
      this._dummyDepth.needsUpdate = true;
      this.U.uDepth.value = this._dummyDepth;

      this._noiseTex = this._makeNoise();

      this._buildRain();
      this._buildSplash();
      this._buildFlakes('snow');
      this._buildFlakes('ash');
      this._buildEmber();
      this._buildDust();
      this._buildFog();

      engine.scene.add(this.group);

      this._offs.push(engine.bus.on('weather:set', (p) => {
        if (this._muteBus) return;
        try { this.setWeather(p?.kind ?? p?.weather, p?.intensity, false); }
        catch (e) { console.warn('[weather] weather:set —', e?.message ?? e); }
      }));
      this._offs.push(engine.bus.on('weather:lightning', (p) => {
        if (this._muteBus) return;
        try { this.strike(p?.intensity ?? 1); } catch { /* noop */ }
      }));

      this._syncResolution();
      this.ready = true;

      if (this._pendingScenario) {
        const [n, c] = this._pendingScenario;
        this._pendingScenario = null;
        this.applyScenario(n, c);
      } else {
        this._applyKind(this.kind, this.intensity, true);
      }
      console.info('[weather] ready — 7 instanced systems, soft-particle depth pending');
    } catch (e) {
      console.error('[weather] init failed, module disabled —', e);
      this.__dead = true;
      try { this.dispose(); } catch { /* noop */ }
      throw e;
    }
  }

  dispose() {
    for (const off of this._offs) { try { off(); } catch { /* noop */ } }
    this._offs.length = 0;
    this._restoreFlash(true);
    try { this.group.removeFromParent(); } catch { /* noop */ }
    for (const key in this.systems) {
      const s = this.systems[key];
      try { s.geo.dispose(); } catch { /* noop */ }
      try { s.mat.dispose(); } catch { /* noop */ }
      try { s.mesh.dispose?.(); } catch { /* noop */ }
    }
    this.systems = {};
    try { this._dummyDepth?.dispose(); } catch { /* noop */ }
    if (this._ownsNoise) { try { this._noiseTex?.dispose(); } catch { /* noop */ } }
    this._dummyDepth = null;
    this._noiseTex = null;
    this.ready = false;
  }

  resize() { this._syncResolution(); }

  /* ================================================================ *
   * public API
   * ================================================================ */

  /**
   * Shared deterministic wind. Props, foliage, cloth and VFX should read this so
   * every bit of motion in the frame agrees on which way the air is moving.
   *
   * @param {THREE.Vector3|{x:number,z:number}} pos world position
   * @param {number} [t] seconds; defaults to engine.clock.elapsed
   * @param {THREE.Vector3} [out]
   * @returns {THREE.Vector3} metres/second
   */
  windAt(pos, t = this.engine.clock.elapsed, out = new THREE.Vector3()) {
    const x = pos?.x ?? 0, z = pos?.z ?? 0;
    const s = this._windSeed;
    // Spatial gust cells drifting downwind, plus a fine turbulence term.
    const dx = this.wind.x, dz = this.wind.z;
    const gx = x - dx * t * 0.55, gz = z - dz * t * 0.55;
    const cell = fbm2(gx * 0.028, gz * 0.028, { octaves: 2, seed: s, gain: 0.55 }) - 0.5;
    const swirl = perlin2(gx * 0.11 + t * 0.21, gz * 0.11, s + 4177) - 0.5;
    const mag = this.windSpeed * (1 + cell * 0.85);
    const ang = this._windAngle + cell * 0.55 + swirl * 0.32;
    const vy = (perlin2(gx * 0.09, gz * 0.09 + t * 0.17, s + 811) - 0.5) * this.windSpeed * 0.22;
    return out.set(Math.cos(ang) * mag, vy, Math.sin(ang) * mag);
  }

  /**
   * @param {string} kind clear|overcast|rain|storm|snow|mist|ember|ash|none
   * @param {number} [intensity] 0..1
   * @param {boolean} [emit=true] broadcast 'weather:set' to the other modules
   */
  setWeather(kind, intensity, emit = true) {
    const k = this._resolveKind(kind);
    const i = typeof intensity === 'number' && Number.isFinite(intensity) ? clamp01(intensity) : this.intensity;
    this.kind = k;
    this.intensity = i;
    this._applyKind(k, i, false);
    if (emit) {
      this._muteBus = true;
      try { this.engine.bus.emit('weather:set', { kind: k, intensity: i }); }
      finally { this._muteBus = false; }
    }
    return this;
  }

  /** Fire a lightning strike now (also used by the scheduler). */
  strike(power = 1) {
    if (!this.ready) return false;
    const t = this.engine.clock.elapsed;
    this._flashAt = t;
    this._flashPower = clamp(power, 0.2, 1.6);
    this._captureFlashBase();

    const r = this._rand(0x5115 + this._strikeIndex * 977);
    const distance = r.range(280, 1600);           // metres to the strike
    const delay = distance / 343;                  // speed of sound
    this._thunder.push({ at: t + delay, gain: clamp01(1.15 - distance / 1900) * this._flashPower });

    this.engine.bus.emit('weather:flash', { intensity: this._flashPower, delay, distance });
    this._strikeIndex++;
    return true;
  }

  stats() {
    const out = {};
    for (const k in this.systems) out[k] = this.systems[k].mesh.count;
    return {
      kind: this.kind, intensity: +this.intensity.toFixed(2),
      wet: +this.wetness.toFixed(2), snow: +this.snowAmount.toFixed(2),
      wind: +this.windSpeed.toFixed(2), gust: +this.gust.toFixed(2),
      soft: this._softOn > 0.5, counts: out,
    };
  }

  /* ================================================================ *
   * scenario
   * ================================================================ */

  applyScenario(name, cfg = {}) {
    if (!this.ready) { this._pendingScenario = [name, cfg]; return; }
    try {
      const env = cfg.env ?? {};
      this.interior = !!env.interior;
      this.biome = env.biome ?? this.biome;
      this.fogAmount = typeof env.fog === 'number' ? clamp01(env.fog) : 0.4;
      const kind = this._resolveKind(env.weather ?? (this.interior ? 'none' : 'clear'));
      this.kind = kind;
      this.intensity = 1;

      // Interiors get no precipitation whatever the scenario says — but they do
      // get motes and ground murk, which is most of what sells them.
      this._applyKind(kind, 1, true);

      /* Lightning is scheduled well past the screenshot window on purpose: a
         flash landing on frame 40 would make the captured exposure a coin
         flip. Deterministic, and gameplay still gets storms. */
      const P = KINDS[kind];
      if (P.lightning > 0 && !this.interior) {
        const r = this._rand(0x1eaf + hashStr(name));
        this._strikeIndex = 0;
        this._nextStrike = 5.5 + r.range(0, 7.5) / Math.max(0.35, P.lightning);
      } else {
        this._nextStrike = 1e9;
      }
      this._thunder.length = 0;
      this._restoreFlash(true);
      this.flash = 0;
      this.U.uFlash.value = 0;

      this._seedRipples(true);
      this._emitSignals(true);
    } catch (e) {
      console.error('[weather:applyScenario]', e);
    }
  }

  /**
   * Resolve a weather kind to system levels. `snap` settles every ramp
   * immediately, which the screenshot harness requires.
   */
  _applyKind(kind, intensity, snap) {
    const P = KINDS[kind] ?? KINDS.clear;
    const i = clamp01(intensity);
    const interior = this.interior;
    const fogScale = 0.25 + this.fogAmount * 1.15;

    const T = this._target;
    T.rain = interior ? 0 : P.rain * i;
    T.splash = T.rain > 0.02 ? clamp01(T.rain * 1.1) : 0;
    T.snow = interior ? 0 : P.snow * i;
    T.ash = P.ash * i;
    T.ember = P.ember * i;
    T.fog = clamp01(P.fog * fogScale * (interior ? 0.85 : 1.0));
    // Motes are mandatory indoors; outdoors a thin layer reads as pollen/grit.
    T.dust = interior ? 1.0 : 0.26 + P.ash * 0.3;

    this.windSpeed = P.wind * (0.55 + i * 0.55) * (interior ? 0.22 : 1);
    this._windAngle = P.dir * 3.14159 + 0.3;

    const wetTarget = clamp01(P.wet * i);
    const snowTarget = clamp01(P.snowAcc * i);

    if (snap) {
      for (const k in T) this.level[k] = T[k];
      this.wetness = wetTarget;
      this.snowAmount = snowTarget;
      this._syncCounts();
    }
    this._wetTarget = wetTarget;
    this._snowTarget = snowTarget;
  }

  /* ================================================================ *
   * per-frame
   * ================================================================ */

  update(dt, elapsed) {
    if (!this.ready || this.__dead) return;

    /* --- wind: slow global gust so shader motion and windAt() agree --- */
    const g = perlin2(elapsed * 0.085, 11.7, this._windSeed + 33) - 0.5;
    const g2 = perlin2(elapsed * 0.31, 4.1, this._windSeed + 91) - 0.5;
    this.gust = clamp(1 + g * 0.9 + g2 * 0.28, 0.3, 2.2);
    const ang = this._windAngle + g * 0.42;
    const speed = this.windSpeed * this.gust;
    this.wind.set(Math.cos(ang) * speed, 0, Math.sin(ang) * speed);

    /* --- level ramps --- */
    const k = Math.min(1, dt * 1.6);
    let dirty = false;
    for (const key in this._target) {
      const d = this._target[key] - this.level[key];
      if (Math.abs(d) > 1e-4) { this.level[key] += d * k; dirty = true; }
    }
    if (dirty) this._syncCounts();
    this.wetness += (this._wetTarget - this.wetness) * Math.min(1, dt * 0.8);
    this.snowAmount += (this._snowTarget - this.snowAmount) * Math.min(1, dt * 0.25);
    this._emitSignals(false);

    /* --- framing --- */
    this._updateFocus();
    this._gatherLights();
    this._updateUniforms(elapsed);

    /* --- CPU-driven systems --- */
    this._updateRipples(elapsed);
    this._updateFogSlabs(elapsed);

    /* --- lightning --- */
    this._updateLightning(elapsed);
  }

  /* ---------------- framing + uniforms ---------------- */

  _updateFocus() {
    const cam = this.engine.camera;
    const rig = this.engine.get?.('camera');
    const f = this._focus;
    const aim = rig && !rig.__dead ? (rig.focus ?? rig.target) : null;
    if (aim && aim.isVector3 && Number.isFinite(aim.x)) {
      f.copy(aim);
    } else {
      cam.getWorldDirection(_v);
      const gy = this._groundAt(cam.position.x, cam.position.z);
      if (_v.y < -1e-3) {
        const t = clamp((gy - cam.position.y) / _v.y, 0, 400);
        f.copy(cam.position).addScaledVector(_v, t);
      } else {
        f.set(cam.position.x, gy, cam.position.z);
      }
    }
    if (!Number.isFinite(f.x) || !Number.isFinite(f.z)) f.set(0, 0, 0);
    f.y = this._groundAt(f.x, f.z);
    this._centre.copy(f);
    this._camDist = cam.position.distanceTo(f);
  }

  _updateUniforms(elapsed) {
    const U = this.U;
    const cam = this.engine.camera;
    U.uTime.value = elapsed;
    U.uCentre.value.copy(this._centre);
    U.uCamPos.value.copy(cam.position);
    U.uNearFar.value.set(cam.near, cam.far);
    U.uWind.value.copy(this.wind);
    U.uFlash.value = this.flash;

    /* Soft particles need the pipeline's shared depth prepass. It only exists
       once RenderPipeline has initialised (it is last in the manifest), so
       re-probe periodically and degrade gracefully while it is missing. */
    if ((this.engine.clock.frame & 31) === 0 || this._softOn < 0.5) this._probeDepth();
    if ((this.engine.clock.frame & 63) === 0) this._syncResolution();

    /* atmosphere tint follows whatever the sky/fog is actually doing */
    const sky = this.engine.get?.('sky');
    const fog = this.engine.scene.fog;
    if (fog?.color) _col.copy(fog.color);
    else if (sky && !sky.__dead && sky.sun?.fogColor) _col.copy(sky.sun.fogColor);
    else _col.setRGB(0.11, 0.12, 0.15);

    const fogMat = this.systems.fog?.mat;
    if (fogMat) {
      const u = fogMat.uniforms;
      u.uTint.value.setRGB(_col.r * 0.55 + 0.012, _col.g * 0.56 + 0.013, _col.b * 0.60 + 0.018);
      u.uScroll.value.set(elapsed * 0.0042 * (1 + this.gust * 0.2), elapsed * 0.0031);
    }
    const rainMat = this.systems.rain?.mat;
    if (rainMat) {
      rainMat.uniforms.uTint.value.setRGB(
        0.055 + _col.r * 0.30, 0.070 + _col.g * 0.33, 0.105 + _col.b * 0.38
      );
      rainMat.uniforms.uSlant.value = 0.55 + this.gust * 0.30;
      rainMat.uniforms.uFall.value = 1.0;
      rainMat.uniforms.uYLift.value = 8.0;
    }
    const splashMat = this.systems.splash?.mat;
    if (splashMat) {
      splashMat.uniforms.uTint.value.setRGB(
        0.10 + _col.r * 0.45, 0.125 + _col.g * 0.48, 0.17 + _col.b * 0.55
      );
    }

    /* dust volume tracks the camera distance so screen density stays constant
       from a 6 m close-up to a 42 m vista */
    const dust = this.systems.dust;
    if (dust) {
      const s = clamp((this._camDist || 26) / 26, 0.32, 1.7);
      dust.mat.uniforms.uHalf.value.set(VOL.dust.half[0] * s, VOL.dust.half[1] * s, VOL.dust.half[2] * s);
      dust.mat.uniforms.uYLift.value = VOL.dust.lift * s;
    }
  }

  _probeDepth() {
    let tex = null;
    try {
      const rp = this.engine.get?.('render');
      if (rp && !rp.__dead) tex = rp.gbuffer?.depthTexture ?? null;
      if (!tex && this.engine.renderPipeline && !this.engine.renderPipeline.__dead) {
        tex = this.engine.renderPipeline.gbuffer?.depthTexture ?? null;
      }
    } catch { tex = null; }
    if (tex && tex.isTexture) {
      if (this._depthTex !== tex) {
        this._depthTex = tex;
        this.U.uDepth.value = tex;
      }
      this._softOn = 1;
    } else {
      this._depthTex = null;
      this.U.uDepth.value = this._dummyDepth;
      this._softOn = 0;
    }
    this.U.uSoftOn.value = this._softOn;
  }

  _syncResolution() {
    try {
      const r = this.engine.renderer;
      r.getDrawingBufferSize(_tmpSize);
      if (_tmpSize.x > 1 && _tmpSize.y > 1) this.U.uResolution.value.set(_tmpSize.x, _tmpSize.y);
    } catch { /* keep the previous value */ }
  }

  /* ---------------- practical lights ---------------- */

  /**
   * Feed the strongest practicals into the shader array. Sourced from the
   * Lighting module when present (it knows about lights the GPU pool dropped),
   * otherwise from a cached scan of the scene graph.
   */
  _gatherLights() {
    const list = this._lights;
    list.length = 0;
    const focus = this._focus;

    const lighting = this.engine.get?.('lighting');
    const practicals = lighting && !lighting.__dead ? lighting.practicals : null;
    if (Array.isArray(practicals) && practicals.length) {
      for (let i = 0; i < practicals.length; i++) {
        const p = practicals[i];
        if (!p || p.enabled === false) continue;
        const inten = p.intensity ?? 0;
        if (!(inten > 0.02)) continue;
        const pos = p.position ?? p.basePosition;
        if (!pos) continue;
        const d2 = pos.distanceToSquared(focus);
        list.push({
          pos, col: p.color, inten,
          radius: p.radius > 0.5 ? p.radius : 12,
          dir: p.kind === 'spot' ? p.direction : null,
          cosOuter: p.kind === 'spot'
            ? Math.cos(Math.min(1.52, (p.angle ?? 0.42) * (1 + (p.penumbra ?? 0.6) * 0.55)))
            : -1,
          score: inten / (1 + d2 * 0.018),
        });
      }
    }
    if (!list.length) {
      if (this.engine.clock.frame - this._sceneScanAt > 45) this._scanSceneLights();
      const cached = this._sceneLights;
      for (let i = 0; i < cached.length; i++) {
        const l = cached[i];
        if (!l.visible || !(l.intensity > 0.02)) continue;
        _v2.setFromMatrixPosition(l.matrixWorld);
        const d2 = _v2.distanceToSquared(focus);
        const radius = l.distance > 0.5 ? l.distance : 14;
        list.push({
          pos: _v2.clone(), col: l.color, inten: l.intensity, radius,
          dir: l.isSpotLight ? this._spotDir(l, new THREE.Vector3()) : null,
          cosOuter: l.isSpotLight ? Math.cos(Math.min(1.52, l.angle * (1 + l.penumbra * 0.5))) : -1,
          score: l.intensity / (1 + d2 * 0.018),
        });
      }
    }

    list.sort(byScore);
    const UP = this.U.uLightPos.value, UC = this.U.uLightCol.value, UD = this.U.uLightDir.value;
    const n = Math.min(LIGHTS, list.length);
    for (let i = 0; i < LIGHTS; i++) {
      if (i < n) {
        const L = list[i];
        UP[i].set(L.pos.x, L.pos.y, L.pos.z, L.radius);
        const g = L.inten * LIGHT_UNIT;
        UC[i].set(L.col.r * g, L.col.g * g, L.col.b * g);
        if (L.dir) UD[i].set(L.dir.x, L.dir.y, L.dir.z, L.cosOuter);
        else UD[i].set(0, -1, 0, -1);
      } else {
        UP[i].set(0, -9999, 0, 1);
        UC[i].set(0, 0, 0);
        UD[i].set(0, -1, 0, -1);
      }
    }
    this._lightCount = n;
  }

  _scanSceneLights() {
    this._sceneScanAt = this.engine.clock.frame;
    const out = this._sceneLights;
    out.length = 0;
    try {
      this.engine.scene.traverse((o) => {
        if (o.isPointLight === true || o.isSpotLight === true) out.push(o);
      });
    } catch { /* malformed subtree */ }
  }

  _spotDir(light, out) {
    _v.setFromMatrixPosition(light.matrixWorld);
    if (light.target) out.setFromMatrixPosition(light.target.matrixWorld);
    else out.set(0, 0, 0);
    out.sub(_v);
    if (out.lengthSq() < 1e-8) out.set(0, -1, 0);
    return out.normalize();
  }

  /* ---------------- lightning ---------------- */

  _updateLightning(elapsed) {
    /* schedule */
    if (elapsed >= this._nextStrike) {
      const P = KINDS[this.kind] ?? KINDS.clear;
      this.strike(0.6 + P.lightning * 0.55);
      const r = this._rand(0x2b0b + this._strikeIndex * 5171);
      const gap = lerp(19, 5.5, P.lightning) * r.range(0.65, 1.5);
      this._nextStrike = elapsed + gap;
    }

    /* flash envelope: a strike is never one pulse */
    const dt = elapsed - this._flashAt;
    let f = 0;
    if (dt >= 0 && dt < 1.1) {
      f = pulse(dt, 0.000, 1.00, 0.075)
        + pulse(dt, 0.055, 0.52, 0.045)
        + pulse(dt, 0.150, 0.86, 0.170)
        + pulse(dt, 0.420, 0.24, 0.110);
      f = clamp01(f * (this._flashPower ?? 1));
    }
    if (f !== this.flash) {
      this.flash = f;
      this.U.uFlash.value = f;
      this._driveFlash(f);
    }
    if (f <= 0 && this._flashBase) this._restoreFlash(false);

    /* delayed thunder */
    for (let i = this._thunder.length - 1; i >= 0; i--) {
      const c = this._thunder[i];
      if (elapsed >= c.at) {
        this._thunder.splice(i, 1);
        const payload = { id: 'thunder', gain: c.gain, kind: this.kind, rolloff: 1 - c.gain };
        this.engine.bus.emit('audio:cue', payload);
        this.engine.bus.emit('audio:sfx', payload);
        this.engine.bus.emit('weather:thunder', payload);
      }
    }
  }

  /** Grab the values a flash will modulate so they can be put back exactly. */
  _captureFlashBase() {
    if (this._flashBase) return;
    const scene = this.engine.scene;
    const lighting = this.engine.get?.('lighting');
    const base = {
      env: scene.environmentIntensity ?? 1,
      hemi: null, hemiI: 0,
      sun: null, sunI: 0, sunCol: null,
    };
    if (lighting && !lighting.__dead) {
      if (lighting.hemi) { base.hemi = lighting.hemi; base.hemiI = lighting.hemi.intensity; }
      // Only borrow the key when it is already on: enabling a dark sun would
      // allocate four cascade shadow maps mid-frame.
      if (lighting.sun?.enabled && typeof lighting.setSun === 'function') {
        base.sun = lighting;
        base.sunI = lighting.sun.intensity;
        base.sunCol = lighting.sun.color.clone();
      }
    }
    this._flashBase = base;
  }

  _driveFlash(f) {
    const b = this._flashBase;
    if (!b) return;
    const scene = this.engine.scene;
    try {
      scene.environmentIntensity = b.env * (1 + f * 3.2);
      if (b.hemi) b.hemi.intensity = b.hemiI + f * 1.35;
      if (b.sun) {
        _col.copy(b.sunCol).lerp(FLASH_COLOR, clamp01(f * 0.85));
        b.sun.setSun({ color: _col, intensity: b.sunI + f * 3.4 }, false);
      }
    } catch (e) {
      console.warn('[weather] lightning drive failed —', e?.message ?? e);
      this._restoreFlash(true);
    }
  }

  _restoreFlash(force) {
    const b = this._flashBase;
    if (!b) return;
    this._flashBase = null;
    try {
      this.engine.scene.environmentIntensity = b.env;
      if (b.hemi) b.hemi.intensity = b.hemiI;
      if (b.sun) b.sun.setSun({ color: b.sunCol, intensity: b.sunI }, false);
    } catch { /* the owning module has moved on */ }
    if (force) { this.flash = 0; this.U.uFlash.value = 0; }
  }

  /* ---------------- broadcast ---------------- */

  _emitSignals(force) {
    const bus = this.engine.bus;
    if (force || Math.abs(this.wetness - this._lastWetEmit) > 0.012) {
      this._lastWetEmit = this.wetness;
      bus.emit('weather:wet', { amount: this.wetness, wetness: this.wetness, wet: this.wetness });
    }
    if (force || Math.abs(this.snowAmount - this._lastSnowEmit) > 0.012) {
      this._lastSnowEmit = this.snowAmount;
      bus.emit('weather:snow', { amount: this.snowAmount, snow: this.snowAmount });
    }
  }

  /* ================================================================ *
   * system construction
   * ================================================================ */

  /** Shared unit quad; every system instances this. */
  _quad() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([
      -0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0,
    ]), 3));
    g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]), 2));
    g.setIndex([0, 1, 2, 0, 2, 3]);
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 0.75);
    return g;
  }

  /**
   * Wire up one system. `blend` is 'add' for things that only emit light and
   * 'over' (premultiplied) for things that also occlude.
   */
  _system(name, { vert, frag, uniforms, count, blend, order, star = 0 }) {
    const geo = this._quad();
    const mat = new THREE.ShaderMaterial({
      name: `Weather.${name}`,
      vertexShader: vert,
      fragmentShader: frag,
      uniforms: Object.assign({}, this.U, uniforms),
      transparent: true,
      depthTest: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      fog: false,
      toneMapped: true,
    });
    if (blend === 'add') {
      mat.blending = THREE.AdditiveBlending;
    } else {
      // premultiplied alpha: src * 1 + dst * (1 - a)
      mat.blending = THREE.CustomBlending;
      mat.blendSrc = THREE.OneFactor;
      mat.blendDst = THREE.OneMinusSrcAlphaFactor;
      mat.blendSrcAlpha = THREE.OneFactor;
      mat.blendDstAlpha = THREE.OneMinusSrcAlphaFactor;
      mat.blendEquation = THREE.AddEquation;
    }
    mat.userData.skyNoFog = true;   // we do our own atmospherics
    mat.userData.noCSM = true;      // not a lit material; Lighting must skip it

    const mesh = new THREE.InstancedMesh(geo, mat, count);
    mesh.name = `weather.${name}`;
    mesh.frustumCulled = false;
    mesh.matrixAutoUpdate = false;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.renderOrder = order;
    mesh.visible = false;
    mesh.userData.noGBuffer = true;
    mesh.userData.skyNoFog = true;
    mesh.userData.noCSM = true;
    mesh.raycast = noop;             // particles are never a click target
    const id = new THREE.Matrix4();
    for (let i = 0; i < count; i++) mesh.setMatrixAt(i, id);
    mesh.instanceMatrix.needsUpdate = true;

    this.group.add(mesh);
    this.systems[name] = { mesh, mat, geo, max: count, star };
    return this.systems[name];
  }

  _instAttr(sys, name, itemSize) {
    const a = new THREE.InstancedBufferAttribute(new Float32Array(sys.max * itemSize), itemSize);
    a.setUsage(THREE.StaticDrawUsage);
    sys.mesh.geometry.setAttribute(name, a);
    return a;
  }

  /* ---------------- rain ---------------- */

  _buildRain() {
    const count = this._count(MAXC.rain);
    const sys = this._system('rain', {
      vert: RAIN_VERT, frag: RAIN_FRAG, count, blend: 'add', order: 6,
      uniforms: {
        uSoftK: { value: 1 / 0.55 },
        uTint: { value: new THREE.Color(0.09, 0.11, 0.16) },
        uOpacity: { value: 1 },
        uFall: { value: 1 },
        uSlant: { value: 0.8 },
        uYLift: { value: 8.0 },
      },
    });

    const base = this._instAttr(sys, 'aBase', 4);
    const param = this._instAttr(sys, 'aParam', 4);
    const vol = this._instAttr(sys, 'aVol', 4);
    const r = this._rand(0x7a10);

    // Interleave the shells (golden-ratio sequence) so trimming `mesh.count`
    // for a lighter shower thins all three depth layers evenly instead of
    // deleting the far one outright.
    const cum = [];
    let acc = 0;
    for (const s of RAIN_SHELLS) { acc += s.frac; cum.push(acc); }
    for (let i = 0; i < count; i++) {
      const u = (i * 0.6180339887498949) % 1;
      let si = 0;
      while (si < cum.length - 1 && u > cum[si] / acc) si++;
      const S = RAIN_SHELLS[si];
      const hx = S.half[0], hy = S.half[1], hz = S.half[2];
      const fall = r.range(S.fall[0], S.fall[1]);
      base.setXYZW(i,
        r.range(-hx, hx), r.range(-hy, hy), r.range(-hz, hz), r());
      param.setXYZW(i,
        fall,
        fall * r.range(0.042, 0.058),       // exposure smear length
        r.range(S.width[0], S.width[1]),
        r.range(S.alpha[0], S.alpha[1]));
      vol.setXYZW(i, hx, hy, hz, si);
    }
    base.needsUpdate = param.needsUpdate = vol.needsUpdate = true;
  }

  /* ---------------- splash ripples ---------------- */

  _buildSplash() {
    const count = this._count(MAXC.splash);
    const sys = this._system('splash', {
      vert: SPLASH_VERT, frag: SPLASH_FRAG, count, blend: 'add', order: 4,
      uniforms: {
        uSoftK: { value: 1 / 0.22 },
        uTint: { value: new THREE.Color(0.16, 0.19, 0.26) },
        uOpacity: { value: 1 },
        uLife: { value: 0.62 },
        uMaxR: { value: 0.20 },
      },
    });
    sys.rip = this._instAttr(sys, 'aRip', 4);
    sys.ripN = this._instAttr(sys, 'aRipN', 4);
    sys.rip.setUsage(THREE.DynamicDrawUsage);
    sys.ripN.setUsage(THREE.DynamicDrawUsage);
    this._rippleCycle = new Int32Array(count).fill(-99999);
    for (let i = 0; i < count; i++) {
      sys.rip.setXYZW(i, 0, 0, 0, -1);
      sys.ripN.setXYZW(i, 0, 1, 0, 1);
    }
    sys.rip.needsUpdate = sys.ripN.needsUpdate = true;
  }

  _seedRipples(reset) {
    const sys = this.systems.splash;
    if (!sys || !this._rippleCycle) return;
    if (reset) this._rippleCycle.fill(-99999);
  }

  /**
   * Ripples are the one system that has to know where the ground actually is, so
   * placement is CPU-side against the heightfield; the ring itself is animated
   * on the GPU from the stored start time.
   */
  _updateRipples(elapsed) {
    const sys = this.systems.splash;
    if (!sys) return;
    const live = sys.mesh.count;
    if (live <= 0) return;
    const terrain = this.engine.get?.('terrain');
    const hasT = !!(terrain && !terrain.__dead && typeof terrain.heightAt === 'function');
    const cycles = this._rippleCycle;
    const rip = sys.rip, ripN = sys.ripN;
    const cx = this._focus.x, cz = this._focus.z;
    const R = 17 + (this._camDist || 26) * 0.32;
    let dirty = false;

    for (let i = 0; i < live; i++) {
      const period = 0.42 + hash2(i, 7, 5501) * 0.55;
      const phase = hash2(i, 11, 6607) * period;
      const c = Math.floor((elapsed + phase) / period);
      if (c === cycles[i]) continue;
      cycles[i] = c;

      const a = hash2(i, c, 1337) * 6.283185307;
      const rad = Math.sqrt(hash2(i, c, 4211)) * R;
      const x = cx + Math.cos(a) * rad;
      const z = cz + Math.sin(a) * rad;
      let y = 0, nx = 0, ny = 1, nz = 0;
      if (hasT) {
        y = terrain.heightAt(x, z);
        if (!Number.isFinite(y)) y = 0;
        if (typeof terrain.normalAt === 'function') {
          terrain.normalAt(x, z, _v);
          if (Number.isFinite(_v.x)) { nx = _v.x; ny = _v.y; nz = _v.z; }
        }
      }
      const start = c * period - phase;
      rip.setXYZW(i, x, y, z, start);
      ripN.setXYZW(i, nx, ny, nz, 0.62 + hash2(i, c, 9109) * 0.85);
      dirty = true;
    }
    if (dirty) { rip.needsUpdate = true; ripN.needsUpdate = true; }
  }

  /* ---------------- snow / ash ---------------- */

  _buildFlakes(kind) {
    const snow = kind === 'snow';
    const count = this._count(snow ? MAXC.snow : MAXC.ash);
    const V = snow ? VOL.snow : VOL.ash;
    const sys = this._system(kind, {
      vert: FLAKE_VERT, frag: FLAKE_FRAG, count, blend: 'over', order: 6,
      uniforms: {
        uSoftK: { value: 1 / (snow ? 0.35 : 0.45) },
        uHalf: { value: new THREE.Vector3(V.half[0], V.half[1], V.half[2]) },
        uYLift: { value: V.lift },
        uTint: { value: snow ? new THREE.Color(0.86, 0.90, 1.0) : new THREE.Color(0.15, 0.135, 0.13) },
        uOpacity: { value: 1 },
        uLightMul: { value: snow ? 1.5 : 2.4 },
        uStar: { value: snow ? 0.30 : 0.0 },
        uSway: { value: snow ? 1.15 : 1.6 },
        uSpin: { value: snow ? 2.4 : 1.5 },
        uDrift: { value: snow ? 1.0 : 1.35 },
      },
    });

    const base = this._instAttr(sys, 'aBase', 4);
    const param = this._instAttr(sys, 'aParam', 4);
    const r = this._rand(snow ? 0x5407 : 0x4a58);
    const hx = V.half[0], hy = V.half[1], hz = V.half[2];
    for (let i = 0; i < count; i++) {
      base.setXYZW(i, r.range(-hx, hx), r.range(-hy, hy), r.range(-hz, hz), r());
      if (snow) {
        param.setXYZW(i,
          r.range(0.55, 1.35),                       // fall m/s
          r.range(0.055, 0.155),                     // size m
          r.range(0.4, 1.8),                         // spin
          r.range(0.35, 0.85));                      // alpha
      } else {
        param.setXYZW(i,
          r.range(0.28, 0.85),
          r.range(0.030, 0.105),
          r.range(0.3, 1.4),
          r.range(0.22, 0.62));
      }
    }
    base.needsUpdate = param.needsUpdate = true;
  }

  /* ---------------- embers ---------------- */

  _buildEmber() {
    const count = this._count(MAXC.ember);
    const V = VOL.ember;
    const sys = this._system('ember', {
      vert: EMBER_VERT, frag: EMBER_FRAG, count, blend: 'add', order: 7,
      uniforms: {
        uSoftK: { value: 1 / 0.30 },
        uHalf: { value: new THREE.Vector3(V.half[0], V.half[1], V.half[2]) },
        uYLift: { value: V.lift },
        uHot: { value: new THREE.Color(1.0, 0.72, 0.34) },
        uCool: { value: new THREE.Color(0.86, 0.13, 0.028) },
        uOpacity: { value: 1 },
        uGlow: { value: 3.4 },   // > 1 so the bloom threshold actually catches it
      },
    });
    const base = this._instAttr(sys, 'aBase', 4);
    const param = this._instAttr(sys, 'aParam', 4);
    const r = this._rand(0xe3be);
    const hx = V.half[0], hy = V.half[1], hz = V.half[2];
    for (let i = 0; i < count; i++) {
      // bias the seed height downward so most sparks are still near their source
      const yb = -hy + Math.pow(r(), 1.9) * hy * 1.5;
      base.setXYZW(i, r.range(-hx, hx), yb, r.range(-hz, hz), r());
      param.setXYZW(i,
        r.range(0.55, 1.9),                  // rise m/s
        r.range(0.030, 0.085),               // size m
        1 / r.range(2.4, 5.6),               // 1 / lifetime
        r.range(0.10, 0.42));                // turbulence amplitude
    }
    base.needsUpdate = param.needsUpdate = true;
  }

  /* ---------------- dust motes ---------------- */

  _buildDust() {
    const count = this._count(MAXC.dust);
    const V = VOL.dust;
    const sys = this._system('dust', {
      vert: DUST_VERT, frag: DUST_FRAG, count, blend: 'add', order: 8,
      uniforms: {
        uSoftK: { value: 1 / 0.28 },
        uHalf: { value: new THREE.Vector3(V.half[0], V.half[1], V.half[2]) },
        uYLift: { value: V.lift },
        // Candela -> mote irradiance. Only feeds the gate and the hue; the
        // *value* of a mote comes from uPeak and nothing else.
        uLightMul: { value: 2.2 },
        // Irradiance floor below which the air is empty. Tuned against a 15 cd
        // torch: full brightness inside ~1 m of the flame, ~35 % at 3 m, nothing
        // past ~4.5 m. Motes therefore trace the light pools and the shaft and
        // are absent everywhere else.
        uGate: { value: 0.075 },
        // Peak additive contribution, linear, pre-exposure. A firelit crypt floor
        // sits around 0.4-1.0 here, so a mote at 0.13 x its own alpha (~0.25) is
        // roughly 3 % of the surface behind it: visible against shadow, invisible
        // against anything lit. This number is the whole reason the motes stopped
        // reading as snow.
        uPeak: { value: 0.26 },
        // Angular ceiling in radians ~ 0.0055 rad -> about 6 px across on a
        // 900 px frame, whatever the camera distance. Without this the closeup
        // framing (6.5 m) inflated the same flakes to 20 px blobs.
        uAngular: { value: 0.0055 },
        uOpacity: { value: 1 },
      },
    });
    const base = this._instAttr(sys, 'aBase', 4);
    const param = this._instAttr(sys, 'aParam', 4);
    const r = this._rand(0xd057);
    const hx = V.half[0], hy = V.half[1], hz = V.half[2];
    for (let i = 0; i < count; i++) {
      base.setXYZW(i, r.range(-hx, hx), r.range(-hy, hy), r.range(-hz, hz), r());
      // Size and alpha are both heavily skewed by a power curve: the population is
      // mostly tiny and near-invisible with a few larger, slightly brighter flakes.
      // A uniform distribution is what makes particulate read as a regular
      // stipple pattern instead of as air.
      const t = r();
      param.setXYZW(i,
        0.018 + Math.pow(t, 2.1) * 0.090,    // size m — 0.018..0.108, skewed small
        r.range(0.10, 0.62),                 // orbit radius m
        r.range(0.5, 1.7),                   // orbit rate
        0.055 + Math.pow(r(), 1.8) * 0.30);  // alpha — 0.055..0.355, skewed faint
    }
    base.needsUpdate = param.needsUpdate = true;
  }

  /* ---------------- ground fog ---------------- */

  _buildFog() {
    const count = MAXC.fog;
    const sys = this._system('fog', {
      vert: FOG_VERT, frag: FOG_FRAG, count, blend: 'over', order: 5,
      uniforms: {
        uSoftK: { value: 1 / 1.7 },
        uNoise: { value: this._noiseTex },
        uTint: { value: new THREE.Color(0.075, 0.085, 0.105) },
        uWarm: { value: new THREE.Color(0.10, 0.075, 0.055) },
        uOpacity: { value: 1 },
        uContrast: { value: 1.5 },
        uLightMul: { value: 1.15 },
        uScroll: { value: new THREE.Vector2() },
      },
    });
    sys.slab = this._instAttr(sys, 'aSlab', 4);
    sys.slab2 = this._instAttr(sys, 'aSlab2', 4);
    sys.slab.setUsage(THREE.DynamicDrawUsage);
    sys.slab2.setUsage(THREE.DynamicDrawUsage);

    // Static per-slab character; positions are refreshed on the CPU each frame.
    const r = this._rand(0xf06b);
    sys.slabDef = [];
    for (let i = 0; i < count; i++) {
      sys.slabDef.push({
        ox: r.range(-1, 1), oz: r.range(-1, 1),
        size: r.range(11, 26),
        h: Math.pow(r(), 1.6) * 1.45 + 0.06,
        alpha: r.range(0.42, 1.0),
        noise: r.range(0.012, 0.032),
        rot: r.range(0, 6.283),
        spin: r.range(-0.045, 0.045),
        drift: r.range(0.55, 1.35),
        phase: r(),
      });
      sys.slab.setXYZW(i, 0, -9999, 0, 1);
      sys.slab2.setXYZW(i, 0, 0.02, 0, 0);
    }
    sys.slab.needsUpdate = sys.slab2.needsUpdate = true;
  }

  /**
   * Fog slabs are few enough (14) to place on the CPU, which means each one can
   * sit on the real heightfield instead of a guessed plane — the difference
   * between fog that hugs the ground and fog that floats.
   */
  _updateFogSlabs(elapsed) {
    const sys = this.systems.fog;
    if (!sys) return;
    const live = sys.mesh.count;
    if (live <= 0) return;
    const defs = sys.slabDef;
    const slab = sys.slab, slab2 = sys.slab2;
    const cx = this._focus.x, cz = this._focus.z;
    const span = 34 + (this._camDist || 26) * 0.55;
    const wx = this.wind.x, wz = this.wind.z;

    for (let i = 0; i < live; i++) {
      const d = defs[i];
      /* World-anchored drift wrapped into the cell around the focus: the bank
         has a real trajectory (so it slides past the camera), but always has an
         image near the action. */
      const px = d.ox * span + wx * elapsed * 0.11 * d.drift;
      const pz = d.oz * span + wz * elapsed * 0.11 * d.drift;
      const x = cx + wrap(px - cx, span);
      const z = cz + wrap(pz - cz, span);
      const gy = this._groundAt(x, z);
      // breathe the height a little so the bank is never a static slice
      const bob = Math.sin(elapsed * 0.21 + d.phase * 6.283) * 0.12;
      slab.setXYZW(i, x, gy + d.h + bob, z, d.size);
      slab2.setXYZW(i,
        d.alpha * Math.exp(-d.h * 0.85),          // fog thins with height
        d.noise,
        d.rot + elapsed * d.spin,
        d.phase);
    }
    slab.needsUpdate = true;
    slab2.needsUpdate = true;
  }

  /* ================================================================ *
   * helpers
   * ================================================================ */

  /** Instance budget for a system at the running quality tier. */
  _count(max, scale = 1) {
    const tier = TIER_SCALE[this.engine.quality?.tier] ?? 1;
    return Math.max(8, Math.round(max * tier * scale));
  }

  /** Push the smoothed levels onto instance counts + opacity. */
  _syncCounts() {
    const L = this.level;
    this._setLevel('rain', L.rain, 1);
    this._setLevel('splash', L.splash, 1);
    this._setLevel('snow', L.snow, 1);
    this._setLevel('ash', L.ash, 1);
    this._setLevel('ember', L.ember, 1);
    this._setLevel('dust', L.dust, 1);
    this._setLevel('fog', L.fog, 1);
  }

  _setLevel(name, level, opacity) {
    const sys = this.systems[name];
    if (!sys) return;
    const lv = clamp01(level);
    // Count carries most of the density; opacity fades the last sliver so a
    // system never pops out of existence.
    const n = Math.round(sys.max * Math.min(1, lv * 1.08));
    sys.mesh.count = n;
    sys.mesh.visible = n > 0 && lv > 0.004;
    sys.mat.uniforms.uOpacity.value = opacity * Math.min(1, lv * 3.2);
  }

  _groundAt(x, z) {
    const t = this.engine.get?.('terrain');
    if (t && !t.__dead && typeof t.heightAt === 'function') {
      const y = t.heightAt(x, z);
      if (Number.isFinite(y)) return y;
    }
    return 0;
  }

  _resolveKind(kind) {
    if (typeof kind !== 'string') return this.kind;
    const k = kind.toLowerCase();
    if (KINDS[k]) return k;
    if (KIND_ALIAS[k] && KINDS[KIND_ALIAS[k]]) return KIND_ALIAS[k];
    return 'clear';
  }

  _rand(seed) {
    const e = this.engine;
    return (e.freshRand ? e.freshRand(seed) : e.rand(seed));
  }

  /** 4-channel fbm noise for the fog banks. */
  _makeNoise() {
    try {
      const forge = this.engine.assets ?? this.engine.get?.('assets');
      if (forge && typeof forge.noiseTexture === 'function') {
        const t = forge.noiseTexture(256, 4177);
        if (t?.isTexture) { this._ownsNoise = false; return t; }
      }
    } catch { /* fall through to our own */ }

    const S = 128;
    const data = new Uint8Array(S * S * 4);
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const i = (y * S + x) * 4;
        const u = x / S, v = y / S;
        data[i] = fbm2(u * 6, v * 6, { octaves: 4, seed: 17 }) * 255;
        data[i + 1] = fbm2(u * 14, v * 14, { octaves: 3, seed: 91 }) * 255;
        data[i + 2] = fbm2(u * 3, v * 3, { octaves: 2, seed: 411 }) * 255;
        data[i + 3] = 255;
      }
    }
    const tex = new THREE.DataTexture(data, S, S, THREE.RGBAFormat, THREE.UnsignedByteType);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.generateMipmaps = true;
    tex.needsUpdate = true;
    this._ownsNoise = true;
    return tex;
  }
}

/* ------------------------------------------------------------------ *
 * free functions
 * ------------------------------------------------------------------ */

const _tmpSize = new THREE.Vector2();
const FLASH_COLOR = new THREE.Color(0.78, 0.86, 1.0);
const noop = () => {};
const byScore = (a, b) => b.score - a.score;

/** One exponential flash pulse. */
function pulse(t, at, amp, decay) {
  if (t < at) return 0;
  return amp * Math.exp(-(t - at) / decay);
}

/** Wrap v into [-h, h). */
function wrap(v, h) {
  const w = h * 2;
  let x = ((v + h) % w + w) % w;
  return x - h;
}

function hashStr(s) {
  let h = 2166136261;
  const str = String(s ?? '');
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
