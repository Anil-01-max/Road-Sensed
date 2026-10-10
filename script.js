"use strict";

const $ = id => document.getElementById(id);

const DEFAULT_CENTER = [16.5062, 80.6480];

const sampleReports = [
  {name:"Benz Circle",type:"pothole",severity:"high",lat:16.5075,lng:80.6470},
  {name:"MG Road",type:"noise",severity:"moderate",lat:16.5190,lng:80.6300},
  {name:"Railway Station Road",type:"pothole",severity:"high",lat:16.5170,lng:80.6190},
  {name:"Governorpet",type:"rough",severity:"moderate",lat:16.5160,lng:80.6250},
  {name:"Bus Stand Area",type:"noise",severity:"high",lat:16.5060,lng:80.6180},
  {name:"Park Road",type:"rough",severity:"low",lat:16.5000,lng:80.6400},
  {name:"College Road",type:"pothole",severity:"moderate",lat:16.5110,lng:80.6570},
  {name:"Central Junction",type:"noise",severity:"high",lat:16.5040,lng:80.6300}
];

let reports = [...sampleReports];
let activeLayer = "all";
let lastPosition = null;
let userMarker = null;
let journeyActive = false;
let watchId = null;
let motionHandler = null;
let previousMagnitude = null;
let lastSensorReport = 0;

let audioStream = null;
let audioContext = null;
let analyser = null;
let audioFrame = null;

let routeLayers = [];
let activeNavigationRoute = null;
let navigationWatchId = null;
let routeRequestRunning = false;
let availableRouteChoices = [];

const map = L.map("map").setView(DEFAULT_CENTER, 13);

const mapElement = $("map");
const originalMapParent = mapElement.parentElement;
const originalMapNextSibling = mapElement.nextSibling;

L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  attribution: "&copy; OpenStreetMap contributors",
  maxZoom: 19
}).addTo(map);

const markerLayer = L.layerGroup().addTo(map);

const heatLayer = L.heatLayer([], {
  radius: 30,
  blur: 22,
  maxZoom: 17,
  max: 1
}).addTo(map);

function showMessage(message) {
  $("appMessage").textContent = message;
}

function issueName(type) {
  return {
    pothole: "Pothole",
    rough: "Rough road",
    noise: "High noise"
  }[type] || "Road report";
}

function categoryColor(type) {
  return {
    pothole: "#e34d4d",
    rough: "#e9a23b",
    noise: "#7b61c9"
  }[type] || "#24a36b";
}

