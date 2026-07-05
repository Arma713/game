"use strict";

const FETCH_TIMEOUT_MS = 10000;
const TIMELINE_HOURS = 24;

const state = {
  // { time: [unix seconds...], temperature: [...], isDay: [...], utcOffsetSeconds }
  // index 0 is always the current hour (trimmed on load)
  hourly: null,
  deferredInstallPrompt: null,
  requestToken: 0, // invalidates stale in-flight weather requests
};

const el = {
  btnGeoloc: document.getElementById("btn-geoloc"),
  formCity: document.getElementById("form-city"),
  inputCity: document.getElementById("input-city"),
  locationStatus: document.getElementById("location-status"),
  inputIndoor: document.getElementById("input-indoor"),
  inputMin: document.getElementById("input-min"),
  inputMax: document.getElementById("input-max"),
  manualCard: document.getElementById("manual-card"),
  inputOutdoor: document.getElementById("input-outdoor"),
  inputDaytime: document.getElementById("input-daytime"),
  btnManualCompute: document.getElementById("btn-manual-compute"),
  resultCard: document.getElementById("result-card"),
  resultIcon: document.getElementById("result-icon"),
  resultAction: document.getElementById("result-action"),
  resultReason: document.getElementById("result-reason"),
  timelineCard: document.getElementById("timeline-card"),
  timeline: document.getElementById("timeline"),
  timelineChanges: document.getElementById("timeline-changes"),
  installBanner: document.getElementById("install-banner"),
  installInstructions: document.getElementById("install-instructions"),
  btnInstall: document.getElementById("btn-install"),
  btnDismissInstall: document.getElementById("btn-dismiss-install"),
};

// localStorage throws in some private-browsing modes; degrade to no-op.
const storage = {
  get(key) {
    try { return localStorage.getItem(key); } catch { return null; }
  },
  set(key, value) {
    try { localStorage.setItem(key, value); } catch { /* ignore */ }
  },
};

function toFiniteNumber(value, fallback) {
  const n = parseFloat(value);
  return Number.isFinite(n) ? n : fallback;
}

// AbortSignal.timeout is missing on Safari < 16; emulate it there.
function timeoutSignal(ms) {
  if (typeof AbortSignal.timeout === "function") return AbortSignal.timeout(ms);
  const controller = new AbortController();
  setTimeout(() => controller.abort(), ms);
  return controller.signal;
}

function setBusy(busy) {
  el.btnGeoloc.disabled = busy;
  el.formCity.querySelector("button[type=submit]").disabled = busy;
}

// Hour of day at the observed location, regardless of the browser's timezone.
function localHourLabel(unixSeconds, utcOffsetSeconds) {
  const d = new Date((unixSeconds + utcOffsetSeconds) * 1000);
  return d.getUTCHours().toString().padStart(2, "0") + "h";
}

const SETTINGS_KEY = "volet-malin-settings";

function saveSettings() {
  storage.set(
    SETTINGS_KEY,
    JSON.stringify({
      indoor: el.inputIndoor.value,
      min: el.inputMin.value,
      max: el.inputMax.value,
    })
  );
}

function restoreSettings() {
  const raw = storage.get(SETTINGS_KEY);
  if (!raw) return;
  try {
    const s = JSON.parse(raw);
    if (Number.isFinite(parseFloat(s.indoor))) el.inputIndoor.value = s.indoor;
    if (Number.isFinite(parseFloat(s.min))) el.inputMin.value = s.min;
    if (Number.isFinite(parseFloat(s.max))) el.inputMax.value = s.max;
  } catch {
    /* corrupted entry: keep defaults */
  }
}

