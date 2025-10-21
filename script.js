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
    stationAgg: null, // { memberKey -> { monthKey -> Map(station -> {start, end, lat, lng}) } }
    endRoutes: null, // { memberKey -> { monthKey -> { startStation -> Map(endStation -> count) } } }
    stationPos: new Map(), // stationName -> {lat, lng}
    debugStats: [], // per-file debug info
    isDetail: false,
    selectedStation: null,
    selectedMember: 'All',
    selectedMonthKey: 'All',
    projection: null,
    width: 0,
    height: 0,
  };

  // UI elements
  const byMonthEl = document.getElementById('byMonth');
  const monthSliderEl = document.getElementById('monthSlider');
  const monthLabelEl = document.getElementById('monthLabel');
  const memberRadioEls = Array.from(document.querySelectorAll('input[name="memberType"]'));
  const routeInfoEl = document.getElementById('routeInfo');
  const backButtonEl = document.getElementById('backButton');
  const tooltipEl = document.getElementById('tooltip');

  // Table elements
  const topStartTableBody = document.querySelector('#topStartTable tbody');

  // SVG
  const svg = d3.select('#map');
  const gRoot = svg.append('g').attr('class', 'root');
  const gBase = gRoot.append('g').attr('class', 'base');
  const gRoutes = gRoot.append('g').attr('class', 'routes');
  const gStations = gRoot.append('g').attr('class', 'stations');
  const gLabels = gRoot.append('g').attr('class', 'labels');

  // Zoom behavior
  const zoom = d3.zoom().scaleExtent([1, 8]).on('zoom', (event) => {
    gRoot.attr('transform', event.transform);
  });
  svg.call(zoom);
  d3.select('#zoomIn').on('click', () => svg.transition().call(zoom.scaleBy, 1.25));
  d3.select('#zoomOut').on('click', () => svg.transition().call(zoom.scaleBy, 0.8));

  // Events
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

  // Load base map (Toronto GeoJSON)
  let geojson = null;
  const geoUrl = 'https://raw.githubusercontent.com/codeforgermany/click_that_hood/main/public/data/toronto.geojson';

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

    // One-time SVG defs for glow effect
    if (!state.defsInitialized) {
      const defs = svg.append('defs');
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

    // Build links from top K outgoing per station within included set
    const routes = state.endRoutes?.[memberKey]?.[monthKey] || {};
    const links = [];
    const TOP_LINKS_PER_SOURCE = 5;
    for (const src of nodes) {
      const m = routes[src.name];
      if (!m) continue;
      const arr = Array.from(m.entries()).sort((a,b) => b[1]-a[1]).slice(0, TOP_LINKS_PER_SOURCE);
      for (const [t, count] of arr) {
        if (!included.has(t)) continue;
        links.push({ source: src.name, target: t, value: count });
      }
    }

    // Scales
    const totals = nodes.map(n => n.total);
    const minTrips = totals.length ? d3.min(totals) : 0;
    const maxTrips = totals.length ? d3.max(totals) : 1;
    const radiusScale = d3.scaleSqrt().domain([minTrips, maxTrips]).range([4, 18]);
    const colorScale = d3.scaleSequential(d3.interpolateYlOrRd).domain([minTrips, maxTrips]);
    const linkExtent = d3.extent(links, d => d.value) || [1,1];
    const linkWidth = d3.scaleSqrt().domain(linkExtent).range([0.6, 6]);

    // Links
    const linkSel = gRoutes.selectAll('line.route-line')
      .data(links, d => `${d.source}→${d.target}`);

    linkSel.join(
      enter => enter.append('line')
        .attr('class', 'route-line')
        .attr('stroke-width', d => linkWidth(d.value)),
      update => update
        .attr('stroke-width', d => linkWidth(d.value)),
      exit => exit.remove()
    );

    // Nodes
    const nodeSel = gStations.selectAll('circle.station')
      .data(nodes, d => d.name);

    nodeSel.join(
      enter => enter.append('circle')
        .attr('class', 'station')
        .attr('r', d => Math.max(3, radiusScale(d.total)))
        .attr('fill', d => colorScale(d.total))
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
            });
        })
        .on('mouseleave', (event) => {
          hideTooltip();
          d3.select(event.currentTarget).classed('hovered', false).attr('filter', null);
          gStations.selectAll('circle.station').classed('endpoint-highlight', false);
          gRoutes.selectAll('line.route-line').classed('endpoint-highlight', false).attr('filter', null);
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
          .on('end', (event, d) => { if (!event.active && state.simulation) state.simulation.alphaTarget(0); d.fx = null; d.fy = null; }))
      ,
      update => update
        .attr('r', d => Math.max(3, radiusScale(d.total)))
        .attr('fill', d => colorScale(d.total))
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
      // Popular nodes (top fraction up to 20)
      const nLabel = Math.min(20, Math.max(8, Math.round(nodes.length * 0.2)));
      const labelCutoff = nodes[nLabel - 1] ? nodes[nLabel - 1].total : Infinity;
      labelNodes = nodes.filter(n => n.total >= labelCutoff);
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

    // Initialize or update simulation
    if (!state.simulation) {
      state.simulation = d3.forceSimulation(nodes)
        .force('link', d3.forceLink(links)
          .id(d => d.name || d.id)
          .distance(d => 200 - Math.min(140, Math.log1p(d.value) * 30))
          .strength(0.5)
        )
        .force('charge', d3.forceManyBody().strength(-120))
        .force('collide', d3.forceCollide().radius(d => Math.max(3, radiusScale(d.total)) + 4))
        .force('center', d3.forceCenter(state.width/2, state.height/2));
    } else {
      state.simulation.nodes(nodes);
      state.simulation.force('link').links(links);
    }

    state.simulation.on('tick', () => {
      gRoutes.selectAll('line.route-line')
        .attr('x1', d => d.source.x)
        .attr('y1', d => d.source.y)
        .attr('x2', d => d.target.x)
        .attr('y2', d => d.target.y);
      gStations.selectAll('circle.station')
        .attr('cx', d => d.x)
        .attr('cy', d => d.y);
      gLabels.selectAll('text.label')
        .attr('x', d => d.x + 8)
        .attr('y', d => d.y - 8);
    });
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

      gRoutes.selectAll('line.route-line')
        .classed('dimmed', d => {
          const src = (typeof d.source === 'string') ? d.source : d.source.name;
          const tgt = (typeof d.target === 'string') ? d.target : d.target.name;
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
      gRoutes.selectAll('line.route-line').classed('dimmed', false);
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
