/* app.js - UI, map, animation, analytics, and orchestration
 * ---------------------------------------------------------------------
 * Depends on: field.js, drift.js, Leaflet, Plotly
 *
 * This is the "glue layer" for the entire browser application. It does not
 * own the physical forcing data (field.js) or the particle equations
 * themselves (drift.js / weathering.js). Instead it coordinates everything:
 *
 * 1. Boot the map and cache DOM references.
 * 2. Draw the current field and animated background tracers.
 * 3. Launch ensemble runs and capture snapshots/metrics.
 * 4. Reconstruct any playback frame from the stored tracks.
 * 5. Update the UI, charts, exports, and scenario controls.
 *
 * When you want to understand "what happens when I press Run?" or "what is
 * redrawn every animation frame?", this is the file to read.
 */

/* Preset bundles map user-friendly scenario buttons to concrete model inputs.
   They are intentionally opinionated starting points, not exhaustive physics
   definitions. */
const SCENARIO_PRESETS = {
  leeway: [
    { id: "sar_fast", label: "S&R fast response", category: "piw_light", relRadius: 80, diffK: 8, durHours: 24, nEns: 300, useWind: true },
    { id: "sar_uncertain", label: "Wide uncertainty search", category: "raft_4_6", relRadius: 250, diffK: 18, durHours: 36, nEns: 500, useWind: true },
    { id: "sar_long", label: "Long horizon drifting object", category: "debris", relRadius: 180, diffK: 14, durHours: 72, nEns: 600, useWind: true },
  ],
  oil: [
    { id: "oil_diesel", label: "Diesel leak", oilType: "diesel", oilVol: 10, relRadius: 120, diffK: 10, durHours: 24, nEns: 320, useWind: true },
    { id: "oil_light", label: "Light crude release", oilType: "light_crude", oilVol: 150, relRadius: 220, diffK: 14, durHours: 48, nEns: 420, useWind: true },
    { id: "oil_heavy", label: "Heavy fuel shoreline risk", oilType: "heavy_fuel", oilVol: 800, relRadius: 260, diffK: 18, durHours: 72, nEns: 520, useWind: true },
  ],
};

/* Global runtime state for playback, current run output, and UI toggles.
   This file intentionally uses a small shared-state model instead of a full
   framework so the browser app stays portable and dependency-light. */
let tIdx = 0;
let playing = true;
let playSpeed = 1.5;
let nParticles = 2000;
let fieldLayer = null;
let releasePoint = null;
let activeScenario = "leeway";
let activeRun = null;
let oilSlickModel = null;
let oilBudgetModel = null;
let runTimer = null;
let focusMode = false;
let frameCache = null;
let lastResultsKey = null;
let lastPlotMarkerKey = null;
let bgParticles = [];

const overlayState = {
  currents: true,
  tracers: true,
  trails: true,
  density: true,
  uncertainty: true,
  release: true,
  oilRadius: true,
};
const els = {};

/* Leaflet owns the geographic view and projection math. Canvas overlays are
   layered above it for field rendering, tracers, and drift results. */
const map = L.map("map", { zoomControl: false, preferCanvas: true, attributionControl: false }).setView([26.45, 56.1], 9);
L.tileLayer("https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png", {
  subdomains: "abcd",
  maxZoom: 13,
  attribution: "OpenStreetMap | CARTO | Currents: CMEMS",
}).addTo(map);

/* Three stacked canvases:
   - field: colorized current vectors
   - part: ambient background tracers that make the field feel alive
   - drift: actual scenario output (particles, trails, density, uncertainty)
*/
const DualCanvasLayer = L.Layer.extend({
  onAdd(m) {
    this._map = m;
    const pane = m.getPanes().overlayPane;
    this._field = L.DomUtil.create("canvas", "overlay", pane);
    this._part = L.DomUtil.create("canvas", "overlay", pane);
    this._drift = L.DomUtil.create("canvas", "overlay", pane);
    m.on("moveend zoomend resize", this._reset, this);
    this._reset();
  },
  _reset() {
    const size = this._map.getSize();
    const topLeft = this._map.containerPointToLayerPoint([0, 0]);
    for (const canvas of [this._field, this._part, this._drift]) {
      canvas.width = size.x;
      canvas.height = size.y;
      L.DomUtil.setPosition(canvas, topLeft);
    }
    if (fieldLayer) {
      drawField();
    }
    this._part.getContext("2d").clearRect(0, 0, size.x, size.y);
    this._drift.getContext("2d").clearRect(0, 0, size.x, size.y);
  },
  fieldCtx() { return this._field.getContext("2d"); },
  partCtx() { return this._part.getContext("2d"); },
  driftCtx() { return this._drift.getContext("2d"); },
  size() { return this._map.getSize(); },
});

/* Timeline helper functions convert between Leaflet/UI-friendly slider indices
   and the absolute second-based timestamps used by the simulation. */
function maxDataSec() {
  return Field.t0Unix + (Field.times.length - 1) * Field.dtSec;
}

function tIdxToSec(ti) {
  return Field.t0Unix + ti * Field.dtSec;
}

