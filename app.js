"use strict";

const FETCH_TIMEOUT_MS = 10000;
const TIMELINE_HOURS = 24;
const WEATHER_REFRESH_MS = 30 * 60 * 1000;

const state = {
  // { time: [unix seconds...], temperature: [...], isDay: [...], utcOffsetSeconds }
  // index 0 is always the current hour (trimmed on load)
  hourly: null,
  deferredInstallPrompt: null,
  requestToken: 0, // invalidates stale in-flight weather requests
  lastRecommendation: null, // "open" | "close", set on every renderResult
  lastLocation: null, // { lat, lon, label } of the last successful weather load
  weatherLoadedAt: 0,
  notifyEnabled: false,
  notifyTimer: null,
  ha: { url: "", token: "", sensorId: "", coverIds: [], refreshTimer: null },
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
  haHelpToggle: document.getElementById("ha-help-toggle"),
  haHelp: document.getElementById("ha-help"),
  haUrl: document.getElementById("ha-url"),
  haToken: document.getElementById("ha-token"),
  btnHaConnect: document.getElementById("btn-ha-connect"),
  haStatus: document.getElementById("ha-status"),
  haDevices: document.getElementById("ha-devices"),
  haSensor: document.getElementById("ha-sensor"),
  haCovers: document.getElementById("ha-covers"),
  btnShuttersOpen: document.getElementById("btn-shutters-open"),
  btnShuttersClose: document.getElementById("btn-shutters-close"),
  btnApplyReco: document.getElementById("btn-apply-reco"),
  btnNotify: document.getElementById("btn-notify"),
  notifyStatus: document.getElementById("notify-status"),
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

const btnCitySubmit = document.querySelector("#form-city button[type=submit]");

function setBusy(busy) {
  el.btnGeoloc.disabled = busy;
  btnCitySubmit.disabled = busy;
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
  state.lastRecommendation = rec.action;
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
    const cellLabel = `${hourLabel} : ${outdoorTemp}°C, volets ${rec.action === "close" ? "fermés" : "ouverts"}`;
    hourEl.title = cellLabel;
    hourEl.setAttribute("aria-label", cellLabel);
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
    !h.time.every(Number.isFinite) ||
    !h.temperature_2m.every(Number.isFinite) ||
    !h.is_day.every(Number.isFinite)
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

    state.lastLocation = { lat, lon, label };
    state.weatherLoadedAt = Date.now();
    const timeLabel = new Date().toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
    el.locationStatus.textContent = `${label ? `Météo chargée pour ${label}` : "Météo chargée pour votre position"} · MAJ ${timeLabel}`;
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
    scheduleNotifications();
    syncWatchSnapshot();
  } catch (err) {
    if (token !== state.requestToken) return;
    el.locationStatus.textContent = "Météo automatique indisponible. Utilisez le mode manuel ci-dessous.";
    el.manualCard.classList.remove("hidden");
  } finally {
    if (token === state.requestToken) setBusy(false);
  }
}

// Re-fetch the forecast when it goes stale so a device left open (installed
// PWA, wall tablet) keeps showing a recommendation for the current hour.
function refreshWeatherIfStale() {
  if (!state.lastLocation) return;
  if (Date.now() - state.weatherLoadedAt < WEATHER_REFRESH_MS) return;
  const { lat, lon, label } = state.lastLocation;
  loadWeatherFor(lat, lon, label);
}

setInterval(refreshWeatherIfStale, WEATHER_REFRESH_MS);
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) refreshWeatherIfStale();
});

el.btnGeoloc.addEventListener("click", () => {
  if (!navigator.geolocation) {
    el.locationStatus.textContent = "Géolocalisation non supportée. Utilisez le mode manuel.";
    el.manualCard.classList.remove("hidden");
    return;
  }
  el.locationStatus.textContent = "Localisation en cours…";
  setBusy(true);
  const tokenBeforeGeoloc = state.requestToken;
  navigator.geolocation.getCurrentPosition(
    // ~1 km precision is plenty for weather and avoids sending an exact
    // home location to a third-party API.
    (pos) => loadWeatherFor(pos.coords.latitude.toFixed(2), pos.coords.longitude.toFixed(2)),
    () => {
      // Only release the buttons if no other request took over meanwhile.
      if (state.requestToken === tokenBeforeGeoloc) setBusy(false);
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
      scheduleNotifications();
      syncWatchSnapshot();
    }
  });
});