function setupInstallBanner() {
  const isStandalone =
    window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;
  if (isStandalone) return;
  if (storage.get("volet-malin-install-dismissed") === "1") return;

  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);

  if (isIOS) {
    el.installInstructions.textContent =
      "Appuyez sur Partager, puis \"Sur l'écran d'accueil\" pour installer l'app.";
    el.installBanner.classList.remove("hidden");
  } else {
    el.installInstructions.textContent = "Ajoutez l'app à votre écran d'accueil pour un accès rapide.";
    window.addEventListener("beforeinstallprompt", (e) => {
      e.preventDefault();
      state.deferredInstallPrompt = e;
      el.btnInstall.classList.remove("hidden");
      el.installBanner.classList.remove("hidden");
    });
  }

  el.btnInstall.addEventListener("click", async () => {
    if (!state.deferredInstallPrompt) return;
    state.deferredInstallPrompt.prompt();
    await state.deferredInstallPrompt.userChoice;
    state.deferredInstallPrompt = null;
    el.installBanner.classList.add("hidden");
  });

  el.btnDismissInstall.addEventListener("click", () => {
    storage.set("volet-malin-install-dismissed", "1");
    el.installBanner.classList.add("hidden");
  });
}

function registerServiceWorker() {
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }
}

setupInstallBanner();
registerServiceWorker();
restoreSettings();

function getRecommendation({ outdoorTemp, indoorTemp, targetMin, targetMax, isDay }) {
  if (isDay) {
    if (outdoorTemp > targetMax) {
      return {
        action: "close",
        reason: `Il fait ${outdoorTemp}°C dehors, au-dessus de votre confort (${targetMax}°C). Fermez les volets pour bloquer la chaleur et le rayonnement solaire.`,
      };
    }
    if (outdoorTemp < targetMin) {
      return {
        action: "open",
        reason: `Il fait ${outdoorTemp}°C dehors, en dessous de votre confort (${targetMin}°C). Ouvrez les volets pour profiter du soleil et réchauffer la pièce.`,
      };
    }
    return {
      action: "open",
      reason: `Température extérieure agréable (${outdoorTemp}°C). Ouvrez les volets pour profiter de la lumière naturelle.`,
    };
  }
  if (outdoorTemp < targetMin) {
    return {
      action: "close",
      reason: `Il fait ${outdoorTemp}°C dehors cette nuit, plus frais que votre confort. Fermez les volets pour limiter les pertes de chaleur.`,
    };
  }
  if (indoorTemp > targetMax && outdoorTemp < indoorTemp) {
    return {
      action: "open",
      reason: `Il fait plus frais dehors (${outdoorTemp}°C) qu'à l'intérieur (${indoorTemp}°C). Ouvrez pour aérer et rafraîchir la maison pendant la nuit.`,
    };
  }
  return {
    action: "close",
    reason: `Fermez les volets la nuit pour conserver la chaleur et améliorer l'isolation.`,
  };
}

function renderResult(rec) {
  el.resultCard.classList.remove("hidden");
  el.resultIcon.className = `result-icon ${rec.action}`;
  el.resultIcon.textContent = rec.action === "close" ? "🌡️" : "☀️";
  el.resultAction.className = `result-action ${rec.action}`;
  el.resultAction.textContent = rec.action === "close" ? "Fermez vos volets" : "Ouvrez vos volets";
  el.resultReason.textContent = rec.reason;
}

function getSettings() {
  const indoorTemp = toFiniteNumber(el.inputIndoor.value, 22);
  let targetMin = toFiniteNumber(el.inputMin.value, 19);
  let targetMax = toFiniteNumber(el.inputMax.value, 24);
  if (targetMin > targetMax) [targetMin, targetMax] = [targetMax, targetMin];
  return { indoorTemp, targetMin, targetMax };
}

function computeManual() {
  const { indoorTemp, targetMin, targetMax } = getSettings();
  const outdoorTemp = toFiniteNumber(el.inputOutdoor.value, 20);
  const isDay = el.inputDaytime.value === "day";
  const rec = getRecommendation({ outdoorTemp, indoorTemp, targetMin, targetMax, isDay });
  renderResult(rec);
  el.timelineCard.classList.add("hidden");
}

function makeDiv(className, text) {
  const div = document.createElement("div");
  if (className) div.className = className;
  if (text !== undefined) div.textContent = text;
  return div;
}

