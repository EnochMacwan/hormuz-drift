/* field.js — load forcing data and provide bilinear + temporal sampling
 * ------------------------------------------------------------------
 *   Field.load()            -> fetch data/currents.json
 *   Field.sampleCurrent(lon,lat,tSec)  -> {u,v} m/s   or null (land/OOB)
 *   Field.sampleWind(lon,lat,tSec)     -> {u,v} m/s   or null
 *   Field.t0Unix                      -> start epoch (sec)
 *   Field.dtSec                       -> grid time step (sec)
 *   Field.times[]                     -> ISO strings (for UI)
 *   Field.grid                        -> {lats, lons, nLat, nLon, dlat, dlon}
 */
window.Field = (() => {
  const F = {
    loaded:false, meta:null, times:[],
    grid:{lats:null, lons:null, nLat:0, nLon:0, dlat:0, dlon:0,
          latMin:0, latMax:0, lonMin:0, lonMax:0},
    u:null, v:null, uw:null, vw:null,
    hasWind:false,
    t0Unix:0, dtSec:3600,
  };

  F.load = async function(url = 'data/currents.json'){
    if (window.location.protocol === 'file:'){
      throw new Error(
        'This app cannot load data over file://. Start a local server and open http://localhost:8000 instead.'
      );
    }

    let r;
    try {
      r = await fetch(url);
    } catch (err) {
      throw new Error(
        `Could not reach ${url}. Start a local server and open the site over http://localhost:8000.`
      );
    }

    if (!r.ok) throw new Error(`Failed to load ${url}: ${r.status}`);
    const d = await r.json();
    F.meta  = d.meta;
    F.times = d.times;
    F.u = d.u; F.v = d.v;
    F.uw = d.uw; F.vw = d.vw;   // may be null (wind not yet integrated)
    F.hasWind = Array.isArray(F.uw) && Array.isArray(F.vw);
    F.grid.lats = d.lats; F.grid.lons = d.lons;
    F.grid.nLat = d.lats.length; F.grid.nLon = d.lons.length;
    F.grid.dlat = d.meta.dlat;  F.grid.dlon = d.meta.dlon;
    F.grid.latMin = d.lats[0]; F.grid.latMax = d.lats[F.grid.nLat - 1];
    F.grid.lonMin = d.lons[0]; F.grid.lonMax = d.lons[F.grid.nLon - 1];
    F.t0Unix = Date.parse(d.times[0].replace(' ','T') + 'Z') / 1000;
    F.dtSec = d.meta.time_step_sec;
    F.loaded = true;
    return F;
  };

  /* ─── bilinear space + linear time on a 3-D (t,lat,lon) grid ─────── */
  function _sample(arr, lon, lat, tSec){
    if (!arr) return null;
    const g = F.grid;
    const i = (lon - g.lonMin) / g.dlon;
    const j = (lat - g.latMin) / g.dlat;
    if (i < 0 || i >= g.nLon - 1 || j < 0 || j >= g.nLat - 1) return null;

    const tf    = (tSec - F.t0Unix) / F.dtSec;          // fractional time idx
    const nT    = F.times.length;
    const tWrap = ((tf % nT) + nT) % nT;                // loop if past end
    const t0    = Math.floor(tWrap) | 0;
    const t1    = (t0 + 1) % nT;
    const ft    = tWrap - Math.floor(tWrap);

    const i0 = Math.floor(i), j0 = Math.floor(j);
    const fi = i - i0,        fj = j - j0;

    function atT(ti){
      const a = arr[ti][j0    ][i0    ];
      const b = arr[ti][j0    ][i0 + 1];
      const c = arr[ti][j0 + 1][i0    ];
      const d = arr[ti][j0 + 1][i0 + 1];
      if (a === null || b === null || c === null || d === null) return null;
      return (1 - fi)*(1 - fj)*a + fi*(1 - fj)*b
           + (1 - fi)*fj      *c + fi*fj      *d;
    }
    const A = atT(t0), B = atT(t1);
    if (A === null || B === null) return null;
    return A * (1 - ft) + B * ft;
  }

  F.sampleCurrent = function(lon, lat, tSec){
    const u = _sample(F.u, lon, lat, tSec);
    const v = _sample(F.v, lon, lat, tSec);
    if (u === null || v === null) return null;
    return {u, v};
  };

  F.sampleWind = function(lon, lat, tSec){
    if (!F.uw || !F.vw) return null;
    const u = _sample(F.uw, lon, lat, tSec);
    const v = _sample(F.vw, lon, lat, tSec);
    if (u === null || v === null) return null;
    return {u, v};
  };

  /* convenience: is this (lon,lat) on land / OOB at any time? */
  F.isLand = function(lon, lat){
    const g = F.grid;
    const i = Math.round((lon - g.lonMin) / g.dlon);
    const j = Math.round((lat - g.latMin) / g.dlat);
    if (i < 0 || i >= g.nLon || j < 0 || j >= g.nLat) return true;
    return F.u[0][j][i] === null;
  };

  /* integer grid index for a lon/lat (for click-to-plot cell picking) */
  F.nearestCell = function(lon, lat){
    const g = F.grid;
    const i = Math.round((lon - g.lonMin) / g.dlon);
    const j = Math.round((lat - g.latMin) / g.dlat);
    if (i < 0 || i >= g.nLon || j < 0 || j >= g.nLat) return null;
    return {i, j, lon: g.lons[i], lat: g.lats[j]};
  };

  return F;
})();