function escapeHTML(value) {
  return String(value).replace(/[&<>"']/g, c => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[c]);
}

/* MAP AND FILTERS */

function renderMap() {
  markerLayer.clearLayers();

  const visible = reports.filter(report =>
    activeLayer === "all" || report.type === activeLayer
  );

  visible.forEach(report => {
    const color = categoryColor(report.type);

    L.circleMarker([report.lat, report.lng], {
      radius: 8,
      color,
      fillColor: color,
      fillOpacity: 0.85,
      weight: 2
    }).bindPopup(
      `<strong>${escapeHTML(report.name)}</strong><br>` +
      `${issueName(report.type)}<br>` +
      `Severity: ${escapeHTML(report.severity)}`
    ).addTo(markerLayer);
  });

  heatLayer.setLatLngs(visible.map(report => [
    report.lat,
    report.lng,
    report.severity === "high" ? 1 :
      report.severity === "moderate" ? 0.65 : 0.3
  ]));
}

function renderFeed() {
  const feed = $("reportFeed");
  feed.replaceChildren();

  reports.slice(-10).reverse().forEach(report => {
    const item = document.createElement("div");
    item.className = "feed-item";

    const details = document.createElement("div");
    const title = document.createElement("strong");
    const description = document.createElement("small");
    const tag = document.createElement("span");

    title.textContent = report.name;
    description.textContent =
      `${issueName(report.type)} · ${report.severity}`;

    tag.className = "tag";
    tag.style.color = categoryColor(report.type);
    tag.textContent = report.severity.toUpperCase();

    details.append(title, description);
    item.append(details, tag);
    feed.appendChild(item);
  });

  $("reportCount").textContent = reports.length;
  $("potholeCount").textContent =
    reports.filter(r => r.type === "pothole").length;
  $("roughCount").textContent =
    reports.filter(r => r.type === "rough").length;
  $("noiseStat").textContent =
    reports.filter(r => r.type === "noise").length;
}

document.querySelectorAll(".tab").forEach(button => {
  button.addEventListener("click", () => {
    activeLayer = button.dataset.layer;

    document.querySelectorAll(".tab").forEach(tab => {
      tab.classList.toggle("active", tab === button);
    });

    renderMap();
  });
});

/* PLACE SEARCH */

function setupPlaceAutocomplete(inputId, boxId) {
  const input = $(inputId);
  const box = $(boxId);

  let timer;
  let requestNumber = 0;
  let lastSearchTime = 0;

  function hideSuggestions() {
    box.style.display = "none";
    box.replaceChildren();
  }

  function showStatus(message) {
    box.replaceChildren();

    const element = document.createElement("div");
    element.className = "suggestion-message";
    element.textContent = message;

    box.appendChild(element);
    box.style.display = "block";
  }

  function selectPlace(place) {
    input.value = place.display_name;
    input.dataset.lat = place.lat;
    input.dataset.lng = place.lon;
    hideSuggestions();
  }

  async function searchPlaces(query, id) {
    try {
      const wait = Math.max(
        0,
        1100 - (Date.now() - lastSearchTime)
      );

      if (wait > 0) {
        await new Promise(resolve => setTimeout(resolve, wait));
      }

      if (id !== requestNumber) return;

      lastSearchTime = Date.now();

      const url = new URL(
        "https://nominatim.openstreetmap.org/search"
      );

      url.searchParams.set("q", query);
      url.searchParams.set("format", "jsonv2");
      url.searchParams.set("limit", "6");
      url.searchParams.set("accept-language", "en");

      const response = await fetch(url);

      if (!response.ok) {
        throw new Error("Search unavailable");
      }

      const places = await response.json();

      if (id !== requestNumber) return;

      box.replaceChildren();

      if (!places.length) {
        showStatus("No matching places found.");
        return;
      }

      places.forEach(place => {
        const item = document.createElement("div");
        item.className = "suggestion-item";
        item.tabIndex = 0;

        const name = document.createElement("div");
        name.className = "suggestion-name";
        name.textContent = place.display_name.split(",")[0];

        const address = document.createElement("div");
        address.className = "suggestion-address";
        address.textContent = place.display_name;

        item.append(name, address);

        item.addEventListener("click", () => selectPlace(place));

        item.addEventListener("keydown", event => {
          if (event.key === "Enter") selectPlace(place);
        });

        box.appendChild(item);
      });

      box.style.display = "block";
    } catch (error) {
      if (id === requestNumber) {
        showStatus(
          "Could not load suggestions. Check your internet."
        );
      }
    }
  }

  input.addEventListener("input", () => {
    clearTimeout(timer);

    delete input.dataset.lat;
    delete input.dataset.lng;

    const query = input.value.trim();
    const id = ++requestNumber;

    if (query.length < 3) {
      hideSuggestions();
      return;
    }

    showStatus("Searching places...");
    timer = setTimeout(() => searchPlaces(query, id), 650);
  });

  input.addEventListener("keydown", event => {
    if (event.key === "Escape") hideSuggestions();

    if (event.key === "ArrowDown") {
      box.querySelector(".suggestion-item")?.focus();
    }
  });

  document.addEventListener("click", event => {
    if (!input.contains(event.target) && !box.contains(event.target)) {
      hideSuggestions();
    }
  });
}

setupPlaceAutocomplete("routeOrigin", "originSuggestions");
setupPlaceAutocomplete("routeDestination", "destinationSuggestions");

/* LOCATION */

function getCurrentPosition() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error("Location is not supported."));
      return;
    }

    navigator.geolocation.getCurrentPosition(
      position => resolve({
        lat: position.coords.latitude,
        lng: position.coords.longitude,
        name: "My current location"
      }),
      error => reject(new Error(
        error.code === 1
          ? "Location permission denied. Allow location in browser settings."
          : "Could not get location. Enter a starting address."
      )),
      {
        enableHighAccuracy: true,
        timeout: 15000,
        maximumAge: 3000
      }
    );
  });
}