// ---------------------------------------------------------------------------
// Notifications: alert at the moment the recommendation flips open <-> close
// ---------------------------------------------------------------------------

const NOTIFY_KEY = "volet-malin-notify";
// Never fire a notification during these device-local hours; a night-time
// transition is deferred to the end of the quiet window instead.
const QUIET_START_HOUR = 23;
const QUIET_END_HOUR = 7;

function msUntilQuietEnd(now = new Date()) {
  const h = now.getHours();
  const inQuiet = h >= QUIET_START_HOUR || h < QUIET_END_HOUR;
  if (!inQuiet) return 0;
  const end = new Date(now);
  end.setHours(QUIET_END_HOUR, 0, 0, 0);
  if (h >= QUIET_START_HOUR) end.setDate(end.getDate() + 1);
  return end.getTime() - now.getTime();
}

// Tiny IndexedDB key-value store, shared with the service worker so its
// periodic background checks can read the location/settings snapshot.
function idbOpen() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open("volet-malin", 1);
    req.onupgradeneeded = () => req.result.createObjectStore("kv");
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbSet(key, value) {
  const db = await idbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("kv", "readwrite");
    tx.objectStore("kv").put(value, key);
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(tx.error); };
  });
}

async function idbGet(key) {
  const db = await idbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("kv", "readonly");
    const rq = tx.objectStore("kv").get(key);
    rq.onsuccess = () => { db.close(); resolve(rq.result); };
    rq.onerror = () => { db.close(); reject(rq.error); };
  });
}

// Snapshot for the service worker's periodicsync checks (app closed).
function syncWatchSnapshot() {
  if (!state.lastLocation) return;
  const { indoorTemp, targetMin, targetMax } = getSettings();
  idbSet("watch", {
    enabled: state.notifyEnabled,
    lat: state.lastLocation.lat,
    lon: state.lastLocation.lon,
    indoorTemp,
    targetMin,
    targetMax,
    lastAction: state.lastRecommendation,
  }).catch(() => {});
}

// All future open/close transitions in the loaded forecast.
function upcomingChanges() {
  if (!state.hourly) return [];
  const { indoorTemp, targetMin, targetMax } = getSettings();
  const { time, temperature, isDay, utcOffsetSeconds } = state.hourly;
  const changes = [];
  let prevAction = null;
  for (let i = 0; i < time.length; i++) {
    const rec = getRecommendation({
      outdoorTemp: Math.round(temperature[i]),
      indoorTemp,
      targetMin,
      targetMax,
      isDay: isDay[i] === 1,
    });
    if (prevAction !== null && rec.action !== prevAction) {
      changes.push({
        atSeconds: time[i],
        action: rec.action,
        reason: rec.reason,
        hourLabel: localHourLabel(time[i], utcOffsetSeconds),
      });
    }
    prevAction = rec.action;
  }
  return changes;
}

// Morning catch-up after quiet hours: notify the recommendation that is
// current *now*, deduplicated against the last alert. A flip that reverted
// overnight produces no notification at all.
async function notifyCurrentIfChanged() {
  if (!state.hourly) return;
  const { indoorTemp, targetMin, targetMax } = getSettings();
  const { time, temperature, isDay } = state.hourly;
  const nowSeconds = Date.now() / 1000;
  let idx = 0;
  for (let i = 0; i < time.length; i++) {
    if (time[i] > nowSeconds) break;
    idx = i;
  }
  const rec = getRecommendation({
    outdoorTemp: Math.round(temperature[idx]),
    indoorTemp,
    targetMin,
    targetMax,
    isDay: isDay[idx] === 1,
  });
  await fireActionNotification({ action: rec.action, reason: rec.reason });
}

async function fireActionNotification(change) {
  try {
    // Skip if the service worker's background check already notified this flip.
    const watch = await idbGet("watch").catch(() => null);
    if (watch && watch.lastAction === change.action) return;
    const reg = await navigator.serviceWorker.ready;
    await reg.showNotification(
      change.action === "close" ? "Fermez vos volets 🌡️" : "Ouvrez vos volets ☀️",
      { body: change.reason, tag: "volet-action", icon: "icons/icon-192.png", badge: "icons/icon-96.png" }
    );
    if (watch) {
      watch.lastAction = change.action;
      idbSet("watch", watch).catch(() => {});
    }
  } catch {
    /* notification failed: nothing actionable */
  }
}