function secToTIdx(sec) {
  return (sec - Field.t0Unix) / Field.dtSec;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function fmt(value, digits) {
  return Number.isFinite(value) ? value.toFixed(digits) : "-";
}

function formatPercent(value) {
  return Number.isFinite(value) ? `${value.toFixed(0)}%` : "-";
}

function formatRunOffset(hours) {
  return `${hours >= 0 ? "+" : "-"}${Math.abs(hours).toFixed(1)} h`;
}

function directionHue(screenX, screenY) {
  const angle = Math.atan2(screenY, screenX);
  return ((angle + Math.PI) / (2 * Math.PI)) * 360;
}

function getScenarioLabel(scenario) {
  return scenario === "oil" ? "Oil spill" : "Man overboard";
}

function selectedPreset() {
  return SCENARIO_PRESETS[activeScenario].find((preset) => preset.id === els.scenarioPreset.value) || null;
}

function resetFrameCache() {
  frameCache = null;
  lastResultsKey = null;
  lastPlotMarkerKey = null;
}

function updateBodyState() {
  document.body.classList.toggle("focus-mode", focusMode);
}

function setStatus(message) {
  els.runStatus.textContent = message || "";
}

function setRunProgress(percent, label, detail) {
  if (!els.runProgress) {
    return;
  }
  els.runProgress.hidden = false;
  els.progressFill.style.width = `${clamp(percent, 0, 100)}%`;
  els.progressLabel.textContent = label;
  els.progressDetail.textContent = detail || "";
}

function hideRunProgress() {
  if (els.runProgress) {
    els.runProgress.hidden = true;
    els.progressFill.style.width = "0%";
  }
}

/* Fail loudly in the UI when data cannot be loaded so users are not forced to
   diagnose the issue from console output alone. */
function showStartupError(message) {
  setStatus(message);
  els.timeLabel.textContent = "server required";
  els.dataMeta.textContent = "Open this app through http://localhost:8000, not file://";
  els.releaseInfo.textContent = "Startup failed. Use start_local_server.bat or python -m http.server 8000.";
  els.results.innerHTML = '<div class="result-card wide"><span class="result-label">Startup</span><span class="result-value">Data unavailable</span><span class="result-subvalue">This page was opened without a local web server.</span></div>';
  els.runBtn.disabled = true;
  if (els.quickRunRailBtn) els.quickRunRailBtn.disabled = true;
  els.useWind.disabled = true;
  Plotly.purge(els.tsPlot);
}

/* Background particles are purely visual. They make the current field feel
   alive before a scenario is run and while playback is paused. */
function randomBgParticle() {
  const grid = Field.grid;
  for (let tries = 0; tries < 30; tries += 1) {
    const lon = grid.lonMin + Math.random() * (grid.lonMax - grid.lonMin);
    const lat = grid.latMin + Math.random() * (grid.latMax - grid.latMin);
    const cur = Field.sampleCurrent(lon, lat, tIdxToSec(tIdx));
    if (cur) {
      return { lon, lat, age: 320 + Math.random() * 420 };
    }
  }
  return {
    lon: grid.lonMin + Math.random() * (grid.lonMax - grid.lonMin),
    lat: grid.latMin + Math.random() * (grid.latMax - grid.latMin),
    age: 1,
  };
}

function makeBgParticles(n) {
  bgParticles = [];
  for (let i = 0; i < n; i += 1) {
    bgParticles.push(randomBgParticle());
  }
}

/* Advance the ambient tracer particles. These do not affect the simulation;
   they are a Windy-style visual layer driven directly by the current field. */
function stepBgParticles(dtReal) {
  const tSec = tIdxToSec(tIdx);
  const dt = dtReal * 3600 * 2;
  for (const particle of bgParticles) {
    const cur = Field.sampleCurrent(particle.lon, particle.lat, tSec);
    if (!cur || particle.age <= 0) {
      Object.assign(particle, randomBgParticle());
      continue;
    }
    particle.prevLon = particle.lon;
    particle.prevLat = particle.lat;
    particle.prevOK = true;
    particle.lon += cur.u * dt / mPerDegLon(particle.lat);
    particle.lat += cur.v * dt / mPerDegLat(particle.lat);
    particle.age -= 1;
    const grid = Field.grid;
    if (particle.lon < grid.lonMin || particle.lon > grid.lonMax || particle.lat < grid.latMin || particle.lat > grid.latMax) {
      particle.age = 0;
    }
  }
}

/* Offscreen low-res field buffer:
 * we paint one pixel per model cell, then scale/blit it to the visible canvas.
 * That is much cheaper than repainting thousands of screen-sized quads every
 * frame and still produces a smooth-looking current layer. */
/* Two small offscreen canvases let the visible current field cross-fade
   between adjacent hourly frames instead of snapping from color to color. */
const fieldSrcBuffers = [
  { canvas: null, ctx: null, data: null, ti: -1 },
  { canvas: null, ctx: null, data: null, ti: -1 },
];

function ensureFieldSrc(grid) {
  if (
    fieldSrcBuffers[0].canvas &&
    fieldSrcBuffers[0].canvas.width === grid.nLon &&
    fieldSrcBuffers[0].canvas.height === grid.nLat
  ) return;
  fieldSrcBuffers.forEach((buffer) => {
    buffer.canvas = document.createElement("canvas");
    buffer.canvas.width = grid.nLon;
    buffer.canvas.height = grid.nLat;
    buffer.ctx = buffer.canvas.getContext("2d");
    buffer.data = buffer.ctx.createImageData(grid.nLon, grid.nLat);
    buffer.ti = -1;
  });
}

/* Paint a single time slice of the current field into the offscreen buffer. */
function paintFieldSrc(ti, grid, buffer) {
  if (ti === buffer.ti) return;
  const pix = buffer.data.data;
  const nW = grid.nLon;
  const nH = grid.nLat;
  const nCells = nW * nH;

  /* Pass 1 — paint water cells, mark land cells. We keep RGB channels
   * separate so we can BFS-fill land pixels with the nearest water color.
   * Alpha is 0 for land so bilinear blit lets the Leaflet basemap show
   * through the coastline without any brown tint smearing into water.    */
  const isWater = new Uint8Array(nCells);
  for (let row = 0; row < nH; row += 1) {
    const j = nH - 1 - row;       // image row 0 = northernmost lat
    for (let i = 0; i < nW; i += 1) {
      const u = Field.u[ti][j][i];
      const v = Field.v[ti][j][i];
      const cellIdx = row * nW + i;
      const p = cellIdx * 4;
      if (u === null || v === null) {
        pix[p]     = 0;   // will be overwritten by BFS fill below
        pix[p + 1] = 0;
        pix[p + 2] = 0;
        pix[p + 3] = 0;   // transparent → basemap shows through
        continue;
      }
      const speed = Math.hypot(u, v);
      const hue   = directionHue(u, -v);
      const alpha = Math.min(speed / 0.8, 0.78);
      const [r, g, b] = hslToRgb(hue / 360, 0.88, 0.56);
      pix[p]     = r;
      pix[p + 1] = g;
      pix[p + 2] = b;
      pix[p + 3] = Math.round(alpha * 255);
      isWater[cellIdx] = 1;
    }
  }

  /* Pass 2 — BFS from every water cell outward, copying its RGB (not
   * alpha) into adjacent land cells. This propagates the nearest water
   * color across the land mask so bilinear smoothing near coastlines
   * blends water-hue → water-hue rather than water-hue → black.          */
  const dist = new Int32Array(nCells).fill(1 << 30);
  let head = 0;
  const queue = new Int32Array(nCells);
  let tail = 0;
  for (let idx = 0; idx < nCells; idx += 1) {
    if (isWater[idx]) {
      dist[idx] = 0;
      queue[tail++] = idx;
    }
  }
  while (head < tail) {
    const idx = queue[head++];
    const y = (idx / nW) | 0;
    const x = idx - y * nW;
    const dNext = dist[idx] + 1;
    const srcP = idx * 4;
    const srcR = pix[srcP];
    const srcG = pix[srcP + 1];
    const srcB = pix[srcP + 2];
    for (let k = 0; k < 4; k += 1) {
      const nx = x + (k === 0 ? 1 : k === 1 ? -1 : 0);
      const ny = y + (k === 2 ? 1 : k === 3 ? -1 : 0);
      if (nx < 0 || nx >= nW || ny < 0 || ny >= nH) continue;
      const nIdx = ny * nW + nx;
      if (dist[nIdx] > dNext) {
        dist[nIdx] = dNext;
        const nP = nIdx * 4;
        pix[nP]     = srcR;   // inherit water color
        pix[nP + 1] = srcG;
        pix[nP + 2] = srcB;
        // pix[nP + 3] stays 0 (land remains transparent)
        queue[tail++] = nIdx;
      }
    }
  }

  buffer.ctx.putImageData(buffer.data, 0, 0);
  buffer.ti = ti;
}

/* Draw the colorized current field for the current playback instant. */
function drawField() {
  if (!fieldLayer || !Field.loaded) {
    return;
  }
  const ctx  = fieldLayer.fieldCtx();
  const size = fieldLayer.size();
  ctx.clearRect(0, 0, size.x, size.y);
  if (!overlayState.currents) {
    return;
  }
  const ti0 = clamp(Math.floor(tIdx), 0, Field.times.length - 1);
  const ti1 = clamp(ti0 + 1, 0, Field.times.length - 1);
  const blend = clamp(tIdx - ti0, 0, 1);
  const grid = Field.grid;

  ensureFieldSrc(grid);
  paintFieldSrc(ti0, grid, fieldSrcBuffers[0]);
  if (blend > 0 && ti1 !== ti0) {
    paintFieldSrc(ti1, grid, fieldSrcBuffers[1]);
  }

  /* Destination rect aligned so that each source-pixel CENTER lands on its
   * corresponding grid point. Grid point (i,j) = (lons[i], lats[j]).
   * Pixel center in image coords is (i + 0.5, row + 0.5) where row = nLat-1-j.
   *   X0,Y0 = screen coords of NW-most grid point (lats[nLat-1], lons[0])
   *   X1,Y1 = screen coords of SE-most grid point (lats[0],       lons[nLon-1])
   * dWidth  = nLon * (X1 - X0) / (nLon - 1)
   * dHeight = nLat * (Y1 - Y0) / (nLat - 1)                                 */
  const nw = map.latLngToContainerPoint([grid.lats[grid.nLat - 1], grid.lons[0]]);
  const se = map.latLngToContainerPoint([grid.lats[0],             grid.lons[grid.nLon - 1]]);
  const spanX = se.x - nw.x;
  const spanY = se.y - nw.y;
  const dW = (grid.nLon * spanX) / (grid.nLon - 1);
  const dH = (grid.nLat * spanY) / (grid.nLat - 1);
  const dX = nw.x - (0.5 * spanX) / (grid.nLon - 1);
  const dY = nw.y - (0.5 * spanY) / (grid.nLat - 1);

  ctx.save();
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(fieldSrcBuffers[0].canvas, dX, dY, dW, dH);
  if (blend > 0 && ti1 !== ti0) {
    ctx.globalAlpha = blend;
    ctx.drawImage(fieldSrcBuffers[1].canvas, dX, dY, dW, dH);
  }
  ctx.restore();

  ctx.save();
  ctx.fillStyle = "rgba(0, 0, 0, 0.13)";
  ctx.fillRect(0, 0, size.x, size.y);
  ctx.restore();
}

/* Draw streak-style background tracers by fading the previous frame slightly
   and then drawing new short segments. That repeated partial fade is what
   creates the visible trail effect. */
function drawBgParticles() {
  if (!fieldLayer) {
    return;
  }
  const ctx = fieldLayer.partCtx();
  const size = fieldLayer.size();
  if (!overlayState.tracers) {
    ctx.clearRect(0, 0, size.x, size.y);
    return;
  }
  ctx.globalCompositeOperation = "destination-out";
  ctx.fillStyle = "rgba(0, 0, 0, 0.05)";
  ctx.fillRect(0, 0, size.x, size.y);
  ctx.globalCompositeOperation = "source-over";
  ctx.strokeStyle = "rgba(255, 255, 255, 0.85)";
  ctx.lineCap    = "round";
  ctx.lineWidth  = 2.2;
  ctx.beginPath();
  for (const particle of bgParticles) {
    if (!particle.prevOK) {
      continue;
    }
    const a = map.latLngToContainerPoint([particle.prevLat, particle.prevLon]);
    const b = map.latLngToContainerPoint([particle.lat, particle.lon]);
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    particle.prevOK = false;
  }
  ctx.stroke();
}

/* Some drifters only append to track periodically, so this helper forces the
   final state to exist in each track before playback reconstruction begins. */
function ensureFinalTrackSamples(ensemble) {
  for (const drifter of ensemble) {
    const last = drifter.track[drifter.track.length - 1];
    if (!last || last[2] !== drifter.t) {
      drifter.track.push([drifter.lon, drifter.lat, drifter.t]);
    }
  }
}

/* Reconstruct a particle location at an arbitrary playback time by sampling
   between stored track points rather than rerunning the integrator live. */
function sampleTrackPosition(drifter, tSec) {
  if (tSec <= drifter.t0) {
    return { lon: drifter.lon0, lat: drifter.lat0, ageSec: 0, stranded: false, massFrac: 1 };
  }

  const track = drifter.track;
  const last = track[track.length - 1];
  const sampleSec = Math.min(tSec, last[2]);
  if (sampleSec >= last[2]) {
    return {
      lon: last[0],
      lat: last[1],
      ageSec: Math.max(0, sampleSec - drifter.t0),
      stranded: drifter.stranded && sampleSec >= drifter.t,
      massFrac: drifter.tau_evap ? Math.exp(-(sampleSec - drifter.t0) / drifter.tau_evap) : drifter.mass_frac,
    };
  }

  let lo = 0;
  let hi = track.length - 1;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (track[mid][2] < sampleSec) {
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }

  const nextIndex = Math.min(lo, track.length - 1);
  const prevIndex = Math.max(0, nextIndex - 1);
  const prev = track[prevIndex];
  const next = track[nextIndex];
  const span = Math.max(1, next[2] - prev[2]);
  const f = clamp((sampleSec - prev[2]) / span, 0, 1);
  return {
    lon: prev[0] + (next[0] - prev[0]) * f,
    lat: prev[1] + (next[1] - prev[1]) * f,
    ageSec: Math.max(0, sampleSec - drifter.t0),
    stranded: drifter.stranded && sampleSec >= drifter.t,
    massFrac: drifter.tau_evap ? Math.exp(-(sampleSec - drifter.t0) / drifter.tau_evap) : drifter.mass_frac,
  };
}

/* Reduce a cloud of particles into centroid/spread/stranding metrics for UI
   cards, uncertainty drawing, and analytics plots. */
function summarizePoints(points, tSec) {
  if (!points.length) {
    return {
      total: 0,
      drifting: 0,
      stranded: 0,
      centroidLon: null,
      centroidLat: null,
      sigmaKm: null,
      maxAgeHours: 0,
      massLeftPct: null,
      ellipse: null,
      tSec,
    };
  }

  let sumLon = 0;
  let sumLat = 0;
  let stranded = 0;
  let maxAge = 0;
  let massTotal = 0;

  for (const point of points) {
    sumLon += point.lon;
    sumLat += point.lat;
    if (point.stranded) {
      stranded += 1;
    }
    maxAge = Math.max(maxAge, point.ageSec);
    massTotal += point.massFrac ?? 1;
  }

  const centroidLon = sumLon / points.length;
  const centroidLat = sumLat / points.length;
  const dx = [];
  const dy = [];
  for (const point of points) {
    dx.push((point.lon - centroidLon) * mPerDegLon(centroidLat));
    dy.push((point.lat - centroidLat) * mPerDegLat(centroidLat));
  }

  let covXX = 0;
  let covYY = 0;
  let covXY = 0;
  for (let i = 0; i < dx.length; i += 1) {
    covXX += dx[i] * dx[i];
    covYY += dy[i] * dy[i];
    covXY += dx[i] * dy[i];
  }
  covXX /= Math.max(1, dx.length);
  covYY /= Math.max(1, dy.length);
  covXY /= Math.max(1, dx.length);

  const sigmaKm = Math.sqrt((covXX + covYY) / 2) / 1000;
  const trace = covXX + covYY;
  const detTerm = Math.sqrt(Math.max(0, (covXX - covYY) * (covXX - covYY) + 4 * covXY * covXY));
  const lambda1 = Math.max(0, (trace + detTerm) / 2);
  const lambda2 = Math.max(0, (trace - detTerm) / 2);
  const angleRad = 0.5 * Math.atan2(2 * covXY, covXX - covYY);

  return {
    total: points.length,
    drifting: points.length - stranded,
    stranded,
    centroidLon,
    centroidLat,
    sigmaKm,
    maxAgeHours: maxAge / 3600,
    massLeftPct: (massTotal / points.length) * 100,
    ellipse: { majorM: 2 * Math.sqrt(lambda1), minorM: 2 * Math.sqrt(lambda2), angleRad },
    tSec,
  };
}

/* Build one snapshot of the ensemble at a requested time by sampling the saved
   tracks of every particle. */
function snapshotFromEnsemble(ensemble, tSec) {
  const points = ensemble.map((drifter) => ({
    lon: drifter.lon,
    lat: drifter.lat,
    ageSec: drifter.age,
    stranded: drifter.stranded,
    massFrac: drifter.mass_frac,
  }));
  return summarizePoints(points, tSec);
}

/* Playback cache. This is called constantly while scrubbing/playing, so frames
   are memoized to avoid repeated whole-ensemble reconstruction work. */
function getRunFrame(tSec) {
  if (!activeRun || !activeRun.ensemble.length) {
    return null;
  }
  if (tSec < activeRun.startSec) {
    return {
      preRun: true,
      tSec,
      points: [],
      metrics: {
        total: activeRun.ensemble.length,
        drifting: activeRun.ensemble.length,
        stranded: 0,
        centroidLon: releasePoint ? releasePoint.lon : null,
        centroidLat: releasePoint ? releasePoint.lat : null,
        sigmaKm: 0,
        maxAgeHours: 0,
        massLeftPct: 100,
        ellipse: null,
        tSec,
      },
    };
  }

  const viewSec = Math.min(tSec, activeRun.endSec);
  const key = `${Math.round(viewSec)}:${activeRun.ensemble.length}`;
  if (frameCache && frameCache.key === key) {
    return frameCache.value;
  }

  const points = activeRun.ensemble.map((drifter) => sampleTrackPosition(drifter, viewSec));
  const metrics = summarizePoints(points, viewSec);
  const value = { preRun: false, tSec: viewSec, points, metrics };
  frameCache = { key, value };
  return value;
}

/* Density is drawn as a soft heat/glow layer so the ensemble reads as a cloud
   rather than a pile of equally important dots. */
function drawDensity(ctx, points) {
  const stride = Math.max(1, Math.ceil(points.length / 900));
  const radiusPx = points.length > 1200 ? 16 : points.length > 600 ? 22 : 28;
  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  for (let i = 0; i < points.length; i += stride) {
    const point = points[i];
    if (point.stranded) {
      continue;
    }
    const p = map.latLngToContainerPoint([point.lat, point.lon]);
    const gradient = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, radiusPx);
    gradient.addColorStop(0, "rgba(0, 170, 231, 0.24)");
    gradient.addColorStop(0.55, "rgba(0, 18, 32, 0.14)");
    gradient.addColorStop(1, "rgba(0, 18, 32, 0)");
    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.arc(p.x, p.y, radiusPx, 0, 2 * Math.PI);
    ctx.fill();
  }
  ctx.restore();
}