function updateUserMarker(position) {
  lastPosition = {
    lat: position.coords.latitude,
    lng: position.coords.longitude
  };

  if (userMarker) {
    userMarker.setLatLng([lastPosition.lat, lastPosition.lng]);
  } else {
    userMarker = L.marker([
      lastPosition.lat,
      lastPosition.lng
    ]).addTo(map).bindPopup("Your location");
  }
}

$("locationBtn").addEventListener("click", async () => {
  try {
    const position = await getCurrentPosition();
    lastPosition = position;

    updateUserMarker({
      coords: {
        latitude: position.lat,
        longitude: position.lng
      }
    });

    map.setView([position.lat, position.lng], 16);
    userMarker.openPopup();
  } catch (error) {
    showMessage(error.message);
  }
});

/* MANUAL REPORTS */

$("reportForm").addEventListener("submit", event => {
  event.preventDefault();

  const name = $("roadName").value.trim();

  if (!name) {
    showMessage("Enter a road or area name.");
    return;
  }

  reports.push({
    name,
    type: $("issueType").value,
    severity: $("severity").value,
    lat: lastPosition?.lat ??
      DEFAULT_CENTER[0] + (Math.random() - 0.5) * 0.02,
    lng: lastPosition?.lng ??
      DEFAULT_CENTER[1] + (Math.random() - 0.5) * 0.02
  });

  renderMap();
  renderFeed();
  $("reportForm").reset();

  showMessage(
    "Report added to this browser session only. " +
    "It has not been uploaded to a server."
  );
});

function addSensorReport(type, severity) {
  if (!lastPosition || Date.now() - lastSensorReport < 5000) {
    return;
  }

  lastSensorReport = Date.now();

  reports.push({
    name: "Phone sensor reading",
    type,
    severity,
    lat: lastPosition.lat,
    lng: lastPosition.lng
  });

  renderMap();
  renderFeed();
}

/* MOTION SENSOR */

async function startMotionSensor() {
  if (!("DeviceMotionEvent" in window)) {
    $("motionStatus").textContent =
      "Motion sensor is not supported on this device/browser.";
    return false;
  }

  try {
    if (typeof DeviceMotionEvent.requestPermission === "function") {
      const permission =
        await DeviceMotionEvent.requestPermission();

      if (permission !== "granted") {
        $("motionStatus").textContent =
          "Motion permission denied. Check browser/site settings.";
        return false;
      }
    }

    if (motionHandler) {
      window.removeEventListener("devicemotion", motionHandler);
    }

    previousMagnitude = null;

    motionHandler = event => {
      const acceleration =
        event.acceleration ||
        event.accelerationIncludingGravity;

      if (!acceleration) {
        $("motionStatus").textContent =
          "Waiting for motion readings. Try moving the phone.";
        return;
      }

      const x = Number(acceleration.x) || 0;
      const y = Number(acceleration.y) || 0;
      const z = Number(acceleration.z) || 0;

      const magnitude = Math.sqrt(x*x + y*y + z*z);

      const change = previousMagnitude === null
        ? 0
        : Math.abs(magnitude - previousMagnitude);

      previousMagnitude = magnitude;

      $("roughValue").textContent = change.toFixed(2);
      $("motionStatus").textContent =
        "Motion active · experimental roughness estimate";

      if (journeyActive && lastPosition && change > 2.2) {
        addSensorReport(
          "rough",
          change > 5 ? "high" : "moderate"
        );
      }
    };

    window.addEventListener("devicemotion", motionHandler);

    $("motionStatus").textContent =
      "Permission granted. Waiting for motion readings.";

    return true;
  } catch (error) {
    console.error("Motion sensor error:", error);

    $("motionStatus").textContent =
      "Could not enable motion. Try Android Chrome and allow sensor access.";

    return false;
  }
}

