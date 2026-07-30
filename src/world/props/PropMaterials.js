/**
 * THE NINTH VIGIL — Props material bank.
 *
 * Three jobs:
 *
 *  1. Extend AssetForge with the three surface kinds the dressing library needs
 *     and the core library does not have: gnarled **bark**, dry moorland
 *     **foliage**, and glowing **coal**. Registered through the documented
 *     `assets.register()` hook so they go through the same wear/AO/normal pass
 *     as every built-in kind and therefore match the rest of the game.
 *
 *  2. Hand out configured materials whose texture tiling is expressed in
 *     *metres per tile* — every prop geometry writes metre UVs, so a barrel
 *     stave, a tombstone and a cliff chunk all show the same grain density.
 *
 *  3. Inject the two shader features instancing cannot express through
 *     uniforms: a layered **vertex wind** (gust × sway × flutter, per-instance
 *     phase, world-space direction correctly rotated into instance space) and a
 *     per-instance **roughness jitter**, so a hundred copies of one barrel do
 *     not all have identical specular response.
 */

import * as THREE from 'three';

/* ------------------------------------------------------------------ *
 * custom AssetForge kinds
 * ------------------------------------------------------------------ */

/** Local re-implementations of Kinds.js' private helpers (not exported there). */
function detailF(T, c, seed) {
  const size = c.size;
  const fa = Math.max(16, size >> 2);
  const fb = Math.max(8, Math.round(size / 11));
  const lo = T.field(size, 2, (u, v) => T.perlinT(u * fb, v * fb, fb, fb, seed + 7));
  const inv = 1 / size;
  for (let y = 0, i = 0; y < size; y++) {
    const va = (y + 0.5) * inv * fa;
    for (let x = 0; x < size; x++, i++) {
      lo[i] = T.perlinT((x + 0.5) * inv * fa, va, fa, fa, seed) * 0.58 + lo[i] * 0.42;
    }
  }
  return lo;
}
function fleckF(T, c, seed) {
  const size = c.size;
  const out = new Float32Array(size * size);
  for (let y = 0, i = 0; y < size; y++) for (let x = 0; x < size; x++, i++) out[i] = T.hash2(x, y, seed);
  return out;
}
function aniso(T, u, v, ax, ay, bx, by, Fa, Fb, seed, oct = 3) {
  return T.fbmT((ax * u + ay * v) * Fa, (bx * u + by * v) * Fb, Fa, Fb, oct, 0.5, seed);
}

/**
 * Bark. Deep vertical fissures between raised plates, a fibrous grain running
 * up the trunk, knots where limbs were shed, and lichen crusting the fissures.
 * Tile is authored to ~0.9 m so a plate reads at roughly 8 cm.
 */
function genBark(c, T) {
  const size = c.size, S = c.seed, P = c.params;
  const { clamp01, smoothstep, lerp, fbmT, warpT, worleyT4, WK, WP, field, FBM_RIDGED } = T;
  P.normalStrength = 1.35;
  P.aoStrength = 1.2; P.cavity1 = 1.35; P.cavity2 = 1.3;
  P.grimeAmount = 0.85; P.grimeColor = [0.052, 0.05, 0.04]; P.grimeRough = 0.97;
  P.grimeCavity = 1.0; P.roughMin = 0.44; P.displacement = 0.1; P.cavityTint = 0.34;

  // long vertical fissures — high frequency across u, very low along v
  const fis = field(size, 2, (u, v) => {
    warpT(u * 9, v * 3, 9, 3, S + 11, 0.42, 3);
    return fbmT(WP.x, WP.y, 9, 3, 5, 0.5, S + 13, FBM_RIDGED);
  });
  // plate cells — irregular, tall
  const [plate, pRand] = T.fieldN(size, 2, 2, (u, v, out) => {
    warpT(u * 6, v * 3, 6, 3, S + 23, 0.35, 3);
    worleyT4((WP.x / 6) * 11, (WP.y / 3) * 5, 11, 5, S + 29);
    out[0] = WK.edge;
    out[1] = T.hash2(WK.cx, WK.cy, S + 31);
  });
  const fibre = field(size, 2, (u, v) => aniso(T, u, v, 0, 1, 1, 0, 5, 170, S + 43, 3));
  const knotF = field(size, 4, (u, v) => fbmT(u * 3, v * 3, 3, 3, 4, 0.55, S + 59));
  const lich = field(size, 4, (u, v) => {
    warpT(u * 5, v * 5, 5, 5, S + 71, 0.7, 3);
    return fbmT(WP.x, WP.y, 5, 5, 4, 0.6, S + 73);
  });
  const det = detailF(T, c, S + 89);
  const flk = fleckF(T, c, S + 97);

  for (let i = 0; i < c.n; i++) {
    const f = fis[i];
    const crack = clamp01(Math.pow(1 - f, 2.1) * 1.45);              // 1 in a fissure
    const ridge = smoothstep(0.18, 0.02, plate[i]);                  // plate boundary
    const knot = smoothstep(0.74, 0.93, knotF[i]);
    const fib = fibre[i] - 0.5;
    const tone = 0.5 + (pRand[i] - 0.5) * 0.9;

    let h = 0.62
      - crack * 0.34 - ridge * 0.12
      + (f - 0.5) * 0.1
      + fib * 0.045
      + (det[i] - 0.5) * 0.028
      + (flk[i] - 0.5) * 0.008
      + knot * 0.1;

    // greyed, cold, dead wood — never "brown tree bark" saturated
    let r = lerp(0.088, 0.132, tone) + fib * 0.02;
    let g = lerp(0.074, 0.108, tone) + fib * 0.016;
    let b = lerp(0.058, 0.082, tone) + fib * 0.011;
    let rough = 0.86 - fib * 0.05 + (det[i] - 0.5) * 0.09;

    // fissures are darker and rougher (dirt + damp accumulate in them)
    const cd = crack * 0.72;
    r *= 1 - cd * 0.62; g *= 1 - cd * 0.66; b *= 1 - cd * 0.68;
    rough += cd * 0.09;

    // pale silvered weathering on the exposed plate faces
    const wsil = clamp01((1 - crack) * smoothstep(0.4, 0.78, knotF[i]) * 0.8);
    r = lerp(r, 0.152, wsil * 0.5); g = lerp(g, 0.146, wsil * 0.5); b = lerp(b, 0.134, wsil * 0.5);

    // lichen: pale grey-green crust, only where the surface is broken
    const lc = clamp01(smoothstep(0.56, 0.8, lich[i]) * (0.35 + 0.65 * crack) * 1.25);
    r = lerp(r, 0.108, lc); g = lerp(g, 0.126, lc); b = lerp(b, 0.096, lc);
    rough = lerp(rough, 0.95, lc);
    h += lc * 0.012;

    c.h[i] = h;
    c.cr[i] = r; c.cg[i] = g; c.cb[i] = b;
    c.rg[i] = clamp01(rough);
    c.mt[i] = 0;
    c.gm[i] = clamp01(0.5 + crack * 0.5);
  }
}

/**
 * Dry moorland foliage — heather, dead sedge, bracken. Longitudinal fibre with
 * a darker central rib, sun-bleached tips and a rot/blight mottle. Deliberately
 * desaturated olive-ochre: saturated green would break the palette instantly.
 */
