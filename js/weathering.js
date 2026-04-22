/* weathering.js — WebGNOME-equivalent oil weathering model
 * =========================================================
 * Implements:
 *   1. Multi-component evaporation  (Fingas 1996 log-linear model)
 *   2. Emulsification               (Mackay et al. 1980)
 *   3. Natural dispersion           (Delvigne & Sweeney 1988, simplified)
 *   4. Response options             (skimming · in-situ burning · chemical dispersant)
 *   5. OilBudget mass-balance tracker with history for stacked area chart
 *   6. Extended ADIOS-style oil catalog — 12 Hormuz-relevant types
 *
 * ⚠ Educational / research approximation. Parameters from published empirical
 *   studies; not calibrated to specific spill events. See README caveats.
 */

/* ─────────────────────────────────────────────────────────────────────────
 * ADIOS-style oil catalog
 *
 * Fingas evaporation model:
 *   F(t_h) = C1 × ln(t_h × 60)    (% evaporated, clamped to [0, f_max])
 *   Source: Fingas, M. (1998). Studies on crude oil and petroleum product
 *           evaporation. J. Hazardous Materials 57:41–53.
 *
 * Emulsification (Mackay et al. 1980):
 *   dW/dt = K_e × U10² × (1 − W/W_max)
 *   W_max = max stable water-in-oil fraction (0 = no emulsion, 0.8 = mousse)
 *
 * Natural dispersion coefficient (Delvigne & Sweeney 1988):
 *   D_nd = C_nd  (fraction of surface oil dispersed per unit time per unit wind)
 *
 * All per-oil data are literature medians ± ~20 %; treat as order-of-magnitude.
 * ───────────────────────────────────────────────────────────────────────── */