function stopJourney() {
  journeyActive = false;

  if (watchId !== null) {
    navigator.geolocation.clearWatch(watchId);
  }

  watchId = null;

  if (motionHandler) {
    window.removeEventListener("devicemotion", motionHandler);
  }

  motionHandler = null;

  $("journeyBtn").textContent = "Start journey";
  $("status").textContent = "● Demo mode";
  $("motionStatus").textContent = "Journey stopped.";
}

$("journeyBtn").addEventListener("click", async () => {
  if (journeyActive) {
    stopJourney();
    return;
  }

  const motionStarted = await startMotionSensor();

  journeyActive = true;
  $("journeyBtn").textContent = "Stop journey";
  $("status").textContent = "● Journey active";

  if (!motionStarted) {
    $("motionStatus").textContent +=
      " Journey can continue without motion readings.";
  }

  if (!navigator.geolocation) {
    showMessage("Location tracking is not supported.");
    return;
  }

  watchId = navigator.geolocation.watchPosition(
    updateUserMarker,
    error => showMessage(
      error.code === 1
        ? "Location permission denied. Allow location in browser settings."
        : "Location tracking failed. Check GPS and permissions."
    ),
    {
      enableHighAccuracy: true,
      maximumAge: 2000,
      timeout: 15000
    }
  );
});

/* MICROPHONE */

async function startMicrophone() {
  if (audioStream) {
    stopMicrophone();
    return;
  }

  if (
    !window.isSecureContext ||
    !navigator.mediaDevices?.getUserMedia
  ) {
    $("micStatus").textContent =
      "Microphone requires HTTPS or http://localhost. Use VS Code Live Server.";
    return;
  }

  try {
    $("micBtn").disabled = true;
    $("micStatus").textContent =
      "Requesting microphone permission...";

    audioStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false
      }
    });

    const AudioContextClass =
      window.AudioContext || window.webkitAudioContext;

    if (!AudioContextClass) {
      throw new Error("Web Audio is not supported.");
    }

    audioContext = new AudioContextClass();
    await audioContext.resume();

    analyser = audioContext.createAnalyser();
    analyser.fftSize = 4096;
    analyser.smoothingTimeConstant = 0.15;

    audioContext.createMediaStreamSource(audioStream)
      .connect(analyser);

    $("micBtn").textContent = "Stop microphone";
    $("micStatus").textContent =
      "Microphone active. Audio is processed on this device.";
    $("micBtn").disabled = false;

    measureNoise();
  } catch (error) {
    console.error("Microphone error:", error);
    stopMicrophone();

    $("micStatus").textContent =
      error.name === "NotAllowedError"
        ? "Microphone denied. Open site settings, allow Microphone, and reload."
        : "Microphone failed. Use HTTPS/localhost and check device settings.";

    $("micBtn").disabled = false;
  }
}

function measureNoise() {
  if (!analyser || !audioContext || !audioStream) return;

  const samples = new Float32Array(analyser.fftSize);
  analyser.getFloatTimeDomainData(samples);

  let sumSquares = 0;

  for (const sample of samples) {
    sumSquares += sample * sample;
  }

  const rms = Math.sqrt(sumSquares / samples.length);
  const dbfs = 20 * Math.log10(Math.max(rms, 0.0000001));

  const level = Math.max(
    0,
    Math.min(100, Math.round((dbfs + 80) * 1.25))
  );

  $("noiseValue").textContent = level + " / 100";

  $("micStatus").textContent =
    audioContext.state !== "running"
      ? "Audio paused. Check browser permissions."
      : level >= 65
        ? "Loud sound detected · relative level"
        : level >= 35
          ? "Moderate sound detected · relative level"
          : "Quiet environment · relative level";

  if (journeyActive && lastPosition && level >= 55) {
    addSensorReport(
      "noise",
      level >= 75 ? "high" : "moderate"
    );
  }

  audioFrame = requestAnimationFrame(measureNoise);
}