function genFoliage(c, T) {
  const size = c.size, S = c.seed, P = c.params;
  const { clamp01, smoothstep, lerp, fbmT, field, warpT, WP } = T;
  P.normalStrength = 0.8;
  P.aoStrength = 0.95; P.cavity1 = 1.1; P.cavity2 = 0.85;
  P.grimeAmount = 0.42; P.grimeColor = [0.055, 0.05, 0.032]; P.grimeRough = 0.96;
  P.roughMin = 0.5; P.displacement = 0.02; P.cavityTint = 0.2;

  const rib = field(size, 2, (u) => {
    // three or four blades across the tile, each with a central rib
    const f = T.frac(u * 4);
    return Math.abs(f * 2 - 1);
  });
  const fibre = field(size, 2, (u, v) => aniso(T, u, v, 0, 1, 1, 0, 4, 190, S + 17, 3));
  const blight = field(size, 4, (u, v) => {
    warpT(u * 5, v * 4, 5, 4, S + 23, 0.6, 3);
    return fbmT(WP.x, WP.y, 5, 4, 4, 0.6, S + 29);
  });
  const dryF = field(size, 4, (u, v) => fbmT(u * 3, v * 7, 3, 7, 4, 0.6, S + 37));
  const det = detailF(T, c, S + 43);
  const flk = fleckF(T, c, S + 53);

  for (let i = 0; i < c.n; i++) {
    const rb = rib[i];
    const groove = 1 - smoothstep(0.0, 0.22, rb);
    const fib = fibre[i] - 0.5;
    const dry = smoothstep(0.34, 0.82, dryF[i]);
    const bl = smoothstep(0.55, 0.85, blight[i]);

    c.h[i] = 0.6 + (0.5 - groove) * 0.06 + fib * 0.03 + (det[i] - 0.5) * 0.018 + (flk[i] - 0.5) * 0.006;

    // living-but-tired olive → straw → dead brown
    let r = 0.096, g = 0.112, b = 0.056;
    r = lerp(r, 0.185, dry); g = lerp(g, 0.158, dry); b = lerp(b, 0.078, dry);
    r = lerp(r, 0.116, bl * 0.8); g = lerp(g, 0.082, bl * 0.8); b = lerp(b, 0.052, bl * 0.8);
    const shade = 1 - groove * 0.4 + fib * 0.16;
    r *= shade; g *= shade; b *= shade;

    c.cr[i] = clamp01(r); c.cg[i] = clamp01(g); c.cb[i] = clamp01(b);
    c.rg[i] = clamp01(0.72 + dry * 0.16 - fib * 0.08 + (det[i] - 0.5) * 0.08);
    c.mt[i] = 0;
    c.gm[i] = clamp01(0.35 + groove * 0.4);
  }
}

/**
 * Burning coal / charred timber. A cracked black crust with an incandescent
 * network in the fissures, written into the emissive channel so bloom picks up
 * only the glowing veins and never the crust.
 */
function genCoal(c, T) {
  const size = c.size, S = c.seed, P = c.params;
  const { clamp01, smoothstep, fbmT, field, warpT, worleyT4, WK, WP, FBM_RIDGED } = T;
  P.normalStrength = 1.15;
  P.aoStrength = 1.1; P.cavity1 = 1.25; P.cavity2 = 1.15;
  P.grimeAmount = 0.25; P.grimeColor = [0.02, 0.019, 0.018]; P.grimeRough = 0.98;
  P.roughMin = 0.5; P.displacement = 0.06; P.cavityTint = 0.3;

  const lump = field(size, 2, (u, v) => { worleyT4(u * 9, v * 9, 9, 9, S + 7); return WK.f1; });
  const crack = field(size, 2, (u, v) => {
    warpT(u * 6, v * 6, 6, 6, S + 11, 0.6, 3);
    return fbmT(WP.x, WP.y, 6, 6, 5, 0.5, S + 13, FBM_RIDGED);
  });
  const heat = field(size, 4, (u, v) => fbmT(u * 3, v * 3, 3, 3, 4, 0.6, S + 19));
  const det = detailF(T, c, S + 23);
  const em = c.emissive();

  for (let i = 0; i < c.n; i++) {
    const lp = smoothstep(0.42, 0.02, lump[i]);
    const cr = clamp01(Math.pow(1 - crack[i], 2.4) * 1.6);
    const ht = clamp01(cr * (0.35 + 0.9 * heat[i]) * 1.25 - 0.06);

    c.h[i] = 0.58 + lp * 0.12 - cr * 0.22 + (det[i] - 0.5) * 0.03;
    // crust is near-black carbon, slightly warm where hot
    const k = 0.026 + (det[i] - 0.5) * 0.012 + lp * 0.012;
    c.cr[i] = k * 1.28 + ht * 0.09;
    c.cg[i] = k * 1.02 + ht * 0.035;
    c.cb[i] = k * 0.9;
    c.rg[i] = clamp01(0.82 - ht * 0.24 + (det[i] - 0.5) * 0.1);
    c.mt[i] = 0;
    c.gm[i] = 0.2;

    // incandescence — steep ramp so only the deepest cracks glow
    const g = Math.pow(ht, 2.3);
    const o = i * 3;
    em[o] = g * 2.9;
    em[o + 1] = g * g * 0.95;
    em[o + 2] = g * g * g * 0.2;
  }
}

/** Register the extra kinds. Safe to call more than once. */
export function registerPropKinds(engine) {
  const a = engine.assets;
  if (!a || typeof a.register !== 'function') return false;
  try {
    a.register('propbark', genBark);
    a.register('propfoliage', genFoliage);
    a.register('propcoal', genCoal);
    a.registerMaterial?.('propbark', { normalScale: 1.1, envMapIntensity: 0.75, aoMapIntensity: 1.1 });
    a.registerMaterial?.('propfoliage', { normalScale: 0.8, envMapIntensity: 0.6, aoMapIntensity: 1.0 });
    a.registerMaterial?.('propcoal', {
      normalScale: 1.0, envMapIntensity: 0.5, aoMapIntensity: 1.0,
      props: { emissiveIntensity: 1.5 },
    });
    return true;
  } catch (e) {
    console.warn('[props] custom kinds unavailable —', e);
    return false;
  }
}

/* ------------------------------------------------------------------ *
 * shader injection
 * ------------------------------------------------------------------ */

const VERT_DECL = /* glsl */`
attribute vec4 aJit;
varying float vPropRough;
varying vec3 vPropW;
varying float vPropSeed;
varying float vPropUp;
uniform vec4 uPropWind;
uniform vec2 uPropWindDir;
#ifdef NONA_PROP_WIND
attribute float aWindW;
#endif
`;

