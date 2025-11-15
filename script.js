/*
  Toronto BikeShare Heatmap — D3.js
  - Loads monthly CSVs from /data/
  - Cleans rows (drops NULL/empty), keeps required fields
  - Aggregates per station by month and member type
  - Renders stations as red circles sized/colored by usage
  - Hover tooltip, month filter, membership filter
  - Click station to show top 5 routes, with Back button
  - Zoom and pan via d3.zoom and buttons
*/

(function() {
  const MONTHS = [
    'January','February','March','April','May','June',
    'July','August','September','October','November','December'
  ];

  const files = [
    'sample-data/Bike share ridership 2023-01.csv',
    'sample-data/Bike share ridership 2023-02.csv',
    'sample-data/Bike share ridership 2023-03.csv',
    'sample-data/Bike share ridership 2023-04.csv',
    'sample-data/Bike share ridership 2023-05.csv',
    'sample-data/Bike share ridership 2023-06.csv',
    'sample-data/Bike share ridership 2023-07.csv',
    'sample-data/Bike share ridership 2023-08.csv',
    'sample-data/Bike share ridership 2023-09.csv',
    'sample-data/Bike share ridership 2023-10.csv',
    'sample-data/Bike share ridership 2023-11.csv',
    'sample-data/Bike share ridership 2023-12.csv'
  ];

  const state = {
     allData: [], // [{month: '2023-01', trips: [...]}]
     stationAgg: null, // { memberKey -> { monthKey -> Map(station -> {start, end}) } }
     endRoutes: null, // { memberKey -> { monthKey -> { startStation -> Map(endStation -> count) } } }
     debugStats: [], // per-file debug info
     isDetail: false,
     selectedStation: null,
     selectedMember: 'All',
     selectedMonthKey: 'All',
     mode3d: false,
     yaw: 0, // rotation around Y (left-right)
     pitch: 0, // rotation around X (up-down)
     width: 0,
     height: 0,
     minRouteCount: 0,
     minRoutePercent: 0,
     hideLowNodes: false,
     // new: palettes and geocode stores
     colorBlind: false,
     stationPos: new Map(),
     stationPosNorm: new Map(),
   };

  // UI elements
  const byMonthEl = document.getElementById('byMonth');
  const monthSliderEl = document.getElementById('monthSlider');
  const monthLabelEl = document.getElementById('monthLabel');
  const memberRadioEls = Array.from(document.querySelectorAll('input[name="memberType"]'));
  const routeInfoEl = document.getElementById('routeInfo');
  const backButtonEl = document.getElementById('backButton');
  const tooltipEl = document.getElementById('tooltip');
  const minRouteSliderEl = document.getElementById('minRouteSlider');
  const minRouteLabelEl = document.getElementById('minRouteLabel');
  const routeHistSvg = d3.select('#routeHist');
  const hideLowNodesEl = document.getElementById('hideLowNodes');
  const colorBlindEl = document.getElementById('colorBlindPalette');
  const legendGradient = d3.select('#legendGradient');
  const legendSizeSvg = d3.select('#legendSize');

  // Table elements
  const topStartTableBody = document.querySelector('#topStartTable tbody');

  // SVG
  const svg = d3.select('#map');
  const gRoot = svg.append('g').attr('class', 'root');
  const gBase = gRoot.append('g').attr('class', 'base');
  const gGrid = gRoot.append('g').attr('class', 'grid3d');
  const gRoutes = gRoot.append('g').attr('class', 'routes');
  const gStations = gRoot.append('g').attr('class', 'stations');
  const gLabels = gRoot.append('g').attr('class', 'labels');

  // Zoom behavior
  // Allow zooming out further to see the full network
  const zoom = d3.zoom().scaleExtent([0.05, 32]).on('zoom', (event) => {
    gRoot.attr('transform', event.transform);
  });
  // Helper to switch zoom filter depending on 3D mode (allow only wheel zoom in 3D to keep drag for rotation)
  function applyZoomFilter() {
    if (state.mode3d) {
      zoom.filter((event) => event.type === 'wheel');
    } else {
      zoom.filter(null); // default behavior (pan on drag, wheel zoom)
    }
  }
  applyZoomFilter();
  svg.call(zoom);
  d3.select('#zoomIn').on('click', () => svg.transition().call(zoom.scaleBy, 1.25));
  d3.select('#zoomOut').on('click', () => svg.transition().call(zoom.scaleBy, 0.8));

  // Events
  const mode3dEl = document.getElementById('mode3d');
  if (mode3dEl) {
    mode3dEl.addEventListener('change', () => {
      state.mode3d = !!mode3dEl.checked;
      // On enable 3D, reset yaw/pitch and set zoom filter; on disable, also reset cursor
      state.yaw = 0; state.pitch = 0;
      applyZoomFilter();
      // Toggle dark background look via class
      try { svg.classed('three-d', state.mode3d); } catch(_) {}
      // Reset zoom/pan to center when toggling for a clean view
      try { svg.transition().duration(300).call(zoom.transform, d3.zoomIdentity); } catch(_) {}
      // Update cursor hint
      try { svg.style('cursor', state.mode3d ? 'grab' : null); } catch(_) {}
      if (state.isDetail) exitDetailView();
      // Remove grid lines in 3D mode (no-op grid)
      gGrid.selectAll('*').remove();
      updateVis();
    });
  }

  // Simple 3D grid model storage
  state.gridSegments = [];
  function buildGridModel() {
    try {
      const W = state.width || 960;
      const H = state.height || 600;
      const zMax = Math.min(W, H) * 0.3; // match depth range used in projection
      const step = Math.round(Math.min(W, H) / 8); // coarse grid
      const zSteps = 4; // number of Z slices on each side (total 2*zSteps+1)
      const cx = W/2, cy = H/2;
      const segs = [];
      for (let k = -zSteps; k <= zSteps; k++) {
        const z = (k / zSteps) * zMax;
        // horizontal lines (varying x)
        for (let y = -cy; y <= cy + 0.1; y += step) {
          segs.push({ x1: -cx, y1: y, z1: z, x2: cx, y2: y, z2: z });
        }
        // vertical lines (varying y)
        for (let x = -cx; x <= cx + 0.1; x += step) {
          segs.push({ x1: x, y1: -cy, z1: z, x2: x, y2: cy, z2: z });
        }
      }
      state.gridSegments = segs;
    } catch (e) {
      state.gridSegments = [];
    }
  }

  // Drag-to-rotate interactions for 3D mode (background space)
  let rotating = false;
  let lastPX = 0, lastPY = 0;
  const ROT_SENS = 0.005; // radians per pixel
  svg.on('pointerdown', (event) => {
    if (!state.mode3d) return;
    // Ignore when starting on interactive elements (nodes/labels/links)
    const t = event.target;
    if (t && (t.closest && (t.closest('circle.station') || t.closest('text.label') || t.closest('line.route-line')))) return;
    rotating = true;
    lastPX = event.clientX; lastPY = event.clientY;
    try { svg.style('cursor', 'grabbing'); } catch(_) {}
    event.preventDefault();
  });
  svg.on('pointermove', (event) => {
    if (!rotating) return;
    const dx = event.clientX - lastPX;
    const dy = event.clientY - lastPY;
    lastPX = event.clientX; lastPY = event.clientY;
    // Reverse yaw so dragging right rotates the scene to the right (intuitive)
    state.yaw -= dx * ROT_SENS;
    state.pitch += dy * ROT_SENS;
    // Clamp pitch to avoid flipping
    const maxPitch = Math.PI/2 * 0.88;
    if (state.pitch > maxPitch) state.pitch = maxPitch;
    if (state.pitch < -maxPitch) state.pitch = -maxPitch;
    // Redraw with current simulation positions
    if (typeof state.current3dRedraw === 'function') state.current3dRedraw();
    event.preventDefault();
  });
  function endRotate(){
    if (!rotating) return;
    rotating = false;
    try { svg.style('cursor', state.mode3d ? 'grab' : null); } catch(_) {}
  }
  svg.on('pointerup', endRotate);
  svg.on('pointerleave', endRotate);

  byMonthEl.addEventListener('change', () => {
    monthSliderEl.disabled = !byMonthEl.checked;
    if (!byMonthEl.checked) {
      state.selectedMonthKey = 'All';
      monthLabelEl.textContent = 'All months';
    } else {
      updateMonthFromSlider();
    }
    if (state.isDetail) exitDetailView();
    updateVis();
  });

  if (minRouteSliderEl) {
    const updateMinRouteLabel = (count = 0, p = 0) => {
      if (minRouteLabelEl) {
        const pct = Math.round(p);
        minRouteLabelEl.textContent = `≥ ${count} trip${count===1?'':'s'} (P${pct})`;
      }
    };
    minRouteSliderEl.addEventListener('input', () => {
      state.minRoutePercent = +minRouteSliderEl.value || 0;
      // Defer label update to updateVis where we know the mapped count
      updateVis();
    });
    // Initialize label
    updateMinRouteLabel(0, 0);
  }

  if (hideLowNodesEl) {
    hideLowNodesEl.addEventListener('change', () => {
      state.hideLowNodes = !!hideLowNodesEl.checked;
      if (state.isDetail) exitDetailView();
      updateVis();
    });
  }

  // Color-blind-friendly palette toggle
  if (colorBlindEl) {
    colorBlindEl.addEventListener('change', () => {
      state.colorBlind = !!colorBlindEl.checked;
      updateVis();
    });
  }

  monthSliderEl.addEventListener('input', () => {
    updateMonthFromSlider();
    if (state.isDetail) exitDetailView();
    updateVis();
  });

  memberRadioEls.forEach(r => r.addEventListener('change', () => {
    const checked = memberRadioEls.find(x => x.checked);
    state.selectedMember = checked ? checked.value : 'All';
    if (state.isDetail) exitDetailView();
    updateVis();
  }));

  backButtonEl.addEventListener('click', () => {
    exitDetailView();
    updateVis();
  });

  function updateMonthFromSlider() {
    const m = +monthSliderEl.value; // 1..12
    state.selectedMonthKey = m.toString().padStart(2, '0');
    monthLabelEl.textContent = MONTHS[m-1];
  }

  // Inject a synthetic demo station and routes if no valid trips were loaded from CSVs.
  function injectSyntheticIfNeeded() {
    try {
      const totalTrips = state.allData.reduce((sum, m) => sum + (m.trips ? m.trips.length : 0), 0);
      if (totalTrips > 0) return; // Real data exists; no need for synthetic demo

      const mm = '09';
      const monthKey = '2023-09';

      const demoStart = { name: 'Demo Station (Synthetic)', lat: 43.6532, lng: -79.3832 };
      const ends = [
        { name: 'Union Station (Synthetic)',      lat: 43.6450, lng: -79.3800, count: 40 },
        { name: 'Harbourfront (Synthetic)',       lat: 43.6390, lng: -79.3800, count: 30 },
        { name: 'Chinatown (Synthetic)',          lat: 43.6520, lng: -79.3980, count: 20 },
        { name: 'Distillery District (Synthetic)',lat: 43.6500, lng: -79.3590, count: 15 },
        { name: 'Kensington Market (Synthetic)',  lat: 43.6550, lng: -79.4050, count: 10 }
      ];

      const trips = [];
      ends.forEach((e) => {
        for (let i = 0; i < e.count; i++) {
          trips.push({
            start_station_name: demoStart.name,
            end_station_name: e.name,
            start_lat: demoStart.lat,
            start_lng: demoStart.lng,
            end_lat: e.lat,
            end_lng: e.lng,
            member_type: (i % 2 === 0 ? 'Annual' : 'Casual')
          });
        }
      });

      state.allData.push({ month: monthKey, mm, trips });

      // Seed station positions for projection and routing
      state.stationPos.set(demoStart.name, { lat: demoStart.lat, lng: demoStart.lng });
      ends.forEach(e => state.stationPos.set(e.name, { lat: e.lat, lng: e.lng }));

      console.info('Injected synthetic BikeShare demo data (no valid CSV rows detected).');
    } catch (e) {
      console.warn('Failed to inject synthetic data:', e);
    }
  }

  // Tooltip helpers
  function showTooltip(html, x, y) {
    tooltipEl.innerHTML = html;
    tooltipEl.style.display = 'block';
    const pad = 12;
    tooltipEl.style.left = `${x + pad}px`;
    tooltipEl.style.top = `${y + pad}px`;
  }
  function hideTooltip() { tooltipEl.style.display = 'none'; }

  // Distance helpers (Haversine)
  function haversineKm(a, b){
    if (!a || !b) return null;
    const R = 6371; // km
    const toRad = (deg) => deg * Math.PI / 180;
    const dLat = toRad((b.lat||0) - (a.lat||0));
    const dLng = toRad((b.lng||0) - (a.lng||0));
    const lat1 = toRad(a.lat||0), lat2 = toRad(b.lat||0);
    const h = Math.sin(dLat/2)**2 + Math.cos(lat1)*Math.cos(lat2)*Math.sin(dLng/2)**2;
    const d = 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
    return d; // km
  }
  function fmtDist(d){
    if (d == null || !isFinite(d)) return '';
    const km = d;
    const mi = d * 0.621371;
    return `${km.toFixed(1)} km (${mi.toFixed(1)} mi)`;
  }

  // Load base map (Toronto GeoJSON) and optional station geocodes
  let geojson = null;
  const geoUrl = 'https://raw.githubusercontent.com/codeforgermany/click_that_hood/main/public/data/toronto.geojson';
  const geocodeUrl = 'stations-geocoded.json';
  // Try multiple GBFS endpoints for Bike Share Toronto station info (lat/lng)
  const gbfsStationInfoUrls = [
    'https://toronto.publicbikesystem.net/ube/gbfs/v2/en/station_information.json',
    'https://toronto.publicbikesystem.net/ube/gbfs/v1/en/station_information.json',
    'https://gbfs.bikesharetoronto.com/gbfs/en/station_information.json'
  ];

  async function ensureProjection() {
    try {
      if (!geojson) {
        geojson = await fetch(geoUrl).then(r => r.json()).catch(() => null);
      }
      if (!state.projection && geojson) {
        state.projection = d3.geoMercator().fitSize([state.width, state.height], geojson);
        // compute geographic centroid of Toronto for fallback placement
        try { state.torontoCentroid = d3.geoCentroid(geojson); } catch(_) { state.torontoCentroid = [-79.3832, 43.6532]; }
      }
      // Load GBFS station information (authoritative lat/lng) once
      if (!state.gbfsLoaded) {
        state.gbfsLoaded = true;
        for (const url of gbfsStationInfoUrls) {
          try {
            const gbfs = await fetch(url, { cache: 'no-store' }).then(r => r.ok ? r.json() : null).catch(() => null);
            const stations = gbfs?.data?.stations || gbfs?.stations || [];
            if (Array.isArray(stations) && stations.length) {
              stations.forEach(s => {
                const name = (s.name || s.station_name || s.short_name || '').trim();
                const lat = +s.lat; const lng = +(s.lon ?? s.lng);
                if (name && isFinite(lat) && isFinite(lng)) {
                  state.stationPos.set(name, { lat, lng });
                  const norm = normalizeName(name);
                  state.stationPosNorm.set(norm, { lat, lng });
                }
              });
              console.info(`Loaded ${stations.length} stations from GBFS: ${url}`);
              break;
            }
          } catch (e) {
            // try next URL
          }
        }
      }
      // Optionally load local station geocodes once (used as manual overrides/additions)
      if (!state.geocodesLoaded) {
        state.geocodesLoaded = true;
        try {
          const arr = await fetch(geocodeUrl).then(r => r.ok ? r.json() : null).catch(() => null);
          if (Array.isArray(arr)) {
            arr.forEach(rec => {
              if (rec && rec.name && isFinite(rec.lat) && isFinite(rec.lng)) {
                state.stationPos.set(String(rec.name), { lat: +rec.lat, lng: +rec.lng });
                state.stationPosNorm.set(normalizeName(String(rec.name)), { lat: +rec.lat, lng: +rec.lng });
              }
            });
            console.info(`Loaded ${arr.length} station geocodes from ${geocodeUrl}`);
          }
        } catch (e) {
          // optional, ignore
        }
      }
    } catch (e) {
      console.warn('ensureProjection failed', e);
    }
  }

  // Load CSVs, build caches, and render debug/table BEFORE drawing the network
  loadAllCSVs()
    .then(() => {
      buildCaches();
      renderDebugTable();
      updateTopStartTable();
      initCanvas();
      updateVis();
    })
    .catch(err => {
      console.error('Initialization error', err);
    });

  function initCanvas() {
    const container = document.getElementById('map-container');
    state.width = container.clientWidth || 960;
    state.height = container.clientHeight || 600;
    svg.attr('viewBox', `0 0 ${state.width} ${state.height}`);

    // One-time SVG defs for glow effect and gradients
    if (!state.defsInitialized) {
      const defs = svg.append('defs');
      state.defs = defs;
      const glow = defs.append('filter').attr('id', 'glow');
      glow.append('feGaussianBlur')
        .attr('in', 'SourceGraphic')
        .attr('stdDeviation', 2)
        .attr('result', 'blur');
      const merge = glow.append('feMerge');
      merge.append('feMergeNode').attr('in', 'blur');
      merge.append('feMergeNode').attr('in', 'SourceGraphic');
      state.defsInitialized = true;
    }
  }

  function drawBaseMap() {
    gBase.selectAll('*').remove();
    if (!geojson) return; // optional
    const path = d3.geoPath(state.projection);
    gBase.selectAll('path')
      .data(geojson.features || [geojson])
      .join('path')
      .attr('d', path)
      .attr('fill', '#f0f2f5')
      .attr('stroke', '#c7cdd4')
      .attr('stroke-width', 0.6);
  }

  async function loadAllCSVs() {
    const results = await Promise.all(files.map((path) => d3.csv(path).catch(() => [])));
    state.allData = [];
    state.debugStats = [];

    for (let i = 0; i < files.length; i++) {
      const path = files[i];
      const rows = results[i] || [];
      const m = path.match(/(\d{4})-(\d{2})/);
      const monthKey = m ? `${m[1]}-${m[2]}` : 'unknown';
      const monthMM = m ? m[2] : '01';

      const cleanedTrips = [];
      const rawCount = rows.length;
      const columns = rawCount ? Object.keys(rows[0]) : [];
      const expected = ['Start Station Name','End Station Name','Start Station Id','End Station Id','User Type'];

      for (const row of rows) {
        const startName = safeStr(row['Start Station Name']);
        const endName = safeStr(row['End Station Name']);
        const memberRaw = safeStr(row['User Type']);
        const member = memberRaw.replace(/\s*Member$/i, ''); // Normalize to Annual|Casual

        // Validate essentials available in the sample dataset
        if (!startName || !endName || !member) continue;
        if (startName.toUpperCase() === 'NULL' || endName.toUpperCase() === 'NULL') continue;

        cleanedTrips.push({
          start_station_name: startName,
          end_station_name: endName,
          member_type: (member === 'Annual' || member === 'Casual') ? member : 'Other'
        });
      }

      const cleanedCount = cleanedTrips.length;
      const missing = expected.filter(k => !columns.includes(k));
      state.debugStats.push({
        file: path.replace(/^.*\//, ''),
        month: monthKey,
        rawRows: rawCount,
        cleanedRows: cleanedCount,
        columns,
        expectedPresent: expected.length - missing.length,
        expectedTotal: expected.length,
        missing
      });

      state.allData.push({ month: monthKey, mm: monthMM, trips: cleanedTrips });
    }
  }

  function buildCaches() {
    const members = ['All', 'Annual', 'Casual'];
    const months = ['All', '01','02','03','04','05','06','07','08','09','10','11','12'];

    const stationAgg = Object.create(null);
    const endRoutes = Object.create(null);

    for (const mem of members) {
      stationAgg[mem] = Object.create(null);
      endRoutes[mem] = Object.create(null);
      for (const mk of months) {
        stationAgg[mem][mk] = new Map();
        endRoutes[mem][mk] = Object.create(null); // startStation -> Map(end -> count)
      }
    }

    function updateStation(map, name, type) {
      if (!name) return;
      let rec = map.get(name);
      if (!rec) { rec = { name, start: 0, end: 0 }; map.set(name, rec); }
      if (type === 'start') rec.start += 1; else if (type === 'end') rec.end += 1;
    }

    for (const monthObj of state.allData) {
      const mm = monthObj.mm;
      for (const trip of monthObj.trips) {
        const mt = trip.member_type === 'Annual' ? 'Annual' : (trip.member_type === 'Casual' ? 'Casual' : 'Other');
        const applyMembers = mt === 'Other' ? ['All'] : ['All', mt];

        for (const mem of applyMembers) {
          // All months
          updateStation(stationAgg[mem]['All'], trip.start_station_name, 'start');
          updateStation(stationAgg[mem]['All'], trip.end_station_name, 'end');
          // Specific month
          updateStation(stationAgg[mem][mm], trip.start_station_name, 'start');
          updateStation(stationAgg[mem][mm], trip.end_station_name, 'end');

          // End routes from start -> end
          if (!endRoutes[mem]['All'][trip.start_station_name]) {
            endRoutes[mem]['All'][trip.start_station_name] = new Map();
          }
          const mAll = endRoutes[mem]['All'][trip.start_station_name];
          mAll.set(trip.end_station_name, (mAll.get(trip.end_station_name) || 0) + 1);

          if (!endRoutes[mem][mm][trip.start_station_name]) {
            endRoutes[mem][mm][trip.start_station_name] = new Map();
          }
          const mMonth = endRoutes[mem][mm][trip.start_station_name];
          mMonth.set(trip.end_station_name, (mMonth.get(trip.end_station_name) || 0) + 1);
        }
      }
    }

    state.stationAgg = stationAgg;
    state.endRoutes = endRoutes;
  }

  function renderDebugTable() {
    try {
      const tbody = document.querySelector('#debugTable tbody');
      if (!tbody) return;
      tbody.innerHTML = '';

      const stats = state.debugStats || [];
      let totalRaw = 0, totalClean = 0;

      stats.forEach(s => {
        totalRaw += s.rawRows || 0;
        totalClean += s.cleanedRows || 0;
        const tr = document.createElement('tr');

        const tdFile = document.createElement('td');
        tdFile.textContent = s.file;
        tr.appendChild(tdFile);

        const tdMonth = document.createElement('td');
        tdMonth.textContent = s.month;
        tr.appendChild(tdMonth);

        const tdRaw = document.createElement('td');
        tdRaw.className = 'num';
        tdRaw.textContent = (s.rawRows || 0).toLocaleString();
        tr.appendChild(tdRaw);

        const tdClean = document.createElement('td');
        tdClean.className = 'num';
        tdClean.textContent = (s.cleanedRows || 0).toLocaleString();
        tr.appendChild(tdClean);

        const tdSpec = document.createElement('td');
        const ok = (s.expectedPresent || 0) === (s.expectedTotal || 0);
        tdSpec.innerHTML = `<span class="${ok ? 'status-ok' : 'status-bad'}">${s.expectedPresent}/${s.expectedTotal}${ok ? '' : ' (missing: ' + (s.missing || []).join(', ') + ')'}</span>`;
        tr.appendChild(tdSpec);

        const tdCols = document.createElement('td');
        tdCols.textContent = (s.columns || []).join(', ');
        tr.appendChild(tdCols);

        tbody.appendChild(tr);
      });

      // Totals row
      const trTot = document.createElement('tr');
      const tdLabel = document.createElement('td');
      tdLabel.colSpan = 2;
      tdLabel.innerHTML = '<strong>Totals</strong>';
      trTot.appendChild(tdLabel);

      const tdTotRaw = document.createElement('td');
      tdTotRaw.className = 'num';
      tdTotRaw.innerHTML = `<strong>${totalRaw.toLocaleString()}</strong>`;
      trTot.appendChild(tdTotRaw);

      const tdTotClean = document.createElement('td');
      tdTotClean.className = 'num';
      tdTotClean.innerHTML = `<strong>${totalClean.toLocaleString()}</strong>`;
      trTot.appendChild(tdTotClean);

      const tdBlank1 = document.createElement('td');
      trTot.appendChild(tdBlank1);

      const tdBlank2 = document.createElement('td');
      trTot.appendChild(tdBlank2);

      tbody.appendChild(trTot);
    } catch (e) {
      console.warn('Failed to render debug table', e);
    }
  }

  // Render a tiny histogram of route popularity values under the percentile slider
  function renderRouteHistogram(values, cutoff) {
    if (!routeHistSvg || routeHistSvg.empty()) return;
    const width = +routeHistSvg.attr('width') || 360;
    const height = +routeHistSvg.attr('height') || 40;
    const margin = { top: 6, right: 6, bottom: 8, left: 6 };
    const innerW = width - margin.left - margin.right;
    const innerH = height - margin.top - margin.bottom;

    const g = routeHistSvg.selectAll('g.root').data([0]).join('g').attr('class', 'root')
      .attr('transform', `translate(${margin.left},${margin.top})`);

    // Clear if no values
    if (!values || !values.length) {
      g.selectAll('*').remove();
      return;
    }

    const x = d3.scaleLinear().domain(d3.extent(values)).nice().range([0, innerW]);
    const bins = d3.bin().domain(x.domain()).thresholds(20)(values);
    const y = d3.scaleLinear().domain([0, d3.max(bins, d => d.length) || 1]).range([innerH, 0]);

    const bars = g.selectAll('rect.bar').data(bins);
    bars.join('rect')
      .attr('class', d => `bar${(cutoff != null && (d.x1 >= cutoff)) ? ' active' : ''}`)
      .attr('x', d => x(d.x0) + 0.5)
      .attr('y', d => y(d.length))
      .attr('width', d => Math.max(0, x(d.x1) - x(d.x0) - 1))
      .attr('height', d => innerH - y(d.length))
      .attr('rx', 1.5);

    // Axis baseline
    g.selectAll('line.axis').data([0]).join('line')
      .attr('class', 'axis-line')
      .attr('x1', 0).attr('y1', innerH + 0.5)
      .attr('x2', innerW).attr('y2', innerH + 0.5);

    // P50 marker at the middle of the track (visual guidance)
    const p50Val = d3.quantileSorted(values, 0.5) || 0;
    const p50x = x(p50Val);
    g.selectAll('line.p50').data([p50x]).join('line')
      .attr('class', 'marker p50')
      .attr('x1', p50x).attr('x2', p50x)
      .attr('y1', 0).attr('y2', innerH);

    // Current cutoff marker
    const cx = x(cutoff || 0);
    g.selectAll('line.cutoff').data([cx]).join('line')
      .attr('class', 'marker cutoff')
      .attr('x1', cx).attr('x2', cx)
      .attr('y1', 0).attr('y2', innerH);
  }

  function updateTopStartTable() {
    try {
      if (!topStartTableBody) return;
      const memberKey = state.selectedMember || 'All';
      const monthKey = state.selectedMonthKey || 'All';
      const aggMap = state.stationAgg?.[memberKey]?.[monthKey] || new Map();

      const rows = Array.from(aggMap.values())
        .filter(d => (d.start || 0) > 0)
        .map(d => ({
          name: d.name,
          start: d.start || 0,
          end: d.end || 0,
          total: (d.start || 0) + (d.end || 0)
        }))
        .sort((a, b) => b.start - a.start)
        .slice(0, 25);

      // Clear body
      topStartTableBody.innerHTML = '';

      if (rows.length === 0) {
        const tr = document.createElement('tr');
        const td = document.createElement('td');
        td.colSpan = 5;
        td.textContent = 'No data to display for the current filters.';
        tr.appendChild(td);
        topStartTableBody.appendChild(tr);
        return;
      }

      rows.forEach((r, idx) => {
        const tr = document.createElement('tr');

        const tdRank = document.createElement('td');
        tdRank.className = 'rank';
        tdRank.textContent = String(idx + 1);
        tr.appendChild(tdRank);

        const tdName = document.createElement('td');
        const a = document.createElement('a');
        a.href = 'javascript:void(0)';
        a.className = 'station-link';
        a.textContent = r.name;
        a.title = 'Show top routes from this station';
        a.addEventListener('click', () => {
          goToDetail(r.name);
          updateVis();
        });
        tdName.appendChild(a);
        tr.appendChild(tdName);

        const tdStart = document.createElement('td');
        tdStart.className = 'num';
        tdStart.textContent = r.start.toLocaleString();
        tr.appendChild(tdStart);

        const tdEnd = document.createElement('td');
        tdEnd.className = 'num';
        tdEnd.textContent = r.end.toLocaleString();
        tr.appendChild(tdEnd);

        const tdTotal = document.createElement('td');
        tdTotal.className = 'num';
        tdTotal.textContent = r.total.toLocaleString();
        tr.appendChild(tdTotal);

        topStartTableBody.appendChild(tr);
      });
    } catch (e) {
      // fail-safe: don't break visualization if table rendering fails
      console.warn('Failed to update top start table', e);
    }
  }

  function updateVis() {
    // Show/hide base map depending on mode
    try { gBase.style('display', state.mode3d ? 'none' : null); } catch(_) {}

    // Precompute a deterministic Z-depth per node name when in 3D mode
    function depthFor(name){
      if (!state.mode3d) return 0;
      const s = String(name);
      let h = 0;
      for (let i=0;i<s.length;i++) h = (h*31 + s.charCodeAt(i)) | 0;
      const u = ((h >>> 0) % 1000) / 999; // 0..1
      const zRange = Math.min(state.width, state.height) * 0.6; // depth span in px
      return (u*2 - 1) * (zRange*0.5); // -z..+z
    }
    function projectXY(x, y, z){
      if (!state.mode3d) return { x, y, scale: 1, zCam: 0 };
      const cx = state.width/2, cy = state.height/2;
      // translate to center
      const dx = x - cx; const dy = y - cy; let dz = z;
      // apply rotation yaw (Y axis) and pitch (X axis)
      const cyaw = Math.cos(state.yaw || 0), syaw = Math.sin(state.yaw || 0);
      const cpit = Math.cos(state.pitch || 0), spit = Math.sin(state.pitch || 0);
      // yaw: rotate around Y (x-z)
      const x1 = dx * cyaw + dz * syaw;
      const z1 = -dx * syaw + dz * cyaw;
      // pitch: rotate around X (y-z)
      const y2 = dy * cpit - z1 * spit;
      const z2 = dy * spit + z1 * cpit;
      // perspective projection
      const f = Math.min(state.width, state.height) * 0.9; // focal length
      const denom = (f + z2);
      const s = denom !== 0 ? (f/denom) : 1;
      return { x: cx + x1 * s, y: cy + y2 * s, scale: s, zCam: z2 };
    }
    if (!state.stationAgg) return;

    const memberKey = state.selectedMember || 'All';
    const monthKey = state.selectedMonthKey || 'All';

    const aggMap = state.stationAgg[memberKey]?.[monthKey] || new Map();
    let nodes = Array.from(aggMap.values()).map(d => ({
      id: d.name,
      name: d.name,
      start: d.start || 0,
      end: d.end || 0,
      total: (d.start || 0) + (d.end || 0)
    }));

    // Keep the most used stations
    const MAX_NODES = 60;
    nodes.sort((a,b) => b.total - a.total);
    nodes = nodes.slice(0, MAX_NODES);
    const included = new Set(nodes.map(n => n.name));

    // Build links: default view keeps only top K per source; in detail view include ALL links from selected source
    const routes = state.endRoutes?.[memberKey]?.[monthKey] || {};
    const linksRaw = [];
    const TOP_LINKS_PER_SOURCE = 5;
    for (const src of nodes) {
      const m = routes[src.name];
      if (!m) continue;
      let arr = Array.from(m.entries()).sort((a,b) => b[1]-a[1]);
      if (!(state.isDetail && state.selectedStation === src.name)) {
        arr = arr.slice(0, TOP_LINKS_PER_SOURCE);
      }
      for (const [t, count] of arr) {
        if (!included.has(t)) continue;
        linksRaw.push({ source: src.name, target: t, value: count });
      }
    }

    // Setup route popularity slider bounds based on current data
    // Build route popularity distribution and map percentile to count threshold
    const values = linksRaw.map(d => d.value).sort((a,b) => a-b);
    let thresholdCount = 0;
    if (values.length) {
      const p = (state.minRoutePercent || 0) / 100; // 0..1
      thresholdCount = Math.floor(d3.quantileSorted(values, p) || 0);
    }
    state.minRouteCount = thresholdCount;
    if (minRouteSliderEl) {
      // Ensure slider is 0..100 reflecting percentile
      if (+minRouteSliderEl.min !== 0) minRouteSliderEl.min = '0';
      if (+minRouteSliderEl.max !== 100) minRouteSliderEl.max = '100';
      if (+minRouteSliderEl.value !== (state.minRoutePercent||0)) minRouteSliderEl.value = String(state.minRoutePercent||0);
      // Update label with mapped count and percentile
      if (minRouteLabelEl) {
        const v = state.minRouteCount || 0;
        const pct = Math.round(state.minRoutePercent || 0);
        minRouteLabelEl.textContent = `≥ ${v} trip${v===1?'':'s'} (P${pct})`;
      }
    }

    // Render histogram under the slider
    renderRouteHistogram(values, state.minRouteCount);

    // Apply popularity filter only in default (non-detail) view
    const links = (state.isDetail && state.selectedStation)
      ? linksRaw.filter(l => l.source === state.selectedStation)
      : linksRaw.filter(l => l.value >= (state.minRouteCount || 0));

    // Optionally hide low-activity nodes in default view: keep only nodes that appear in remaining links
    let nodesVis = nodes;
    if (!state.isDetail && state.hideLowNodes) {
      const keep = new Set();
      links.forEach(l => {
        const s = (typeof l.source === 'string') ? l.source : l.source.name;
        const t = (typeof l.target === 'string') ? l.target : l.target.name;
        if (s) keep.add(s);
        if (t) keep.add(t);
      });
      nodesVis = nodes.filter(n => keep.has(n.name));
    }

    // Further restrict links to those between visible nodes when hiding low nodes
    let linksView = links;
    if (!state.isDetail && state.hideLowNodes) {
      const keepNames = new Set(nodesVis.map(n => n.name));
      linksView = links.filter(l => {
        const s = (typeof l.source === 'string') ? l.source : l.source.name;
        const t = (typeof l.target === 'string') ? l.target : l.target.name;
        return keepNames.has(s) && keepNames.has(t);
      });
    }

    // Scales
    const totals = nodesVis.map(n => n.total);
    const minTrips = totals.length ? d3.min(totals) : 0;
    const maxTrips = totals.length ? d3.max(totals) : 1;
    const radiusRange = [4, 18];
    const radiusScale = d3.scaleSqrt().domain([minTrips, maxTrips]).range(radiusRange);
    const colorScale = (state.colorBlind
      ? d3.scaleSequential(d3.interpolateViridis)
      : d3.scaleSequential(d3.interpolateYlOrRd)
    ).domain([minTrips, maxTrips]);
    const linkExtent = d3.extent(linksView, d => d.value) || [1,1];
    const linkWidth = d3.scaleSqrt().domain(linkExtent).range([0.6, 6]);

    // Update legend visuals
    try {
      if (!legendGradient.empty()) {
        const stops = legendGradient.selectAll('stop').data([0,1]);
        stops.join('stop')
          .attr('offset', d => (d*100)+"%")
          .attr('stop-color', d => colorScale(d === 0 ? minTrips : maxTrips));
      }
      if (!legendSizeSvg.empty()) {
        const minR = Math.max(3, radiusScale(minTrips));
        const midR = Math.max(3, radiusScale((minTrips+maxTrips)/2));
        const maxR = Math.max(3, radiusScale(maxTrips));
        legendSizeSvg.select('#sz1').attr('r', Math.max(3, Math.min(8, minR)));
        legendSizeSvg.select('#sz2').attr('r', Math.max(6, Math.min(12, midR)));
        legendSizeSvg.select('#sz3').attr('r', Math.max(10, Math.min(18, maxR)));
      }
    } catch(_) {}

    // Links
    const linkSel = gRoutes.selectAll('line.route-line')
      .data(linksView, d => `${d.source}→${d.target}`);

    linkSel.join(
      enter => enter.append('line')
        .attr('class', 'route-line')
        .attr('stroke-width', d => linkWidth(d.value))
        .attr('stroke-opacity', 0.6),
      update => update
        .attr('stroke-width', d => linkWidth(d.value))
        .attr('stroke-opacity', 0.6),
      exit => exit.remove()
    );

    // Edge tooltips with distance
    gRoutes.selectAll('line.route-line')
      .on('mouseenter', function(event, d){
        try {
          const sName = (typeof d.source === 'string') ? d.source : (d.source.name || d.source.id);
          const tName = (typeof d.target === 'string') ? d.target : (d.target.name || d.target.id);
          const a = getStationLatLng(sName);
          const b = getStationLatLng(tName);
          const dist = haversineKm(a, b);
          const html = `<div class="title">${escapeHtml(sName)} → ${escapeHtml(tName)}</div>`+
                       `<div class="muted">Trips: <b>${(d.value||0).toLocaleString()}</b></div>`+
                       (dist!=null ? `<div class=\"muted\">Distance: <b>${fmtDist(dist)}</b></div>` : '');
          showTooltip(html, event.pageX, event.pageY);
        } catch(_) {}
      })
      .on('mousemove', function(event){
        if (tooltipEl && tooltipEl.style.display !== 'none') {
          showTooltip(tooltipEl.innerHTML, event.pageX, event.pageY);
        }
      })
      .on('mouseleave', function(){ hideTooltip(); });

    // Nodes
    const nodeSel = gStations.selectAll('circle.station')
      .data(nodesVis, d => d.name);

    function sphereFill(d){
      const base = colorScale(d.total);
      if (!state.mode3d || !state.defs) return base;
      const id = 'sphere-' + String(d.name).replace(/[^a-z0-9]+/gi, '-');
      if (!document.getElementById(id)) {
        try {
          const g = state.defs.append('radialGradient')
            .attr('id', id)
            .attr('cx', '35%').attr('cy', '35%')
            .attr('r', '75%')
            .attr('fx', '25%').attr('fy', '25%');
          const cBase = d3.color(base) || d3.color('#ef4444');
          const cCenter = cBase.brighter(1.2);
          const cMid = cBase;
          const cEdge = cBase.darker(1.4);
          g.append('stop').attr('offset', '0%').attr('stop-color', cCenter.formatHex()).attr('stop-opacity', 0.95);
          g.append('stop').attr('offset', '55%').attr('stop-color', cMid.formatHex()).attr('stop-opacity', 0.95);
          g.append('stop').attr('offset', '100%').attr('stop-color', cEdge.formatHex()).attr('stop-opacity', 0.98);
        } catch(_) {}
      }
      return `url(#${id})`;
    }

    nodeSel.join(
      enter => enter.append('circle')
        .attr('class', 'station')
        .attr('r', d => Math.max(3, radiusScale(d.total)))
        .attr('fill', d => sphereFill(d))
        .on('mouseenter', (event, d) => {
          if (state.isDetail) return;
          const html = `<div class=\"title\">${escapeHtml(d.name)}</div>
                        <div class=\"muted\">Trips Started: <b>${(d.start||0).toLocaleString()}</b></div>
                        <div class=\"muted\">Trips Ended: <b>${(d.end||0).toLocaleString()}</b></div>
                        <div class=\"muted\">Total: <b>${(d.total||0).toLocaleString()}</b></div>`;
          showTooltip(html, event.pageX, event.pageY);

          // Highlight top endpoints for hovered node
          const memberKey = state.selectedMember || 'All';
          const monthKey = state.selectedMonthKey || 'All';
          const routeMap = (state.endRoutes?.[memberKey]?.[monthKey] || {})[d.name];
          let topSet = new Set();
          if (routeMap) {
            const topArr = Array.from(routeMap.entries()).sort((a,b) => b[1]-a[1]).slice(0, 5);
            topSet = new Set(topArr.map(x => x[0]));
          }
          // Mark hovered node
          d3.select(event.currentTarget).classed('hovered', true).attr('filter', 'url(#glow)');
          // Highlight target nodes
          gStations.selectAll('circle.station')
            .classed('endpoint-highlight', n => topSet.has(n.name));
          // Highlight links that originate from hovered and go to top endpoints
          gRoutes.selectAll('line.route-line')
            .classed('endpoint-highlight', l => {
              const src = (typeof l.source === 'string') ? l.source : l.source.name;
              const tgt = (typeof l.target === 'string') ? l.target : l.target.name;
              return src === d.name && topSet.has(tgt);
            })
            .attr('filter', function(l){
              const src = (typeof l.source === 'string') ? l.source : l.source.name;
              const tgt = (typeof l.target === 'string') ? l.target : l.target.name;
              return (src === d.name && topSet.has(tgt)) ? 'url(#glow)' : null;
            })
            .attr('stroke-opacity', function(l){
              return d3.select(this).attr('stroke-opacity') || 0.6;
            });
        })
        .on('mouseleave', (event) => {
          hideTooltip();
          d3.select(event.currentTarget).classed('hovered', false).attr('filter', null);
          gStations.selectAll('circle.station').classed('endpoint-highlight', false);
          gRoutes.selectAll('line.route-line').classed('endpoint-highlight', false).attr('filter', null)
            .attr('stroke-opacity', 0.6);
        })
        .on('click', (event, d) => {
          goToDetail(d.name);
          updateVis();
        })
        .call(d3.drag()
          .on('start', (event, d) => {
            if (!event.active && state.simulation) state.simulation.alphaTarget(0.3).restart();
            d.fx = d.x; d.fy = d.y;
          })
          .on('drag', (event, d) => { d.fx = event.x; d.fy = event.y; })
          .on('end', (event, d) => {
            // Keep node fixed at released position for stability; double-click to release
            if (!event.active && state.simulation) state.simulation.alphaTarget(0);
            d.fx = d.x; d.fy = d.y;
          }))
        .on('dblclick', (event, d) => {
          // Unfix node so it can settle naturally again
          d.fx = null; d.fy = null;
          if (state.simulation) state.simulation.alpha(0.5).restart();
        })
      ,
      update => update
        .attr('r', d => Math.max(3, radiusScale(d.total)))
        .attr('fill', d => sphereFill(d))
      ,
      exit => exit.remove()
    );

    // Labels
    let labelNodes;
    if (state.isDetail && state.selectedStation) {
      // Show only the selected station and its top 5 connected stations
      const memberKeyL = state.selectedMember || 'All';
      const monthKeyL = state.selectedMonthKey || 'All';
      const routeMapL = (state.endRoutes?.[memberKeyL]?.[monthKeyL] || {})[state.selectedStation];
      let topSetL = new Set([state.selectedStation]);
      if (routeMapL) {
        const topArrL = Array.from(routeMapL.entries()).sort((a,b) => b[1]-a[1]).slice(0, 5);
        topArrL.forEach(x => topSetL.add(x[0]));
      }
      labelNodes = nodes.filter(n => topSetL.has(n.name));
    } else {
      // Popular nodes (reduce label count to avoid clutter)
      const base = nodesVis; // use visible nodes as the pool
      const baseCount = Math.round(base.length * 0.2);
      const cap = 20;
      const floorMin = 8;
      const nLabel = Math.min(cap, Math.max(floorMin, baseCount));
      const labelCutoff = base[nLabel - 1] ? base[nLabel - 1].total : Infinity;
      labelNodes = base.filter(n => n.total >= labelCutoff);
    }

    const labelSel = gLabels.selectAll('text.label')
      .data(labelNodes, d => d.name);

    labelSel.join(
      enter => enter.append('text')
        .attr('class', 'label fade-in')
        .text(d => d.name),
      update => update.text(d => d.name),
      exit => exit.remove()
    );

    // Initialize or update force-directed simulation
    if (!state.simulation) {
      state.simulation = d3.forceSimulation(nodesVis)
        .force('link', d3.forceLink(linksView)
          .id(d => d.name || d.id)
          .distance(d => 200 - Math.min(140, Math.log1p(d.value) * 30))
          .strength(0.5)
        )
        .force('charge', d3.forceManyBody().strength(-120))
        .force('collide', d3.forceCollide().radius(d => Math.max(3, radiusScale(d.total)) + 4))
        .force('center', d3.forceCenter(state.width/2, state.height/2));
    } else {
      state.simulation.nodes(nodesVis);
      state.simulation.force('link').links(linksView);
    }

    function redraw3d() {
      // Remove grid lines entirely in all modes
      if (gGrid) gGrid.selectAll('*').remove();

      // Project with simple perspective when 3D mode is on
      gRoutes.selectAll('line.route-line')
        .each(function(d){
          const sName = (typeof d.source === 'string') ? d.source : (d.source.name || d.source.id);
          const tName = (typeof d.target === 'string') ? d.target : (d.target.name || d.target.id);
          const zs = depthFor(sName);
          const zt = depthFor(tName);
          const ps = projectXY(d.source.x, d.source.y, zs);
          const pt = projectXY(d.target.x, d.target.y, zt);
          const scaleAvg = (ps.scale + pt.scale) / 2;
          d3.select(this)
            .attr('x1', ps.x)
            .attr('y1', ps.y)
            .attr('x2', pt.x)
            .attr('y2', pt.y)
            .attr('stroke-width', w => Math.max(0.4, (linkWidth(d.value) * (state.mode3d ? scaleAvg : 1))));
        });

      // Project nodes and cache camera-space z for sorting
      gStations.selectAll('circle.station')
        .each(function(d){
          const z = depthFor(d.name);
          const p = projectXY(d.x, d.y, z);
          d._zCam = p.zCam;
          const r = Math.max(3, radiusScale(d.total)) * (state.mode3d ? p.scale : 1);
          d3.select(this)
            .attr('cx', p.x)
            .attr('cy', p.y)
            .attr('r', r);
        });

      // Sort stations by camera-space depth (farther first -> larger zCam first)
      if (state.mode3d) {
        gStations.selectAll('circle.station')
          .sort((a,b) => (b._zCam||0) - (a._zCam||0));
      }

      gLabels.selectAll('text.label')
        .each(function(d){
          const z = depthFor(d.name);
          const p = projectXY(d.x, d.y, z);
          d3.select(this)
            .attr('x', p.x + 8)
            .attr('y', p.y - 8)
            .style('opacity', state.mode3d ? Math.max(0.35, Math.min(1, 0.6 + 0.4 * p.scale)) : 1);
        });
    }
    // store redraw for external calls (e.g., rotation)
    state.current3dRedraw = redraw3d;
    state.simulation.on('tick', redraw3d);
    state.simulation.alpha(0.8).restart();

    // Detail mode highlighting
    if (state.isDetail && state.selectedStation) {
      const selected = state.selectedStation;
      const selectedLinks = links.filter(l => l.source === selected || (l.source.name && l.source.name === selected));
      selectedLinks.sort((a,b) => b.value - a.value);
      const top = selectedLinks.filter(l => (l.source === selected) || (l.source.name === selected)).slice(0,5);
      const endNames = new Set(top.map(l => (typeof l.target === 'string') ? l.target : l.target.name));
      const keepNodes = new Set([selected, ...endNames]);

      gStations.selectAll('circle.station')
        .classed('dimmed', d => !keepNodes.has(d.name))
        .classed('highlight', d => d.name === selected)
        .classed('connected', d => endNames.has(d.name))
        .attr('filter', d => d.name === selected ? 'url(#glow)' : null)
        .attr('r', d => keepNodes.has(d.name) ? Math.max(3, radiusScale(d.total) * 2) : 2);

      // In detail mode, dim all links not originating from selected
      gRoutes.selectAll('line.route-line')
        .classed('dimmed', d => {
          const src = (typeof d.source === 'string') ? d.source : d.source.name;
          return src !== selected; // dim all links not originating from selected
        });

      routeInfoEl.textContent = `Showing top 5 end stations starting from ${selected}`;
      routeInfoEl.style.display = 'block';
      backButtonEl.style.display = 'block';
    } else {
      gStations.selectAll('circle.station')
        .classed('dimmed', false)
        .classed('highlight', false)
        .classed('connected', false)
        .attr('filter', null)
        .attr('r', d => Math.max(3, radiusScale(d.total)));
      gRoutes.selectAll('line.route-line')
        .classed('dimmed', false)
        .attr('stroke-opacity', 0.6);
      routeInfoEl.style.display = 'none';
      backButtonEl.style.display = 'none';
    }

    // Refresh table
    updateTopStartTable();
  }

  function goToDetail(stationName) {
    state.isDetail = true;
    state.selectedStation = stationName;
    updateVis();
  }

  function drawTopRoutes(stationName, memberKey, monthKey, radiusScale, colorScale) {
    const startPos = state.stationPos.get(stationName);
    if (!startPos) return;

    // Dim all stations except selected and top 5 ends
    gStations.selectAll('circle.station').classed('dimmed', true).classed('highlight', d => d.name === stationName);

    const routeMap = state.endRoutes[memberKey]?.[monthKey]?.[stationName] || new Map();
    const pairs = Array.from(routeMap.entries());
    pairs.sort((a,b) => b[1] - a[1]);
    const top = pairs.slice(0, 5);

    // Build lines
    gRoutes.selectAll('*').remove();

    const rankScale = d3.scaleLinear().domain([1,5]).range([4,10]);

    const startXY = [projectX(startPos.lng, startPos.lat), projectY(startPos.lng, startPos.lat)];

    const lineSel = gRoutes.selectAll('path.route-line').data(top, d => d[0]);
    lineSel.join('path')
      .attr('class', 'route-line')
      .attr('stroke-width', (d, i) => rankScale(i+1))
      .attr('d', (d) => {
        const endStation = d[0];
        const pos = state.stationPos.get(endStation);
        if (!pos) return null;
        const x2 = projectX(pos.lng, pos.lat), y2 = projectY(pos.lng, pos.lat);
        return `M${startXY[0]},${startXY[1]} L${x2},${y2}`;
      });

    // Highlight end stations
    const endData = top.map(([name, count], i) => {
      const pos = state.stationPos.get(name);
      if (!pos) return null;
      const total = count; // ranking by route count
      return { name, count, lat: pos.lat, lng: pos.lng, rank: i+1, total };
    }).filter(Boolean);

    const ends = gRoutes.selectAll('circle.route-end').data(endData, d => d.name);
    ends.join('circle')
      .attr('class', 'route-end')
      .attr('cx', d => projectX(d.lng, d.lat))
      .attr('cy', d => projectY(d.lng, d.lat))
      .attr('r', d => 6 + (6 - d.rank))
      .attr('fill', d => colorScale(d.total))
      .append('title').text(d => `${d.name} — ${d.count.toLocaleString()} trips`);

    // Un-dim selected and top ends
    const topNames = new Set(endData.map(d => d.name));
    gStations.selectAll('circle.station')
      .classed('dimmed', d => !(d.name === stationName || topNames.has(d.name)))
      .classed('highlight', d => d.name === stationName);

    routeInfoEl.textContent = `Showing top 5 end stations starting from ${stationName}`;
    routeInfoEl.style.display = 'block';
    backButtonEl.style.display = 'block';
  }

  function exitDetailView() {
    state.isDetail = false;
    state.selectedStation = null;
    updateVis();
  }

  // Helpers
  function projectX(lng, lat) { return state.projection([lng, lat])[0]; }
  function projectY(lng, lat) { return state.projection([lng, lat])[1]; }
  function safeStr(v) { return (v == null) ? '' : String(v).trim(); }
  function escapeHtml(s) { return s.replaceAll && s.replaceAll(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;','\'':'&#39;'}[ch])) || s; }
  function normalizeName(name) {
    try {
      return String(name)
        .toLowerCase()
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '') // strip diacritics
        .replace(/[^a-z0-9]+/g, ' ') // non-alphanum to space
        .trim()
        .replace(/\s+/g, ' ');
    } catch(_) { return String(name).toLowerCase().trim(); }
  }

  // Smoothly zoom the SVG view to center on Toronto at a given scale.
  function zoomToToronto(scale = 2) {
    try {
      if (!state.projection) return;
      const c = state.torontoCentroid || [-79.3832, 43.6532];
      const [cx, cy] = state.projection([c[0], c[1]]);
      // First scale, then center the projected centroid in the viewport
      const minScale = 0.05, maxScale = 32;
      svg.transition().duration(600)
        .call(zoom.scaleTo, Math.max(minScale, Math.min(maxScale, scale)))
        .transition().duration(300)
        .call(zoom.translateTo, cx, cy);
    } catch (e) {
      // no-op
    }
  }

  // Returns {lat, lng} either from known geocodes or a deterministic fallback within Toronto bounds
  function getStationLatLng(name) {
    // Prefer GBFS/external and local overrides
    let rec = state.stationPos.get(name);
    if (rec && isFinite(rec.lat) && isFinite(rec.lng)) return rec;
    const norm = normalizeName(name);
    rec = state.stationPosNorm.get(norm);
    if (rec && isFinite(rec.lat) && isFinite(rec.lng)) return rec;

    // Deterministic pseudo-random based on name hash within Toronto bounds
    const hash = Array.from(String(name)).reduce((h, ch) => ((h << 5) - h) + ch.charCodeAt(0) | 0, 0);
    // Toronto approximate bounds (used for a first guess)
    const minLat = 43.58, maxLat = 43.85;
    const minLng = -79.65, maxLng = -79.12;
    const u = (Math.abs(hash) % 1000) / 999; // 0..1
    const v = (Math.abs((hash >> 10)) % 1000) / 999; // 0..1
    let lat = minLat + u * (maxLat - minLat);
    let lng = minLng + v * (maxLng - minLng);

    // If we have the city polygon, ensure the point lies within it.
    if (geojson && typeof d3.geoContains === 'function') {
      if (!d3.geoContains(geojson, [lng, lat])) {
        // fall back to a small jitter around the Toronto centroid (inside city)
        const c = state.torontoCentroid || [-79.3832, 43.6532];
        const jitterR = 0.01; // ~1km
        const ju = ((Math.abs(hash >> 5) % 1000) / 999 - 0.5) * 2; // -1..1
        const jv = ((Math.abs(hash >> 11) % 1000) / 999 - 0.5) * 2; // -1..1
        lng = c[0] + ju * jitterR;
        lat = c[1] + jv * jitterR;
        if (!d3.geoContains(geojson, [lng, lat])) {
          // As a last resort, use the centroid directly
          lng = c[0];
          lat = c[1];
        }
      }
    }
    return { lat, lng };
  }
})();