window.ADIOS_OILS = {

  arabian_light: {
    label:       'Arabian Light (API 33)',
    adiosId:     'AD00340',
    api:         33,
    rho:         860,           // kg/m³ at 15 °C
    nu15:        8e-6,          // kinematic visc m²/s at 15 °C
    nu25:        4e-6,
    pour_pt_C:   -12,
    // Fingas evaporation
    C1:          5.6,           // % evaporated = C1 × ln(t_min)
    f_max:       30,            // max % evaporable (in 72 h)
    // SARA fractions
    saturates:   0.62, aromatics: 0.25, resins: 0.09, asphaltenes: 0.04,
    // Emulsification
    K_e:         1.5e-6,        // (m/s)⁻² s⁻¹  (Mackay K parameter)
    W_max:       0.65,
    // Dispersion
    C_nd:        0.024,         // fraction surface oil dispersed per breaking-wave event
    // Oil budget display colour
    color:       '#f4a340',
  },

  arabian_medium: {
    label:       'Arabian Medium (API 29)',
    adiosId:     'AD00341',
    api:         29,
    rho:         879,
    nu15:        1.5e-4,
    nu25:        5e-5,
    pour_pt_C:   -6,
    C1:          4.2,
    f_max:       22,
    saturates:   0.55, aromatics: 0.28, resins: 0.11, asphaltenes: 0.06,
    K_e:         1.8e-6,
    W_max:       0.70,
    C_nd:        0.018,
    color:       '#d97c2e',
  },

  arabian_heavy: {
    label:       'Arabian Heavy (API 27)',
    adiosId:     'AD00342',
    api:         27,
    rho:         893,
    nu15:        6e-4,
    nu25:        2e-4,
    pour_pt_C:    0,
    C1:          3.0,
    f_max:       14,
    saturates:   0.48, aromatics: 0.30, resins: 0.14, asphaltenes: 0.08,
    K_e:         2.0e-6,
    W_max:       0.75,
    C_nd:        0.012,
    color:       '#a05020',
  },

  iranian_heavy: {
    label:       'Iranian Heavy (API 30)',
    adiosId:     'AD00400',
    api:         30,
    rho:         876,
    nu15:        2e-4,
    nu25:        7e-5,
    pour_pt_C:   -3,
    C1:          4.5,
    f_max:       20,
    saturates:   0.53, aromatics: 0.27, resins: 0.12, asphaltenes: 0.08,
    K_e:         1.9e-6,
    W_max:       0.72,
    C_nd:        0.016,
    color:       '#c06030',
  },

  kuwait_export: {
    label:       'Kuwait Export (API 31)',
    adiosId:     'AD00450',
    api:         31,
    rho:         871,
    nu15:        1.2e-4,
    nu25:        4e-5,
    pour_pt_C:   -9,
    C1:          4.8,
    f_max:       25,
    saturates:   0.58, aromatics: 0.26, resins: 0.10, asphaltenes: 0.06,
    K_e:         1.6e-6,
    W_max:       0.68,
    C_nd:        0.020,
    color:       '#e08820',
  },

  murban_abudhabi: {
    label:       'Murban — Abu Dhabi (API 38)',
    adiosId:     'AD00500',
    api:         38,
    rho:         833,
    nu15:        3e-6,
    nu25:        2e-6,
    pour_pt_C:   -30,
    C1:          6.8,
    f_max:       38,
    saturates:   0.70, aromatics: 0.22, resins: 0.06, asphaltenes: 0.02,
    K_e:         1.0e-6,
    W_max:       0.55,
    C_nd:        0.030,
    color:       '#f5c840',
  },

  basrah_light: {
    label:       'Basrah Light — Iraq (API 34)',
    adiosId:     'AD00350',
    api:         34,
    rho:         855,
    nu15:        6e-6,
    nu25:        3e-6,
    pour_pt_C:   -18,
    C1:          5.8,
    f_max:       32,
    saturates:   0.64, aromatics: 0.24, resins: 0.08, asphaltenes: 0.04,
    K_e:         1.4e-6,
    W_max:       0.62,
    C_nd:        0.026,
    color:       '#f0b030',
  },

  condensate: {
    label:       'Qatar Condensate (API 65)',
    adiosId:     'AD00600',
    api:         65,
    rho:         738,
    nu15:        1e-6,
    nu25:        0.8e-6,
    pour_pt_C:   -50,
    C1:          18,
    f_max:       92,
    saturates:   0.85, aromatics: 0.13, resins: 0.02, asphaltenes: 0.00,
    K_e:         0.1e-6,
    W_max:       0.10,
    C_nd:        0.055,
    color:       '#fff176',
  },

  diesel_mgo: {
    label:       'Marine Gas Oil (MGO)',
    adiosId:     'AD00020',
    api:         38,
    rho:         833,
    nu15:        4e-6,
    nu25:        2.5e-6,
    pour_pt_C:   -15,
    C1:          11,
    f_max:       78,
    saturates:   0.78, aromatics: 0.18, resins: 0.04, asphaltenes: 0.00,
    K_e:         0.5e-6,
    W_max:       0.25,
    C_nd:        0.040,
    color:       '#ffe082',
  },

  ifo180: {
    label:       'IFO-180 Fuel Oil',
    adiosId:     'AD00700',
    api:         15,
    rho:         975,
    nu15:        1.8e-2,
    nu25:        4e-3,
    pour_pt_C:    20,
    C1:          1.8,
    f_max:       5,
    saturates:   0.35, aromatics: 0.38, resins: 0.18, asphaltenes: 0.09,
    K_e:         3.0e-6,
    W_max:       0.80,
    C_nd:        0.006,
    color:       '#795548',
  },

  hfo380: {
    label:       'Heavy Fuel Oil (HFO-380)',
    adiosId:     'AD00750',
    api:         12,
    rho:         990,
    nu15:        3.8e-2,
    nu25:        8e-3,
    pour_pt_C:    30,
    C1:          0.8,
    f_max:       2,
    saturates:   0.28, aromatics: 0.40, resins: 0.20, asphaltenes: 0.12,
    K_e:         3.5e-6,
    W_max:       0.82,
    C_nd:        0.003,
    color:       '#4e342e',
  },

  jet_fuel: {
    label:       'Jet Fuel / Kerosene',
    adiosId:     'AD00080',
    api:         44,
    rho:         800,
    nu15:        2e-6,
    nu25:        1.5e-6,
    pour_pt_C:   -47,
    C1:          14,
    f_max:       95,
    saturates:   0.82, aromatics: 0.17, resins: 0.01, asphaltenes: 0.00,
    K_e:         0.2e-6,
    W_max:       0.15,
    C_nd:        0.060,
    color:       '#fff59d',
  },
};

/* Also keep the old OIL_TYPES as a compatibility shim (used by old presets) */
window.OIL_TYPES = {
  light_crude:  window.ADIOS_OILS.arabian_light,
  medium_crude: window.ADIOS_OILS.arabian_medium,
  heavy_fuel:   window.ADIOS_OILS.hfo380,
  diesel:       window.ADIOS_OILS.diesel_mgo,
  condensate:   window.ADIOS_OILS.condensate,
};

/* ─────────────────────────────────────────────────────────────────────────
 * OilBudget — mass-balance tracker
 * ─────────────────────────────────────────────────────────────────────────
 *
 * Usage:
 *   const budget = new OilBudget(volume_m3, 'arabian_medium', responses);
 *   // called every snapshot step (hourly recommended):
 *   budget.step(dt_h, beachedFrac, windSpeed_ms, waveHeight_m);
 *   // read history as array of snapshots for Plotly
 *   budget.history → [{ t_h, surface%, evap%, disp%, beach%, skim%, burn%, water_pct }]
 * ───────────────────────────────────────────────────────────────────────── */