const VERT_BODY = /* glsl */`
	vPropRough = aJit.x;
	vPropSeed = aJit.w;
	/*
	 * WORLD-UP FACING, for the dust layer in FRAG_DUST.
	 *
	 * Uses the raw "normal" attribute rather than objectNormal: this same body is
	 * injected into the depth material, whose vertex stage only defines
	 * objectNormal under USE_DISPLACEMENTMAP — reading it there fails to link and
	 * every prop silently stops casting a shadow. "normal" is in three's default
	 * vertex attribute prefix for every non-raw material, so it is always there.
	 * Interpolating a single float and reading .y costs one varying slot; doing it
	 * per-vertex (rather than from the mapped normal in the fragment stage) is also
	 * what we want, because dust accumulates by macro orientation, not by grain.
	 */
	{
		vec3 sctN = normal;
		#ifdef USE_INSTANCING
			sctN = mat3( instanceMatrix ) * sctN;
		#endif
		vPropUp = normalize( mat3( modelMatrix ) * sctN ).y;
	}
	/*
	 * PER-INSTANCE SCULPT.
	 *
	 * Instancing shares one vertex buffer, so without this every copy of a
	 * rubble heap is geometrically CONGRUENT — identical silhouette, identical
	 * every-edge. Non-uniform instance scale and three-axis rotation hide a lot
	 * of that, but a congruent outline still reads as a stamp once the same shape
	 * appears a dozen times in one frame.
	 *
	 * aJit.z is a per-instance amplitude in metres of object space (0 for props
	 * that must keep their authored form — crates, columns, anything dressed) and
	 * aJit.w is a per-instance phase. Two low-frequency lobes only: the shading
	 * normal is NOT recomputed, so the deformation has to stay long-wavelength or
	 * the lighting stops matching the surface. At 3 cm on a 1 m heap that is a
	 * visibly different outline and an invisible normal error.
	 */
	{
		float sctAmp = aJit.z;
		if ( sctAmp > 0.0001 ) {
			float sd = aJit.w * 43.0;
			vec3 q = transformed;
			vec3 sw1 = vec3(
				sin( q.y * 2.7 + sd ) + sin( q.z * 3.1 - sd * 1.7 ),
				sin( q.x * 2.9 - sd * 1.3 ) + sin( q.z * 2.3 + sd * 0.7 ),
				sin( q.x * 3.3 + sd * 1.1 ) + sin( q.y * 2.1 - sd * 0.5 ) );
			vec3 sw2 = vec3(
				sin( q.y * 7.1 - sd * 2.1 ),
				sin( q.z * 6.3 + sd * 1.9 ),
				sin( q.x * 7.7 - sd * 1.5 ) );
			transformed += ( sw1 * 0.5 + sw2 * 0.22 ) * sctAmp;
		}
	}
#ifdef NONA_PROP_WIND
	{
		#ifdef USE_INSTANCING
			vec3 sctIO = vec3( instanceMatrix[ 3 ].x, instanceMatrix[ 3 ].y, instanceMatrix[ 3 ].z );
			vec2 sctAx = vec2( instanceMatrix[ 0 ].x, instanceMatrix[ 0 ].z );
			sctAx /= max( 1e-5, length( sctAx ) );
			vec2 sctWD = vec2(
				sctAx.x * uPropWindDir.x + sctAx.y * uPropWindDir.y,
				-sctAx.y * uPropWindDir.x + sctAx.x * uPropWindDir.y );
		#else
			vec3 sctIO = vec3( 0.0 );
			vec2 sctWD = uPropWindDir;
		#endif
		float sctT = uPropWind.y;
		float sctPh = aJit.y * 6.2831853 + dot( sctIO.xz, vec2( 0.173, 0.291 ) );
		float sctW = aWindW;
		float sctW2 = sctW * sctW;
		// a gust front travelling across the world, not a global multiplier
		float sctG = 0.5 + 0.5 * sin( sctT * 0.37 - sctIO.x * 0.062 - sctIO.z * 0.047 );
		sctG = mix( 0.30, 1.0, sctG * sctG ) * uPropWind.z;
		float sctF = uPropWind.w;
		float sctSway = sin( sctT * sctF * 0.72 + sctPh ) * 0.62
			+ sin( sctT * sctF * 1.31 + sctPh * 1.7 + 1.3 ) * 0.38;
		float sctFl = sin( sctT * sctF * 4.1 + sctPh * 3.1 + transformed.y * 5.5 ) * 0.3;
		float sctA = uPropWind.x * ( 0.42 + sctG );
		transformed.x += sctWD.x * ( sctSway * sctW2 + sctFl * sctW * 0.42 ) * sctA;
		transformed.z += sctWD.y * ( sctSway * sctW2 + sctFl * sctW * 0.42 ) * sctA;
		transformed.x += -sctWD.y * sctFl * sctW2 * sctA * 0.55;
		transformed.z += sctWD.x * sctFl * sctW2 * sctA * 0.55;
		// shorten as it leans so the blade does not stretch
		transformed.y -= abs( sctSway ) * sctW2 * sctA * 0.24;
	}
#endif
	#ifdef USE_INSTANCING
		vPropW = ( modelMatrix * instanceMatrix * vec4( transformed, 1.0 ) ).xyz;
	#else
		vPropW = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;
	#endif
`;

const FRAG_DECL = /* glsl */`
varying float vPropRough;
varying vec3 vPropW;
varying float vPropSeed;
varying float vPropUp;
uniform vec4 uPropMacro;
uniform vec4 uPropDust;
float sctMacro = 0.5;
float sctMid = 0.5;
float sctFine = 0.5;
float sctDust = 0.0;
float sctHash31( vec3 p ) {
	p = fract( p * 0.3183099 + 0.1 );
	p *= 17.0;
	return fract( p.x * p.y * p.z * ( p.x + p.y + p.z ) );
}
float sctVN3( vec3 p ) {
	vec3 i = floor( p ), f = fract( p );
	f = f * f * ( 3.0 - 2.0 * f );
	return mix(
		mix( mix( sctHash31( i ),                   sctHash31( i + vec3( 1.0, 0.0, 0.0 ) ), f.x ),
		     mix( sctHash31( i + vec3( 0.0, 1.0, 0.0 ) ), sctHash31( i + vec3( 1.0, 1.0, 0.0 ) ), f.x ), f.y ),
		mix( mix( sctHash31( i + vec3( 0.0, 0.0, 1.0 ) ), sctHash31( i + vec3( 1.0, 0.0, 1.0 ) ), f.x ),
		     mix( sctHash31( i + vec3( 0.0, 1.0, 1.0 ) ), sctHash31( i + vec3( 1.0, 1.0, 1.0 ) ), f.x ), f.y ),
		f.z );
}
`;

/*
 * MACRO BREAKUP — two extra scales of variation, zero extra texture units.
 *
 * Round-1 note #5: "single-scale procedural noise with no macro variation". Every
 * bank material is one 512 px tile repeated at a fixed metre rate, so a surface
 * carried exactly ONE feature size and every instance of a prop sampled the same
 * tile at the same phase. Two things fall out of that: the surface reads as a
 * printed pattern rather than as weathered stone, and two copies of the same prop
 * are pixel-identical wherever they stand.
 *
 * This adds a world-anchored value-noise field at THREE scales — a ~2.4 m MACRO
 * band (which patch of the surface is grimy, damp, sun-bleached), a ~0.37 m MID
 * band (which stone in that patch) and a ~0.11 m FINE band (the grain on that
 * stone) — and couples albedo value, albedo HUE and roughness through all three.
 * Three octaves is the answer to round-1 note #5 literally: a surface carrying
 * one feature size reads as a printed pattern no matter how good that pattern is,
 * and the macro band is what tells the eye the pattern is not the material.
 *
 * The hue coupling is the other half of "the rubble is cold blue-grey while the
 * architecture is warm stone". Flattening the debris hue into the masonry family
 * fixes the mismatch but costs the surface its variety, so the macro band puts
 * variety back along a limestone->slate tilt: warm dry patches against cool damp
 * ones, INSIDE one family, which is what real weathered stone does.
 *
 * World-anchored is the important word: two instances of one geometry standing a
 * metre apart get different fields, so the congruence that instancing forces on
 * the geometry is broken in the shading.
 *
 * uPropMacro = ( valueAmp, grimeAmp, roughAmp, freqScale ). Pure function of
 * world position: no samplers, no time, byte-deterministic.
 */
const FRAG_MACRO = /* glsl */`
	{
		vec3 sctMP = vPropW * uPropMacro.w + vPropSeed * 11.37;
		sctMacro = sctVN3( sctMP * 0.42 );
		sctMid = sctVN3( sctMP * 2.7 + 11.3 );
		sctFine = sctVN3( sctMP * 9.1 + 41.7 );
		float sctV = 1.0 + ( sctMacro - 0.5 ) * uPropMacro.x
			+ ( sctMid - 0.5 ) * uPropMacro.x * 0.45
			+ ( sctFine - 0.5 ) * uPropMacro.x * 0.20;
		// warm/cool tilt across the macro band — one stone family, two exposures
		float sctH = ( sctMacro - 0.5 ) * 0.72 + ( sctMid - 0.5 ) * 0.28;
		vec3 sctTint = vec3( 1.0 + sctH * 0.13, 1.0 + sctH * 0.022, 1.0 - sctH * 0.115 );
		// grime darkens, desaturates toward soot and roughens TOGETHER — an
		// uncoupled darkening is just a stain and reads as a texture bug
		float sctG = smoothstep( 0.30, 0.80, sctMacro * 0.66 + sctMid * 0.34 ) * uPropMacro.y;
		diffuseColor.rgb *= sctV * sctTint * mix( vec3( 1.0 ), vec3( 0.80, 0.755, 0.70 ), sctG );
	}
`;

