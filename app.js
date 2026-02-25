/* ============================================================
   FRA Flight Tracker — App Logic + Runway Prediction Engine
   ============================================================ */

(function () {
    'use strict';

    // ========================
    // Constants
    // ========================

    const FRA = { lat: 50.0267, lng: 8.5584 };
    const REFRESH_INTERVAL = 15_000;
    const ARRIVING_MAX_ALT = 4000;   // meters — only predict for aircraft below this
    const ARRIVING_MAX_DIST = 80;    // km — consider aircraft within this radius
    const FRA_ELEVATION = 111;       // meters above sea level

    // Runway threshold coordinates (from AIP Germany / metar-taf.com)
    // The "threshold" is the landing end for that runway designation.
    // For westerly ops (heading ~249°), planes land on 25R, 25C, and 25L.
    // For easterly ops (heading ~69°), planes land on 07L, 07C, and 07R.
    //
    // Physical layout (north to south):
    //   07L/25R  = Northwest runway (2800m, LANDING)
    //   07C/25C  = Center runway (4000m, LANDING + DEPARTURES)
    //   07R/25L  = South runway (4000m, LANDING)
    //   18/36    = West runway, N-S oriented (4000m, DEPARTURES only)

    const RUNWAYS = {
        '25R': {
            // Northwest runway — western threshold (landing end for 25R)
            threshold: { lat: 50.0371, lng: 8.4971 },
            opposite: { lat: 50.0458, lng: 8.5337 },
            heading: 249,
            color: '#3b82f6',
            label: '25R (NW Runway)',
        },
        '25C': {
            // Center runway — western threshold (landing end for 25C)
            threshold: { lat: 50.0326, lng: 8.5346 },
            opposite: { lat: 50.0451, lng: 8.5870 },
            heading: 249,
            color: '#8b5cf6',
            label: '25C (Center)',
        },
        '25L': {
            // South runway — western threshold (landing end for 25L)
            threshold: { lat: 50.0275, lng: 8.5342 },
            opposite: { lat: 50.0401, lng: 8.5865 },
            heading: 249,
            color: '#10b981',
            label: '25L (South Runway)',
        },
        '07L': {
            // Northwest runway — eastern threshold (landing end for 07L)
            threshold: { lat: 50.0458, lng: 8.5337 },
            opposite: { lat: 50.0371, lng: 8.4971 },
            heading: 69,
            color: '#f59e0b',
            label: '07L (NW Runway)',
        },
        '07C': {
            // Center runway — eastern threshold (landing end for 07C)
            threshold: { lat: 50.0451, lng: 8.5870 },
            opposite: { lat: 50.0326, lng: 8.5346 },
            heading: 69,
            color: '#a855f7',
            label: '07C (Center)',
        },
        '07R': {
            // South runway — eastern threshold (landing end for 07R)
            threshold: { lat: 50.0401, lng: 8.5865 },
            opposite: { lat: 50.0275, lng: 8.5342 },
            heading: 69,
            color: '#ef4444',
            label: '07R (South Runway)',
        },
    };

    // Which runways are used for landing in each config
    const CONFIGS = {
        westerly: ['25R', '25C', '25L'],
        easterly: ['07L', '07C', '07R'],
    };

    // All physical runway lines (for drawing on map)
    const RUNWAY_LINES = [
        // Northwest runway (07L/25R) — used for landing
        { from: { lat: 50.0371, lng: 8.4971 }, to: { lat: 50.0458, lng: 8.5337 }, label: '07L/25R', landing: true },
        // Center runway (07C/25C) — landing + departures
        { from: { lat: 50.0326, lng: 8.5346 }, to: { lat: 50.0451, lng: 8.5870 }, label: '07C/25C', landing: true },
        // South runway (07R/25L) — used for landing
        { from: { lat: 50.0275, lng: 8.5342 }, to: { lat: 50.0401, lng: 8.5865 }, label: '07R/25L', landing: true },
        // West runway (18/36) — departures only, N-S oriented
        { from: { lat: 50.0342, lng: 8.5259 }, to: { lat: 49.9985, lng: 8.5263 }, label: '18/36', landing: false },
    ];

    // ========================
    // State
    // ========================

    let map;
    let aircraftMarkers = new Map();
    let runwayLayers = [];
    let fraMarker = null;
    let activeConfig = null;
    let selectedIcao = null;
    let searchFilter = '';
    let flights = [];

    // ========================
    // Map Setup
    // ========================

    function initMap() {
        map = L.map('map', {
            center: [FRA.lat, FRA.lng],
            zoom: 10,
            zoomControl: true,
            attributionControl: true,
        });

        // Map tiles — use light or dark based on current theme
        const theme = document.documentElement.getAttribute('data-theme') || 'dark';
        currentTileLayer = createTileLayer(theme);
        currentTileLayer.addTo(map);

        // Draw runways + airport marker (theme-aware)
        drawRunways();
    }

    function getTheme() {
        return document.documentElement.getAttribute('data-theme') || 'dark';
    }

    function drawRunways() {
        // Clear existing runway layers
        runwayLayers.forEach(l => map.removeLayer(l));
        runwayLayers = [];
        if (fraMarker) { map.removeLayer(fraMarker); fraMarker = null; }

        const isLight = getTheme() === 'light';

        RUNWAY_LINES.forEach((rwy) => {
            // Runway line colors adapt to theme
            const landingColor = isLight ? '#1e293b' : '#ffffff';
            const departColor = isLight ? '#94a3b8' : '#8892a4';

            const line = L.polyline(
                [
                    [rwy.from.lat, rwy.from.lng],
                    [rwy.to.lat, rwy.to.lng],
                ],
                {
                    color: rwy.landing ? landingColor : departColor,
                    weight: rwy.landing ? 3 : 2,
                    opacity: rwy.landing ? (isLight ? 0.8 : 0.7) : (isLight ? 0.4 : 0.35),
                    dashArray: rwy.landing ? null : '6, 4',
                }
            ).addTo(map);
            runwayLayers.push(line);

            // Label at midpoint
            const midLat = (rwy.from.lat + rwy.to.lat) / 2;
            const midLng = (rwy.from.lng + rwy.to.lng) / 2;

            const labelColor = isLight ? 'rgba(30,41,59,0.7)' : 'rgba(255,255,255,0.6)';
            const labelIcon = L.divIcon({
                className: '',
                html: `<div class="runway-label" style="color: ${labelColor};">${rwy.label}</div>`,
                iconSize: [80, 16],
                iconAnchor: [40, 8],
            });

            const labelMarker = L.marker([midLat, midLng], { icon: labelIcon, interactive: false }).addTo(map);
            runwayLayers.push(labelMarker);
        });

        // FRA airport marker
        const fraColor = isLight ? 'rgba(14, 116, 144, 0.9)' : 'rgba(6, 182, 212, 0.8)';
        const fraBorder = isLight ? 'rgba(14, 116, 144, 0.4)' : 'rgba(6, 182, 212, 0.4)';
        const fraGlow = isLight ? 'rgba(14, 116, 144, 0.3)' : 'rgba(6, 182, 212, 0.5)';
        const fraIcon = L.divIcon({
            className: '',
            html: `<div style="
                width: 10px; height: 10px;
                background: ${fraColor};
                border: 2px solid ${fraBorder};
                border-radius: 50%;
                box-shadow: 0 0 12px ${fraGlow};
            "></div>`,
            iconSize: [14, 14],
            iconAnchor: [7, 7],
        });

        fraMarker = L.marker([FRA.lat, FRA.lng], { icon: fraIcon })
            .addTo(map)
            .bindPopup('<div class="popup-title">Frankfurt Airport</div><div class="popup-row"><span class="popup-label">ICAO</span><span class="popup-value">EDDF</span></div>');
    }

    // ========================
    // Aircraft Markers
    // ========================

    function createAircraftSvg(color, heading) {
        return `<svg width="24" height="24" viewBox="0 0 24 24" fill="${color}" style="transform: rotate(${heading || 0}deg);" xmlns="http://www.w3.org/2000/svg">
      <path d="M12 2L14.5 9H21L15.5 13L17.5 21L12 17L6.5 21L8.5 13L3 9H9.5L12 2Z" opacity="0.9"/>
    </svg>`;
    }

    function updateAircraftOnMap(flightData) {
        const currentIcaos = new Set(flightData.map((f) => f.icao24));

        // Remove markers for aircraft no longer present
        for (const [icao, marker] of aircraftMarkers) {
            if (!currentIcaos.has(icao)) {
                map.removeLayer(marker);
                aircraftMarkers.delete(icao);
            }
        }

        // Add or update markers
        flightData.forEach((f) => {
            const color = f.predictedRunway ? RUNWAYS[f.predictedRunway]?.color || '#5b6478' : '#5b6478';

            const icon = L.divIcon({
                className: 'aircraft-marker-wrapper',
                html: `<div style="position:relative;display:flex;flex-direction:column;align-items:center;pointer-events:auto;">
                    <div class="aircraft-label">${f.callsign || f.icao24}</div>
                    ${createAircraftSvg(color, f.heading)}
                </div>`,
                iconSize: [0, 0],
                iconAnchor: [0, 0],
            });

            if (aircraftMarkers.has(f.icao24)) {
                const marker = aircraftMarkers.get(f.icao24);
                marker.setLatLng([f.latitude, f.longitude]);
                marker.setIcon(icon);
            } else {
                const marker = L.marker([f.latitude, f.longitude], { icon })
                    .addTo(map)
                    .on('click', () => selectFlight(f.icao24));

                aircraftMarkers.set(f.icao24, marker);
            }

            // Update popup
            const marker = aircraftMarkers.get(f.icao24);
            marker.bindPopup(createPopup(f));
        });
    }

    function createPopup(f) {
        const alt = f.baroAltitude != null ? `${Math.round(f.baroAltitude)}m (${Math.round(f.baroAltitude * 3.281)}ft)` : '—';
        const spd = f.velocity != null ? `${Math.round(f.velocity * 1.944)}kts` : '—';
        const vr = f.verticalRate != null ? `${f.verticalRate > 0 ? '+' : ''}${Math.round(f.verticalRate * 196.85)}ft/min` : '—';
        const dist = f.distanceToAirport != null ? `${f.distanceToAirport.toFixed(1)}km` : '—';
        const rwy = f.predictedRunway || '—';
        const conf = f.confidence != null ? `${Math.round(f.confidence * 100)}%` : '—';

        return `
      <div class="popup-title">${f.callsign || f.icao24}</div>
      <div class="popup-row"><span class="popup-label">Altitude</span><span class="popup-value">${alt}</span></div>
      <div class="popup-row"><span class="popup-label">Speed</span><span class="popup-value">${spd}</span></div>
      <div class="popup-row"><span class="popup-label">Vert. Rate</span><span class="popup-value">${vr}</span></div>
      <div class="popup-row"><span class="popup-label">Distance</span><span class="popup-value">${dist}</span></div>
      <div class="popup-row"><span class="popup-label">Pred. Runway</span><span class="popup-value" style="color: ${RUNWAYS[rwy]?.color || 'inherit'}">${rwy}</span></div>
      <div class="popup-row"><span class="popup-label">Confidence</span><span class="popup-value">${conf}</span></div>
    `;
    }

    // ========================
    // Runway Prediction Engine
    // ========================

    function toRad(deg) { return (deg * Math.PI) / 180; }
    function toDeg(rad) { return (rad * 180) / Math.PI; }

    /**
     * Haversine distance between two lat/lng points in km
     */
    function haversine(lat1, lon1, lat2, lon2) {
        const R = 6371;
        const dLat = toRad(lat2 - lat1);
        const dLon = toRad(lon2 - lon1);
        const a =
            Math.sin(dLat / 2) ** 2 +
            Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
        return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    }

    /**
     * Calculate bearing from point 1 to point 2 in degrees
     */
    function bearing(lat1, lon1, lat2, lon2) {
        const dLon = toRad(lon2 - lon1);
        const y = Math.sin(dLon) * Math.cos(toRad(lat2));
        const x =
            Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) -
            Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(dLon);
        return ((toDeg(Math.atan2(y, x)) % 360) + 360) % 360;
    }

    /**
     * Cross-track distance: perpendicular distance from a point to a great circle
     * defined by two points (the runway centerline extended).
     * Returns distance in km.
     */
    function crossTrackDistance(pointLat, pointLon, lineLat1, lineLon1, lineLat2, lineLon2) {
        const R = 6371;
        const d13 = haversine(lineLat1, lineLon1, pointLat, pointLon) / R; // angular dist
        const brng13 = toRad(bearing(lineLat1, lineLon1, pointLat, pointLon));
        const brng12 = toRad(bearing(lineLat1, lineLon1, lineLat2, lineLon2));
        return Math.abs(Math.asin(Math.sin(d13) * Math.sin(brng13 - brng12))) * R;
    }

    /**
     * Normalize angle difference to [-180, 180]
     */
    function angleDiff(a, b) {
        let diff = ((a - b + 180) % 360) - 180;
        if (diff < -180) diff += 360;
        return diff;
    }

    /**
     * Detect active runway configuration from aircraft headings
     */
    function detectConfiguration(flights) {
        // Look at aircraft that are low, descending, and close
        const candidates = flights.filter(
            (f) =>
                f.baroAltitude != null &&
                f.baroAltitude < ARRIVING_MAX_ALT &&
                f.heading != null &&
                f.verticalRate != null &&
                f.verticalRate < -1 &&
                f.distanceToAirport < ARRIVING_MAX_DIST
        );

        if (candidates.length === 0) {
            // Default to westerly (most common ~75% of the time)
            return 'westerly';
        }

        let westerlyVotes = 0;
        let easterlyVotes = 0;

        candidates.forEach((f) => {
            const diffWest = Math.abs(angleDiff(f.heading, 250));
            const diffEast = Math.abs(angleDiff(f.heading, 70));

            if (diffWest < 40) westerlyVotes++;
            if (diffEast < 40) easterlyVotes++;
        });

        return westerlyVotes >= easterlyVotes ? 'westerly' : 'easterly';
    }

    /**
     * Determine if a flight is likely DEPARTING (vs arriving or overflying)
     * Returns true if the flight appears to be a departure
     */
    function isDeparting(flight) {
        if (flight.distanceToAirport == null || flight.baroAltitude == null) return false;

        // 1. Aircraft close to airport and climbing = departing
        if (flight.distanceToAirport < 30 &&
            flight.verticalRate != null && flight.verticalRate > 2) {
            return true;
        }

        // 2. Very low altitude, very close, and climbing = definitely departing
        if (flight.distanceToAirport < 15 &&
            flight.baroAltitude < 1500 &&
            flight.verticalRate != null && flight.verticalRate > 0.5) {
            return true;
        }

        // 3. Close to airport, low, and heading aligned with DEPARTURE runways
        //    (07C/25C heading ~69/249° or 18/36 heading ~180/360°)
        if (flight.distanceToAirport < 25 &&
            flight.baroAltitude < 2000 &&
            flight.heading != null) {
            // Check alignment with departure runway 18/36 (N-S: ~180° or ~360°)
            const diffNS1 = Math.abs(angleDiff(flight.heading, 180));
            const diffNS2 = Math.abs(angleDiff(flight.heading, 360));
            if ((diffNS1 < 25 || diffNS2 < 25) && flight.verticalRate != null && flight.verticalRate > 0) {
                return true;
            }
        }

        // 4. Check if aircraft is moving AWAY from airport at low altitude
        //    Bearing from airport to aircraft vs aircraft heading should be similar
        //    (within ~40°) if departing
        if (flight.distanceToAirport < 40 &&
            flight.baroAltitude < 3000 &&
            flight.heading != null &&
            flight.verticalRate != null && flight.verticalRate > 1) {
            const bearingToAircraft = bearing(FRA.lat, FRA.lng, flight.latitude, flight.longitude);
            const diff = Math.abs(angleDiff(flight.heading, bearingToAircraft));
            // If heading roughly matches bearing FROM airport → moving away = departing
            if (diff < 40) {
                return true;
            }
        }

        return false;
    }

    /**
     * Determine if a flight looks like it is arriving at FRA
     */
    function isArriving(flight) {
        if (flight.baroAltitude == null || flight.heading == null) return false;
        if (flight.distanceToAirport > ARRIVING_MAX_DIST) return false;
        if (flight.baroAltitude > ARRIVING_MAX_ALT) return false;

        // Must NOT be identified as departing
        if (isDeparting(flight)) return false;

        // Must be descending or at least level (not significantly climbing)
        if (flight.verticalRate != null && flight.verticalRate > 3) return false;

        // Heading should be roughly aligned with one of the landing runway headings
        const diffWest = Math.abs(angleDiff(flight.heading, 249));
        const diffEast = Math.abs(angleDiff(flight.heading, 69));
        if (diffWest > 50 && diffEast > 50) return false;

        // Aircraft should be approaching (bearing TO airport from aircraft
        // should be roughly aligned with aircraft heading)
        if (flight.distanceToAirport > 5) {
            const bearingToAirport = bearing(flight.latitude, flight.longitude, FRA.lat, FRA.lng);
            const approachDiff = Math.abs(angleDiff(flight.heading, bearingToAirport));
            if (approachDiff > 70) return false;
        }

        return true;
    }

    /**
     * Predict runway for a single flight
     */
    function predictRunway(flight, config) {
        const activeRunways = CONFIGS[config];

        // Only predict for aircraft classified as arriving
        if (!flight.isArriving) {
            return { runway: null, confidence: 0 };
        }

        const rwyHeading = RUNWAYS[activeRunways[0]].heading;
        const headingDiff = Math.abs(angleDiff(flight.heading, rwyHeading));

        let bestRunway = null;
        let bestScore = Infinity;
        let scores = {};

        activeRunways.forEach((rwyName) => {
            const rwy = RUNWAYS[rwyName];

            // 1. Cross-track distance to extended centerline
            const xtd = crossTrackDistance(
                flight.latitude, flight.longitude,
                rwy.threshold.lat, rwy.threshold.lng,
                rwy.opposite.lat, rwy.opposite.lng
            );

            // 2. Heading alignment penalty
            const headingPenalty = Math.abs(angleDiff(flight.heading, rwy.heading)) / 180;

            // Combined score (lower is better)
            const score = xtd + headingPenalty * 5;
            scores[rwyName] = score;

            if (score < bestScore) {
                bestScore = score;
                bestRunway = rwyName;
            }
        });

        // Confidence: based on how much better the best is vs the other
        const scoreValues = Object.values(scores);
        const otherScore = scoreValues.find((s) => s !== bestScore) || bestScore;
        const separation = otherScore - bestScore;

        // Higher separation → higher confidence
        let confidence = Math.min(1, 0.5 + separation * 0.5);

        // Boost confidence if aircraft is very close and well aligned
        if (flight.distanceToAirport < 20 && headingDiff < 10) {
            confidence = Math.min(1, confidence + 0.2);
        }

        // Reduce confidence if aircraft is far away
        if (flight.distanceToAirport > 50) {
            confidence *= 0.6;
        } else if (flight.distanceToAirport > 30) {
            confidence *= 0.8;
        }

        // Boost if descending
        if (flight.verticalRate != null && flight.verticalRate < -2) {
            confidence = Math.min(1, confidence + 0.1);
        }

        return { runway: bestRunway, confidence };
    }

    /**
     * Run prediction on all flights
     */
    function runPredictions(flights) {
        // Add distance to airport and classify each flight
        flights.forEach((f) => {
            f.distanceToAirport = haversine(f.latitude, f.longitude, FRA.lat, FRA.lng);
            f.isDeparting = isDeparting(f);
            f.isArriving = isArriving(f);
        });

        // Detect active configuration (only from arriving aircraft)
        activeConfig = detectConfiguration(flights.filter(f => f.isArriving || !f.isDeparting));

        // Predict for each flight
        flights.forEach((f) => {
            const prediction = predictRunway(f, activeConfig);
            f.predictedRunway = prediction.runway;
            f.confidence = prediction.confidence;
        });

        return flights;
    }

    // ========================
    // Flight List (Sidebar)
    // ========================

    function renderFlightList(flights) {
        const container = document.getElementById('flight-list');
        const countEl = document.getElementById('flight-count');

        // Filter to arriving flights (those with predictions or close+descending)
        let arriving = flights.filter(
            (f) =>
                f.predictedRunway ||
                (f.distanceToAirport < ARRIVING_MAX_DIST &&
                    f.baroAltitude != null &&
                    f.baroAltitude < ARRIVING_MAX_ALT)
        );

        // Apply search filter
        if (searchFilter) {
            const q = searchFilter.toLowerCase();
            arriving = arriving.filter(
                (f) =>
                    (f.callsign && f.callsign.toLowerCase().includes(q)) ||
                    f.icao24.toLowerCase().includes(q)
            );
        }

        // Sort by distance
        arriving.sort((a, b) => (a.distanceToAirport || 999) - (b.distanceToAirport || 999));

        countEl.textContent = arriving.length;

        if (arriving.length === 0) {
            container.innerHTML = `
        <div class="empty-state">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.4">
            <path d="M17.8 19.2L16 11l3.5-3.5C21 6 21.5 4 21 3c-1-.5-3 0-4.5 1.5L13 8 4.8 6.2c-.5-.1-.9.1-1.1.5l-.3.5c-.2.4-.1.9.3 1.1L11 12l-2 3H6l-1 1 3 2 2 3 1-1v-3l3-2 3.7 7.3c.2.4.7.5 1.1.3l.5-.3c.4-.2.5-.6.4-1.1z"/>
          </svg>
          <p>${searchFilter ? 'No matching flights' : 'No arriving flights detected'}</p>
        </div>
      `;
            return;
        }

        container.innerHTML = arriving
            .map((f) => {
                const rwy = f.predictedRunway;
                const color = rwy ? RUNWAYS[rwy]?.color || '#5b6478' : '#5b6478';
                const alt = f.baroAltitude != null ? `${Math.round(f.baroAltitude * 3.281).toLocaleString()}ft` : '—';
                const spd = f.velocity != null ? `${Math.round(f.velocity * 1.944)}kts` : '—';
                const dist = f.distanceToAirport != null ? `${f.distanceToAirport.toFixed(1)}km` : '—';
                const confPct = f.confidence != null ? Math.round(f.confidence * 100) : 0;
                const isActive = f.icao24 === selectedIcao;

                return `
          <div class="flight-card${isActive ? ' active' : ''}"
               style="--card-accent: ${color}"
               data-icao="${f.icao24}"
               onclick="window.__selectFlight('${f.icao24}')">
            <div class="flight-card-header">
              <span class="flight-callsign">${f.callsign || f.icao24}</span>
              <span class="flight-runway-badge" style="background: ${rwy ? color + '20' : ''}; color: ${color}">
                ${rwy || 'N/A'}
              </span>
            </div>
            <div class="flight-card-details">
              <div class="flight-detail">
                <span class="flight-detail-label">Alt</span>
                <span class="flight-detail-value">${alt}</span>
              </div>
              <div class="flight-detail">
                <span class="flight-detail-label">Speed</span>
                <span class="flight-detail-value">${spd}</span>
              </div>
              <div class="flight-detail">
                <span class="flight-detail-label">Dist</span>
                <span class="flight-detail-value">${dist}</span>
              </div>
            </div>
            ${rwy ? `
              <div class="confidence-bar">
                <div class="confidence-track">
                  <div class="confidence-fill" style="width: ${confPct}%; background: ${color};"></div>
                </div>
                <span class="confidence-label">${confPct}%</span>
              </div>
            ` : ''}
          </div>
        `;
            })
            .join('');
    }

    // ========================
    // UI Updates
    // ========================

    function updateConfigBadge() {
        const badge = document.getElementById('config-badge');
        const label = document.getElementById('config-label');

        if (activeConfig === 'westerly') {
            badge.className = 'config-badge westerly';
            label.textContent = 'Westerly Ops (25R/25C/25L)';
        } else if (activeConfig === 'easterly') {
            badge.className = 'config-badge easterly';
            label.textContent = 'Easterly Ops (07L/07C/07R)';
        }
    }

    function updateLegend() {
        const container = document.getElementById('legend-items');
        if (!activeConfig) return;

        const runwayNames = CONFIGS[activeConfig];
        container.innerHTML = runwayNames
            .map(
                (name) => `
        <div class="legend-item">
          <div class="legend-color" style="background: ${RUNWAYS[name].color};"></div>
          <span>${RUNWAYS[name].label}</span>
        </div>
      `
            )
            .join('');

        // Add "Other / Unknown"
        container.innerHTML += `
      <div class="legend-item">
        <div class="legend-color" style="background: #5b6478;"></div>
        <span>No prediction</span>
      </div>
    `;
    }

    function updateStatus(text, isError = false) {
        const badge = document.getElementById('status-badge');
        const textEl = document.getElementById('status-text');
        badge.className = isError ? 'status-badge error' : 'status-badge';
        textEl.textContent = text;
    }

    function selectFlight(icao24) {
        selectedIcao = icao24;

        // Center map on aircraft
        const flight = flights.find((f) => f.icao24 === icao24);
        if (flight) {
            map.setView([flight.latitude, flight.longitude], Math.max(map.getZoom(), 11), {
                animate: true,
                duration: 0.5,
            });

            // Open popup
            const marker = aircraftMarkers.get(icao24);
            if (marker) marker.openPopup();
        }

        renderFlightList(flights);
    }

    // Expose to global for onclick handlers
    window.__selectFlight = selectFlight;

    // ========================
    // Data Fetching
    // ========================

    // OpenSky API bounding box for FRA region
    const OPENSKY_URL = 'https://opensky-network.org/api/states/all?lamin=49.75&lomin=8.05&lamax=50.30&lomax=9.05';

    async function fetchFlights() {
        try {
            const res = await fetch(OPENSKY_URL);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);

            const raw = await res.json();

            // Parse state vectors into clean objects
            flights = (raw.states || [])
                .map((s) => ({
                    icao24: s[0],
                    callsign: (s[1] || '').trim(),
                    country: s[2],
                    longitude: s[5],
                    latitude: s[6],
                    baroAltitude: s[7],
                    onGround: s[8],
                    velocity: s[9],
                    heading: s[10],
                    verticalRate: s[11],
                    geoAltitude: s[13],
                    squawk: s[14],
                    lastUpdate: s[4],
                }))
                .filter((f) => f.latitude != null && f.longitude != null && !f.onGround);

            // Run predictions
            runPredictions(flights);

            // Update UI
            updateAircraftOnMap(flights);
            renderFlightList(flights);
            updateConfigBadge();
            updateLegend();

            const now = new Date();
            updateStatus(`Live — ${flights.length} aircraft · ${now.toLocaleTimeString()}`);
        } catch (err) {
            console.error('Fetch error:', err);
            updateStatus('Connection error', true);
        }
    }

    // ========================
    // Init
    // ========================

    function init() {
        // Theme toggle
        initTheme();

        initMap();

        // Search input
        document.getElementById('search-input').addEventListener('input', (e) => {
            searchFilter = e.target.value;
            renderFlightList(flights);
        });

        // Initial fetch
        fetchFlights();

        // Auto-refresh
        setInterval(fetchFlights, REFRESH_INTERVAL);
    }

    let currentTileLayer = null;

    function initTheme() {
        const saved = localStorage.getItem('fra-tracker-theme');
        if (saved === 'light') {
            document.documentElement.setAttribute('data-theme', 'light');
        }

        document.getElementById('theme-toggle').addEventListener('click', () => {
            const current = document.documentElement.getAttribute('data-theme');
            const next = current === 'light' ? 'dark' : 'light';

            if (next === 'light') {
                document.documentElement.setAttribute('data-theme', 'light');
            } else {
                document.documentElement.removeAttribute('data-theme');
            }

            localStorage.setItem('fra-tracker-theme', next);

            // Swap map tiles
            if (map && currentTileLayer) {
                map.removeLayer(currentTileLayer);
                currentTileLayer = createTileLayer(next);
                currentTileLayer.addTo(map);
            }

            // Redraw runways and airport marker with theme-appropriate colors
            drawRunways();

            // Refresh aircraft markers with current data
            if (flights.length) {
                updateAircraftOnMap(flights);
            }
        });
    }

    function createTileLayer(theme) {
        if (theme === 'light') {
            return L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', {
                attribution: '&copy; <a href="https://carto.com/">CARTO</a> &copy; <a href="https://www.openstreetmap.org/copyright">OSM</a>',
                subdomains: 'abcd',
                maxZoom: 18,
            });
        } else {
            return L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
                attribution: '&copy; <a href="https://carto.com/">CARTO</a> &copy; <a href="https://www.openstreetmap.org/copyright">OSM</a>',
                subdomains: 'abcd',
                maxZoom: 18,
            });
        }
    }

    // Start when DOM is ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