function updateNotifyUI(extraStatus) {
  el.btnNotify.textContent = state.notifyEnabled
    ? "🔕 Désactiver les notifications"
    : "🔔 Activer les notifications";
  if (extraStatus !== undefined) {
    el.notifyStatus.textContent = extraStatus;
  }
}

function scheduleNotifications() {
  clearTimeout(state.notifyTimer);
  state.notifyTimer = null;
  if (!state.notifyEnabled) return;
  if (!state.hourly) {
    updateNotifyUI("Notifications activées. Chargez la météo de votre position pour programmer les alertes.");
    return;
  }
  const next = upcomingChanges().find((c) => c.atSeconds * 1000 > Date.now());
  if (!next) {
    updateNotifyUI("Notifications activées · aucun changement prévu dans les prochaines 48 h.");
    return;
  }
  const delay = Math.min(next.atSeconds * 1000 - Date.now(), 2 ** 31 - 1);
  state.notifyTimer = setTimeout(async () => {
    const quietMs = msUntilQuietEnd();
    if (quietMs > 0) {
      // Transition falls in quiet hours: wait until morning, then notify
      // the recommendation valid at that moment (if it still differs).
      state.notifyTimer = setTimeout(async () => {
        await notifyCurrentIfChanged();
        scheduleNotifications();
      }, quietMs);
      return;
    }
    await fireActionNotification(next);
    scheduleNotifications(); // chain to the following transition
  }, delay);
  updateNotifyUI(
    `Notifications activées · prochaine alerte : ${next.action === "close" ? "FERMER" : "OUVRIR"} vers ${next.hourLabel}.`
  );
}

async function enableNotifications() {
  if (!("Notification" in window) || !("serviceWorker" in navigator)) {
    const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
    updateNotifyUI(
      isIOS
        ? "Sur iPhone/iPad : installez d'abord l'app (Partager → Sur l'écran d'accueil), puis activez les notifications depuis l'app installée."
        : "Les notifications ne sont pas supportées par ce navigateur."
    );
    return;
  }
  const permission = await Notification.requestPermission();
  if (permission !== "granted") {
    updateNotifyUI("Autorisation refusée. Vous pouvez la réactiver dans les réglages du navigateur.");
    return;
  }
  state.notifyEnabled = true;
  storage.set(NOTIFY_KEY, "1");
  scheduleNotifications();
  syncWatchSnapshot();
  // Progressive enhancement: periodic background checks (Chrome/Android,
  // installed PWA) so the flip is detected even with the app closed.
  try {
    const reg = await navigator.serviceWorker.ready;
    if ("periodicSync" in reg) {
      await reg.periodicSync.register("volet-check", { minInterval: 60 * 60 * 1000 });
    }
  } catch {
    /* not available: in-app scheduling still works */
  }
}

async function disableNotifications() {
  state.notifyEnabled = false;
  storage.set(NOTIFY_KEY, "0");
  clearTimeout(state.notifyTimer);
  state.notifyTimer = null;
  updateNotifyUI("Notifications désactivées.");
  syncWatchSnapshot();
  try {
    const reg = await navigator.serviceWorker.ready;
    if ("periodicSync" in reg) await reg.periodicSync.unregister("volet-check");
  } catch {
    /* ignore */
  }
}

el.btnNotify.addEventListener("click", () => {
  if (state.notifyEnabled) {
    disableNotifications();
  } else {
    enableNotifications();
  }
});

// Restore notification preference (permission may have been revoked since).
if (
  storage.get(NOTIFY_KEY) === "1" &&
  "Notification" in window &&
  Notification.permission === "granted"
) {
  state.notifyEnabled = true;
  scheduleNotifications();
}
updateNotifyUI();

// ---------------------------------------------------------------------------
// Home Assistant: read indoor thermometers, drive shutters (cover entities)
// ---------------------------------------------------------------------------

const HA_KEY = "volet-malin-ha";
const HA_SENSOR_REFRESH_MS = 5 * 60 * 1000;

function haBaseUrl() {
  return state.ha.url.replace(/\/+$/, "");
}