/*
 * WARM DUST ON UP-FACING SURFACES — the fix for "the rubble is cold blue-grey
 * while the architecture and floor are warm stone".
 *
 * The mechanism behind that note is not the albedo. `genStone` authors dressed
 * stone slightly WARM (b/r 0.918) and the debris materials are warm-tinted on top
 * of that. What made every slab, capital and rubble block read slate blue is the
 * LIGHT: this is an isometric camera at 28 m looking down, so the biggest surface
 * of every prop in frame is its up-face, the torches only rake the vertical faces,
 * and the sole illuminant a horizontal face receives is the sky/irradiance probe —
 * which is cold by art direction. A near-neutral albedo under a cold-only ambient
 * IS slate blue, next to a floor whose vertical relief catches the warm practicals.
 *
 * Warming the albedo globally would fix the tops and turn the torch-lit verticals
 * orange. So the correction is applied where the problem is and where it is also
 * physically true: dust settles on up-facing surfaces, and dust in a crypt is
 * powdered warm limestone. The layer warms and lifts by macro orientation, is
 * modulated by BOTH the macro and mid noise bands (so it is a broken, drifted
 * deposit rather than a uniform wash — round-1 note #5), and roughens where it
 * lands, because an uncoupled tint reads as a shader bug.
 *
 * uPropDust = ( amount, ambient-lift scale, roughness coupling, unused ).
 */
const FRAG_DUST = /* glsl */`
	{
		float sctUp = clamp( vPropUp, 0.0, 1.0 );
		// two scales of deposit + a hard-ish orientation gate: ledges and tops get
		// it, vertical faces get none, and the drift edge wanders with the macro band
		float sctDep = smoothstep( 0.26, 0.88, sctUp )
			* ( 0.30 + 0.70 * smoothstep( 0.24, 0.78, sctMacro ) )
			* ( 0.55 + 0.45 * sctMid );
		sctDust = clamp( sctDep * uPropDust.x, 0.0, 1.0 );
		vec3 sctDC = diffuseColor.rgb * vec3( 1.30, 1.12, 0.86 )
			+ vec3( 0.0135, 0.0104, 0.0068 ) * uPropDust.y;
		diffuseColor.rgb = mix( diffuseColor.rgb, sctDC, sctDust );
	}
`;

const FRAG_ROUGH = /* glsl */`
	roughnessFactor = clamp(
		roughnessFactor + vPropRough
			+ ( sctMid - 0.5 ) * uPropMacro.z
			+ ( sctMacro - 0.5 ) * uPropMacro.z * 0.6
			+ ( sctFine - 0.5 ) * uPropMacro.z * 0.85
			+ sctDust * uPropDust.z,
		0.045, 1.0 );
`;

/**
 * Attach the props vertex-wind + per-instance roughness jitter to a stock
 * material. Composes with any hook already installed (Lighting's CSM/probe
 * wrapper and Sky's fog wrapper both compose with us in either order).
 */
export function injectProps(mat, {
  wind = 0, windFreq = 1.0, tag = 'x', macro = null, dust = null,
} = {}) {
  const mv = macro ?? [0.16, 0.24, 0.09, 1.0];
  const dv = dust ?? [0.0, 0.0, 0.0, 0.0];
  const u = {
    uPropWind: { value: new THREE.Vector4(wind, 0, 1, windFreq) },
    uPropWindDir: { value: new THREE.Vector2(0.86, 0.51) },
    uPropMacro: { value: new THREE.Vector4(mv[0], mv[1], mv[2], mv[3] ?? 1.0) },
    uPropDust: { value: new THREE.Vector4(dv[0], dv[1] ?? 1, dv[2] ?? 0, 0) },
  };
  mat.userData.propUniforms = u;
  mat.userData.propWind = wind;
  if (wind > 0) mat.defines = Object.assign(mat.defines || {}, { NONA_PROP_WIND: 1 });

  const prev = mat.onBeforeCompile;
  const hasPrev = typeof prev === 'function' && prev !== THREE.Material.prototype.onBeforeCompile;

  mat.onBeforeCompile = function nonaPropsInject(shader, renderer) {
    if (hasPrev) { try { prev.call(this, shader, renderer); } catch (e) { console.error('[props:chain]', e); } }
    shader.uniforms.uPropWind = u.uPropWind;
    shader.uniforms.uPropWindDir = u.uPropWindDir;
    shader.uniforms.uPropMacro = u.uPropMacro;
    shader.uniforms.uPropDust = u.uPropDust;

    if (shader.vertexShader.includes('#include <begin_vertex>')) {
      shader.vertexShader = VERT_DECL + shader.vertexShader.replace(
        '#include <begin_vertex>', '#include <begin_vertex>\n' + VERT_BODY
      );
    }
    if (shader.fragmentShader.includes('#include <roughnessmap_fragment>')) {
      let f = shader.fragmentShader;
      // The macro band must resolve BEFORE roughness reads it. In three's
      // fragment main() <color_fragment> precedes <roughnessmap_fragment>, which
      // is exactly the order the coupling needs.
      if (f.includes('#include <color_fragment>')) {
        f = f.replace('#include <color_fragment>', '#include <color_fragment>\n' + FRAG_MACRO + FRAG_DUST);
      } else {
        f = f.replace('#include <map_fragment>', '#include <map_fragment>\n' + FRAG_MACRO + FRAG_DUST);
      }
      f = f.replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\n' + FRAG_ROUGH);
      shader.fragmentShader = FRAG_DECL + f;
    } else if (shader.fragmentShader.includes('void main()')) {
      // depth / distance materials: the varyings must still be declared, or the
      // program fails to link against a vertex stage that writes them
      shader.fragmentShader = FRAG_DECL + shader.fragmentShader;
    }
  };

  const prevKey = mat.customProgramCacheKey;
  mat.customProgramCacheKey = function nonaPropsKey() {
    let base = '';
    try { base = typeof prevKey === 'function' ? String(prevKey.call(this)) : ''; } catch { base = ''; }
    return `${base}|sctprops-${tag}-${wind > 0 ? 'w' : 's'}`;
  };
  mat.needsUpdate = true;
  return mat;
}

/**
 * A depth material carrying the same wind displacement, so a swaying tree casts
 * a swaying shadow instead of a static one.
 */
export function makeWindDepthMaterial(sourceMat) {
  const u = sourceMat.userData.propUniforms;
  if (!u) return null;
  const d = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
  d.defines = { NONA_PROP_WIND: 1 };
  d.userData.propUniforms = u;
  d.onBeforeCompile = (shader) => {
    shader.uniforms.uPropWind = u.uPropWind;
    shader.uniforms.uPropWindDir = u.uPropWindDir;
    shader.uniforms.uPropMacro = u.uPropMacro;
    shader.uniforms.uPropDust = u.uPropDust;
    if (shader.vertexShader.includes('#include <begin_vertex>')) {
      shader.vertexShader = VERT_DECL + shader.vertexShader.replace(
        '#include <begin_vertex>', '#include <begin_vertex>\n' + VERT_BODY
      );
    }
    shader.fragmentShader = FRAG_DECL + shader.fragmentShader;
  };
  d.customProgramCacheKey = () => 'sctprops-depth-wind';
  return d;
}

/* ------------------------------------------------------------------ *
 * the bank
 * ------------------------------------------------------------------ */

/**
 * name -> { kind, tile (metres per texture tile), wind class, tint, extra }
 *
 * `tile` is the whole point of this table. Canonical scale is 1 unit = 1 m, so
 * an ashlar block is 0.55 × 0.32 m and the stone generator lays 3 × 5 blocks
 * per tile — hence a 1.65 m stone tile. Every other value is derived the same
 * way from the feature count in its generator.
 */
/*
 * `macro` = ( valueAmp, grimeAmp, roughAmp, freqScale ) for FRAG_MACRO above.
 * Stone carries the most because stone is what fills the frame; cloth and wax
 * carry the least because a woven or cast surface genuinely is more even.
 */