class OilBudget {
  /**
   * @param {number}  volume_m3   Initial spill volume in cubic metres
   * @param {string}  oilKey      Key in ADIOS_OILS table
   * @param {object}  responses   { skimming, burning, dispersant } — see below
   *
   * responses.skimming  = { active, startH, endH, rateM3h, efficiency_pct }
   * responses.burning   = { active, startH, endH, efficiency_pct }
   * responses.dispersant= { active, startH, endH, effectiveness_pct }
   */
  constructor(volume_m3, oilKey, responses = {}) {
    this.V0  = volume_m3;
    this.oil = ADIOS_OILS[oilKey] || ADIOS_OILS.arabian_medium;
    this.resp = responses;

    /* State (all in m³ of original oil, NOT including water uptake) */
    this.t_h       = 0;
    this.evap      = 0;     // evaporated
    this.disp      = 0;     // naturally dispersed
    this.beachVol  = 0;     // beached / stranded
    this.skimVol   = 0;     // mechanically recovered
    this.burnVol   = 0;     // burned
    this.chemDisp  = 0;     // chemically dispersed
    this.W         = 0;     // emulsion water fraction (0–W_max)

    /* Surface = everything not yet accounted for */
    this.surface   = volume_m3;

    /* Fay slick state — needed for burn-rate calculation */
    this.rho_w = 1025; this.nu_w = 1.05e-6; this.g = 9.81;
    this.delta = Math.max(0.02, (this.rho_w - this.oil.rho) / this.rho_w);

    /* Snapshot history for plotting */
    this.history   = [];
    this._snap();
  }

  /* ── Fay slick radius at current surface volume ─────────────────────── */
  _slickRadius(vol_m3 = this.surface) {
    if (vol_m3 <= 0) return 0;
    const t = Math.max(1, this.t_h * 3600);
    const r_gv = 1.5 * Math.pow(
      (this.delta * this.g * vol_m3 * vol_m3 * Math.pow(t, 1.5)) /
      Math.sqrt(this.nu_w), 1 / 6);
    return r_gv;       // metres
  }

  _slickArea(vol_m3 = this.surface) {
    return Math.PI * Math.pow(this._slickRadius(vol_m3), 2);  // m²
  }

