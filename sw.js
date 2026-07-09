const CACHE_NAME = "volet-malin-v10";
const APP_SHELL = [
  "./",
  "./index.html",
  "./style.css",
  "./app.js",
  "./manifest.json",
  "./icons/icon-96.png",
  "./icons/icon-180.png",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  // Only handle same-origin requests; API calls (open-meteo) go straight
  // to the network so weather data is never served stale from cache.
  if (url.origin !== self.location.origin) return;

  // Stale-while-revalidate: serve from cache instantly, refresh the cache in
  // the background so app updates reach users on their next visit without a
  // manual cache-version bump.
  event.respondWith(
    caches.open(CACHE_NAME).then(async (cache) => {
      const cached = await cache.match(request);
      const network = fetch(request)
        .then((response) => {
          // Cache only complete, successful responses (not errors/opaque/partial).
          if (response.ok && response.type === "basic") {
            cache.put(request, response.clone());
          }
          return response;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
});

// ---------------------------------------------------------------------------
// Notifications: periodic background check (Chrome/Android installed PWA)
// and notification click handling. The page stores a snapshot of the watched
// location and comfort settings in IndexedDB under the "watch" key.
// ---------------------------------------------------------------------------

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

// Mirror of the app's recommendation logic, kept minimal for background use.
function decideAction(outdoorTemp, indoorTemp, targetMin, targetMax, isDay) {
  if (isDay) {
    if (outdoorTemp > targetMax) {
      return { action: "close", reason: `Il fait ${outdoorTemp}°C dehors. Fermez les volets pour bloquer la chaleur.` };
    }
    return { action: "open", reason: `Il fait ${outdoorTemp}°C dehors. Ouvrez les volets pour profiter de la lumière.` };
  }
  if (outdoorTemp < targetMin) {
    return { action: "close", reason: `Il fait ${outdoorTemp}°C dehors cette nuit. Fermez les volets pour garder la chaleur.` };
  }
  if (indoorTemp > targetMax && outdoorTemp < indoorTemp) {
    return { action: "open", reason: `Plus frais dehors (${outdoorTemp}°C) que dedans (${indoorTemp}°C). Ouvrez pour rafraîchir.` };
  }
  return { action: "close", reason: "Fermez les volets la nuit pour conserver la chaleur." };
}

const QUIET_START_HOUR = 23;
const QUIET_END_HOUR = 7;

async function checkAndNotify() {
  // Quiet hours (device time): skip without updating lastAction, so the
  // first check after the quiet window delivers the pending alert.
  const hour = new Date().getHours();
  if (hour >= QUIET_START_HOUR || hour < QUIET_END_HOUR) return;

  let watch;
  try {
    watch = await idbGet("watch");
  } catch {
    return;
  }
  if (!watch || !watch.enabled) return;

  const url = new URL("https://api.open-meteo.com/v1/forecast");
  url.searchParams.set("latitude", watch.lat);
  url.searchParams.set("longitude", watch.lon);
  url.searchParams.set("current", "temperature_2m,is_day");
  let data;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) return;
    data = await res.json();
  } catch {
    return;
  }
  const current = data && data.current;
  if (!current || !Number.isFinite(current.temperature_2m)) return;

  const rec = decideAction(
    Math.round(current.temperature_2m),
    watch.indoorTemp,
    watch.targetMin,
    watch.targetMax,
    current.is_day === 1
  );
  if (rec.action === watch.lastAction) return;

  await self.registration.showNotification(
    rec.action === "close" ? "Fermez vos volets 🌡️" : "Ouvrez vos volets ☀️",
    { body: rec.reason, tag: "volet-action", icon: "icons/icon-192.png", badge: "icons/icon-96.png" }
  );
  watch.lastAction = rec.action;
  await idbSet("watch", watch).catch(() => {});
}

self.addEventListener("periodicsync", (event) => {
  if (event.tag === "volet-check") event.waitUntil(checkAndNotify());
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((windows) => {
      for (const client of windows) {
        if ("focus" in client) return client.focus();
      }
      return self.clients.openWindow("./");
    })
  );
});