const M_STONE = [0.34, 0.52, 0.17, 1.0];
const M_ROCK = [0.36, 0.44, 0.19, 0.72];
const M_WOOD = [0.20, 0.32, 0.12, 1.1];
const M_ORGANIC = [0.20, 0.18, 0.08, 1.55];
const M_METAL = [0.14, 0.42, 0.15, 1.6];
const M_BONE = [0.18, 0.34, 0.12, 1.4];
const M_CLOTH = [0.16, 0.24, 0.09, 1.3];

/*
 * `dust` = ( amount, ambient-lift scale, roughness coupling, unused ) for
 * FRAG_DUST. Masonry and loose debris carry the most because they are the
 * surfaces the isometric camera sees mostly end-on and the ones the art director
 * called out as cold; turned wood, cloth and metal carry a token amount (a barrel
 * lid does gather dust) and anything vertical or hanging carries none, since the
 * layer is gated on world-up anyway.
 */
const D_STONE = [0.72, 1.0, 0.10];
const D_ROCK = [0.58, 0.9, 0.09];
const D_DEBRIS = [0.86, 1.15, 0.12];
const D_WOOD = [0.34, 0.7, 0.07];
const D_MISC = [0.22, 0.5, 0.05];

const DEFS = {
  /*
   * WARM LIMESTONE, NOT NEUTRAL GRANITE. `genStone` authors its body at
   * b/r 0.918 — already faintly warm — but at the value these props sit on screen
   * that is not enough to survive an ambient-only up-face, and the architecture and
   * floor it has to match are visibly tan. The tint pushes the whole masonry family
   * one step further into limestone so the family reads as one quarry, and the three
   * members then separate by VALUE (0.965 / 1.0 / 1.07), never by hue.
   */
  stone:      { kind: 'stone', tile: 1.65, seed: 21, tint: [1.045, 1.0, 0.925], macro: M_STONE, dust: D_STONE },
  /*
   * ONE STONE FAMILY, THREE VALUES — not two hues.
   *
   * This tint was [0.86, 0.90, 1.00]: blue over red by a factor of 1.163, which
   * on an isometric camera whose only fill on up-facing surfaces is a cold
   * ambient probe resolves as slate BLUE. It is the material on the boulders, the
   * rock clusters, the cliff chunks and the tombstones — the majority of the
   * hard-surface dressing in every frame — and the art director's note was
   * exactly that: the debris reads cold blue-grey against warm tan architecture,
   * so the two do not read as the same building. [0.90, 0.905, 0.925] is
   * b/r 1.028: still the darkest and coolest member of the family, still
   * unmistakably a different stone from `stoneWarm`, but the separation is now
   * carried by VALUE (0.90 against 1.06) instead of by hue. The macro band in
   * FRAG_MACRO supplies the warm/cool variation that the flatter tint gives up.
   */
  stoneCold:  { kind: 'stone', tile: 1.65, seed: 47, tint: [0.955, 0.935, 0.895], macro: M_STONE, dust: D_STONE },
  stoneWarm:  { kind: 'stone', tile: 1.65, seed: 63, tint: [1.12, 1.03, 0.90], macro: M_STONE, dust: D_STONE },
  marble:     { kind: 'stone', tile: 2.3, seed: 91, tint: [1.22, 1.2, 1.16], macro: [0.2, 0.34, 0.12, 0.8], dust: D_MISC, extra: { roughness: 1, envMapIntensity: 1.25 } },
  /*
   * NATURAL ROCK — a granular surface, not coursed ashlar.
   *
   * Boulders, rock clusters and cliff chunks used to draw in `stoneCold`, whose
   * generator lays 0.55 x 0.32 m dressed blocks in running bond. Coursed masonry
   * wrapped round a 2 m boulder reads as a manhole cover, and the previous attempt
   * to hide it — pushing that material's tile out by 2.4x through Props.TILE_SCALE
   * — traded the manhole cover for something worse: at ~6.5 m per repeat a 0.6 m
   * prop covers under a tenth of one tile, i.e. a fragment of ONE block face, so
   * every tombstone, debris chunk and boulder rendered as a flat near-constant
   * value with a single stray joint across it. That is the art director's
   * "untextured placeholder slab" in as many words.
   *
   * These two are the `cobble` generator instead — irregular worley grain with real
   * per-cell value spread — read at a rock scale (see Props.TILE_SCALE) so the
   * cells land near 0.16 m: coarse breccia, warm, with two values in the family.
   */
  stoneRock:     { kind: 'cobble', tile: 1.65, seed: 129, tint: [1.10, 1.005, 0.87], macro: M_ROCK, dust: D_ROCK },
  stoneRockCold: { kind: 'cobble', tile: 1.65, seed: 151, tint: [0.94, 0.915, 0.875], macro: M_ROCK, dust: D_ROCK },
  /*
   * Debris grit. THE COLD-BLUE DEFECT: this was untinted `cobble`, which
   * generates a neutral grey body, and every rubble heap in the game sits on a
   * floor whose only light is a cold ambient probe on its up-facing surfaces.
   * Neutral albedo + cold ambient = slate blue, next to warm tan architecture
   * lit on its vertical faces by torchlight — so the debris read as belonging to
   * a different building. The tint puts it in the same warm family as the
   * masonry it fell off, and the macro band supplies the value variation that
   * would otherwise be lost by flattening the hue.
   */
  rubble:     { kind: 'cobble', tile: 1.1, seed: 33, tint: [1.14, 1.035, 0.85], macro: [0.38, 0.54, 0.19, 1.15], dust: D_DEBRIS },
  bark:       { kind: 'propbark', tile: 0.9, seed: 11, wind: 'tree', macro: [0.22, 0.34, 0.12, 0.85], dust: D_MISC },
  barkBare:   { kind: 'propbark', tile: 0.9, seed: 57, tint: [0.9, 0.9, 0.94], wind: 'tree', macro: [0.22, 0.34, 0.12, 0.85], dust: D_MISC },
  barkStatic: { kind: 'propbark', tile: 0.9, seed: 11, macro: [0.22, 0.34, 0.12, 0.85], dust: D_MISC },
  barkCharred:{ kind: 'propbark', tile: 0.9, seed: 83, tint: [0.34, 0.31, 0.3], macro: [0.24, 0.2, 0.12, 0.9] },
  foliage:    { kind: 'propfoliage', tile: 0.55, seed: 13, wind: 'grass', macro: M_ORGANIC },
  foliageDry: { kind: 'propfoliage', tile: 0.55, seed: 71, tint: [1.18, 1.05, 0.82], wind: 'grass', macro: M_ORGANIC },
  reed:       { kind: 'propfoliage', tile: 0.7, seed: 29, tint: [0.96, 1.0, 0.86], wind: 'reed', macro: M_ORGANIC },
  thorn:      { kind: 'propbark', tile: 0.42, seed: 37, tint: [0.78, 0.76, 0.72], wind: 'shrub', macro: M_ORGANIC },
  moss:       { kind: 'moss', tile: 0.55, seed: 19, wind: 'moss', macro: M_ORGANIC },
  wood:       { kind: 'wood', tile: 0.62, seed: 17, macro: M_WOOD, dust: D_WOOD },
  woodDark:   { kind: 'wood', tile: 0.62, seed: 53, tint: [0.68, 0.64, 0.6], macro: M_WOOD, dust: D_WOOD },
  timber:     { kind: 'wood', tile: 1.0, seed: 77, macro: M_WOOD, dust: D_WOOD },
  metal:      { kind: 'metal', tile: 0.34, seed: 23, macro: M_METAL, dust: D_MISC },
  metalDark:  { kind: 'metal', tile: 0.34, seed: 61, tint: [0.72, 0.7, 0.7], macro: M_METAL, dust: D_MISC },
  bronze:     { kind: 'gold', tile: 0.3, seed: 41, tint: [0.82, 0.7, 0.5], macro: M_METAL, dust: D_MISC },
  bone:       { kind: 'bone', tile: 0.3, seed: 31, macro: M_BONE, dust: D_MISC },
  boneOld:    { kind: 'bone', tile: 0.3, seed: 67, tint: [0.82, 0.8, 0.72], macro: M_BONE, dust: D_MISC },
  cloth:      { kind: 'cloth', tile: 0.34, seed: 43, wind: 'cloth', macro: M_CLOTH },
  clothRed:   { kind: 'cloth', tile: 0.34, seed: 87, tint: [1.35, 0.6, 0.52], wind: 'cloth', macro: M_CLOTH },
  sack:       { kind: 'cloth', tile: 0.28, seed: 59, tint: [0.9, 0.82, 0.66], macro: M_CLOTH, dust: D_MISC },
  leather:    { kind: 'leather', tile: 0.4, seed: 47, macro: M_CLOTH, dust: D_MISC },
  flesh:      { kind: 'flesh', tile: 0.42, seed: 51, macro: [0.14, 0.2, 0.08, 1.5] },
  dirt:       { kind: 'dirt', tile: 1.0, seed: 27, macro: [0.28, 0.34, 0.13, 0.95], dust: D_ROCK },
  ash:        { kind: 'ash', tile: 0.85, seed: 39, macro: [0.26, 0.24, 0.12, 1.0], dust: D_MISC },
  coal:       { kind: 'propcoal', tile: 0.28, seed: 15, macro: [0.1, 0.12, 0.06, 1.4] },
  wax:        { kind: 'bone', tile: 0.22, seed: 95, tint: [1.06, 1.0, 0.86], macro: [0.08, 0.08, 0.05, 1.5], extra: { roughness: 1 } },
};

