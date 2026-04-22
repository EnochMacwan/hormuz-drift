# Animation Build Summary

This is a quick technical handoff note for the Strait of Hormuz drift animation.

## Short summary

1. Downloaded hourly surface current data for the Strait of Hormuz from CMEMS.
2. Converted that gridded scientific data into a compact browser-friendly JSON file.
3. Used OpenDrift as the modeling reference, but reimplemented a simplified drift model in JavaScript instead of running Python in the browser.
4. Added the main particle physics in JavaScript:
   current advection, random-walk diffusion, leeway drift for SAR objects, simple Stokes-drift approximation, and a simplified oil spreading / evaporation mode.
5. Built a sampler that interpolates the gridded data in both space and time so particles move smoothly.
6. Created an ensemble system so many particles can be released at once with slightly different initial conditions.
7. Rendered the basemap with Leaflet and drew the currents / particles on stacked canvas overlays for performance.
8. Added ambient tracer particles so the current field itself looks animated even when no scenario is running.
9. Added playback controls, scenario controls, overlays, presets, and analytics in the browser UI.
10. Served it as a static web app, so the final pipeline is:
    data download -> preprocess to JSON -> interpolate in JS -> simulate particles -> draw on canvas over the map.

## Important clarification

This was not a literal line-by-line conversion of OpenDrift into JavaScript.

The approach was:

- Use CMEMS as the forcing data source.
- Use OpenDrift as the conceptual / physics reference.
- Rebuild a lightweight browser-native version of the core behavior in JavaScript.

## Which file does what

### Data preparation

- `scripts/fetch_data.py`
  Daily / refresh pipeline.
  Downloads CMEMS currents and, when available, GFS surface wind.
  Packs everything into `data/currents.json`.

- `scripts/prepare_data.py`
  Local one-shot converter.
  Takes the local NetCDF file and builds `data/currents.json`.
  Useful for offline or manual workflow.

- `data/currents.json`
  Browser input data.
  Contains timestamps, lat/lon grid, `u/v` currents, and optional `uw/vw` wind.

### Data loading and interpolation

- `js/field.js`
  Loads `data/currents.json`.
  Provides bilinear spatial interpolation and linear time interpolation.
  Exposes helper functions like:
  - current sampling
  - wind sampling
  - land / out-of-bounds checks

This is what makes the particles move smoothly instead of snapping cell to cell.

### Drift physics

- `js/drift.js`
  Core particle model.
  Defines:
  - SAR leeway categories
  - oil presets
  - `Drifter` particle class
  - `OilSlick` helper model
  - `spawnEnsemble()` for multi-particle runs

Main physics implemented here:

- ocean-current advection
- RK2 / midpoint stepping
- random-walk diffusion
- leeway drift
- simple Stokes drift approximation
- simplified oil spreading and evaporation

### Animation and rendering

- `js/app.js`
  Main browser orchestration layer.
  Handles:
  - map setup
  - stacked canvas overlays
  - ambient tracer animation
  - playback loop
  - scenario execution
  - trail / density / uncertainty overlays
  - analytics and export

This is the main animation file.

Important pieces inside it:

- background tracer particles for visual motion
- field coloring by current direction / speed
- playback frame reconstruction from stored particle tracks
- per-frame redraw through `requestAnimationFrame`

### UI shell

- `index.html`
  The app structure and UI layout.

- `css/style.css`
  Visual styling, layout, and responsive behavior.

### Reference / context

- `README.md`
  Project overview, scope, caveats, and deployment notes.

## Practical mental model

If you want to understand the build in the simplest way, think of it as five stages:

1. Get ocean data.
2. Convert it to a format the browser can load fast.
3. Interpolate the vector field at arbitrary particle positions.
4. Move particles through that field over time.
5. Draw everything efficiently on canvas over a map.

## Good places to experiment

If you want to play with the process, the easiest knobs are:

- `js/field.js`
  Change how the data is sampled.

- `js/drift.js`
  Change how particles move.

- `js/app.js`
  Change how the motion is visualized.

Best specific beginner experiments:

1. Change background tracer lifetime / fade rate.
2. Change diffusion strength.
3. Change particle count.
4. Change trail / density rendering.
5. Change playback speed and run duration.
