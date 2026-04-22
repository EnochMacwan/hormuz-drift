/* drift.js — Lagrangian particle tracker with Leeway + simple oil model
 * ---------------------------------------------------------------------
 * Physics:
 *   dx/dt = V_current + V_leeway(wind, object) + V_stokes(wind) + diffusion
 *   Integrator: second-order Runge-Kutta (midpoint) on ocean current +
 *               forward Euler on wind-driven terms (slowly varying).
 *   Diffusion: random walk, σ = √(2 K dt), default K = 10 m²/s.
 *
 * Leeway coefficients follow NOAA / Allen (2005) & Breivik+ (2011):
 *     V_leeway = dw · W · ŵ  +  cw · W · ŵ⊥       (in m/s)
 *   where W = wind speed (m/s), ŵ = wind unit vector,
 *   dw/cw are fractions (typical range 0.01 – 0.05).
 *
 * Oil spreading follows Fay (1971) gravity-viscous regime (t > 1 h):
 *     r(t) = 1.5 · (Δ g V² t^1.5 / ν_w^0.5)^(1/6)
 *   with evaporation fraction = 1 − exp(−t / τ_evap) (first-order).
 *
 * ⚠  This is an educational approximation — NOT a replacement for
 *    OpenOil / full OpenDrift. See README for scope & caveats.
 */

/* ─── NOAA Leeway categories (downwind + crosswind slope, % of wind) ─── */
/* Additional maintainer notes:
 * - This file is the browser model's physics core.
 * - Drifter handles motion/history for one particle.
 * - spawnEnsemble expands one release into a spread of particles.
 * - OilSlick is only a lightweight visual footprint helper.
 */
window.LEEWAY_CATEGORIES = [
  {id:'piw_ps',    label:'Person in water — survival suit',         dw:1.5, cw:0.0},
  {id:'piw_heavy', label:'Person in water — heavy clothing',        dw:1.2, cw:0.0},
  {id:'piw_light', label:'Person in water — light clothing',        dw:1.1, cw:0.0},
  {id:'piw_dec',   label:'Person in water — deceased (vertical)',   dw:1.0, cw:0.0},
  {id:'raft_4_6',  label:'Life raft 4–6 ppl, no ballast, no canopy',dw:3.6, cw:0.5},
  {id:'raft_4_6b', label:'Life raft 4–6 ppl, w/ ballast + canopy',  dw:2.8, cw:0.4},
  {id:'raft_15',   label:'Life raft 15 ppl, ballast + canopy',      dw:2.2, cw:0.3},
  {id:'raft_20',   label:'Life raft 20+ ppl, ballast + canopy',     dw:2.0, cw:0.3},
  {id:'sail_keel', label:'Sailboat, keeled, bare-poles',            dw:4.0, cw:0.6},
  {id:'sail_dism', label:'Sailboat, dismasted',                     dw:2.8, cw:0.3},
  {id:'skiff',     label:'Skiff / small open boat, bare',           dw:3.8, cw:0.6},
  {id:'fish_sm',   label:'Fishing vessel 7–20 m',                   dw:4.2, cw:0.8},
  {id:'fish_md',   label:'Fishing vessel 20–40 m',                  dw:3.6, cw:0.6},
  {id:'cont_40',   label:'Shipping container 40 ft (full)',         dw:2.8, cw:0.4},
  {id:'cont_20',   label:'Shipping container 20 ft (half-full)',    dw:3.2, cw:0.5},
  {id:'kayak',     label:'Sea kayak w/ person',                     dw:1.1, cw:0.1},
  {id:'surf',      label:'Surfboard w/ person',                     dw:1.3, cw:0.1},
  {id:'swamp',     label:'Swamped boat',                            dw:1.4, cw:0.2},
  {id:'debris',    label:'Generic floating debris',                 dw:2.0, cw:0.3},
];

/* ─── oil presets (density kg/m³, kinematic visc m²/s, evap halflife h) */
/* These are the lightweight oil presets used by the drift layer. The richer
   oil catalog that powers the budget chart lives in weathering.js. */