  /* ── One timestep ───────────────────────────────────────────────────── */
  /**
   * @param {number} dt_h           Time step in hours
   * @param {number} beachedFrac    Fraction of ensemble stranded (0–1)
   * @param {number} windSpeed_ms   Wind speed at 10 m (m/s)
   * @param {number} waveHeight_m   Significant wave height (m), defaults to Hs(U10)
   */
  step(dt_h, beachedFrac = 0, windSpeed_ms = 5, waveHeight_m = null) {
    const t_new = this.t_h + dt_h;
    const U = Math.max(0, windSpeed_ms);

    /* Auto-estimate Hs from Beaufort if not provided */
    const Hs = waveHeight_m != null ? waveHeight_m : 0.0248 * U * U;

    const surf = this.surface;
    if (surf <= 0) { this.t_h = t_new; this._snap(); return; }

    /* 1. Evaporation — Fingas log model (% of original volume) ----------- */
    const tMin0 = Math.max(1, this.t_h  * 60);
    const tMin1 = Math.max(1, t_new * 60);
    const F0 = Math.min(this.oil.f_max, this.oil.C1 * Math.log(tMin0));
    const F1 = Math.min(this.oil.f_max, this.oil.C1 * Math.log(tMin1));
    const dEvap = Math.max(0, (F1 - F0) / 100) * this.V0;
    const actualEvap = Math.min(surf * 0.9, dEvap);  // can't evaporate beached oil

    /* 2. Emulsification — Mackay (updates W fraction) -------------------- */
    const dW = this.oil.K_e * U * U * (this.oil.W_max - this.W) * dt_h * 3600;
    this.W = Math.min(this.oil.W_max, this.W + dW);

    /* 3. Natural dispersion — Delvigne-Sweeney simplified ---------------- */
    //    D = 0.11 × (U + 0.01)² × Qd   [fraction of oil dispersed per h]
    //    Qd ∝ fraction of surface covered by breaking waves
    const Qd  = Math.min(1, 0.032 * Hs);            // wave-breaking coverage
    const D_rate = 0.11 * Math.pow(U + 0.01, 2) * Qd * this.oil.C_nd;
    const dDisp = Math.min(surf - actualEvap, D_rate * surf * (1 - this.W) * dt_h);

    /* 4. Beaching --------------------------------------------------------- */
    const targetBeach = Math.max(0, beachedFrac * this.V0 - this.beachVol);
    const dBeach = Math.min(surf - actualEvap - dDisp, targetBeach);

    /* 5. Response options ------------------------------------------------- */
    let dSkim = 0;
    let dBurn = 0;
    let dChemDisp = 0;

    const t0 = this.t_h;

    /* Mechanical skimming */
    const sk = this.resp.skimming;
    if (sk?.active && t0 >= sk.startH && t0 < sk.endH) {
      const available = surf - actualEvap - dDisp - dBeach;
      /* Skimming is less effective on high-viscosity emulsions */
      const viscPenalty = 1 - 0.6 * this.W;
      const rate = sk.rateM3h * (sk.efficiency_pct / 100) * viscPenalty;
      dSkim = Math.min(available * 0.35, rate * dt_h);
    }

    /* In-situ burning */
    const bu = this.resp.burning;
    if (bu?.active && t0 >= bu.startH && t0 < bu.endH) {
      /* Burn rate ≈ 3.5 mm/min × slick area × efficiency */
      const burnRateM3h = 3.5e-3 * 60 * this._slickArea() * (bu.efficiency_pct / 100);
      const available    = surf - actualEvap - dDisp - dBeach - dSkim;
      dBurn = Math.min(available * 0.25, burnRateM3h * dt_h);
      /* Burning is less effective when W > 0.25 (emulsified mousse) */
      if (this.W > 0.25) dBurn *= Math.max(0, 1 - (this.W - 0.25) / 0.55);
    }

    /* Chemical dispersant */
    const cd = this.resp.dispersant;
    if (cd?.active && t0 >= cd.startH && t0 < cd.endH) {
      /* Multiplies natural dispersion rate */
      const mult = cd.effectiveness_pct / 100;
      const extra = Math.min(0.15, D_rate * mult) * surf * dt_h;
      const available = surf - actualEvap - dDisp - dBeach - dSkim - dBurn;
      dChemDisp = Math.min(available * 0.20, extra);
      /* Chemically dispersed oil is counted separately */
    }

    /* 6. Update accumulators --------------------------------------------- */
    this.evap     += actualEvap;
    this.disp     += dDisp + dChemDisp;
    this.beachVol += dBeach;
    this.skimVol  += dSkim;
    this.burnVol  += dBurn;
    this.chemDisp += dChemDisp;
    this.surface   = Math.max(0,
      this.V0 - this.evap - this.disp - this.beachVol - this.skimVol - this.burnVol);

    this.t_h = t_new;
    this._snap();
  }

  /* -- Build full history in one pass (post-simulation) ------------------- */
  /**
   * Run the full budget simulation from t=0 to maxH in hourly steps,
   * driven by a stranding time-series from the particle ensemble.
   *
   * @param {number}      maxH          Duration in hours
   * @param {number[]}    beachSeries   Beached fraction at each integer hour
   * @param {number}      windSpeed_ms  Mean wind speed
   * @param {number}      waveHeight_m  Significant wave height (optional)
   */
  static runFull(volume_m3, oilKey, responses, maxH, beachSeries, windSpeed_ms = 5, waveHeight_m = null) {
    const budget = new OilBudget(volume_m3, oilKey, responses);
    const dt = 0.5;   // 30-min timestep for smoother curves
    const steps = Math.ceil(maxH / dt);
    for (let i = 0; i < steps; i++) {
      const t_h = Math.min(budget.t_h, maxH);
      const idx = Math.min(Math.floor(t_h), beachSeries.length - 1);
      budget.step(dt, beachSeries[idx] || 0, windSpeed_ms, waveHeight_m);
      if (budget.t_h >= maxH) break;
    }
    return budget;
  }

  /* -- Summary at current state ------------------------------------------ */
  summary() {
    return {
      surface_pct:    this._pct(this.surface),
      evap_pct:       this._pct(this.evap),
      disp_pct:       this._pct(this.disp),
      beach_pct:      this._pct(this.beachVol),
      skim_pct:       this._pct(this.skimVol),
      burn_pct:       this._pct(this.burnVol),
      water_pct:      this.W * 100,
      volume_m3:      { surface: this.surface, evap: this.evap, disp: this.disp,
                        beach: this.beachVol, skim: this.skimVol, burn: this.burnVol },
    };
  }

  _pct(v) { return this.V0 > 0 ? Math.min(100, (v / this.V0) * 100) : 0; }

  _snap() {
    const s = this.summary();
    this.history.push({
      t_h:       this.t_h,
      surface:   s.surface_pct,
      evap:      s.evap_pct,
      disp:      s.disp_pct,
      beach:     s.beach_pct,
      skim:      s.skim_pct,
      burn:      s.burn_pct,
      water_pct: s.water_pct,
    });
  }
}
window.OilBudget = OilBudget;
