const state = {
  hourly: null, // { time: [...], temperature: [...], isDay: [...] }
  deferredInstallPrompt: null,
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

function setupInstallBanner() {
  const isStandalone =
    window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;
  if (isStandalone) return;
  if (localStorage.getItem("volet-malin-install-dismissed") === "1") return;

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
    localStorage.setItem("volet-malin-install-dismissed", "1");
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
  return {
    indoorTemp: parseFloat(el.inputIndoor.value) || 22,
    targetMin: parseFloat(el.inputMin.value) || 19,
    targetMax: parseFloat(el.inputMax.value) || 24,
  };
}

function computeManual() {
  const { indoorTemp, targetMin, targetMax } = getSettings();
  const outdoorTemp = parseFloat(el.inputOutdoor.value) || 20;
  const isDay = el.inputDaytime.value === "day";
  const rec = getRecommendation({ outdoorTemp, indoorTemp, targetMin, targetMax, isDay });
  renderResult(rec);
  el.timelineCard.classList.add("hidden");
}

function renderTimeline() {
  if (!state.hourly) return;
  const { indoorTemp, targetMin, targetMax } = getSettings();
  const { time, temperature, isDay } = state.hourly;

  el.timeline.innerHTML = "";
  el.timelineChanges.innerHTML = "";

  let prevAction = null;
  const changes = [];

  for (let i = 0; i < time.length && i < 24; i++) {
    const outdoorTemp = Math.round(temperature[i]);
    const day = isDay[i] === 1;
    const rec = getRecommendation({ outdoorTemp, indoorTemp, targetMin, targetMax, isDay: day });
    const date = new Date(time[i]);
    const hourLabel = date.getHours().toString().padStart(2, "0") + "h";

    const hourEl = document.createElement("div");
    hourEl.className = "timeline-hour";
    hourEl.innerHTML = `
      <div>${hourLabel}</div>
      <div class="bar ${rec.action}">${rec.action === "close" ? "🌡️" : "☀️"}</div>
      <div class="temp">${outdoorTemp}°</div>
    `;
    el.timeline.appendChild(hourEl);

    if (rec.action !== prevAction) {
      changes.push({ hourLabel, action: rec.action, index: i });
      prevAction = rec.action;
    }
  }

  changes.forEach((c) => {
    if (c.index === 0) return;
    const item = document.createElement("div");
    item.className = "change-item";
    item.innerHTML = `
      <span class="badge ${c.action}">${c.action === "close" ? "FERMER" : "OUVRIR"}</span>
      <span>vers ${c.hourLabel}</span>
    `;
    el.timelineChanges.appendChild(item);
  });

  el.timelineCard.classList.remove("hidden");
}

async function fetchWeather(lat, lon) {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&hourly=temperature_2m,is_day&timezone=auto&forecast_days=2`;
  const res = await fetch(url);
  if (!res.ok) throw new Error("Erreur météo");
  const data = await res.json();
  return {
    time: data.hourly.time,
    temperature: data.hourly.temperature_2m,
    isDay: data.hourly.is_day,
  };
}

async function fetchCityCoords(cityName) {
  const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(cityName)}&count=1&language=fr&format=json`;
  const res = await fetch(url);
  if (!res.ok) throw new Error("Erreur géocodage");
  const data = await res.json();
  if (!data.results || data.results.length === 0) throw new Error("Ville introuvable");
  const r = data.results[0];
  return { lat: r.latitude, lon: r.longitude, name: r.name };
}

async function loadWeatherFor(lat, lon, label) {
  el.locationStatus.textContent = "Récupération de la météo…";
  try {
    state.hourly = await fetchWeather(lat, lon);
    el.locationStatus.textContent = label ? `Météo chargée pour ${label}` : "Météo chargée pour votre position";
    el.manualCard.classList.add("hidden");

    const now = Date.now();
    let nowIdx = 0;
    for (let i = 0; i < state.hourly.time.length; i++) {
      if (new Date(state.hourly.time[i]).getTime() <= now) nowIdx = i;
    }
    const { indoorTemp, targetMin, targetMax } = getSettings();
    const outdoorTemp = Math.round(state.hourly.temperature[nowIdx]);
    const isDay = state.hourly.isDay[nowIdx] === 1;
    renderResult(getRecommendation({ outdoorTemp, indoorTemp, targetMin, targetMax, isDay }));

    const trimmed = {
      time: state.hourly.time.slice(nowIdx),
      temperature: state.hourly.temperature.slice(nowIdx),
      isDay: state.hourly.isDay.slice(nowIdx),
    };
    state.hourly = trimmed;
    renderTimeline();
  } catch (err) {
    el.locationStatus.textContent = "Météo automatique indisponible. Utilisez le mode manuel ci-dessous.";
    el.manualCard.classList.remove("hidden");
  }
}

el.btnGeoloc.addEventListener("click", () => {
  if (!navigator.geolocation) {
    el.locationStatus.textContent = "Géolocalisation non supportée. Utilisez le mode manuel.";
    el.manualCard.classList.remove("hidden");
    return;
  }
  el.locationStatus.textContent = "Localisation en cours…";
  navigator.geolocation.getCurrentPosition(
    (pos) => loadWeatherFor(pos.coords.latitude, pos.coords.longitude),
    () => {
      el.locationStatus.textContent = "Position refusée ou indisponible. Utilisez le mode manuel.";
      el.manualCard.classList.remove("hidden");
    },
    { timeout: 8000 }
  );
});

el.formCity.addEventListener("submit", async (e) => {
  e.preventDefault();
  const cityName = el.inputCity.value.trim();
  if (!cityName) return;
  el.locationStatus.textContent = "Recherche de la ville…";
  try {
    const { lat, lon, name } = await fetchCityCoords(cityName);
    await loadWeatherFor(lat, lon, name);
  } catch (err) {
    el.locationStatus.textContent = "Ville introuvable ou service indisponible. Utilisez le mode manuel.";
    el.manualCard.classList.remove("hidden");
  }
});

el.btnManualCompute.addEventListener("click", computeManual);

[el.inputIndoor, el.inputMin, el.inputMax].forEach((input) => {
  input.addEventListener("change", () => {
    if (state.hourly) renderTimeline();
  });
});