function stopMicrophone() {
  if (audioFrame !== null) {
    cancelAnimationFrame(audioFrame);
    audioFrame = null;
  }

  if (audioStream) {
    audioStream.getTracks().forEach(track => track.stop());
    audioStream = null;
  }

  if (audioContext) {
    audioContext.close().catch(console.error);
    audioContext = null;
  }

  analyser = null;

  $("micBtn").textContent = "Enable microphone";
  $("micBtn").disabled = false;
  $("micStatus").textContent = "Microphone inactive.";
  $("noiseValue").textContent = "--";
}

$("micBtn").addEventListener("click", startMicrophone);

/* ROUTE CHOICES */

function setupRouteChoices() {
  if ($("routeChoices")) return;

  const routeForm = $("routeForm");
  const routeCard = routeForm.closest(".card");
  const choices = document.createElement("div");

  choices.id = "routeChoices";
  choices.hidden = true;
  choices.style.marginTop = "18px";

  routeCard.appendChild(choices);
}

function renderRouteChoices(routes, shortestRoute) {
  const container = $("routeChoices");
  container.replaceChildren();
  container.hidden = false;

  const heading = document.createElement("h3");
  heading.textContent = "Choose your route";
  container.appendChild(heading);

  routes.forEach(route => {
    const score = scoreRoute(route);
    const isShortest = route === shortestRoute;

    const card = document.createElement("div");
    card.className = "route-choice-card";

    const label = document.createElement("span");
    label.className = "route-label";
    label.textContent = isShortest
      ? "SHORTEST DISTANCE"
      : "ROAD CONDITION OPTION";

    const title = document.createElement("h3");
    title.textContent = isShortest
      ? "Shortest Route"
      : "Best Road Condition";

    const details = document.createElement("p");
    details.textContent =
      `Distance: ${formatDistance(route.distance)}\n` +
      `Estimated time: ${formatDuration(route.duration)}\n` +
      `Potholes: ${score.potholes} | ` +
      `Rough spots: ${score.roughSpots} | ` +
      `Noise reports: ${score.noiseSpots}`;

    const selectButton = document.createElement("button");
    selectButton.type = "button";
    selectButton.textContent = "Choose this route";
    selectButton.style.width = "100%";

    selectButton.addEventListener("click", () => {
      drawRoute(route);
      updateRouteComfort(route);
      openNavigation(route);
    });

    card.append(label, title, details, selectButton);
    container.appendChild(card);
  });
}

function updateRouteComfort(route) {
  const score = scoreRoute(route);

  $("comfortScore").textContent =
    Math.max(0, 100 - score.hazardScore * 8);

  $("comfortText").textContent =
    `Nearby reports: ${score.potholes} potholes, ` +
    `${score.roughSpots} rough-road spots, ` +
    `${score.noiseSpots} noise reports. ` +
    "Prototype estimate, not a certified road-quality score.";
}

/* ROUTING */

function haversine(a, b) {
  const rad = x => x * Math.PI / 180;
  const R = 6371000;

  const dLat = rad(b[0] - a[0]);
  const dLng = rad(b[1] - a[1]);

  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a[0])) * Math.cos(rad(b[0])) *
    Math.sin(dLng / 2) ** 2;

  return 2 * R * Math.asin(Math.sqrt(h));
}

function formatDistance(meters) {
  return meters >= 1000
    ? (meters / 1000).toFixed(1) + " km"
    : Math.round(meters) + " m";
}

function formatDuration(seconds) {
  const minutes = Math.round(seconds / 60);

  return minutes >= 60
    ? `${Math.floor(minutes / 60)} h ${minutes % 60} min`
    : `${minutes} min`;
}