/** Wind amplitude (metres of tip travel at weight 1) and sway frequency. */
const WIND = {
  tree:  { amp: 0.085, freq: 0.55 },
  shrub: { amp: 0.10, freq: 0.95 },
  grass: { amp: 0.115, freq: 1.35 },
  reed:  { amp: 0.15, freq: 1.15 },
  moss:  { amp: 0.09, freq: 0.8 },
  cloth: { amp: 0.11, freq: 1.05 },
  chain: { amp: 0.028, freq: 0.7 },
};

export class MatBank {
  /** @param {import('../../core/Engine.js').Engine} engine */
  constructor(engine) {
    this.engine = engine;
    this.map = new Map();
    this.list = [];
    this.windMats = [];
    this._gust = 1;
    this._gustTarget = 1;
    registerPropKinds(engine);
  }

  /** Configured, injected, lighting-registered material for a bank name. */
  get(name) {
    const hit = this.map.get(name);
    if (hit) return hit;
    const def = DEFS[name] ?? DEFS.stone;
    let mat = null;
    try {
      mat = this.engine.assets.material({
        kind: def.kind,
        // 512 px, not the 1024 px default. The bank hands out roughly twenty
        // distinct surfaces and each one is a private (map + normal + ORM) set;
        // at 1024 that is over 400 MB of texture for the dressing alone, which
        // blows the whole frame's budget and forces AssetForge to start
        // downgrading *other* modules' maps. At a 1.65 m tile, 512 px is still
        // 310 px/m — far more than a prop resolves at a 28 m camera.
        size: 512,
        /*
         * TILING IS 1 HERE ON PURPOSE — DO NOT PUT `1 / def.tile` BACK.
         *
         * Every prop builder in props/*.js writes its UVs as `position * uTile`
         * with `uTile = 1 / <metres per tile>` (see Geo.faceBoxUV / latheGeo /
         * tube), i.e. **the geometry already hands the sampler tile units**. Setting
         * the material's repeat to 1/tile as well divided by the tile a SECOND time,
         * so the real world size of one texture repeat was `tile²`, not `tile`.
         *
         * On the family that fills the frame that is catastrophic rather than
         * subtle: stone's 1.65 m tile became 2.72 m, so the generator's 0.55 x
         * 0.32 m ashlar rendered at 0.91 x 0.53 m, and a 0.5 m rubble block or a
         * 0.6 m tombstone therefore showed a fragment of ONE block face — a flat
         * near-constant value with a stray joint across it, which is exactly the
         * "untextured flat placeholder slab, near-uniform in value" note. It also
         * quietly inverted for every fine material (bone's 0.3 m tile became
         * 0.09 m, four times finer than authored).
         *
         * `def.tile` stays the authored truth and is still what the builders and
         * Props.TILE_SCALE are written against; the repeat that expresses it lives
         * in the geometry, exactly once.
         */
        tiling: 1,
        seed: def.seed,
        tint: def.tint ?? null,
        unique: true,
        vertexColors: true,
        ...(def.extra ?? {}),
      });
    } catch (e) {
      console.warn(`[props] material "${name}" fell back —`, e);
      mat = new THREE.MeshStandardMaterial({ color: 0x5c574d, roughness: 0.9, metalness: 0, vertexColors: true });
    }
    mat.vertexColors = true;
    mat.name = `props.${name}`;
    // Emissive on dressing must stay below the bloom threshold unless it is
    // genuinely fire; the coal kind is the only one allowed to break 1.0.
    if (mat.emissiveMap && def.kind !== 'propcoal') mat.emissiveIntensity = Math.min(mat.emissiveIntensity ?? 1, 0.85);

    const w = def.wind ? WIND[def.wind] : null;
    injectProps(mat, {
      wind: w ? w.amp : 0, windFreq: w ? w.freq : 1, tag: name,
      macro: def.macro ?? null, dust: def.dust ?? null,
    });
    if (w) this.windMats.push(mat);

    try { this.engine.get('lighting')?.registerMaterial?.(mat); } catch { /* optional */ }
    this.map.set(name, mat);
    this.list.push(mat);
    return mat;
  }

  /** Depth material matching a wind material (for swaying shadows). */
  depthFor(name) {
    const key = `__depth_${name}`;
    const hit = this.map.get(key);
    if (hit) return hit;
    const src = this.get(name);
    const d = makeWindDepthMaterial(src);
    if (d) { this.map.set(key, d); this.list.push(d); }
    return d;
  }

  /** Advance wind time + weather-driven gust amplitude. Deterministic. */
  update(dt, elapsed) {
    this._gust += (this._gustTarget - this._gust) * Math.min(1, dt * 1.4);
    for (let i = 0; i < this.windMats.length; i++) {
      const u = this.windMats[i].userData.propUniforms;
      if (!u) continue;
      u.uPropWind.value.y = elapsed;
      u.uPropWind.value.z = this._gust;
    }
  }

  /** 'weather:set' handler — storms move the grass a lot more than clear air. */
  setWeather(kind, intensity = 1) {
    const base = {
      storm: 2.5, rain: 1.65, snow: 1.15, overcast: 1.15, fog: 0.55, mist: 0.5,
      clear: 0.72, ember: 0.8, ash: 0.9, none: 0.62,
    }[kind] ?? 1;
    const t = Math.max(0, Math.min(1, intensity));
    this._gustTarget = 0.45 + (base - 0.45) * (0.35 + 0.65 * t);
  }

  /** Wind bearing in world XZ. */
  setWindDir(x, z) {
    const l = Math.hypot(x, z) || 1;
    for (const m of this.windMats) {
      m.userData.propUniforms?.uPropWindDir.value.set(x / l, z / l);
    }
  }

  dispose() {
    for (const m of this.list) { try { m.dispose(); } catch { /* noop */ } }
    this.map.clear();
    this.list.length = 0;
    this.windMats.length = 0;
  }
}

/* ------------------------------------------------------------------ *
 * emissive materials (fire, contact shadow, motes)
 * ------------------------------------------------------------------ */