/* Trajectory tails show where currently visible particles came from. */
function drawTrails(ctx, tSec) {
  if (!activeRun) {
    return;
  }
  const stride = Math.max(1, Math.ceil(activeRun.ensemble.length / 700));
  ctx.save();
  ctx.strokeStyle = "rgba(255, 127, 0, 0.36)";
  ctx.lineWidth = 1.1;
  ctx.beginPath();

  for (let i = 0; i < activeRun.ensemble.length; i += stride) {
    const drifter = activeRun.ensemble[i];
    const track = drifter.track;
    if (!track.length || tSec <= drifter.t0) {
      continue;
    }

    let started = false;
    for (let j = 0; j < track.length; j += 1) {
      const entry = track[j];
      if (entry[2] > tSec) {
        const sampled = sampleTrackPosition(drifter, tSec);
        const sampledPoint = map.latLngToContainerPoint([sampled.lat, sampled.lon]);
        ctx.lineTo(sampledPoint.x, sampledPoint.y);
        break;
      }
      const p = map.latLngToContainerPoint([entry[1], entry[0]]);
      if (!started) {
        ctx.moveTo(p.x, p.y);
        started = true;
      } else {
        ctx.lineTo(p.x, p.y);
      }
    }
  }

  ctx.stroke();
  ctx.restore();
}

/* Uncertainty ellipse is a compact visual summary of the cloud orientation and
   spread, useful when hundreds of particles would otherwise look noisy. */