function haValidateUrl(raw) {
  const url = new URL(raw); // throws if malformed
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("Protocole non supporté");
  }
  return url.origin + url.pathname.replace(/\/+$/, "");
}

async function haFetch(path, body) {
  const res = await fetch(haBaseUrl() + path, {
    method: body ? "POST" : "GET",
    headers: {
      Authorization: `Bearer ${state.ha.token}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: timeoutSignal(FETCH_TIMEOUT_MS),
  });
  if (res.status === 401 || res.status === 403) throw new Error("Jeton refusé");
  if (!res.ok) throw new Error(`Erreur Home Assistant (${res.status})`);
  return res.json();
}

function haSaveConfig() {
  storage.set(
    HA_KEY,
    JSON.stringify({
      url: state.ha.url,
      token: state.ha.token,
      sensorId: state.ha.sensorId,
      coverIds: state.ha.coverIds,
    })
  );
}

function haSelectedCoverIds() {
  return Array.from(el.haCovers.querySelectorAll("input:checked")).map((c) => c.value);
}

function isTemperatureSensor(s) {
  if (!s.entity_id.startsWith("sensor.")) return false;
  const attrs = s.attributes || {};
  const isTemp =
    attrs.device_class === "temperature" || String(attrs.unit_of_measurement || "").includes("°C");
  return isTemp && Number.isFinite(parseFloat(s.state));
}

function haRenderDevices(states) {
  const sensors = states.filter(isTemperatureSensor);
  const covers = states.filter((s) => s.entity_id.startsWith("cover."));

  el.haSensor.replaceChildren();
  const noneOpt = document.createElement("option");
  noneOpt.value = "";
  noneOpt.textContent = "— Aucun (saisie manuelle) —";
  el.haSensor.appendChild(noneOpt);
  sensors.forEach((s) => {
    const opt = document.createElement("option");
    opt.value = s.entity_id;
    opt.textContent = `${s.attributes.friendly_name || s.entity_id} (${parseFloat(s.state)}°C)`;
    el.haSensor.appendChild(opt);
  });
  if (state.ha.sensorId && sensors.some((s) => s.entity_id === state.ha.sensorId)) {
    el.haSensor.value = state.ha.sensorId;
  } else if (state.ha.sensorId) {
    // The saved sensor no longer exists in HA: forget it, otherwise we would
    // keep polling a dead entity (404) every 5 minutes forever.
    state.ha.sensorId = "";
    haSaveConfig();
  }

  el.haCovers.replaceChildren();
  if (covers.length === 0) {
    el.haCovers.appendChild(makeDiv("hint", "Aucun volet trouvé dans Home Assistant."));
  }
  covers.forEach((c) => {
    const label = document.createElement("label");
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.value = c.entity_id;
    checkbox.checked = state.ha.coverIds.includes(c.entity_id);
    const span = document.createElement("span");
    span.textContent = c.attributes.friendly_name || c.entity_id;
    label.append(checkbox, span);
    el.haCovers.appendChild(label);
  });

  el.haDevices.classList.remove("hidden");
  return { sensorCount: sensors.length, coverCount: covers.length };
}

function haApplySensorReading(tempValue) {
  const temp = parseFloat(tempValue);
  if (!Number.isFinite(temp)) return;
  el.inputIndoor.value = String(Math.round(temp * 10) / 10);
  saveSettings();
  if (state.hourly) {
    renderCurrentRecommendation();
    renderTimeline();
  }
}

async function haRefreshSensor() {
  if (!state.ha.sensorId || !state.ha.token) return;
  try {
    const s = await haFetch(`/api/states/${encodeURIComponent(state.ha.sensorId)}`);
    haApplySensorReading(s.state);
  } catch (err) {
    // A rejected token won't fix itself: stop polling and tell the user.
    if (err && err.message === "Jeton refusé") {
      clearInterval(state.ha.refreshTimer);
      state.ha.refreshTimer = null;
      el.haStatus.textContent = "Jeton Home Assistant expiré ou révoqué. Reconnectez-vous.";
    }
    /* otherwise transient failure: keep last known value */
  }
}

function haStartSensorRefresh() {
  clearInterval(state.ha.refreshTimer);
  state.ha.refreshTimer = setInterval(haRefreshSensor, HA_SENSOR_REFRESH_MS);
}

async function haConnect({ silent = false } = {}) {
  let cleanUrl;
  try {
    cleanUrl = haValidateUrl(el.haUrl.value.trim());
  } catch {
    if (!silent) el.haStatus.textContent = "Adresse invalide. Exemple : http://192.168.1.20:8123";
    return;
  }
  const token = el.haToken.value.trim();
  if (!token) {
    if (!silent) el.haStatus.textContent = "Entrez votre jeton d'accès longue durée.";
    return;
  }

  state.ha.url = cleanUrl;
  state.ha.token = token;
  el.btnHaConnect.disabled = true;
  el.haStatus.textContent = "Connexion à Home Assistant…";
  try {
    const states = await haFetch("/api/states");
    if (!Array.isArray(states)) throw new Error("Réponse inattendue");
    const { sensorCount, coverCount } = haRenderDevices(states);
    el.haStatus.textContent = `Connecté ✓ ${sensorCount} thermomètre(s), ${coverCount} volet(s) trouvés.`;
    haSaveConfig();
    if (state.ha.sensorId) {
      const match = states.find((s) => s.entity_id === state.ha.sensorId);
      if (match) haApplySensorReading(match.state);
    }
    haStartSensorRefresh();
  } catch (err) {
    el.haDevices.classList.add("hidden");
    el.haStatus.textContent =
      err.message === "Jeton refusé"
        ? "Jeton refusé par Home Assistant. Vérifiez-le et réessayez."
        : "Home Assistant injoignable. Vérifiez l'adresse (et le HTTPS si l'app est en ligne).";
  } finally {
    el.btnHaConnect.disabled = false;
  }
}

async function haCoverCommand(service, statusVerb) {
  const ids = haSelectedCoverIds();
  if (ids.length === 0) {
    el.haStatus.textContent = "Cochez au moins un volet à piloter.";
    return;
  }
  el.btnShuttersOpen.disabled = true;
  el.btnShuttersClose.disabled = true;
  el.btnApplyReco.disabled = true;
  try {
    await haFetch(`/api/services/cover/${service}`, { entity_id: ids });
    el.haStatus.textContent = `Ordre envoyé : ${statusVerb} ${ids.length} volet(s) ✓`;
  } catch {
    el.haStatus.textContent = "Échec de l'envoi de la commande aux volets.";
  } finally {
    el.btnShuttersOpen.disabled = false;
    el.btnShuttersClose.disabled = false;
    el.btnApplyReco.disabled = false;
  }
}

function haRestoreConfig() {
  const raw = storage.get(HA_KEY);
  if (!raw) return;
  try {
    const saved = JSON.parse(raw);
    if (typeof saved.url === "string") el.haUrl.value = saved.url;
    if (typeof saved.token === "string") el.haToken.value = saved.token;
    if (typeof saved.sensorId === "string") state.ha.sensorId = saved.sensorId;
    if (Array.isArray(saved.coverIds)) state.ha.coverIds = saved.coverIds.map(String);
    if (saved.url && saved.token) haConnect({ silent: true });
  } catch {
    /* corrupted entry: start unconfigured */
  }
}

el.haHelpToggle.addEventListener("click", () => el.haHelp.classList.toggle("hidden"));
el.btnHaConnect.addEventListener("click", () => haConnect());

el.haSensor.addEventListener("change", () => {
  state.ha.sensorId = el.haSensor.value;
  haSaveConfig();
  if (state.ha.sensorId) haRefreshSensor();
});

el.haCovers.addEventListener("change", () => {
  state.ha.coverIds = haSelectedCoverIds();
  haSaveConfig();
});

el.btnShuttersOpen.addEventListener("click", () => haCoverCommand("open_cover", "ouvrir"));
el.btnShuttersClose.addEventListener("click", () => haCoverCommand("close_cover", "fermer"));

el.btnApplyReco.addEventListener("click", () => {
  if (!state.lastRecommendation) {
    el.haStatus.textContent = "Obtenez d'abord une recommandation (météo ou mode manuel).";
    return;
  }
  if (state.lastRecommendation === "close") {
    haCoverCommand("close_cover", "fermer");
  } else {
    haCoverCommand("open_cover", "ouvrir");
  }
});

haRestoreConfig();