const FLAME_VERT = /* glsl */`
attribute float aH;
varying float vH;
varying float vFl;
uniform float uTime;
uniform float uAmp;
uniform float uSpeed;
#include <common>
void main() {
	vH = aH;
	vec3 transformed = position;
	#ifdef USE_INSTANCING
		vec3 io = vec3( instanceMatrix[ 3 ].x, instanceMatrix[ 3 ].y, instanceMatrix[ 3 ].z );
	#else
		vec3 io = vec3( 0.0 );
	#endif
	float ph = dot( io.xz, vec2( 0.317, 0.529 ) ) + io.y * 0.11;
	float t = uTime * uSpeed + ph * 6.2831853;
	float k = aH * aH;
	float lean = sin( t * 2.7 ) * 0.5 + sin( t * 4.3 + 1.7 ) * 0.32 + sin( t * 7.1 + 3.1 ) * 0.18;
	float lean2 = cos( t * 2.3 + 0.9 ) * 0.5 + cos( t * 5.1 + 2.2 ) * 0.3;
	transformed.x += lean * k * uAmp;
	transformed.z += lean2 * k * uAmp;
	float pinch = 1.0 + 0.26 * sin( t * 6.1 + aH * 7.0 );
	transformed.xz *= mix( 1.0, pinch, aH * 0.75 );
	transformed.y *= 1.0 + 0.2 * sin( t * 3.3 + 1.1 );
	vFl = 0.5 + 0.5 * sin( t * 5.7 + aH * 3.0 );
	vec4 mv = vec4( transformed, 1.0 );
	#ifdef USE_INSTANCING
		mv = instanceMatrix * mv;
	#endif
	mv = modelViewMatrix * mv;
	gl_Position = projectionMatrix * mv;
}
`;

const FLAME_FRAG = /* glsl */`
varying float vH;
varying float vFl;
uniform vec3 uCore;
uniform vec3 uMid;
uniform vec3 uTip;
uniform float uIntensity;
#include <common>
// NOTE: three r185's fragment prefix already injects <tonemapping_pars_fragment>
// for every material with toneMapped = true. Including it again here is a
// redefinition and the whole program fails to link (silently: additive fire and
// motes simply vanish). Do not re-add it.
void main() {
	vec3 c = mix( uCore, uMid, smoothstep( 0.0, 0.42, vH ) );
	c = mix( c, uTip, smoothstep( 0.38, 1.0, vH ) );
	float a = 1.0 - smoothstep( 0.5, 1.0, vH );
	a *= 0.78 + 0.34 * vFl;
	gl_FragColor = vec4( c * uIntensity * ( 0.78 + 0.44 * vFl ), a );
	#include <tonemapping_fragment>
	#include <colorspace_fragment>
}
`;

/**
 * Real 3D flame body (a teardrop of revolution, animated in the vertex shader).
 * Additive, above the bloom threshold at the core, black-clipping at the tip.
 */
export function makeFlameMaterial({
  core = [1.0, 0.86, 0.52], mid = [1.0, 0.44, 0.11], tip = [0.42, 0.075, 0.02],
  intensity = 3.4, amp = 0.03, speed = 1.0,
} = {}) {
  const m = new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uAmp: { value: amp },
      uSpeed: { value: speed },
      uIntensity: { value: intensity },
      uCore: { value: new THREE.Vector3(...core) },
      uMid: { value: new THREE.Vector3(...mid) },
      uTip: { value: new THREE.Vector3(...tip) },
    },
    vertexShader: FLAME_VERT,
    fragmentShader: FLAME_FRAG,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
  });
  m.userData.noCSM = true;
  m.userData.skyNoFog = true;
  m.name = 'props.flame';
  return m;
}

/**
 * Contact darkening under every prop. This is the difference between "props
 * placed in a world" and "props floating on a texture".
 */
export function makeContactMaterial() {
  const m = new THREE.ShaderMaterial({
    uniforms: { uStrength: { value: 0.62 } },
    vertexShader: /* glsl */`
			varying vec2 vUv;
			void main() {
				vUv = uv;
				vec4 mv = vec4( position, 1.0 );
				#ifdef USE_INSTANCING
					mv = instanceMatrix * mv;
				#endif
				gl_Position = projectionMatrix * modelViewMatrix * mv;
			}
		`,
    fragmentShader: /* glsl */`
			varying vec2 vUv;
			uniform float uStrength;
			void main() {
				float d = length( vUv - 0.5 ) * 2.0;
				float a = 1.0 - smoothstep( 0.15, 1.0, d );
				a = pow( a, 1.55 ) * uStrength;
				gl_FragColor = vec4( 0.0, 0.0, 0.0, a );
			}
		`,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: THREE.NormalBlending,
    polygonOffset: true,
    polygonOffsetFactor: -3,
    polygonOffsetUnits: -3,
  });
  m.userData.noCSM = true;
  m.userData.skyNoFog = true;
  m.userData.noGBuffer = true;
  m.name = 'props.contact';
  return m;
}

/**
 * Airborne motes — fireflies over the moor, embers over hell, dust in the
 * crypt. Drift is computed entirely in the vertex shader from uTime, so this
 * costs one draw call and no CPU.
 */
export function makeMoteMaterial({
  color = [1.0, 0.78, 0.3], size = 5.0, intensity = 2.4, speed = 1, rise = 0.0, spanY = 3.0,
} = {}) {
  const m = new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uSize: { value: size },
      uColor: { value: new THREE.Vector3(...color) },
      uIntensity: { value: intensity },
      uSpeed: { value: speed },
      uRise: { value: rise },
      uSpanY: { value: spanY },
      uPixelRatio: { value: 1 },
    },
    vertexShader: /* glsl */`
			attribute vec3 aSeed;
			varying float vTw;
			uniform float uTime;
			uniform float uSize;
			uniform float uSpeed;
			uniform float uRise;
			uniform float uSpanY;
			uniform float uPixelRatio;
			void main() {
				vec3 p = position;
				float t = uTime * uSpeed;
				p.x += sin( t * 0.55 + aSeed.x * 6.283 ) * 0.85 + sin( t * 1.31 + aSeed.y * 6.283 ) * 0.3;
				p.z += cos( t * 0.47 + aSeed.y * 6.283 ) * 0.85 + cos( t * 1.17 + aSeed.z * 6.283 ) * 0.3;
				if ( uRise > 0.0 ) {
					p.y += mod( t * uRise + aSeed.z * uSpanY, uSpanY );
				} else {
					p.y += sin( t * 0.71 + aSeed.z * 6.283 ) * 0.45;
				}
				vec4 mv = modelViewMatrix * vec4( p, 1.0 );
				gl_Position = projectionMatrix * mv;
				float fade = 1.0 - ( uRise > 0.0 ? mod( t * uRise + aSeed.z * uSpanY, uSpanY ) / uSpanY : 0.0 );
				// Near fade. A speck of dust 1 m from the lens covers twenty pixels and
				// then gets a 6 px circle of confusion from the closeup DOF profile on
				// top: the closeup frame filled with white bokeh discs, which is the
				// "obvious camera-facing billboard" instant fail. Dust belongs in the
				// mid and far field, so it fades out inside 2.6 m and its point size is
				// capped no matter how close the camera gets.
				fade *= smoothstep( 0.7, 2.6, -mv.z );
				vTw = ( 0.42 + 0.58 * pow( 0.5 + 0.5 * sin( t * 3.1 + aSeed.x * 19.0 ), 2.2 ) ) * fade;
				float ps = uSize * uPixelRatio * ( 8.0 / max( 1.0, -mv.z ) ) * ( 0.6 + 0.6 * vTw );
				gl_PointSize = min( ps, 4.5 * uPixelRatio );
			}
		`,
    fragmentShader: /* glsl */`
			varying float vTw;
			uniform vec3 uColor;
			uniform float uIntensity;
			#include <common>
			// three r185 injects <tonemapping_pars_fragment> into every fragment
			// prefix already; including it again fails the link. See makeFlameMaterial.
			void main() {
				vec2 d = gl_PointCoord - 0.5;
				float r = length( d ) * 2.0;
				float a = 1.0 - smoothstep( 0.25, 1.0, r );
				a *= a * vTw;
				gl_FragColor = vec4( uColor * uIntensity * a, a );
				#include <tonemapping_fragment>
				#include <colorspace_fragment>
			}
		`,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: THREE.AdditiveBlending,
  });
  m.userData.noCSM = true;
  m.userData.skyNoFog = true;
  m.name = 'props.motes';
  return m;
}