window.OIL_TYPES = {
  light_crude:  {label:'Light crude (API 40)',          rho:820,  nu:5e-6,   tau_h:12},
  medium_crude: {label:'Medium crude (API 25)',         rho:910,  nu:1e-4,   tau_h:36},
  heavy_fuel:   {label:'Heavy fuel oil (API 15)',       rho:980,  nu:1e-3,   tau_h:200},
  diesel:       {label:'Diesel / #2 marine gas oil',    rho:840,  nu:3e-6,   tau_h:24},
  condensate:   {label:'Condensate (very light)',       rho:780,  nu:2e-6,   tau_h:6},
};

/* ─── utilities ─────────────────────────────────────────────────────── */
const EARTH_R = 6371000;       // m
const DEG     = Math.PI / 180;

// Gaussian random via Box–Muller
// Gaussian random via Box-Muller so diffusion perturbations are symmetric.
function randn(){
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
function mPerDegLat(lat){ return 111132.92 - 559.82*Math.cos(2*lat*DEG); }
function mPerDegLon(lat){ return 111412.84*Math.cos(lat*DEG)
                              - 93.5*Math.cos(3*lat*DEG); }

/* ─── Drifter ───────────────────────────────────────────────────────── */
/* One Lagrangian particle. Each instance stores its own track so the UI can
   replay the run later without rerunning the model. */
class Drifter {
  constructor(lon, lat, tSec, opts){
    this.lon0 = lon; this.lat0 = lat; this.t0 = tSec;
    this.lon  = lon; this.lat  = lat; this.t  = tSec;
    this.alive = true; this.stranded = false;
    this.age = 0;                      // seconds since release
    this.mass_frac = 1.0;              // remaining oil fraction (for oil mode)
    this.leeway_dw = opts.leeway_dw || 0;   // fractions (0.03 = 3%)
    this.leeway_cw = opts.leeway_cw || 0;
    this.K         = opts.K        ?? 10;   // eddy diffusivity m²/s
    this.stokes    = opts.stokes   ?? true;
    this.useWind   = opts.useWind  ?? true;
    this.track     = [[lon, lat, tSec]];    // [lon,lat,t]
    // inter-particle variability: randomise leeway coefficients ±15 %
    // Add small inter-particle variability so ensembles spread naturally.
    const jitter = 1 + 0.15 * randn();
    this.leeway_dw *= Math.max(0.5, jitter);
    this.leeway_cw *= Math.max(0.5, jitter);
  }

  /* total velocity in m/s at a given location & time */
  /* Combine current, optional leeway, and optional Stokes drift into one
     instantaneous velocity vector in metres per second. */
  _vel(lon, lat, t){
    const cur = Field.sampleCurrent(lon, lat, t);
    if (!cur) return null;
    const wind = this.useWind ? Field.sampleWind(lon, lat, t) : null;
    let u = cur.u, v = cur.v;
    if (wind){
      const W = Math.hypot(wind.u, wind.v);
      if (W > 0){
        const wx = wind.u / W, wy = wind.v / W;
        // leeway: downwind along wind + crosswind perpendicular (right)
        // Leeway = downwind plus a right-hand crosswind component.
        u += this.leeway_dw * W * wx  +  this.leeway_cw * W * (-wy);
        v += this.leeway_dw * W * wy  +  this.leeway_cw * W * ( wx);
        // Stokes drift ≈ 1.6 % wind (Kenyon)
        // Tiny wind-following Stokes surrogate for extra realism.
        if (this.stokes){ u += 0.016 * wind.u; v += 0.016 * wind.v; }
      }
    }
    return {u, v};
  }

  step(dt){
    if (!this.alive) return;

    /* RK2 midpoint on ocean+wind velocity */
    /* RK2 midpoint is more stable than a simple Euler step in a spatially
       varying current field. */
    const k1 = this._vel(this.lon, this.lat, this.t);
    if (!k1){ this._strand(); return; }
    const dLatMid = (k1.v * dt/2) / mPerDegLat(this.lat);
    const dLonMid = (k1.u * dt/2) / mPerDegLon(this.lat);
    const k2 = this._vel(this.lon + dLonMid, this.lat + dLatMid, this.t + dt/2);
    if (!k2){ this._strand(); return; }

    let dLat = (k2.v * dt) / mPerDegLat(this.lat);
    let dLon = (k2.u * dt) / mPerDegLon(this.lat);

    /* random-walk diffusion, σ = √(2 K dt) metres */
    /* Add unresolved small-scale turbulence as a random walk. */
    const sigma = Math.sqrt(2 * this.K * dt);
    dLat += randn() * sigma / mPerDegLat(this.lat);
    dLon += randn() * sigma / mPerDegLon(this.lat);

    this.lon += dLon;  this.lat += dLat;  this.t += dt;  this.age += dt;

    /* oil evaporation (mass_frac only; spatial oil spreading is computed
       for the slick centroid in OilModel, not per-particle) */
    /* Track remaining oil fraction per particle only. Bulk oil geometry is
       handled elsewhere by the slick/budget helpers. */
    if (this.tau_evap){
      this.mass_frac = Math.exp(-this.age / this.tau_evap);
    }

    /* record trajectory (throttle storage every ~10 min wall-model time) */
    /* Decimate stored track points so playback and exports stay lightweight. */
    if (this.track.length === 1 ||
        this.t - this.track[this.track.length-1][2] >= 600){
      this.track.push([this.lon, this.lat, this.t]);
    }
    if (Field.isLand(this.lon, this.lat)) this._strand();
  }

  _strand(){ this.alive = false; this.stranded = true;
             this.track.push([this.lon, this.lat, this.t]); }
}
window.Drifter = Drifter;

/* ─── Oil spreading (slick-scale, Fay gravity-viscous regime) ───────── */
/* Slick-scale helper used by the UI to draw an expanding visual footprint. */
class OilSlick {
  constructor(volume_m3, oilType){
    this.V0 = volume_m3;
    this.oil = OIL_TYPES[oilType] || OIL_TYPES.medium_crude;
    this.rho_w = 1025; this.nu_w = 1.05e-6;     // seawater
    this.g = 9.81;
    this.delta = Math.max(0.01, (this.rho_w - this.oil.rho) / this.rho_w);
  }
  radius(t_sec){
    if (t_sec <= 0) return 0;
    // Fay 3-regime clamped: short-term gravity-inertial, then gravity-viscous
    // Blend early/late Fay-style spreading estimates into one simple radius.
    const V = this.V0;
    const r_gi = 1.14 * Math.pow(this.delta * this.g * V * t_sec*t_sec, 0.25);
    const r_gv = 1.5  * Math.pow(
        (this.delta * this.g * V*V * Math.pow(t_sec, 1.5)) / Math.sqrt(this.nu_w),
        1/6);
    return Math.min(r_gi, r_gv);
  }
  /* evaporation fraction remaining after t_sec */
  massFrac(t_sec){ return Math.exp(-t_sec / (this.oil.tau_h * 3600)); }
}
window.OilSlick = OilSlick;

/* ─── Ensemble launcher ─────────────────────────────────────────────── */
/* Convert one release definition into an ensemble of jittered particles. */
function spawnEnsemble({lon, lat, tSec, n, scenario, params}){
  const out = [];
  const radius_m = params.release_radius_m || 50;
  const latM = mPerDegLat(lat), lonM = mPerDegLon(lat);

  let dw = 0, cw = 0, tau_evap = null;
  if (scenario === 'leeway'){
    const cat = LEEWAY_CATEGORIES.find(c => c.id === params.category)
                || LEEWAY_CATEGORIES[0];
    dw = cat.dw / 100; cw = cat.cw / 100;
  } else if (scenario === 'oil'){
    const oil = OIL_TYPES[params.oil_type] || OIL_TYPES.medium_crude;
    dw = 0.03; cw = 0.0;               // oil slicks drift ~3 % wind
    tau_evap = oil.tau_h * 3600;
  }

  for (let k = 0; k < n; k++){
    // jitter initial release
    const dL = randn() * radius_m / latM;
    const dO = randn() * radius_m / lonM;
    const d = new Drifter(lon + dO, lat + dL, tSec, {
      leeway_dw: dw, leeway_cw: cw,
      K: params.diffusion_K ?? 10,
      useWind: params.useWind ?? true,
    });
    if (tau_evap) d.tau_evap = tau_evap;
    d.scenario = scenario;
    out.push(d);
  }
  return out;
}
window.spawnEnsemble = spawnEnsemble;