async function getSelectedOrSearchedPlace(inputId) {
  const input = $(inputId);

  if (input.dataset.lat && input.dataset.lng) {
    return {
      lat: Number(input.dataset.lat),
      lng: Number(input.dataset.lng),
      name: input.value
    };
  }

  if (!input.value.trim()) {
    throw new Error("Enter a place and select a suggestion.");
  }

  const url = new URL(
    "https://nominatim.openstreetmap.org/search"
  );

  url.searchParams.set("q", input.value.trim());
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("limit", "1");

  const response = await fetch(url);

  if (!response.ok) {
    throw new Error("Place search failed. Check your internet.");
  }

  const data = await response.json();

  if (!data.length) {
    throw new Error("Place not found. Choose a suggestion.");
  }

  input.dataset.lat = data[0].lat;
  input.dataset.lng = data[0].lon;

  return {
    lat: Number(data[0].lat),
    lng: Number(data[0].lon),
    name: data[0].display_name
  };
}

async function requestDrivingRoutes(origin, destination) {
  const coordinates =
    `${origin.lng},${origin.lat};${destination.lng},${destination.lat}`;

  const url =
    `https://router.project-osrm.org/route/v1/driving/${coordinates}` +
    "?alternatives=true&overview=full&geometries=geojson&steps=true";

  const response = await fetch(url);

  if (!response.ok) {
    throw new Error("Routing service unavailable. Try again.");
  }

  const data = await response.json();

  if (data.code !== "Ok" || !data.routes?.length) {
    throw new Error("No driving route was found.");
  }

  return data.routes;
}

function nearestRouteDistance(report, coordinates) {
  let nearest = Infinity;
  const stride = Math.max(1, Math.floor(coordinates.length / 300));

  for (let i = 0; i < coordinates.length; i += stride) {
    const point = coordinates[i];

    nearest = Math.min(
      nearest,
      haversine([report.lat, report.lng], [point[1], point[0]])
    );
  }

  const last = coordinates[coordinates.length - 1];

  if (last) {
    nearest = Math.min(
      nearest,
      haversine([report.lat, report.lng], [last[1], last[0]])
    );
  }

  return nearest;
}

function scoreRoute(route) {
  const nearby = reports.filter(report =>
    nearestRouteDistance(report, route.geometry.coordinates) < 80
  );

  const potholes = nearby.filter(r => r.type === "pothole").length;
  const roughSpots = nearby.filter(r => r.type === "rough").length;
  const noiseSpots = nearby.filter(r => r.type === "noise").length;

  return {
    potholes,
    roughSpots,
    noiseSpots,
    hazardScore: potholes * 3 + roughSpots * 2 + noiseSpots
  };
}

function drawRoute(route) {
  routeLayers.forEach(layer => map.removeLayer(layer));
  routeLayers = [];

  const line = L.geoJSON(route.geometry, {
    style: {
      color: "#365cf5",
      weight: 7,
      opacity: 0.95
    }
  }).addTo(map);

  routeLayers.push(line);
  map.fitBounds(line.getBounds(), {padding: [25, 25]});
}

function directionText(step) {
  const type = step.maneuver?.type || "";
  const modifier = step.maneuver?.modifier || "";
  const road = step.name ? " onto " + step.name : "";

  if (type === "depart") return "Start driving" + road;
  if (type === "arrive") return "You have arrived at your destination";
  if (type === "roundabout" || type === "rotary") {
    return "Enter the roundabout" + road;
  }
  if (type === "merge") return "Merge" + road;
  if (type === "fork") return "Keep " + modifier + road;
  if (type === "on ramp") return "Take the ramp" + road;
  if (type === "off ramp") return "Take the exit" + road;

  if (type === "turn" || type === "end of road") {
    return "Turn " + (modifier || "ahead") + road;
  }

  if (type === "continue" || type === "new name") {
    return "Continue straight" + road;
  }

  return "Continue" + road;
}

function directionArrow(step) {
  const modifier = step.maneuver?.modifier || "";

  if (modifier.includes("left")) return "↰";
  if (modifier.includes("right")) return "↱";
  if (modifier === "uturn") return "↶";
  if (step.maneuver?.type === "arrive") return "⚑";

  return "↑";
}