function drawUncertaintyEllipse(ctx, metrics) {
  if (!metrics || !metrics.ellipse || !Number.isFinite(metrics.centroidLat) || !Number.isFinite(metrics.centroidLon)) {
    return;
  }
  const center = map.latLngToContainerPoint([metrics.centroidLat, metrics.centroidLon]);
  const east = map.latLngToContainerPoint([metrics.centroidLat, metrics.centroidLon + metrics.ellipse.majorM / mPerDegLon(metrics.centroidLat)]);
  const north = map.latLngToContainerPoint([metrics.centroidLat + metrics.ellipse.minorM / mPerDegLat(metrics.centroidLat), metrics.centroidLon]);
  ctx.save();
  ctx.translate(center.x, center.y);
  ctx.rotate(-metrics.ellipse.angleRad);
  ctx.strokeStyle = "rgba(0, 170, 231, 0.9)";
  ctx.fillStyle = "rgba(0, 170, 231, 0.1)";
  ctx.lineWidth = 1.4;
  ctx.beginPath();
  ctx.ellipse(0, 0, Math.abs(east.x - center.x), Math.abs(north.y - center.y), 0, 0, 2 * Math.PI);
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

/* Release marker anchors the user spatially once the ensemble has moved away
   from the original release point. */
function drawReleaseMarker(ctx) {
  if (!releasePoint || !overlayState.release) {
    return;
  }
  const p = map.latLngToContainerPoint([releasePoint.lat, releasePoint.lon]);
  ctx.save();
  ctx.strokeStyle = "#0081b0";
  ctx.fillStyle = "rgba(0, 170, 231, 0.1)";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(p.x, p.y, 8, 0, 2 * Math.PI);
  ctx.fill();
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(p.x - 10, p.y);
  ctx.lineTo(p.x + 10, p.y);
  ctx.moveTo(p.x, p.y - 10);
  ctx.lineTo(p.x, p.y + 10);
  ctx.stroke();
  ctx.restore();
}

/* Master overlay renderer for scenario output. This composites density, tails,
   uncertainty, active particles, stranded particles, and oil footprint cues. */
function drawDrift() {
  if (!fieldLayer) {
    return;
  }

  const ctx = fieldLayer.driftCtx();
  const size = fieldLayer.size();
  ctx.clearRect(0, 0, size.x, size.y);

  const frame = getRunFrame(tIdxToSec(tIdx));
  if (frame && !frame.preRun) {
    if (overlayState.density) {
      drawDensity(ctx, frame.points);
    }
    if (overlayState.trails) {
      drawTrails(ctx, frame.tSec);
    }
    if (overlayState.oilRadius && activeRun.scenario === "oil" && oilSlickModel && releasePoint) {
      const ageSec = frame.tSec - activeRun.startSec;
      if (ageSec > 0) {
        const radiusM = oilSlickModel.radius(ageSec);
        const center = map.latLngToContainerPoint([releasePoint.lat, releasePoint.lon]);
        const edge = map.latLngToContainerPoint([releasePoint.lat, releasePoint.lon + radiusM / mPerDegLon(releasePoint.lat)]);
        ctx.save();
        ctx.strokeStyle = "rgba(255, 127, 0, 0.72)";
        ctx.lineWidth = 1.4;
        ctx.setLineDash([8, 5]);
        ctx.beginPath();
        ctx.arc(center.x, center.y, Math.abs(edge.x - center.x), 0, 2 * Math.PI);
        ctx.stroke();
        ctx.restore();
      }
    }
    if (overlayState.uncertainty) {
      drawUncertaintyEllipse(ctx, frame.metrics);
    }

    const radius = frame.points.length > 1800 ? 1.6 : frame.points.length > 900 ? 2 : 2.4;
    for (const point of frame.points) {
      const p = map.latLngToContainerPoint([point.lat, point.lon]);
      ctx.fillStyle = point.stranded ? "rgba(255, 51, 102, 0.9)" : activeRun.scenario === "oil" ? `rgba(0, 18, 32, ${Math.max(0.35, point.massFrac)})` : "rgba(255, 127, 0, 0.94)";
      ctx.beginPath();
      ctx.arc(p.x, p.y, radius, 0, 2 * Math.PI);
      ctx.fill();
    }
  }

  drawReleaseMarker(ctx);
}

/* Persist a lightweight summary snapshot so results plots/exporters do not
   need to resample the entire ensemble from scratch later. */
function recordSnapshot(run, tSec) {
  const metrics = snapshotFromEnsemble(run.ensemble, tSec);
  const snapshot = {
    tSec,
    drifting: metrics.drifting,
    stranded: metrics.stranded,
    sigmaKm: metrics.sigmaKm,
    centroidLon: metrics.centroidLon,
    centroidLat: metrics.centroidLat,
    massLeftPct: metrics.massLeftPct,
    oilRadiusKm: run.scenario === "oil" && oilSlickModel ? oilSlickModel.radius(tSec - run.startSec) / 1000 : null,
  };
  const prev = run.snapshots[run.snapshots.length - 1];
  if (!prev || prev.tSec !== snapshot.tSec) {
    run.snapshots.push(snapshot);
  }
}

/* Read the current scenario form into one canonical parameter object. */
function collectScenarioParams() {
  const params = {
    release_radius_m: Number(els.relRadius.value),
    diffusion_K: Number(els.diffK.value),
    useWind: Boolean(els.useWind.checked && Field.hasWind),
  };
  if (activeScenario === "leeway") {
    params.category = els.leewayCat.value;
  } else {
    params.oil_type = els.oilType.value;
    params.volume_m3 = Number(els.oilVol.value);
  }
  return params;
}

/* Read the response-option panel into the compact structure consumed by the
   oil-budget model and export helpers. */
function collectResponses() {
  return {
    skimming: {
      active: els.skimActive.checked,
      startH: Number(els.skimStart.value),
      endH: Number(els.skimEnd.value),
      rateM3h: Number(els.skimRate.value),
      efficiency_pct: Number(els.skimEff.value),
    },
    burning: {
      active: els.burnActive.checked,
      startH: Number(els.burnStart.value),
      endH: Number(els.burnEnd.value),
      efficiency_pct: Number(els.burnEff.value),
    },
    dispersant: {
      active: els.dispActive.checked,
      startH: Number(els.dispStart.value),
      endH: Number(els.dispEnd.value),
      effectiveness_pct: Number(els.dispEff.value),
    },
  };
}

/* Render the stacked oil-budget chart after a completed oil run. */
function renderOilBudgetPlot() {
  if (!oilBudgetModel || !oilBudgetModel.history.length) {
    els.oilBudgetCard.style.display = "none";
    els.oilBudgetInsights.innerHTML = "";
    return;
  }
  els.oilBudgetCard.style.display = "";

  const h = oilBudgetModel.history;
  const x = h.map((s) => s.t_h);

  const traces = [
    { x, y: h.map((s) => s.surface), name: "Surface",    stackgroup: "one", line: { width: 0 }, fillcolor: "rgba(255, 127, 0, 0.82)" },
    { x, y: h.map((s) => s.evap),    name: "Evaporated", stackgroup: "one", line: { width: 0 }, fillcolor: "rgba(255, 160, 64, 0.72)" },
    { x, y: h.map((s) => s.disp),    name: "Dispersed",  stackgroup: "one", line: { width: 0 }, fillcolor: "rgba(0, 170, 231, 0.68)" },
    { x, y: h.map((s) => s.beach),   name: "Beached",    stackgroup: "one", line: { width: 0 }, fillcolor: "rgba(0, 129, 176, 0.68)" },
    { x, y: h.map((s) => s.skim),    name: "Skimmed",    stackgroup: "one", line: { width: 0 }, fillcolor: "rgba(0, 255, 204, 0.62)" },
    { x, y: h.map((s) => s.burn),    name: "Burned",     stackgroup: "one", line: { width: 0 }, fillcolor: "rgba(0, 18, 32, 0.72)" },
  ];

  Plotly.newPlot(els.oilBudgetPlot, traces, {
    autosize: true,
    margin: { l: 40, r: 14, t: 10, b: 36 },
    paper_bgcolor: "rgba(255,255,255,0)",
    plot_bgcolor: "rgba(255,255,255,0)",
    font: { family: "Inter, sans-serif", color: "#202124", size: 11 },
    xaxis: { title: "Hours", showgrid: true, gridcolor: "rgba(0,0,0,0.08)", zeroline: false },
    yaxis: { title: "% of spill", range: [0, 100], showgrid: true, gridcolor: "rgba(0,0,0,0.08)", zeroline: false },
    legend: { orientation: "h", y: 1.14, x: 0, font: { size: 10 } },
  }, { displayModeBar: false, responsive: true });

  // Summary stats
  const final = oilBudgetModel.summary();
  els.oilBudgetSummary.innerHTML = [
    ["Surface",    formatPercent(final.surface_pct),  "#FF7F00"],
    ["Evaporated", formatPercent(final.evap_pct),     "#FFA040"],
    ["Dispersed",  formatPercent(final.disp_pct),     "#00AAE7"],
    ["Beached",    formatPercent(final.beach_pct),    "#0081b0"],
    ["Skimmed",    formatPercent(final.skim_pct),     "#00FFCC"],
    ["Burned",     formatPercent(final.burn_pct),     "#001220"],
  ].map(([label, value, color]) =>
    `<div class="budget-stat"><span class="bs-label">${label}</span><span class="bs-value" style="color:${color}">${value}</span></div>`
  ).join("");

  const responses = collectResponses();
  const activeResponses = [
    responses.skimming.active ? `Skimming ${responses.skimming.startH}-${responses.skimming.endH} h` : null,
    responses.burning.active ? `Burning ${responses.burning.startH}-${responses.burning.endH} h` : null,
    responses.dispersant.active ? `Dispersant ${responses.dispersant.startH}-${responses.dispersant.endH} h` : null,
  ].filter(Boolean);
  els.oilBudgetInsights.innerHTML = [
    `<span class="insight-pill">Final floating: ${formatPercent(final.surface_pct)}</span>`,
    `<span class="insight-pill">Beached: ${formatPercent(final.beach_pct)}</span>`,
    `<span class="insight-pill">Water: ${final.water_pct.toFixed(0)}%</span>`,
    ...(activeResponses.length ? activeResponses.map((label) => `<span class="insight-pill active">${label}</span>`) : ['<span class="insight-pill muted">No response actions enabled</span>']),
  ].join("");

  // Emulsion note
  els.emulsionNote.textContent = final.water_pct > 5
    ? `Emulsion: ${final.water_pct.toFixed(0)}% water content (mousse). Increases effective volume and reduces burn/skim efficiency.`
    : "";

  // Show export button
  els.exportBudgetCsvBtn.style.display = "";
}

/* Main simulation entry point.
 * Important: the browser does not integrate particles in real time during
 * playback. Instead, pressing Run precomputes the ensemble forward, stores
 * tracks/snapshots, and then the UI plays back those stored results smoothly.
 */
function runEnsemble() {
  if (!releasePoint) {
    setStatus("Click on the sea to set a release point first.");
    hideRunProgress();
    return;
  }

  clearInterval(runTimer);
  runTimer = null;
  playing = false;
  updatePlayButton();

  const startSec = tIdxToSec(tIdx);
  const durationHours = Number(els.durHours.value);
  const particleCount = Number(els.nEns.value);
  const params = collectScenarioParams();
  const ensemble = spawnEnsemble({
    lon: releasePoint.lon,
    lat: releasePoint.lat,
    tSec: startSec,
    n: particleCount,
    scenario: activeScenario,
    params,
  });

  oilSlickModel = activeScenario === "oil" ? new OilSlick(params.volume_m3 || 10, params.oil_type) : null;
  activeRun = {
    scenario: activeScenario,
    ensemble,
    startSec,
    endSec: startSec + durationHours * 3600,
    durationHours,
    params,
    presetId: els.scenarioPreset.value,
    snapshots: [],
  };
  resetFrameCache();
  recordSnapshot(activeRun, startSec);
  renderResultsPlot();
  updateResultsPanel(true);
  updateStoryCard();

  const dt = 300;
  const steps = Math.ceil((durationHours * 3600) / dt);
  const snapshotEvery = Math.max(1, Math.round(3600 / dt));
  let done = 0;
  setStatus(`Running ${particleCount} particles across ${durationHours} h...`);
  setRunProgress(0, "Preparing simulation", `${particleCount} particles | ${durationHours} h window`);

  runTimer = setInterval(() => {
    const batch = Math.min(30, steps - done);
    for (let s = 0; s < batch; s += 1) {
      for (const drifter of ensemble) {
        drifter.step(dt);
      }
      done += 1;
      if (done % snapshotEvery === 0 || done === steps) {
        recordSnapshot(activeRun, startSec + done * dt);
      }
    }

    const progress = Math.round((done / steps) * 100);
    setStatus(`Simulating ${progress}%...`);
    setRunProgress(progress, "Running ensemble", `${done} / ${steps} integration steps complete`);
    if (done >= steps) {
      clearInterval(runTimer);
      runTimer = null;
      ensureFinalTrackSamples(ensemble);
      recordSnapshot(activeRun, activeRun.endSec);
      activeRun.summary = snapshotFromEnsemble(ensemble, activeRun.endSec);
      setStatus(`Done. ${activeRun.summary.drifting} drifting, ${activeRun.summary.stranded} stranded.`);
      setRunProgress(100, "Simulation complete", `${activeRun.summary.drifting} drifting | ${activeRun.summary.stranded} stranded`);

      /* ── Oil Budget integration ───────────────────────────── */
      if (activeRun.scenario === "oil") {
        const responses = collectResponses();
        const beachSeries = [];
        for (let h = 0; h <= durationHours; h++) {
          const snap = activeRun.snapshots.find((s) => s.tSec >= startSec + h * 3600);
          beachSeries.push(snap ? snap.stranded / particleCount : 0);
        }
        // Estimate mean wind speed from the field at release point
        let meanWind = 5;
        if (Field.hasWind && releasePoint) {
          let windSum = 0, windN = 0;
          for (let h = 0; h < Math.min(durationHours, 24); h++) {
            const w = Field.sampleWind(releasePoint.lon, releasePoint.lat, startSec + h * 3600);
            if (w) { windSum += Math.hypot(w.u, w.v); windN++; }
          }
          if (windN > 0) meanWind = windSum / windN;
        }
        const oilKey = params.oil_type || "arabian_medium";
        // Map old OIL_TYPES keys to ADIOS_OILS keys
        const adiosKey = { light_crude: "arabian_light", medium_crude: "arabian_medium", heavy_fuel: "hfo380", diesel: "diesel_mgo", condensate: "condensate" }[oilKey] || oilKey;
        oilBudgetModel = OilBudget.runFull(
          params.volume_m3 || 10, adiosKey, responses,
          durationHours, beachSeries, meanWind
        );
        renderOilBudgetPlot();
      } else {
        oilBudgetModel = null;
        els.oilBudgetCard.style.display = "none";
        els.exportBudgetCsvBtn.style.display = "none";
        els.oilBudgetInsights.innerHTML = "";
      }

      tIdx = secToTIdx(startSec);
      resetFrameCache();
      updateTimelinePill();
      updateResultsPanel(true);
      renderResultsPlot();
      updateStoryCard();
    }
  }, 10);
}

/* Reset scenario output while keeping the base field, release controls, and
   ambient tracer animation alive. */
function clearRun() {
  clearInterval(runTimer);
  runTimer = null;
  activeRun = null;
  oilSlickModel = null;
  oilBudgetModel = null;
  resetFrameCache();
  setStatus("");
  hideRunProgress();
  updateTimelinePill();
  updateResultsPanel(true);
  renderResultsPlot();
  updateStoryCard();
  els.oilBudgetCard.style.display = "none";
  els.exportBudgetCsvBtn.style.display = "none";
  els.oilBudgetInsights.innerHTML = "";
  Plotly.purge(els.oilBudgetPlot);
}

function buildAnalystSummary(metrics, frame) {
  const strandedPct = metrics.total ? (metrics.stranded / metrics.total) * 100 : 0;
  const risk = strandedPct >= 25 ? "high" : strandedPct >= 8 ? "elevated" : "low";
  const ageHours = (frame.tSec - activeRun.startSec) / 3600;
  const oilPhrase = activeRun.scenario === "oil" && Number.isFinite(metrics.massLeftPct)
    ? ` Estimated floating mass is ${formatPercent(metrics.massLeftPct)}.`
    : "";
  return `At ${formatRunOffset(ageHours)}, shoreline risk is ${risk}: ${metrics.drifting} particles remain drifting, ${metrics.stranded} are stranded, and the cloud spread is ${fmt(metrics.sigmaKm, 2)} km.${oilPhrase}`;
}

/* Populate the metric cards for the current playback instant. */
function updateResultsPanel(force) {
  if (!activeRun) {
    els.results.innerHTML = '<div class="result-card wide"><span class="result-label">Run state</span><span class="result-value">No active simulation</span><span class="result-subvalue">Run a scenario to chart stranding, spread, and uncertainty over time.</span></div>';
    return;
  }

  const frame = getRunFrame(tIdxToSec(tIdx));
  if (!frame) {
    return;
  }
  const key = force ? "force" : Math.round(frame.tSec);
  if (!force && lastResultsKey === key) {
    return;
  }
  lastResultsKey = key;

  const metrics = frame.metrics;
  const centroidText = Number.isFinite(metrics.centroidLat) && Number.isFinite(metrics.centroidLon) ? `${metrics.centroidLat.toFixed(3)} N, ${metrics.centroidLon.toFixed(3)} E` : "Waiting for playback";
  const oilCards = activeRun.scenario === "oil" && oilSlickModel ? `
    <div class="result-card">
      <span class="result-label">Oil radius</span>
      <span class="result-value">${fmt(oilSlickModel.radius(Math.max(0, frame.tSec - activeRun.startSec)) / 1000, 2)} km</span>
      <span class="result-subvalue">Fay gravity-viscous approximation</span>
    </div>
    <div class="result-card">
      <span class="result-label">Mass left</span>
      <span class="result-value">${formatPercent(metrics.massLeftPct)}</span>
      <span class="result-subvalue">Estimated remaining floating mass</span>
    </div>` : "";

  els.results.innerHTML = `
    <div class="result-card wide analyst-card">
      <span class="result-label">Analyst summary</span>
      <span class="result-value">${activeRun.scenario === "oil" ? "Oil trajectory assessment" : "Search drift assessment"}</span>
      <span class="result-subvalue">${buildAnalystSummary(metrics, frame)}</span>
    </div>
    <div class="result-card">
      <span class="result-label">Particles</span>
      <span class="result-value">${metrics.total}</span>
      <span class="result-subvalue">${metrics.drifting} drifting / ${metrics.stranded} stranded</span>
    </div>
    <div class="result-card">
      <span class="result-label">Playback age</span>
      <span class="result-value">${fmt(metrics.maxAgeHours, 1)} h</span>
      <span class="result-subvalue">${formatRunOffset((frame.tSec - activeRun.startSec) / 3600)} from release</span>
    </div>
    <div class="result-card">
      <span class="result-label">Spread radius</span>
      <span class="result-value">${fmt(metrics.sigmaKm, 2)} km</span>
      <span class="result-subvalue">One-sigma ensemble spread</span>
    </div>
    <div class="result-card">
      <span class="result-label">Centroid</span>
      <span class="result-value">${centroidText}</span>
      <span class="result-subvalue">Current ensemble center</span>
    </div>
    ${oilCards}
    <div class="result-card wide">
      <span class="result-label">Interpretation</span>
      <span class="result-subvalue">${overlayState.density ? "Density highlights the most likely particle concentration." : "Enable density to highlight concentration."}${overlayState.uncertainty ? " The cyan ellipse tracks directional spread." : " Enable uncertainty to show the spread ellipse."}</span>
    </div>`;
}

/* Build the time-series analytics chart from stored snapshots. */
function renderResultsPlot() {
  if (!activeRun || !activeRun.snapshots.length) {
    Plotly.purge(els.tsPlot);
    return;
  }

  const snapshots = activeRun.snapshots;
  const x = snapshots.map((snapshot) => new Date(snapshot.tSec * 1000));
  const traces = [
    { x, y: snapshots.map((snapshot) => (snapshot.drifting / activeRun.ensemble.length) * 100), type: "scatter", mode: "lines", name: "Drifting %", line: { color: "#FF7F00", width: 3 }, hovertemplate: "%{y:.0f}% drifting<extra></extra>" },
    { x, y: snapshots.map((snapshot) => snapshot.sigmaKm), type: "scatter", mode: "lines", name: "Spread (km)", yaxis: "y2", line: { color: "#00AAE7", width: 2.2 }, hovertemplate: "%{y:.2f} km spread<extra></extra>" },
  ];
  if (activeRun.scenario === "oil") {
    traces.push({ x, y: snapshots.map((snapshot) => snapshot.massLeftPct), type: "scatter", mode: "lines", name: "Mass left %", line: { color: "#FF3366", width: 2, dash: "dot" }, hovertemplate: "%{y:.0f}% mass left<extra></extra>" });
  }

  const markerTime = new Date(clamp(tIdxToSec(tIdx), activeRun.startSec, activeRun.endSec) * 1000);
  Plotly.newPlot(els.tsPlot, traces, {
    autosize: true,
    margin: { l: 44, r: 44, t: 20, b: 36 },
    paper_bgcolor: "rgba(255,255,255,0)",
    plot_bgcolor: "rgba(255,255,255,0)",
    font: { family: "Inter, sans-serif", color: "#202124", size: 11 },
    xaxis: { showgrid: true, gridcolor: "rgba(0,0,0,0.08)", zeroline: false },
    yaxis: { title: "Drifting / mass (%)", rangemode: "tozero", showgrid: true, gridcolor: "rgba(0,0,0,0.08)", zeroline: false },
    yaxis2: { title: "Spread (km)", overlaying: "y", side: "right", rangemode: "tozero", showgrid: false, zeroline: false },
    legend: { orientation: "h", y: 1.12, x: 0 },
    shapes: [{ type: "line", x0: markerTime, x1: markerTime, y0: 0, y1: 1, yref: "paper", line: { color: "#00AAE7", width: 1, dash: "dot" } }],
  }, { displayModeBar: false, responsive: true });
}

/* Move the chart cursor to match the current playback time. */
function updatePlotCursor(force) {
  if (!activeRun || !activeRun.snapshots.length) {
    return;
  }
  const currentSec = clamp(tIdxToSec(tIdx), activeRun.startSec, activeRun.endSec);
  const key = force ? "force" : Math.round(currentSec);
  if (!force && lastPlotMarkerKey === key) {
    return;
  }
  lastPlotMarkerKey = key;
  Plotly.relayout(els.tsPlot, {
    shapes: [{ type: "line", x0: new Date(currentSec * 1000), x1: new Date(currentSec * 1000), y0: 0, y1: 1, yref: "paper", line: { color: "#00AAE7", width: 1, dash: "dot" } }],
  });
}

function hslToRgb(h, s, l) {
  let r;
  let g;
  let b;
  if (s === 0) {
    r = g = b = l;
  } else {
    const hue2 = (p, q, t) => {
      let next = t;
      if (next < 0) next += 1;
      if (next > 1) next -= 1;
      if (next < 1 / 6) return p + (q - p) * 6 * next;
      if (next < 1 / 2) return q;
      if (next < 2 / 3) return p + (q - p) * (2 / 3 - next) * 6;
      return p;
    };
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    r = hue2(p, q, h + 1 / 3);
    g = hue2(p, q, h);
    b = hue2(p, q, h - 1 / 3);
  }
  return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
}

/* Small helper for all text-based downloads (JSON, CSV, and generated helper
   scripts such as the optional PyGNOME handoff). */
function downloadText(filename, text, mimeType) {
  const blob = new Blob([text], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

/* Serialize the current UI state into a shareable query-string model. */
function buildShareParams() {
  const params = new URLSearchParams();
  params.set("scenario", activeScenario);
  params.set("preset", els.scenarioPreset.value);
  params.set("dur", els.durHours.value);
  params.set("nEns", els.nEns.value);
  params.set("relRadius", els.relRadius.value);
  params.set("diffK", els.diffK.value);
  params.set("useWind", els.useWind.checked ? "1" : "0");
  if (activeScenario === "leeway") {
    params.set("category", els.leewayCat.value);
  } else {
    params.set("oilType", els.oilType.value);
    params.set("oilVol", els.oilVol.value);
  }
  if (releasePoint) {
    params.set("lat", releasePoint.lat.toFixed(5));
    params.set("lon", releasePoint.lon.toFixed(5));
  }
  return params;
}

function buildShareUrl() {
  const url = new URL(window.location.href);
  url.hash = buildShareParams().toString();
  return url.toString();
}

async function copyShareLink() {
  const url = buildShareUrl();
  try {
    await navigator.clipboard.writeText(url);
  } catch (err) {
    const fallback = document.createElement("textarea");
    fallback.value = url;
    document.body.appendChild(fallback);
    fallback.select();
    document.execCommand("copy");
    fallback.remove();
  }
  setStatus("Share link copied.");
}

/* Export the currently active run in machine-readable form for offline
   analysis or handoff. */
function exportRunJson() {
  const payload = {
    scenario: activeScenario,
    preset: els.scenarioPreset.value,
    releasePoint,
    controls: {
      durationHours: Number(els.durHours.value),
      ensembleSize: Number(els.nEns.value),
      releaseRadiusM: Number(els.relRadius.value),
      diffusionK: Number(els.diffK.value),
      useWind: Boolean(els.useWind.checked && Field.hasWind),
    },
    run: activeRun ? {
      startUtc: new Date(activeRun.startSec * 1000).toISOString(),
      endUtc: new Date(activeRun.endSec * 1000).toISOString(),
      scenario: activeRun.scenario,
      snapshots: activeRun.snapshots,
      summary: activeRun.summary,
    } : null,
  };
  downloadText("hormuz-drift-run.json", JSON.stringify(payload, null, 2), "application/json");
  setStatus("Exported run JSON.");
}

/* Export the snapshot time series in spreadsheet-friendly format. */
function exportRunCsv() {
  if (!activeRun || !activeRun.snapshots.length) {
    setStatus("Run a scenario before exporting CSV.");
    return;
  }
  const lines = [
    "utc,drifting,stranded,sigma_km,centroid_lat,centroid_lon,mass_left_pct,oil_radius_km",
    ...activeRun.snapshots.map((snapshot) => [
      new Date(snapshot.tSec * 1000).toISOString(),
      snapshot.drifting,
      snapshot.stranded,
      fmt(snapshot.sigmaKm, 4),
      fmt(snapshot.centroidLat, 6),
      fmt(snapshot.centroidLon, 6),
      snapshot.massLeftPct == null ? "" : fmt(snapshot.massLeftPct, 2),
      snapshot.oilRadiusKm == null ? "" : fmt(snapshot.oilRadiusKm, 4),
    ].join(",")),
  ];
  downloadText("hormuz-drift-run.csv", lines.join("\n"), "text/csv");
  setStatus("Exported run CSV.");
}

/* Oil-specific export for the weathering/budget time history. */
function exportOilBudgetCsv() {
  if (!oilBudgetModel || !oilBudgetModel.history.length) {
    setStatus("Run an oil scenario first.");
    return;
  }
  const lines = [
    "hours,surface_pct,evaporated_pct,dispersed_pct,beached_pct,skimmed_pct,burned_pct,water_pct",
    ...oilBudgetModel.history.map((s) => [
      s.t_h.toFixed(2),
      s.surface.toFixed(2),
      s.evap.toFixed(2),
      s.disp.toFixed(2),
      s.beach.toFixed(2),
      s.skim.toFixed(2),
      s.burn.toFixed(2),
      s.water_pct.toFixed(2),
    ].join(",")),
  ];
  downloadText("hormuz-oil-budget.csv", lines.join("\n"), "text/csv");
  setStatus("Exported oil budget CSV.");
}

/* WebGNOME bridge helpers do not attempt to automate NOAA tooling. They package
   the active browser scenario into a repeatable PyGNOME starter script and give
   users a clean route into the official WebGNOME interface. */
function openWebgnome() {
  window.open("https://gnome.orr.noaa.gov/#config", "_blank", "noopener");
  const wgStatus = document.getElementById("wg-status");
  if (wgStatus) {
    wgStatus.textContent = "WebGNOME opened in a new tab. Use the setup instructions to load CMEMS currents and match the release point.";
  }
}

function buildPygnomeScript() {
  const lat = releasePoint ? releasePoint.lat.toFixed(5) : "26.45000";
  const lon = releasePoint ? releasePoint.lon.toFixed(5) : "56.10000";
  const durationHours = Number(els.durHours.value) || 24;
  const isOil = activeScenario === "oil";
  const oilType = els.oilType ? els.oilType.value : "light_crude";
  const oilVol = els.oilVol ? Number(els.oilVol.value) || 10 : 10;
  const dataStartUtc = Field.loaded && Field.times.length ? Field.times[0] : "2024-01-01T00:00:00";
  const scenarioName = isOil ? "Oil spill" : "Man overboard / S&R";
  const oilBlock = isOil ? `
# -- Oil spill setup ---------------------------------------------------------
# Replace the substance name with the closest ADIOS oil if needed.
substance = gs.get_oil_props("${oilType}")
spill = gs.surface_point_line_spill(
    num_elements=1000,
    start_position=(${lon}, ${lat}, 0.0),
    release_time=start_time,
    amount=${oilVol},
    units="m^3",
    substance=substance,
)
model.spills += spill
` : `
# -- Floating object / S&R-style drifter setup -------------------------------
spill = gs.surface_point_line_spill(
    num_elements=1000,
    start_position=(${lon}, ${lat}, 0.0),
    release_time=start_time,
)
model.spills += spill
`;

  return `#!/usr/bin/env python3
"""
pygnome_hormuz.py - PyGNOME starter generated by the Tridel Hormuz web model.

Scenario : ${scenarioName}
Release  : ${lat} N, ${lon} E
Duration : ${durationHours} h
Generated: ${new Date().toISOString()}

Install  : conda install -c noaa-orr-erd gnome
Run      : python pygnome_hormuz.py
"""

from datetime import datetime, timedelta
import pathlib

import gnome.scripting as gs
from gnome.model import Model
from gnome.maps import GnomeMap
from gnome.movers import GridCurrentMover, PointWindMover
from gnome.environment import Wind
from gnome.outputters import Renderer, NetCDFOutput

CMEMS_NC = pathlib.Path("cmems_mod_glo_phy_anfc_merged-uv_PT1H-i_1776382234335.nc")
OUTPUT_DIR = pathlib.Path("webgnome_output")
OUTPUT_DIR.mkdir(exist_ok=True)

start_time = datetime.fromisoformat("${dataStartUtc}")
duration = timedelta(hours=${durationHours})
time_step = timedelta(minutes=15)

model = Model(
    start_time=start_time,
    duration=duration,
    time_step=time_step,
    map=GnomeMap(),
    uncertain=True,
)

if CMEMS_NC.exists():
    current_mover = GridCurrentMover(
        current_filename=str(CMEMS_NC),
        grid_topology={"u_var": "utotal", "v_var": "vtotal"},
    )
    model.movers += current_mover
    print(f"[OK] Loaded CMEMS currents from {CMEMS_NC}")
else:
    print(f"[WARN] CMEMS file not found: {CMEMS_NC}")
    print("       Copy the NetCDF currents file beside this script before running.")

# Replace this constant wind with GOODS/GFS or another wind file for production
# studies. It is included only so the starter script runs as a complete model.
wind = Wind(timeseries=[(start_time, (5.0, 45.0))], units="m/s")
model.movers += PointWindMover(wind)
${oilBlock}
model.outputters += Renderer(
    map_filename=None,
    output_dir=str(OUTPUT_DIR),
    image_size=(1200, 800),
    output_timestep=timedelta(hours=1),
)
model.outputters += NetCDFOutput(
    str(OUTPUT_DIR / "hormuz_trajectory.nc"),
    which_data="all",
    output_timestep=timedelta(hours=1),
)

print("Running PyGNOME model...")
model.full_run()
print(f"Done. Outputs in: {OUTPUT_DIR.resolve()}")
`;
}

function downloadPygnomeScript() {
  downloadText("pygnome_hormuz.py", buildPygnomeScript(), "text/x-python");
  const wgStatus = document.getElementById("wg-status");
  if (wgStatus) {
    wgStatus.textContent = releasePoint
      ? `PyGNOME script generated for ${releasePoint.lat.toFixed(4)} N, ${releasePoint.lon.toFixed(4)} E.`
      : "PyGNOME script generated with default Hormuz centre coordinates. Click the map first for an exact release point.";
  }
}

function showWgModal() {
  const modal = document.getElementById("webgnome-modal");
  if (modal) modal.style.display = "flex";
}

function hideWgModal() {
  const modal = document.getElementById("webgnome-modal");
  if (modal) modal.style.display = "none";
}

function updatePlayButton() {
  els.playBtn.textContent = playing ? "Pause" : "Play";
}

function syncLayerInputs() {
  const pairs = [
    ["currents", els.layerCurrents],
    ["tracers", els.layerTracers],
    ["trails", els.layerTrails],
    ["density", els.layerDensity],
    ["uncertainty", els.layerUncertainty],
    ["release", els.layerRelease],
    ["oilRadius", els.layerOilRadius],
  ];
  pairs.forEach(([key, input]) => {
    if (input) input.checked = overlayState[key];
  });
}

function updateScenarioBadges() {
  const preset = selectedPreset();
  const scenarioText = `${getScenarioLabel(activeScenario)}${preset ? ` | ${preset.label}` : ""}`;
  if (els.controlScenario) els.controlScenario.textContent = scenarioText;
}

/* Keep the release summary card in sync with the current map click. */
function updateReleaseInfo() {
  if (!releasePoint) {
    els.releaseInfo.textContent = "Click on the map to set release point.";
    els.runBtn.disabled = true;
    if (els.quickRunRailBtn) els.quickRunRailBtn.disabled = true;
    return;
  }
  els.releaseInfo.textContent = `${releasePoint.lat.toFixed(4)} N, ${releasePoint.lon.toFixed(4)} E`;
  els.runBtn.disabled = false;
  if (els.quickRunRailBtn) els.quickRunRailBtn.disabled = false;
}

function updateTimelinePill() {
  const hasField = Field.loaded && Field.times.length;
  if (!activeRun) {
    els.timeWindowLabel.textContent = "Playback follows the forcing timeline.";
    if (hasField) {
      const currentIndex = Math.floor(tIdx);
      els.timelineStart.textContent = `Start ${Field.times[0]} UTC`;
      els.timelineEnd.textContent = `End ${Field.times[Field.times.length - 1]} UTC`;
      els.timelineCurrent.textContent = `${Field.times[currentIndex] || ""} UTC`;
      els.timelineEvents.innerHTML = "";
    }
    return;
  }
  const viewSec = clamp(tIdxToSec(tIdx), activeRun.startSec, activeRun.endSec);
  const offsetHours = (viewSec - activeRun.startSec) / 3600;
  els.timeWindowLabel.textContent = `Viewing ${formatRunOffset(offsetHours)} of ${activeRun.durationHours} h`;
  els.timelineStart.textContent = `Release ${new Date(activeRun.startSec * 1000).toISOString().slice(0, 16).replace("T", " ")} UTC`;
  els.timelineEnd.textContent = `End ${new Date(activeRun.endSec * 1000).toISOString().slice(0, 16).replace("T", " ")} UTC`;
  els.timelineCurrent.textContent = `${formatRunOffset(offsetHours)} | ${new Date(viewSec * 1000).toISOString().slice(0, 16).replace("T", " ")} UTC`;
  renderTimelineEvents();
}

function timelinePct(tSec) {
  if (!activeRun) return 0;
  return clamp(((tSec - activeRun.startSec) / Math.max(1, activeRun.endSec - activeRun.startSec)) * 100, 0, 100);
}

function renderTimelineEvents() {
  if (!activeRun || !els.timelineEvents) {
    return;
  }
  const markers = [
    { label: "Release", tSec: activeRun.startSec, type: "release" },
  ];
  const firstBeach = activeRun.snapshots.find((snapshot) => snapshot.stranded > 0);
  if (firstBeach) markers.push({ label: "First stranding", tSec: firstBeach.tSec, type: "risk" });
  const maxSpread = activeRun.snapshots.reduce((best, snapshot) => snapshot.sigmaKm > (best?.sigmaKm ?? -Infinity) ? snapshot : best, null);
  if (maxSpread) markers.push({ label: "Max spread", tSec: maxSpread.tSec, type: "spread" });
  if (activeRun.scenario === "oil") {
    const responses = collectResponses();
    if (responses.skimming.active) markers.push({ label: "Skim start", tSec: activeRun.startSec + responses.skimming.startH * 3600, type: "response" });
    if (responses.burning.active) markers.push({ label: "Burn start", tSec: activeRun.startSec + responses.burning.startH * 3600, type: "response" });
    if (responses.dispersant.active) markers.push({ label: "Dispersant start", tSec: activeRun.startSec + responses.dispersant.startH * 3600, type: "response" });
  }
  els.timelineEvents.innerHTML = markers.map((marker) =>
    `<span class="timeline-marker ${marker.type}" style="left:${timelinePct(marker.tSec)}%" title="${marker.label}"></span>`
  ).join("");
}

/* Populate scenario-specific select boxes from the model lookup tables. */
function buildLeewayOptions() {
  els.leewayCat.innerHTML = LEEWAY_CATEGORIES.map((category) => `<option value="${category.id}">${category.label} (dw ${category.dw}% | cw ${category.cw}%)</option>`).join("");
}

function buildOilOptions() {
  els.oilType.innerHTML = Object.entries(OIL_TYPES).map(([key, oil]) => `<option value="${key}">${oil.label}</option>`).join("");
}

function buildPresetOptions(preferredId) {
  const presets = SCENARIO_PRESETS[activeScenario];
  els.scenarioPreset.innerHTML = presets.map((preset) => `<option value="${preset.id}">${preset.label}</option>`).join("");
  const nextId = preferredId && presets.some((preset) => preset.id === preferredId) ? preferredId : presets[0].id;
  els.scenarioPreset.value = nextId;
  renderPresetCards();
  applyPreset(nextId, false);
}

function presetDescription(preset) {
  return `${preset.durHours} h | ${preset.nEns} particles | ${preset.useWind ? "wind on" : "currents only"}`;
}

function renderPresetCards() {
  if (!els.presetCards) return;
  const presets = SCENARIO_PRESETS[activeScenario];
  els.presetCards.innerHTML = presets.map((preset) => `
    <button type="button" class="preset-card ${preset.id === els.scenarioPreset.value ? "active" : ""}" data-preset="${preset.id}">
      <span class="preset-label">${preset.label}</span>
      <span class="preset-meta">${presetDescription(preset)}</span>
    </button>
  `).join("");
  els.presetCards.querySelectorAll(".preset-card").forEach((card) => {
    card.onclick = () => {
      els.scenarioPreset.value = card.dataset.preset;
      applyPreset(card.dataset.preset);
    };
  });
}

/* Push a preset's canned values into the live form controls. */
function applyPreset(presetId, announce = true) {
  const preset = SCENARIO_PRESETS[activeScenario].find((entry) => entry.id === presetId);
  if (!preset) {
    return;
  }
  if (preset.category) els.leewayCat.value = preset.category;
  if (preset.oilType) els.oilType.value = preset.oilType;
  if (preset.oilVol !== undefined) els.oilVol.value = preset.oilVol;
  els.relRadius.value = preset.relRadius;
  els.diffK.value = preset.diffK;
  els.durHours.value = preset.durHours;
  els.nEns.value = preset.nEns;
  els.useWind.checked = Field.hasWind ? preset.useWind : false;
  if (announce) setStatus(`Preset loaded: ${preset.label}.`);
  renderPresetCards();
  updateScenarioBadges();
  updateStoryCard();
}

/* Switch between S&R and oil modes and show/hide the matching controls. */
function setScenario(scenario, preservePreset) {
  activeScenario = scenario;
  document.querySelectorAll(".scenario-tabs button").forEach((button) => {
    button.classList.toggle("active", button.dataset.scenario === scenario);
  });
  els.leewayParams.style.display = scenario === "leeway" ? "" : "none";
  els.oilParams.style.display = scenario === "oil" ? "" : "none";
  els.responseCard.style.display = scenario === "oil" ? "" : "none";
  buildPresetOptions(preservePreset ? els.scenarioPreset.value : null);
  updateScenarioBadges();
  updateStoryCard();
}

/* Wind controls depend on both dataset availability and scenario mode. */
function syncWindControls() {
  if (Field.hasWind) {
    els.useWind.disabled = false;
    els.useWind.checked = true;
    els.windStatus.textContent = "Wind ready";
    els.windNote.textContent = `Wind loaded: ${Field.meta.wind_source}`;
  } else {
    els.useWind.checked = false;
    els.useWind.disabled = true;
    els.windStatus.textContent = "No wind in this dataset";
    els.windNote.textContent = "Current package is currents-only. The daily refresh pipeline can attach GFS wind when available.";
  }
}

function updateStoryCard() {
  const preset = selectedPreset();
  if (!els.missionSummary || !preset) return;
  const release = releasePoint
    ? `${releasePoint.lat.toFixed(4)} N, ${releasePoint.lon.toFixed(4)} E`
    : "No release point set";
  const wind = els.useWind?.checked && Field.hasWind ? "wind drift enabled" : "currents only";
  els.missionSummary.dataset.scenario = activeScenario;
  const lede = els.missionSummary.querySelector(".lede");
  if (lede) {
    lede.textContent = `${preset.label}: ${preset.durHours} h, ${preset.nEns} particles, ${wind}. Release: ${release}.`;
  }
  updateScenarioBadges();
}

/* Restore UI state from the query string so scenarios can be shared. */
function applyStateFromUrl() {
  const hash = window.location.hash.startsWith("#") ? window.location.hash.slice(1) : "";
  if (!hash) {
    return;
  }
  const params = new URLSearchParams(hash);
  const scenario = params.get("scenario");
  if (scenario === "leeway" || scenario === "oil") setScenario(scenario, true);
  const preset = params.get("preset");
  if (preset) buildPresetOptions(preset);
  if (params.get("category")) els.leewayCat.value = params.get("category");
  if (params.get("oilType")) els.oilType.value = params.get("oilType");
  if (params.get("oilVol")) els.oilVol.value = params.get("oilVol");
  [["dur", els.durHours], ["nEns", els.nEns], ["relRadius", els.relRadius], ["diffK", els.diffK]].forEach(([key, element]) => {
    if (params.get(key)) element.value = params.get(key);
  });
  if (params.get("useWind") !== null) els.useWind.checked = params.get("useWind") === "1";
  const lat = Number(params.get("lat"));
  const lon = Number(params.get("lon"));
  if (Number.isFinite(lat) && Number.isFinite(lon)) {
    releasePoint = { lat, lon };
    map.panTo([lat, lon]);
  }
  updateReleaseInfo();
  updateStoryCard();
}

/* Jump the playback head relative to the current time. */
function seekHours(deltaHours) {
  let nextSec = tIdxToSec(tIdx) + deltaHours * 3600;
  if (activeRun) {
    nextSec = clamp(nextSec, activeRun.startSec, activeRun.endSec);
  } else if (Field.loaded) {
    nextSec = clamp(nextSec, Field.t0Unix, maxDataSec());
  }
  tIdx = secToTIdx(nextSec);
  resetFrameCache();
  updateTimelinePill();
  updateResultsPanel(false);
  updatePlotCursor(true);
}

let lastTickTime = performance.now();
/* Main requestAnimationFrame loop.
 * This does the screen-time work only: advance playback, redraw layers, and
 * refresh metrics. The expensive physical run itself happens inside runEnsemble.
 */
function tick(now) {
  const dt = Math.max(0, Math.min((now - lastTickTime) / 1000, 0.1));
  lastTickTime = now;

  if (playing && Field.loaded) {
    tIdx += playSpeed * dt;
  }

  if (Field.loaded) {
    const nT = Field.times.length;
    tIdx = ((tIdx % nT) + nT) % nT;
    if (activeRun) {
      tIdx = secToTIdx(clamp(tIdxToSec(tIdx), activeRun.startSec, activeRun.endSec));
    }
    const currentIndex = Math.floor(tIdx);
    els.timeSlider.value = currentIndex;
    els.timeLabel.textContent = `${Field.times[currentIndex] || ""} UTC`;
    drawField();
    stepBgParticles(dt);
    drawBgParticles();
    drawDrift();
    updateTimelinePill();
    updateResultsPanel(false);
    updatePlotCursor(false);
  }

  requestAnimationFrame(tick);
}

/* Cache all frequently used DOM nodes once so the rest of the file can work
   with direct references instead of repeated querySelector lookups. */
function collectDomRefs() {
  Object.assign(els, {
    clearBtn: document.getElementById("clearBtn"),
    controlScenario: document.getElementById("controlScenario"),
    copyLinkBtn: document.getElementById("copyLinkBtn"),
    dataMeta: document.getElementById("data-meta"),
    diffK: document.getElementById("diffK"),
    durHours: document.getElementById("durHours"),
    exportCsvBtn: document.getElementById("exportCsvBtn"),
    exportJsonBtn: document.getElementById("exportJsonBtn"),
    exportBudgetCsvBtn: document.getElementById("exportBudgetCsvBtn"),
    exportMenu: document.getElementById("exportMenu"),
    focusBtn: document.getElementById("focusBtn"),
    jumpBack24: document.getElementById("jumpBack24"),
    jumpBack6: document.getElementById("jumpBack6"),
    jumpForward24: document.getElementById("jumpForward24"),
    jumpForward6: document.getElementById("jumpForward6"),
    leewayCat: document.getElementById("leewayCat"),
    leewayParams: document.getElementById("leeway-params"),
    missionSummary: document.getElementById("mission-summary"),
    nEns: document.getElementById("nEns"),
    nLabel: document.getElementById("n-label"),
    nSlider: document.getElementById("nSlider"),
    layerCurrents: document.getElementById("layerCurrents"),
    layerDensity: document.getElementById("layerDensity"),
    layerOilRadius: document.getElementById("layerOilRadius"),
    layerRelease: document.getElementById("layerRelease"),
    layerTracers: document.getElementById("layerTracers"),
    layerTrails: document.getElementById("layerTrails"),
    layerUncertainty: document.getElementById("layerUncertainty"),
    oilParams: document.getElementById("oil-params"),
    oilType: document.getElementById("oilType"),
    oilVol: document.getElementById("oilVol"),
    playBtn: document.getElementById("playBtn"),
    presetCards: document.getElementById("presetCards"),
    progressDetail: document.getElementById("progress-detail"),
    progressFill: document.getElementById("progress-fill"),
    progressLabel: document.getElementById("progress-label"),
    quickRunRailBtn: document.getElementById("quickRunRailBtn"),
    relRadius: document.getElementById("relRadius"),
    releaseInfo: document.getElementById("release-info"),
    results: document.getElementById("results"),
    runBtn: document.getElementById("runBtn"),
    runProgress: document.getElementById("run-progress"),
    runStatus: document.getElementById("run-status"),
    scenarioPreset: document.getElementById("scenarioPreset"),
    speedLabel: document.getElementById("speed-label"),
    speedSlider: document.getElementById("speedSlider"),
    timeLabel: document.getElementById("time-label"),
    timelineCurrent: document.getElementById("timeline-current"),
    timelineEnd: document.getElementById("timeline-end"),
    timelineEvents: document.getElementById("timeline-events"),
    timelineStart: document.getElementById("timeline-start"),
    timeSlider: document.getElementById("timeSlider"),
    timeWindowLabel: document.getElementById("time-window-label"),
    tsPlot: document.getElementById("ts-plot"),
    useWind: document.getElementById("useWind"),
    windNote: document.getElementById("wind-note"),
    windStatus: document.getElementById("windStatus"),
    // Response options
    responseCard: document.getElementById("response-card"),
    skimActive: document.getElementById("skimActive"),
    skimStart: document.getElementById("skimStart"),
    skimEnd: document.getElementById("skimEnd"),
    skimRate: document.getElementById("skimRate"),
    skimEff: document.getElementById("skimEff"),
    burnActive: document.getElementById("burnActive"),
    burnStart: document.getElementById("burnStart"),
    burnEnd: document.getElementById("burnEnd"),
    burnEff: document.getElementById("burnEff"),
    dispActive: document.getElementById("dispActive"),
    dispStart: document.getElementById("dispStart"),
    dispEnd: document.getElementById("dispEnd"),
    dispEff: document.getElementById("dispEff"),
    // Oil budget
    oilBudgetCard: document.getElementById("oil-budget-card"),
    oilBudgetInsights: document.getElementById("oil-budget-insights"),
    oilBudgetPlot: document.getElementById("oil-budget-plot"),
    oilBudgetSummary: document.getElementById("oil-budget-summary"),
    emulsionNote: document.getElementById("emulsion-note"),
  });
}

/* Attach all event handlers after DOM refs have been collected. */
function wireUi() {
  els.timeSlider.oninput = (event) => {
    tIdx = Number(event.target.value);
    resetFrameCache();
    updateTimelinePill();
    updateResultsPanel(false);
    updatePlotCursor(true);
  };

  els.speedSlider.oninput = (event) => {
    playSpeed = Number(event.target.value);
    els.speedLabel.textContent = `${playSpeed.toFixed(1)}x`;
  };

  els.nSlider.oninput = (event) => {
    nParticles = Number(event.target.value);
    els.nLabel.textContent = String(nParticles);
    makeBgParticles(nParticles);
  };

  els.playBtn.onclick = () => {
    playing = !playing;
    updatePlayButton();
  };
  els.quickRunRailBtn.onclick = runEnsemble;
  els.jumpBack24.onclick = () => seekHours(-24);
  els.jumpBack6.onclick = () => seekHours(-6);
  els.jumpForward6.onclick = () => seekHours(6);
  els.jumpForward24.onclick = () => seekHours(24);

  document.querySelectorAll(".scenario-tabs button").forEach((button) => {
    button.onclick = () => setScenario(button.dataset.scenario, false);
  });

  els.scenarioPreset.onchange = () => applyPreset(els.scenarioPreset.value);
  els.runBtn.onclick = runEnsemble;
  els.clearBtn.onclick = clearRun;
  els.copyLinkBtn.onclick = copyShareLink;
  els.exportJsonBtn.onclick = () => { exportRunJson(); els.exportMenu.open = false; };
  els.exportBudgetCsvBtn.onclick = () => { exportOilBudgetCsv(); els.exportMenu.open = false; };

  const openWebgnomeBtn = document.getElementById("openWebgnomeBtn");
  const downloadPygnomeBtn = document.getElementById("downloadPygnomeBtn");
  const webgnomeHelpBtn = document.getElementById("webgnomeHelpBtn");
  const closeWgModal = document.getElementById("closeWgModal");
  const closeWgModal2 = document.getElementById("closeWgModal2");
  const webgnomeModal = document.getElementById("webgnome-modal");
  if (openWebgnomeBtn) openWebgnomeBtn.onclick = openWebgnome;
  if (downloadPygnomeBtn) downloadPygnomeBtn.onclick = downloadPygnomeScript;
  if (webgnomeHelpBtn) webgnomeHelpBtn.onclick = showWgModal;
  if (closeWgModal) closeWgModal.onclick = hideWgModal;
  if (closeWgModal2) closeWgModal2.onclick = hideWgModal;
  if (webgnomeModal) {
    webgnomeModal.addEventListener("click", (event) => {
      if (event.target === webgnomeModal) hideWgModal();
    });
  }

  // Response tab switching
  document.querySelectorAll(".resp-tab").forEach((tab) => {
    tab.onclick = () => {
      document.querySelectorAll(".resp-tab").forEach((t) => t.classList.remove("active"));
      tab.classList.add("active");
      document.querySelectorAll(".resp-panel").forEach((p) => p.style.display = "none");
      const target = document.getElementById(`resp-${tab.dataset.resp}`);
      if (target) target.style.display = "";
    };
  });
  els.exportCsvBtn.onclick = () => { exportRunCsv(); els.exportMenu.open = false; };
  els.copyLinkBtn.onclick = () => { copyShareLink(); els.exportMenu.open = false; };

  const bindLayer = (key, inputs) => {
    inputs.filter(Boolean).forEach((input) => {
      input.onchange = () => {
        overlayState[key] = input.checked;
        syncLayerInputs();
        drawField();
        drawBgParticles();
        drawDrift();
        updateResultsPanel(true);
      };
    });
  };
  bindLayer("currents", [els.layerCurrents]);
  bindLayer("tracers", [els.layerTracers]);
  bindLayer("trails", [els.layerTrails]);
  bindLayer("density", [els.layerDensity]);
  bindLayer("uncertainty", [els.layerUncertainty]);
  bindLayer("release", [els.layerRelease]);
  bindLayer("oilRadius", [els.layerOilRadius]);
  els.useWind.onchange = updateStoryCard;

  els.focusBtn.onclick = () => {
    focusMode = !focusMode;
    els.focusBtn.textContent = focusMode ? "Exit focus" : "Focus mode";
    updateBodyState();
  };

}

/* One-time startup orchestration for map, data, controls, legend, and the
   initial background animation. */
async function boot() {
  collectDomRefs();
  wireUi();
  updatePlayButton();

  try {
    await Field.load();
  } catch (err) {
    showStartupError(`Failed to load currents data: ${err.message}`);
    return;
  }

  fieldLayer = new DualCanvasLayer().addTo(map);
  makeBgParticles(nParticles);
  drawField();
  buildLeewayOptions();
  buildOilOptions();
  buildPresetOptions();
  setScenario("leeway", true);
  syncWindControls();
  syncLayerInputs();

  els.timeSlider.max = Field.times.length - 1;
  els.dataMeta.textContent = `${Field.meta.source} | ${Field.times[0]} to ${Field.times[Field.times.length - 1]} UTC | ${Field.times.length} hourly frames`;
  updateReleaseInfo();
  updateStoryCard();
  applyStateFromUrl();

  map.on("click", (event) => {
    if (Field.isLand(event.latlng.lng, event.latlng.lat)) {
      setStatus("Release point is on land or outside the data grid.");
      return;
    }
    releasePoint = { lat: event.latlng.lat, lon: event.latlng.lng };
    updateReleaseInfo();
    updateStoryCard();
    setStatus("Release point set.");
  });

  requestAnimationFrame(tick);
}

boot();