// Inject a synthetic demo station and routes if no valid trips were loaded from CSVs.
function injectSyntheticIfNeeded() {
  try {
    const totalTrips = state.allData.reduce((sum, m) => sum + (m.trips ? m.trips.length : 0), 0);
    if (totalTrips > 0) return; // Real data exists; no need for synthetic demo

    const mm = '09';
    const monthKey = '2023-09';

    const demoStart = { name: 'Demo Station (Synthetic)', lat: 43.6532, lng: -79.3832 };
    const ends = [
      { name: 'Union Station (Synthetic)',      lat: 43.6450, lng: -79.3800, count: 40 },
      { name: 'Harbourfront (Synthetic)',       lat: 43.6390, lng: -79.3800, count: 30 },
      { name: 'Chinatown (Synthetic)',          lat: 43.6520, lng: -79.3980, count: 20 },
      { name: 'Distillery District (Synthetic)',lat: 43.6500, lng: -79.3590, count: 15 },
      { name: 'Kensington Market (Synthetic)',  lat: 43.6550, lng: -79.4050, count: 10 }
    ];

    const trips = [];
    ends.forEach((e) => {
      for (let i = 0; i < e.count; i++) {
        trips.push({
          start_station_name: demoStart.name,
          end_station_name: e.name,
          start_lat: demoStart.lat,
          start_lng: demoStart.lng,
          end_lat: e.lat,
          end_lng: e.lng,
          member_type: (i % 2 === 0 ? 'Annual' : 'Casual')
        });
      }
    });

    state.allData.push({ month: monthKey, mm, trips });

    // Seed station positions for projection and routing
    state.stationPos.set(demoStart.name, { lat: demoStart.lat, lng: demoStart.lng });
    ends.forEach(e => state.stationPos.set(e.name, { lat: e.lat, lng: e.lng }));

    console.info('Injected synthetic BikeShare demo data (no valid CSV rows detected).');
  } catch (e) {
    console.warn('Failed to inject synthetic data:', e);
  }
}

// Lightweight story integration: keep essay in plain text, link from page.
(function(){
  const container = document.getElementById('storyContainer');
  if (!container) return;
  const intro = document.createElement('div');
  intro.className = 'story-intro';
  intro.innerHTML = `
    <p>We wove short, contextual notes throughout the page so the data narrative unfolds as you explore. For a full analytical write‑up and technical discussion, read the plain‑text essay.</p>
    <p><a href="narrative.txt" target="_blank" rel="noopener">Open the full essay (plain text)</a></p>
  `;
  container.innerHTML = '';
  container.appendChild(intro);
})();