/**
 * Glowing ritual sigil on the floor.
 *
 * THE DEFECT THIS REPLACES: the network was built from `ring()` — a single
 * smoothstep on |r - c| — so every stroke was a constant-value line of constant
 * width on a geometrically perfect circle, and it was multiplied by
 * `uIntensity 2.2` and then again by its own alpha under additive blending.
 * Effective contribution peaked near 3.5 in the LINEAR HDR buffer, which is
 * every channel railed: the sigil resolved as PURE WHITE hard-edged line art at
 * ~0.98 luma, the brightest element in the boss arena, and it completely occluded
 * the floor it was supposedly carved into.
 *
 * Now every stroke is an engraved CHANNEL (dark down the middle, light at the
 * lips), eroded and chipped by procedural noise, scrolled by a flow field so the
 * network is never uniformly lit, and the final additive contribution is held
 * under a measured luminance + max-channel ceiling. The grade pass lifts midtones
 * roughly 3x, so ceilings have to be set in HDR units against the whole chain,
 * not picked by eye in the shader.
 */
export function makeRuneMaterial({ color = [0.42, 1.0, 0.55], intensity = 2.2 } = {}) {
  const m = new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uColor: { value: new THREE.Vector3(...color) },
      uIntensity: { value: intensity },
    },
    vertexShader: /* glsl */`
			varying vec2 vUv;
			void main() {
				vUv = uv;
				vec4 mv = vec4( position, 1.0 );
				#ifdef USE_INSTANCING
					mv = instanceMatrix * mv;
				#endif
				gl_Position = projectionMatrix * modelViewMatrix * mv;
			}
		`,
    fragmentShader: /* glsl */`
			varying vec2 vUv;
			uniform float uTime;
			uniform vec3 uColor;
			uniform float uIntensity;
			#include <common>
			// three r185 injects <tonemapping_pars_fragment> into every fragment
			// prefix already; including it again fails the link. See makeFlameMaterial.

			/* An engraved channel, not a line: a wide soft lip with its own middle
			   carved back out, so the stroke has a dark shadowed core and light
			   only at its edges. This single change is what stops the sigil
			   reading as a vector stroke laid over the floor. */
			float chan( float d, float w ) {
				float lip  = 1.0 - smoothstep( 0.0, w * 1.80, abs( d ) );
				float core = 1.0 - smoothstep( 0.0, w * 0.58, abs( d ) );
				return max( 0.0, lip - core * 0.88 );
			}
			/* Value noise. No textures — the sigil still costs 0 texture units —
			   and a pure function of uv, so the frame stays byte-deterministic. */
			float rHash( vec2 p ) {
				p = fract( p * vec2( 443.8975, 397.2973 ) );
				p += dot( p, p + 19.19 );
				return fract( ( p.x + p.y ) * p.x );
			}
			float rNoise( vec2 p ) {
				vec2 i = floor( p ), f = fract( p );
				f = f * f * ( 3.0 - 2.0 * f );
				return mix( mix( rHash( i ), rHash( i + vec2( 1.0, 0.0 ) ), f.x ),
				            mix( rHash( i + vec2( 0.0, 1.0 ) ), rHash( i + vec2( 1.0, 1.0 ) ), f.x ), f.y );
			}
			float rFbm( vec2 p ) {
				float a = 0.5, s = 0.0, n = 0.0;
				for ( int i = 0; i < 3; i++ ) { s += rNoise( p ) * a; n += a; p *= 2.03; a *= 0.5; }
				return s / n;
			}
			void main() {
				vec2 p = vUv * 2.0 - 1.0;
				float r = length( p );
				float a = atan( p.y, p.x );
				/* Wander the rings off a true circle by a percent or two — an
				   analytically perfect arc is half of the "debug gizmo" read. */
				float wob = 0.012 * sin( a * 3.0 + 1.7 ) + 0.007 * sin( a * 7.0 - 0.6 );
				float rw = r * ( 1.0 + wob );
				float glyph = 0.0;
				glyph += chan( rw - 0.94, 0.022 );
				glyph += chan( rw - 0.86, 0.013 );
				glyph += chan( rw - 0.52, 0.016 );
				// twelve radial ticks between the rings
				float tick = pow( abs( cos( a * 6.0 ) ), 34.0 );
				glyph += tick * ( 1.0 - smoothstep( 0.52, 0.86, r ) ) * ( 1.0 - smoothstep( 0.0, 0.5, abs( r - 0.69 ) ) ) * 1.1;
				// inner sigil: a rotated triangle wave
				float tri = 0.0;
				for ( int i = 0; i < 3; i++ ) {
					float th = float( i ) * 2.0944 + 0.4;
					float d = abs( p.x * cos( th ) + p.y * sin( th ) - 0.16 );
					tri = max( tri, chan( d, 0.018 ) );
				}
				glyph += tri * ( 1.0 - smoothstep( 0.34, 0.46, r ) );
				glyph *= 1.0 - smoothstep( 0.9, 1.0, r );

				/* Erosion, chipping and charge. The network is pitted, broken clean
				   through in places, and cold over whole arcs — which is what gives
				   the scrolling flow something to travel through. */
				float ero  = rFbm( p * 6.5 );
				float fine = rNoise( p * 23.0 );
				float chip = rNoise( p * 9.0 + 31.0 );
				float chg  = smoothstep( 0.34, 0.76, rFbm( p * 1.7 + 7.0 ) );
				float flow = rFbm( p * 2.4 + vec2( uTime * 0.16, -uTime * 0.11 ) );
				float wear = clamp( 0.24 + ero * 1.25 - fine * 0.24, 0.0, 1.0 );
				wear *= 1.0 - max( 0.0, 1.0 - abs( chip - 0.5 ) * 7.0 ) * 0.55;

				float pulse = 0.74 + 0.26 * sin( uTime * 1.35 + r * 5.0 );
				float g = clamp( glyph, 0.0, 1.0 ) * pulse
					* ( 0.28 + 0.80 * wear ) * ( 0.30 + 0.95 * chg ) * ( 0.46 + 0.62 * flow );

				/* Additive blending is ( SrcAlpha, One ), so what actually lands in
				   the linear HDR buffer is rgb * alpha. The colour is normalised to
				   unit LUMINANCE first, so 0.024 x uIntensity is a display
				   luminance target independent of the accent hue — at the default
				   2.2 intensity that is a 0.053 peak, which resolves near 150/255
				   through exposure -> ACES -> the grade's ~3x midtone lift.
				   The min() below is a SAFETY RAIL, not a limiter: set as a limiter
				   it flattened every pixel past it onto one value and put the flat
				   constant-brightness stroke straight back. */
				float A = clamp( g * 0.80, 0.0, 1.0 );
				if ( A < 0.004 ) discard;
				vec3 colN = uColor / max( dot( uColor, vec3( 0.2126, 0.7152, 0.0722 ) ), 1e-3 );
				vec3 add = colN * ( 0.024 * uIntensity ) * g * A;
				float lum = dot( add, vec3( 0.2126, 0.7152, 0.0722 ) );
				float mxc = max( add.r, max( add.g, add.b ) );
				add *= min( 1.0, min( 0.075 / max( lum, 1e-4 ), 0.135 / max( mxc, 1e-4 ) ) );
				gl_FragColor = vec4( add / A, A );
				#include <tonemapping_fragment>
				#include <colorspace_fragment>
			}
		`,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: THREE.AdditiveBlending,
    polygonOffset: true,
    polygonOffsetFactor: -4,
    polygonOffsetUnits: -4,
  });
  m.userData.noCSM = true;
  m.userData.skyNoFog = true;
  m.userData.noGBuffer = true;
  m.name = 'props.rune';
  return m;
}