function renderCurrentRecommendation() {
  if (!state.hourly || state.hourly.time.length === 0) return;
  const { indoorTemp, targetMin, targetMax } = getSettings();
  const outdoorTemp = Math.round(state.hourly.temperature[0]);
  const isDay = state.hourly.isDay[0] === 1;
  renderResult(getRecommendation({ outdoorTemp, indoorTemp, targetMin, targetMax, isDay }));
}

function renderTimeline() {
  if (!state.hourly) return;
  const { indoorTemp, targetMin, targetMax } = getSettings();
  const { time, temperature, isDay, utcOffsetSeconds } = state.hourly;

  el.timeline.replaceChildren();
  el.timelineChanges.replaceChildren();

  const hoursFragment = document.createDocumentFragment();
  let prevAction = null;
  const changes = [];

  for (let i = 0; i < time.length && i < TIMELINE_HOURS; i++) {
    const outdoorTemp = Math.round(temperature[i]);
    const day = isDay[i] === 1;
    const rec = getRecommendation({ outdoorTemp, indoorTemp, targetMin, targetMax, isDay: day });
    const hourLabel = localHourLabel(time[i], utcOffsetSeconds);

    const hourEl = makeDiv("timeline-hour");
    hourEl.appendChild(makeDiv("", hourLabel));
    hourEl.appendChild(makeDiv(`bar ${rec.action}`, rec.action === "close" ? "🌡️" : "☀️"));
    hourEl.appendChild(makeDiv("temp", `${outdoorTemp}°`));
    hoursFragment.appendChild(hourEl);

    if (rec.action !== prevAction) {
      changes.push({ hourLabel, action: rec.action, index: i });
      prevAction = rec.action;
    }
  }
  el.timeline.appendChild(hoursFragment);

  const changesFragment = document.createDocumentFragment();
  changes.forEach((c) => {
    if (c.index === 0) return;
    const item = makeDiv("change-item");
    const badge = document.createElement("span");
    badge.className = `badge ${c.action}`;
    badge.textContent = c.action === "close" ? "FERMER" : "OUVRIR";
    const label = document.createElement("span");
    label.textContent = `vers ${c.hourLabel}`;
    item.append(badge, label);
    changesFragment.appendChild(item);
  });
  el.timelineChanges.appendChild(changesFragment);

  el.timelineCard.classList.remove("hidden");
}

function fetchWithTimeout(url) {
  return fetch(url, { signal: timeoutSignal(FETCH_TIMEOUT_MS) });
}

async function fetchWeather(lat, lon) {
  const url = new URL("https://api.open-meteo.com/v1/forecast");
  url.searchParams.set("latitude", lat);
  url.searchParams.set("longitude", lon);
  url.searchParams.set("hourly", "temperature_2m,is_day");
  url.searchParams.set("timezone", "auto");
  // Unix timestamps are timezone-unambiguous; local ISO strings would be
  // parsed in the browser's timezone, not the searched location's.
  url.searchParams.set("timeformat", "unixtime");
  url.searchParams.set("forecast_days", "2");
  const res = await fetchWithTimeout(url);
  if (!res.ok) throw new Error("Erreur météo");
  const data = await res.json();
  const h = data && data.hourly;
  if (
    !h ||
    !Array.isArray(h.time) ||
    !Array.isArray(h.temperature_2m) ||
    !Array.isArray(h.is_day) ||
    h.time.length === 0 ||
    h.time.length !== h.temperature_2m.length ||
    h.time.length !== h.is_day.length ||
    !h.time.every(Number.isFinite)
  ) {
    throw new Error("Réponse météo invalide");
  }
  const utcOffsetSeconds = Number.isFinite(data.utc_offset_seconds) ? data.utc_offset_seconds : 0;
  return { time: h.time, temperature: h.temperature_2m, isDay: h.is_day, utcOffsetSeconds };
}