/* NAVIGATION DISPLAY */

function enterNavigationMap() {
  $("navigationScreen").hidden = false;
  $("navigationScreen").prepend(mapElement);
  document.body.classList.add("navigation-mode");

  requestAnimationFrame(() => {
    map.invalidateSize(true);

    if (activeNavigationRoute) {
      map.fitBounds(
        L.geoJSON(activeNavigationRoute.geometry).getBounds(),
        {padding: [30, 30]}
      );
    }
  });
}

function exitNavigationMap() {
  document.body.classList.remove("navigation-mode");

  if (
    originalMapNextSibling &&
    originalMapNextSibling.parentElement === originalMapParent
  ) {
    originalMapParent.insertBefore(
      mapElement,
      originalMapNextSibling
    );
  } else {
    originalMapParent.appendChild(mapElement);
  }

  $("navigationScreen").hidden = true;

  requestAnimationFrame(() => map.invalidateSize(true));

  if (navigationWatchId !== null) {
    navigator.geolocation.clearWatch(navigationWatchId);
    navigationWatchId = null;
  }

  $("startNavigation").textContent = "Start location updates";
}

function openNavigation(route) {
  activeNavigationRoute = route;
  enterNavigationMap();

  $("navDuration").textContent = formatDuration(route.duration);
  $("navDistance").textContent = formatDistance(route.distance);

  const arrival = new Date(Date.now() + route.duration * 1000);

  $("navArrival").textContent =
    "ETA " + arrival.toLocaleTimeString([], {
      hour: "numeric",
      minute: "2-digit"
    });

  const score = scoreRoute(route);

  $("navComfort").textContent =
    `Nearby reports: ${score.potholes} potholes, ` +
    `${score.roughSpots} rough-road spots, ` +
    `${score.noiseSpots} noise reports.`;

  const steps = (route.legs || []).flatMap(
    leg => leg.steps || []
  );

  const first = steps.find(step => step.distance > 0) || steps[0];

  $("turnIcon").textContent = first
    ? directionArrow(first)
    : "↑";

  $("turnAction").textContent = "Selected route";

  $("turnRoad").textContent = first
    ? directionText(first)
    : "Follow the highlighted road";

  $("thenTurn").textContent = steps[1]
    ? "Then " + directionText(steps[1]).toLowerCase()
    : "Continue to your destination";

  const list = $("directionList");
  list.replaceChildren();

  steps.forEach((step, index) => {
    const item = document.createElement("div");
    item.className = "direction-step";

    const title = document.createElement("strong");
    title.textContent =
      `${index + 1}. ${directionText(step)}`;

    const detail = document.createElement("small");
    detail.textContent = formatDistance(step.distance);

    item.append(title, detail);
    list.appendChild(item);
  });
}

$("exitNavigation").addEventListener(
  "click",
  exitNavigationMap
);

$("recenterMap").addEventListener("click", () => {
  if (lastPosition) {
    map.setView([lastPosition.lat, lastPosition.lng], 17);
  } else if (activeNavigationRoute) {
    map.fitBounds(
      L.geoJSON(activeNavigationRoute.geometry).getBounds()
    );
  }
});

$("startNavigation").addEventListener("click", () => {
  if (navigationWatchId !== null) return;

  if (!navigator.geolocation) {
    $("turnAction").textContent =
      "Location tracking unavailable";
    return;
  }

  $("startNavigation").textContent = "Navigation running";

  navigationWatchId = navigator.geolocation.watchPosition(
    position => {
      updateUserMarker(position);

      if (!activeNavigationRoute) return;

      const steps = activeNavigationRoute.legs.flatMap(
        leg => leg.steps || []
      );

      let nearestStep = null;
      let nearestDistance = Infinity;

      for (const step of steps) {
        const location = step.maneuver?.location;
        if (!location) continue;

        const distance = haversine(
          [
            position.coords.latitude,
            position.coords.longitude
          ],
          [location[1], location[0]]
        );

        if (distance < nearestDistance) {
          nearestDistance = distance;
          nearestStep = step;
        }
      }

      if (nearestStep) {
        $("turnIcon").textContent =
          directionArrow(nearestStep);

        $("turnRoad").textContent =
          directionText(nearestStep);

        $("turnAction").textContent =
          nearestDistance < 50
            ? "Next manoeuvre"
            : "Follow the route";
      }
    },
    () => {
      $("turnAction").textContent =
        "Allow location to update your position";
    },
    {
      enableHighAccuracy: true,
      maximumAge: 2000,
      timeout: 15000
    }
  );
});

/* ROUTE FORM AND ROUTE SELECTION */

$("routeForm").addEventListener("submit", async event => {
  event.preventDefault();

  if (routeRequestRunning) return;

  const originText = $("routeOrigin").value.trim();
  const destinationText =
    $("routeDestination").value.trim();

  if (!destinationText) {
    $("routeMessage").textContent =
      "Enter a destination first.";
    return;
  }

  routeRequestRunning = true;
  $("findRoutesBtn").disabled = true;
  $("findRoutesBtn").textContent = "Finding route...";
  $("routeMessage").textContent = "Calculating route...";

  setupRouteChoices();
  $("routeChoices").hidden = true;

  try {
    const destination =
      await getSelectedOrSearchedPlace("routeDestination");

    const origin = originText
      ? await getSelectedOrSearchedPlace("routeOrigin")
      : await getCurrentPosition();

    const routes = await requestDrivingRoutes(
      origin,
      destination
    );

    const shortestRoute = [...routes].sort(
      (a, b) => a.distance - b.distance
    )[0];

    const bestConditionRoute = [...routes].sort((a, b) => {
      const scoreA = scoreRoute(a);
      const scoreB = scoreRoute(b);

      const extraDistanceA =
        Math.max(0, a.distance - shortestRoute.distance) / 1000;

      const extraDistanceB =
        Math.max(0, b.distance - shortestRoute.distance) / 1000;

      const extraTimeA =
        Math.max(0, a.duration - shortestRoute.duration) / 60;

      const extraTimeB =
        Math.max(0, b.duration - shortestRoute.duration) / 60;

      const totalA =
        scoreA.hazardScore +
        extraDistanceA * 1.5 +
        extraTimeA * 0.25;

      const totalB =
        scoreB.hazardScore +
        extraDistanceB * 1.5 +
        extraTimeB * 0.25;

      return totalA - totalB;
    })[0];

    availableRouteChoices = [shortestRoute];

    if (bestConditionRoute !== shortestRoute) {
      availableRouteChoices.push(bestConditionRoute);
    }

    drawRoute(shortestRoute);
    updateRouteComfort(shortestRoute);

    renderRouteChoices(
      availableRouteChoices,
      shortestRoute
    );

    $("routeMessage").textContent = routes.length > 1
      ? `Found ${routes.length} route option(s). Choose the route that suits you.`
      : "Only one route is available. Showing the available route.";

    $("routeChoices").scrollIntoView({
      behavior: "smooth",
      block: "nearest"
    });
  } catch (error) {
    $("routeMessage").textContent = error.message;
  } finally {
    routeRequestRunning = false;
    $("findRoutesBtn").disabled = false;
    $("findRoutesBtn").textContent = "Show directions";
  }
});

/* INITIALIZE AND CLEAN UP */

renderMap();
renderFeed();

window.addEventListener("beforeunload", () => {
  if (watchId !== null) {
    navigator.geolocation.clearWatch(watchId);
  }

  if (navigationWatchId !== null) {
    navigator.geolocation.clearWatch(navigationWatchId);
  }

  if (motionHandler) {
    window.removeEventListener(
      "devicemotion",
      motionHandler
    );
  }

  if (audioFrame !== null) {
    cancelAnimationFrame(audioFrame);
  }

  if (audioStream) {
    audioStream.getTracks().forEach(track => track.stop());
  }

  if (audioContext) {
    audioContext.close();
  }
});