async function fetchCityCoords(cityName) {
  const url = new URL("https://geocoding-api.open-meteo.com/v1/search");
  url.searchParams.set("name", cityName);
  url.searchParams.set("count", "1");
  url.searchParams.set("language", "fr");
  url.searchParams.set("format", "json");
  const res = await fetchWithTimeout(url);
  if (!res.ok) throw new Error("Erreur géocodage");
  const data = await res.json();
  if (!data.results || data.results.length === 0) throw new Error("Ville introuvable");
  const r = data.results[0];
  if (!Number.isFinite(r.latitude) || !Number.isFinite(r.longitude)) {
    throw new Error("Coordonnées invalides");
  }
  return { lat: r.latitude, lon: r.longitude, name: String(r.name || cityName) };
}

async function loadWeatherFor(lat, lon, label) {
  const token = ++state.requestToken;
  el.locationStatus.textContent = "Récupération de la météo…";
  setBusy(true);
  try {
    const hourly = await fetchWeather(lat, lon);
    if (token !== state.requestToken) return; // a newer request superseded this one

    el.locationStatus.textContent = label ? `Météo chargée pour ${label}` : "Météo chargée pour votre position";
    el.manualCard.classList.add("hidden");

    const nowSeconds = Date.now() / 1000;
    let nowIdx = 0;
    for (let i = 0; i < hourly.time.length; i++) {
      if (hourly.time[i] > nowSeconds) break;
      nowIdx = i;
    }
    state.hourly = {
      time: hourly.time.slice(nowIdx),
      temperature: hourly.temperature.slice(nowIdx),
      isDay: hourly.isDay.slice(nowIdx),
      utcOffsetSeconds: hourly.utcOffsetSeconds,
    };
    renderCurrentRecommendation();
    renderTimeline();
  } catch (err) {
    if (token !== state.requestToken) return;
    el.locationStatus.textContent = "Météo automatique indisponible. Utilisez le mode manuel ci-dessous.";
    el.manualCard.classList.remove("hidden");
  } finally {
    if (token === state.requestToken) setBusy(false);
  }
}

el.btnGeoloc.addEventListener("click", () => {
  if (!navigator.geolocation) {
    el.locationStatus.textContent = "Géolocalisation non supportée. Utilisez le mode manuel.";
    el.manualCard.classList.remove("hidden");
    return;
  }
  el.locationStatus.textContent = "Localisation en cours…";
  setBusy(true);
  navigator.geolocation.getCurrentPosition(
    // ~1 km precision is plenty for weather and avoids sending an exact
    // home location to a third-party API.
    (pos) => loadWeatherFor(pos.coords.latitude.toFixed(2), pos.coords.longitude.toFixed(2)),
    () => {
      setBusy(false);
      el.locationStatus.textContent = "Position refusée ou indisponible. Utilisez le mode manuel.";
      el.manualCard.classList.remove("hidden");
    },
    { timeout: 8000, maximumAge: 300000 }
  );
});

el.formCity.addEventListener("submit", async (e) => {
  e.preventDefault();
  const cityName = el.inputCity.value.trim().slice(0, 80);
  if (!cityName) return;
  const token = ++state.requestToken;
  el.locationStatus.textContent = "Recherche de la ville…";
  setBusy(true);
  try {
    const { lat, lon, name } = await fetchCityCoords(cityName);
    if (token !== state.requestToken) return;
    await loadWeatherFor(lat, lon, name);
  } catch (err) {
    if (token !== state.requestToken) return;
    setBusy(false);
    el.locationStatus.textContent = "Ville introuvable ou service indisponible. Utilisez le mode manuel.";
    el.manualCard.classList.remove("hidden");
  }
});

el.btnManualCompute.addEventListener("click", computeManual);

[el.inputIndoor, el.inputMin, el.inputMax].forEach((input) => {
  input.addEventListener("change", () => {
    saveSettings();
    if (state.hourly) {
      renderCurrentRecommendation();
      renderTimeline();
    }
  });
});
