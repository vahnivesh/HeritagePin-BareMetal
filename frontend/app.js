"use strict";

/*
 * Heritage Pin frontend
 *
 * Flow:
 * Telegram → Render → Firebase Auth + Realtime Database
 * Website → Render /api/pins
 * Claim → Render /api/claim
 * Edit profile → Render /api/profile
 *
 * Firebase Storage is NOT used.
 */

function bootHeritagePin() {
  if (window.__heritagePinStarted) return;
  window.__heritagePinStarted = true;

  const $ = selector => document.querySelector(selector);

  const requiredIds = [
    "map",
    "results",
    "search",
    "craft",
    "type",
    "count",
    "savedCount",
    "mode",
    "modeLabel",
    "modeDescription",
    "theme",
    "submitForm",
    "onboard",
    "details",
    "detailContent",
    "claimDialog",
    "claimForm",
    "claimId",
    "claimPassword",
    "claimStatus",
    "profileDialog",
    "profileForm",
    "profilePinId",
    "profileName",
    "profileCraft",
    "profileStory",
    "profileBio",
    "profilePhone",
    "profileWhatsapp",
    "profileWebsite",
    "profilePhotos",
    "photoPreview",
    "profileStatus",
    "profileLogout",
    "reviewDialog",
    "loadReview",
    "speechState",
    "language",
    "task",
    "story",
    "submitStatus",
    "toast",
    "mapError",
    "formMode",
    "telegramLink",
    "telegramUnavailable",
    "locate",
    "formLocation",
    "fit",
    "reset",
    "saved",
    "explore",
    "add",
    "about",
    "aboutDialog",
    "review",
    "myProfile"
  ];

  const missing = requiredIds.filter(id => !document.getElementById(id));

  if (missing.length) {
    console.error("Missing Heritage Pin HTML elements:", missing);

    alert(
      "Missing Heritage Pin HTML elements:\n\n" +
      missing.join(", ")
    );

    return;
  }

  // ------------------------------------------------------------
  // Utility
  // ------------------------------------------------------------

  function escapeHTML(value) {
    return String(value ?? "").replace(
      /[&<>"']/g,
      character => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;"
      })[character]
    );
  }

  function readStorage(key, fallback) {
    try {
      const value = localStorage.getItem(key);
      return value === null ? fallback : JSON.parse(value);
    } catch {
      return fallback;
    }
  }

  function writeStorage(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      // Ignore storage errors.
    }
  }

  function notify(message) {
    const toast = $("#toast");

    if (!toast) return;

    toast.textContent = message;
    toast.hidden = false;

    clearTimeout(notify.timer);

    notify.timer = setTimeout(() => {
      toast.hidden = true;
    }, 3500);
  }

  function prefersReducedMotion() {
    return window.matchMedia?.(
      "(prefers-reduced-motion: reduce)"
    )?.matches;
  }

  function hasCoordinates(record) {
    const lat = Number(record?.lat);
    const lng = Number(record?.lng);

    return (
      Number.isFinite(lat) &&
      Number.isFinite(lng) &&
      lat >= -90 &&
      lat <= 90 &&
      lng >= -180 &&
      lng <= 180
    );
  }

  function safeLink(value) {
    const text = String(value || "").trim();

    if (!text) return "";

    try {
      const url = new URL(text);

      if (!["http:", "https:"].includes(url.protocol)) {
        return "";
      }

      return url.href;
    } catch {
      return "";
    }
  }

  // ------------------------------------------------------------
  // Local state
  // ------------------------------------------------------------

  const storedSaved = readStorage("hp-saved", []);
  const storedDemo = readStorage("hp-demo-records", []);

  let demo = readStorage("hp-demo", false) === true;

  let saved = new Set(
    Array.isArray(storedSaved)
      ? storedSaved
      : []
  );

  let demoRecords = Array.isArray(storedDemo)
    ? storedDemo
    : [];

  let directory = [];
  let live = [];

  let map = null;
  let cluster = null;
  let userMarker = null;

  let onlySaved = false;
  let generation = 0;

  let config = {};

  let claimedSession = null;

  // ------------------------------------------------------------
  // Demo record
  // ------------------------------------------------------------

  const samples = [
    {
      id: "demo-weaver",
      name: "Demo weaving studio",
      craft: "Kachchh Weaving",
      place: "Bhujodi, Gujarat",
      lat: 23.213,
      lng: 69.726,
      type: "Artisan",
      status: "demo",
      claimed: false,

      story:
        "Fictional sample profile demonstrating the Heritage Pin interface.",

      profile: {
        bio: "Demo profile only.",
        phone: "",
        whatsapp: "",
        website: "",
        photos: []
      },

      reviews: []
    }
  ];

  // ------------------------------------------------------------
  // API
  // ------------------------------------------------------------

  async function api(path, options = {}) {
    const base = String(
      window.HERITAGE_API_BASE || ""
    ).replace(/\/+$/, "");

    const url = /^https?:\/\//i.test(path)
      ? path
      : `${base}${path}`;

    if (!base && !/^https?:\/\//i.test(path)) {
      throw new Error(
        "HERITAGE_API_BASE is not configured in index.html."
      );
    }

    const controller = new AbortController();

    const timeout = setTimeout(
      () => controller.abort(),
      options.method === "POST" || options.method === "PUT"
        ? 30000
        : 10000
    );

    try {
      const headers = {
        ...(options.headers || {})
      };

      if (
        options.body &&
        typeof options.body === "string" &&
        !headers["Content-Type"] &&
        !headers["content-type"]
      ) {
        headers["Content-Type"] = "application/json";
      }

      const response = await fetch(url, {
        ...options,
        headers,
        signal: controller.signal
      });

      const contentType =
        response.headers.get("content-type") || "";

      const text = await response.text();

      let data = {};

      if (text) {
        try {
          data = contentType.includes("application/json")
            ? JSON.parse(text)
            : { raw: text };
        } catch {
          data = {
            raw: text
          };
        }
      }

      if (!response.ok) {
        throw new Error(
          data.error ||
          data.message ||
          `Request failed (${response.status}).`
        );
      }

      return data;
    } catch (error) {
      if (error.name === "AbortError") {
        throw new Error(
          "The server took too long to respond."
        );
      }

      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  // ------------------------------------------------------------
  // Data
  // ------------------------------------------------------------

  function currentRows() {
    if (demo) {
      return [
        ...samples,
        ...demoRecords
      ];
    }

    return [
      ...directory,
      ...live
    ];
  }

  function craftIcon(craft) {
    const text = String(craft || "");

    if (/weav|cotton|textile|print|loom/i.test(text)) {
      return "≋";
    }

    if (/pottery|ceramic|clay/i.test(text)) {
      return "◒";
    }

    if (/wood|carv|toy/i.test(text)) {
      return "⌁";
    }

    if (/metal|iron|brass|copper/i.test(text)) {
      return "◇";
    }

    if (/embroid|needle|stitch/i.test(text)) {
      return "✣";
    }

    return "⌘";
  }

  function statusHTML(record) {
    if (record.status === "demo") {
      return `<span class="badge demo">DEMO</span>`;
    }

    if (record.claimed === true) {
      return `
        <span class="badge approved">
          ✓ CLAIMED &amp; VERIFIED
        </span>
      `;
    }

    return `
      <span class="badge approved">
        ✓ VERIFIED
      </span>

      <span class="badge mutedbadge">
        NOT CLAIMED
      </span>
    `;
  }

  function reviewCount(record) {
    return Array.isArray(record.reviews)
      ? record.reviews.length
      : 0;
  }

  // ------------------------------------------------------------
  // Rendering
  // ------------------------------------------------------------

  function render() {
    const rows = currentRows();

    const search =
      $("#search").value.trim().toLowerCase();

    const selectedCraft =
      $("#craft").value;

    const selectedType =
      $("#type").value;

    const filtered = rows.filter(record => {
      if (!record || !record.id) {
        return false;
      }

      const haystack = [
        record.name,
        record.craft,
        record.place,
        record.story
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();

      if (
        search &&
        !haystack.includes(search)
      ) {
        return false;
      }

      if (
        selectedCraft &&
        String(record.craft || "") !== selectedCraft
      ) {
        return false;
      }

      if (selectedType === "approved") {
        if (record.status !== "verified") {
          return false;
        }
      } else if (
        selectedType &&
        String(record.type || "") !== selectedType
      ) {
        return false;
      }

      if (
        onlySaved &&
        !saved.has(record.id)
      ) {
        return false;
      }

      return true;
    });

    $("#count").textContent =
      `${filtered.length} ${
        filtered.length === 1
          ? "profile"
          : "profiles"
      }`;

    $("#savedCount").textContent =
      String(saved.size);

    if (!filtered.length) {
      $("#results").innerHTML = `
        <p class="empty">
          No Heritage Pins match this search.
        </p>
      `;
    } else {
      $("#results").innerHTML =
        filtered.map(record => `
          <article
            class="resultcard"
            data-id="${escapeHTML(record.id)}"
          >
            <div class="resulticon">
              ${craftIcon(record.craft)}
            </div>

            <div class="resultmain">

              <div class="resulttop">
                <strong>
                  ${escapeHTML(
                    record.name ||
                    "Unnamed custodian"
                  )}
                </strong>

                <span class="smallid">
                  ${escapeHTML(record.id)}
                </span>
              </div>

              <p>
                ${escapeHTML(
                  record.craft ||
                  "Traditional craft"
                )}

                ${
                  record.place
                    ? ` · ${escapeHTML(record.place)}`
                    : ""
                }
              </p>

              <div class="statusrow">
                ${statusHTML(record)}
              </div>

              ${
                reviewCount(record)
                  ? `
                    <small>
                      ${reviewCount(record)}
                      ${
                        reviewCount(record) === 1
                          ? " review"
                          : " reviews"
                      }
                    </small>
                  `
                  : ""
              }

            </div>
          </article>
        `).join("");
    }

    drawMarkers(filtered);
  }

  function drawMarkers(rows) {
    if (!map || !cluster) {
      return;
    }

    cluster.clearLayers();

    rows
      .filter(hasCoordinates)
      .forEach(record => {
        // 1. Determine marker status classes based on the record
        let pinClass = "pin";
        if (record.status === "demo") pinClass += " demo";
        else if (record.claimed === true || record.status === "verified") pinClass += " approved";

        // 2. Create a custom modern HTML marker instead of the default blue pin
        const customIcon = L.divIcon({
          className: "custom-leaflet-icon", // Removes default Leaflet white square
          html: `<div class="${pinClass}">${craftIcon(record.craft)}</div>`,
          iconSize: [36, 36],
          iconAnchor: [18, 18] // Centers the marker exactly over the coordinates
        });

        // 3. Apply the custom icon to the marker
        const marker = L.marker([
          Number(record.lat),
          Number(record.lng)
        ], { icon: customIcon });

        marker.bindTooltip(
          `${escapeHTML(
            record.name ||
            "Heritage Pin"
          )} · ${escapeHTML(record.id)}`,
          {
            direction: "top"
          }
        );

        marker.on(
          "click",
          () => showDetail(record.id)
        );

        cluster.addLayer(marker);
      });
  }

  // ------------------------------------------------------------
  // Profile detail dialog
  // ------------------------------------------------------------

  function showDetail(id) {
    const record = currentRows()
      .find(item => item.id === id);

    if (!record) {
      return;
    }

    const profile =
      record.profile || {};

    const mapped =
      hasCoordinates(record);

    const source =
      safeLink(record.source);

    const photos =
      Array.isArray(profile.photos)
        ? profile.photos
        : [];

    const contactValue =
      String(
        profile.whatsapp ||
        profile.phone ||
        record.phone ||
        ""
      ).replace(/\D/g, "");

    const canContact =
      contactValue.length > 7;

    const message = encodeURIComponent(
      `Hello, I found your Heritage Pin ${record.id} on Heritage Pin.`
    );

    $("#detailContent").innerHTML = `
      <p class="eyebrow">
        ${escapeHTML(record.id)}
      </p>

      <h2>
        ${escapeHTML(
          record.name ||
          "Heritage Pin"
        )}
      </h2>

      <div class="statusrow">
        ${statusHTML(record)}
      </div>

      <p class="lead">
        ${escapeHTML(
          record.craft ||
          "Traditional craft"
        )}

        ${
          record.place
            ? ` · ${escapeHTML(record.place)}`
            : ""
        }
      </p>

      ${
        photos.length
          ? `
            <div class="photogrid detailphotos">
              ${photos.map(
                (photo, index) => `
                  <img
                    src="${escapeHTML(photo)}"
                    alt="Craft photo ${index + 1}"
                    loading="lazy"
                  >
                `
              ).join("")}
            </div>
          `
          : ""
      }

      <section class="detailblock">
        <h3>The story</h3>

        <p>
          ${escapeHTML(
            record.story ||
            "The custodian has not added a public story yet."
          )}
        </p>
      </section>

      ${
        record.native_transcript
          ? `
            <section class="detailblock">
              <h3>Original story</h3>

              <p>
                ${escapeHTML(
                  record.native_transcript
                )}
              </p>
            </section>
          `
          : ""
      }

      ${
        profile.bio
          ? `
            <section class="detailblock">
              <h3>About the custodian</h3>

              <p>
                ${escapeHTML(profile.bio)}
              </p>
            </section>
          `
          : ""
      }

      <p class="verifiedline">
        ✓ Verified Heritage Pin
        ${
          record.claimed
            ? " · ✓ Claimed by custodian"
            : " · ⚪ Not claimed"
        }
      </p>

      <div class="buttonrow">

        ${
          record.claimed
            ? `
              <button
                id="claimFromDetail"
                type="button"
              >
                View / manage profile
              </button>
            `
            : `
              <button
                id="claimFromDetail"
                type="button"
                class="primary"
              >
                Claim this profile
              </button>
            `
        }

        <button
          id="saveDetail"
          type="button"
        >
          ${
            saved.has(id)
              ? "♥ Saved — remove"
              : "♡ Save this place"
          }
        </button>

        ${
          mapped
            ? `
              <button
                id="viewMap"
                type="button"
              >
                View area on map
              </button>
            `
            : ""
        }

        ${
          canContact
            ? `
              <a
                class="actionlink"
                href="https://wa.me/${contactValue}?text=${message}"
                target="_blank"
                rel="noopener"
              >
                Enquire on WhatsApp ↗
              </a>
            `
            : ""
        }

        ${
          source
            ? `
              <a
                class="actionlink"
                href="${escapeHTML(source)}"
                target="_blank"
                rel="noopener"
              >
                Read source ↗
              </a>
            `
            : ""
        }

      </div>
    `;

    // Save button
    $("#saveDetail").onclick = () => {
      if (saved.has(id)) {
        saved.delete(id);
      } else {
        saved.add(id);
      }

      writeStorage(
        "hp-saved",
        [...saved]
      );

      render();
      showDetail(id);
    };

    // Claim/manage button
    $("#claimFromDetail").onclick = () => {
      $("#details").close();

      if (
        record.claimed &&
        claimedSession?.pin?.id === record.id
      ) {
        openProfileDialog();
        return;
      }

      $("#claimId").value = record.id;
      $("#claimPassword").value = "";

      $("#claimStatus").textContent =
        record.claimed
          ? "This profile is already claimed. Enter the owner's credentials to access it."
          : "Enter the Heritage ID and password you received after verification.";

      $("#claimDialog").showModal();
    };

    // Map button
    if (mapped && $("#viewMap")) {
      $("#viewMap").onclick = () => {
        $("#details").close();

        if (!map) {
          notify("Map is unavailable.");
          return;
        }

        map.flyTo(
          [
            Number(record.lat),
            Number(record.lng)
          ],
          12,
          {
            animate: !prefersReducedMotion()
          }
        );

        $("#map").scrollIntoView({
          block: "center",
          behavior:
            prefersReducedMotion()
              ? "auto"
              : "smooth"
        });
      };
    }

    if (!$("#details").open) {
      $("#details").showModal();
    }
  }

  // ------------------------------------------------------------
  // Map
  // ------------------------------------------------------------

  function showMapError(message) {
    $("#mapError").hidden = false;
    $("#mapError").textContent = message;
  }

  function initMap() {
    if (map) {
      return;
    }

    if (!window.L) {
      showMapError(
        "Leaflet could not load. Check your internet connection."
      );
      return;
    }

    // MAP TOKENS (Replace with your safe tokens)
    const MAPBOX_TOKEN = "token"; 
    const MAPTILER_KEY = "token"; 

    // --- MAPBOX LAYERS ---
    window.mapboxLight = L.tileLayer(
      `https://api.mapbox.com/styles/v1/mapbox/light-v11/tiles/{z}/{x}/{y}?access_token=${MAPBOX_TOKEN}`,
      { maxZoom: 19, tileSize: 512, zoomOffset: -1, attribution: '© Mapbox' }
    );
    window.mapboxDark = L.tileLayer(
      `https://api.mapbox.com/styles/v1/mapbox/dark-v11/tiles/{z}/{x}/{y}?access_token=${MAPBOX_TOKEN}`,
      { maxZoom: 19, tileSize: 512, zoomOffset: -1, attribution: '© Mapbox' }
    );
    window.mapboxSatellite = L.tileLayer(
      `https://api.mapbox.com/styles/v1/mapbox/satellite-streets-v12/tiles/{z}/{x}/{y}?access_token=${MAPBOX_TOKEN}`,
      { maxZoom: 19, tileSize: 512, zoomOffset: -1, attribution: '© Mapbox' }
    );

    // --- MAPTILER LAYERS ---
    window.maptilerLight = L.tileLayer(
      `https://api.maptiler.com/maps/dataviz-light/{z}/{x}/{y}.png?key=${MAPTILER_KEY}`,
      { maxZoom: 19, attribution: '© MapTiler' }
    );
    window.maptilerDark = L.tileLayer(
      `https://api.maptiler.com/maps/dataviz-dark/{z}/{x}/{y}.png?key=${MAPTILER_KEY}`,
      { maxZoom: 19, attribution: '© MapTiler' }
    );

    // Read initial theme and default to Mapbox
    const isDark = document.documentElement.dataset.theme === "dark";
    const initialLayer = isDark ? window.mapboxDark : window.mapboxLight;

    map = L.map("map", {
      zoomControl: false,
      layers: [initialLayer]
    }).setView([22.8, 77.4], 5);

    L.control.zoom({
      position: "topright"
    }).addTo(map);

    // Inject the Multi-Layer toggle control with BOTH options
    const baseMaps = {
      "Mapbox (Light)": window.mapboxLight,
      "Mapbox (Dark)": window.mapboxDark,
      "MapTiler (Light)": window.maptilerLight,
      "MapTiler (Dark)": window.maptilerDark,
      "Satellite": window.mapboxSatellite
    };
    
    L.control.layers(baseMaps, null, { position: "bottomright" }).addTo(map);

    cluster =
      L.markerClusterGroup
        ? L.markerClusterGroup({
            maxClusterRadius: 40,
            showCoverageOnHover: false
          })
        : L.layerGroup();

    map.addLayer(cluster);

    requestAnimationFrame(() => {
      map.invalidateSize();
    });
  }

  function fitMap() {
    if (!map) {
      return;
    }

    const points =
      currentRows()
        .filter(hasCoordinates)
        .map(record => [
          Number(record.lat),
          Number(record.lng)
        ]);

    if (!points.length) {
      map.setView(
        [22.8, 77.4],
        5
      );

      return;
    }

    map.fitBounds(
      points,
      {
        padding: [30, 30],
        maxZoom: 12
      }
    );
  }

  // ------------------------------------------------------------
  // Craft filter
  // ------------------------------------------------------------

  function updateCraftOptions() {
    const current =
      $("#craft").value;

    const crafts =
      [...new Set(
        currentRows()
          .map(record =>
            String(record.craft || "").trim()
          )
          .filter(Boolean)
      )].sort(
        (a, b) =>
          a.localeCompare(b)
      );

    $("#craft").innerHTML =
      `<option value="">All crafts</option>` +
      crafts.map(craft => `
        <option value="${escapeHTML(craft)}">
          ${escapeHTML(craft)}
        </option>
      `).join("");

    if (crafts.includes(current)) {
      $("#craft").value = current;
    }
  }

  // ------------------------------------------------------------
  // Refresh data from Render
  // ------------------------------------------------------------

  async function refresh() {
    const requestGeneration =
      ++generation;

    updateCraftOptions();
    render();

    if (!demo) {
      try {
        const data =
          await api("/api/pins");

        if (
          requestGeneration !== generation
        ) {
          return;
        }

        live =
          Array.isArray(data.pins)
            ? data.pins
            : [];

      } catch (error) {
        if (
          requestGeneration !== generation
        ) {
          return;
        }

        live = [];

        console.warn(
          "Heritage Pin API error:",
          error.message
        );

        notify(
          "Could not load live Heritage Pins."
        );
      }
    }

    if (
      requestGeneration !== generation
    ) {
      return;
    }

    updateCraftOptions();
    render();
  }

  // ------------------------------------------------------------
  // Directory
  // ------------------------------------------------------------

  async function loadDirectory() {
    try {
      const response =
        await fetch("./directory.json");

      if (!response.ok) {
        throw new Error(
          `Directory request failed (${response.status}).`
        );
      }

      const records =
        await response.json();

      if (Array.isArray(records)) {
        directory =
          records.filter(
            record =>
              record &&
              typeof record.id === "string"
          );
      }
    } catch (error) {
      directory = [];

      console.warn(
        "directory.json unavailable:",
        error.message
      );
    }

    await refresh();
    await loadConfig();
  }

  async function loadConfig() {
    try {
      config =
        await api("/api/config");

      if (
        typeof config.telegram === "string" &&
        /^[A-Za-z0-9_]{5,32}$/.test(
          config.telegram
        )
      ) {
        $("#telegramLink").href =
          `https://t.me/${config.telegram}`;

        $("#telegramLink").hidden =
          false;

        $("#telegramUnavailable").hidden =
          true;
      }

    } catch (error) {
      console.warn(
        "Could not load API config:",
        error.message
      );
    }
  }

  // ------------------------------------------------------------
  // Location
  // ------------------------------------------------------------

  function geolocate(onSuccess) {
    if (!navigator.geolocation) {
      notify(
        "Location is unavailable. Enter coordinates manually."
      );

      return;
    }

    navigator.geolocation.getCurrentPosition(
      position => {
        const lat =
          Number(
            position.coords.latitude.toFixed(6)
          );

        const lng =
          Number(
            position.coords.longitude.toFixed(6)
          );

        onSuccess(lat, lng);
      },

      () => {
        notify(
          "Could not read your current location."
        );
      },

      {
        enableHighAccuracy: true,
        timeout: 10000,
        maximumAge: 30000
      }
    );
  }

  // ------------------------------------------------------------
  // Claim session
  // ------------------------------------------------------------

  function setClaimSession(payload) {
    claimedSession = {
      token: payload.token,
      pin: payload.pin
    };

    try {
      sessionStorage.setItem(
        "hp-session",
        JSON.stringify(
          claimedSession
        )
      );
    } catch {}

    $("#myProfile").hidden = false;
  }

  function restoreClaimSession() {
    try {
      const value =
        sessionStorage.getItem(
          "hp-session"
        );

      if (!value) {
        return;
      }

      const session =
        JSON.parse(value);

      if (
        session &&
        typeof session.token === "string" &&
        session.pin &&
        typeof session.pin.id === "string"
      ) {
        claimedSession = session;
        $("#myProfile").hidden = false;
      }
    } catch {
      claimedSession = null;
    }
  }

  function clearClaimSession() {
    claimedSession = null;

    $("#myProfile").hidden = true;

    try {
      sessionStorage.removeItem(
        "hp-session"
      );
    } catch {}
  }

  // ------------------------------------------------------------
  // Photo handling
  // ------------------------------------------------------------

  function renderPhotoPreview(photos) {
    const list =
      Array.isArray(photos)
        ? photos
        : [];

    $("#photoPreview").innerHTML =
      list.map(
        (photo, index) => `
          <div class="photoitem">
            <img
              src="${escapeHTML(photo)}"
              alt="Profile photo ${index + 1}"
              loading="lazy"
            >
          </div>
        `
      ).join("");
  }

  async function filesToDataURLs(fileList) {
    const files =
      [...(fileList || [])].slice(0, 3);

    return Promise.all(
      files.map(file =>
        new Promise(
          (resolve, reject) => {
            const reader =
              new FileReader();

            reader.onload = () => {
              const image =
                new Image();

              image.onload = () => {
                const maxSide = 1000;

                const scale =
                  Math.min(
                    1,
                    maxSide /
                      Math.max(
                        image.width,
                        image.height
                      )
                  );

                const canvas =
                  document.createElement(
                    "canvas"
                  );

                canvas.width =
                  Math.max(
                    1,
                    Math.round(
                      image.width *
                      scale
                    )
                  );

                canvas.height =
                  Math.max(
                    1,
                    Math.round(
                      image.height *
                      scale
                    )
                  );

                const ctx =
                  canvas.getContext(
                    "2d"
                  );

                if (!ctx) {
                  reject(
                    new Error(
                      "Could not process image."
                    )
                  );

                  return;
                }

                ctx.drawImage(
                  image,
                  0,
                  0,
                  canvas.width,
                  canvas.height
                );

                resolve(
                  canvas.toDataURL(
                    "image/jpeg",
                    0.68
                  )
                );
              };

              image.onerror = () => {
                reject(
                  new Error(
                    `Could not read ${file.name}.`
                  )
                );
              };

              image.src =
                String(reader.result);
            };

            reader.onerror = () => {
              reject(
                new Error(
                  `Could not read ${file.name}.`
                )
              );
            };

            reader.readAsDataURL(file);
          }
        )
      )
    );
  }

  // ------------------------------------------------------------
  // Dashboard
  // ------------------------------------------------------------

  function openProfileDialog() {
    if (
      !claimedSession ||
      !claimedSession.pin
    ) {
      $("#claimDialog").showModal();
      return;
    }

    const pin =
      claimedSession.pin;

    const profile =
      pin.profile || {};

    $("#profilePinId").value =
      pin.id || "";

    $("#profileName").value =
      pin.name || "";

    $("#profileCraft").value =
      pin.craft || "";

    $("#profileStory").value =
      pin.story || "";

    $("#profileBio").value =
      profile.bio || "";

    $("#profilePhone").value =
      profile.phone || "";

    $("#profileWhatsapp").value =
      profile.whatsapp || "";

    $("#profileWebsite").value =
      profile.website || "";

    renderPhotoPreview(
      profile.photos || []
    );

    $("#profileState").innerHTML = `
      <strong>
        ✓ CLAIMED &amp; VERIFIED
      </strong>

      <span>
        ${escapeHTML(pin.id || "")}
      </span>
    `;

    $("#profileStatus").textContent = "";

    if (!$("#profileDialog").open) {
      $("#profileDialog").showModal();
    }
  }

  // ------------------------------------------------------------
  // Claim form
  // ------------------------------------------------------------

  $("#claimForm").addEventListener(
    "submit",
    async event => {
      event.preventDefault();

      const pinId =
        $("#claimId")
          .value
          .trim()
          .toUpperCase();

      const password =
        $("#claimPassword").value;

      $("#claimStatus").textContent =
        "Checking credentials…";

      try {
        const result =
          await api("/api/claim", {
            method: "POST",

            body: JSON.stringify({
              pin_id: pinId,
              password
            })
          });

        if (
          !result.success ||
          !result.token ||
          !result.pin
        ) {
          throw new Error(
            "The server returned an invalid claim response."
          );
        }

        setClaimSession(result);

        $("#claimPassword").value = "";

        $("#claimStatus").textContent =
          "Profile claimed successfully.";

        setTimeout(() => {
          if ($("#claimDialog").open) {
            $("#claimDialog").close();
          }

          openProfileDialog();

          refresh();
        }, 350);

      } catch (error) {
        $("#claimStatus").textContent =
          error.message;
      }
    }
  );

  // ------------------------------------------------------------
  // Profile form
  // ------------------------------------------------------------

  $("#profileForm").addEventListener(
    "submit",
    async event => {
      event.preventDefault();

      if (
        !claimedSession?.token ||
        !claimedSession?.pin?.id
      ) {
        $("#profileStatus").textContent =
          "Your session has expired. Please claim the profile again.";

        return;
      }

      $("#profileStatus").textContent =
        "Saving changes…";

      try {
        let photos =
          Array.isArray(
            claimedSession.pin?.profile?.photos
          )
            ? claimedSession.pin.profile.photos
            : [];

        if (
          $("#profilePhotos").files.length
        ) {
          photos =
            await filesToDataURLs(
              $("#profilePhotos").files
            );
        }

        const result =
          await api("/api/profile", {
            method: "PUT",

            headers: {
              Authorization:
                `Bearer ${claimedSession.token}`
            },

            body: JSON.stringify({
              pin_id:
                claimedSession.pin.id,

              profile: {
                name:
                  $("#profileName")
                    .value
                    .trim(),

                craft:
                  $("#profileCraft")
                    .value
                    .trim(),

                story:
                  $("#profileStory")
                    .value
                    .trim(),

                bio:
                  $("#profileBio")
                    .value
                    .trim(),

                phone:
                  $("#profilePhone")
                    .value
                    .trim(),

                whatsapp:
                  $("#profileWhatsapp")
                    .value
                    .trim(),

                website:
                  $("#profileWebsite")
                    .value
                    .trim(),

                photos
              }
            })
          });

        if (
          !result.success ||
          !result.pin
        ) {
          throw new Error(
            "The server returned an invalid profile response."
          );
        }

        claimedSession.pin =
          result.pin;

        try {
          sessionStorage.setItem(
            "hp-session",
            JSON.stringify(
              claimedSession
            )
          );
        } catch {}

        renderPhotoPreview(
          result.pin.profile?.photos || []
        );

        $("#profilePhotos").value = "";

        $("#profileStatus").textContent =
          "Saved. Your Heritage Pin has been updated.";

        await refresh();

      } catch (error) {
        $("#profileStatus").textContent =
          error.message;
      }
    }
  );

  // ------------------------------------------------------------
  // Logout
  // ------------------------------------------------------------

  $("#profileLogout").addEventListener(
    "click",
    () => {
      clearClaimSession();

      if ($("#profileDialog").open) {
        $("#profileDialog").close();
      }

      notify("Signed out.");
    }
  );

  $("#myProfile").addEventListener(
    "click",
    openProfileDialog
  );

  // ------------------------------------------------------------
  // Owner access
  // ------------------------------------------------------------

  $("#review").addEventListener(
    "click",
    () => {
      if (!$("#reviewDialog").open) {
        $("#reviewDialog").showModal();
      }
    }
  );

  $("#loadReview").addEventListener(
    "click",
    () => {
      if ($("#reviewDialog").open) {
        $("#reviewDialog").close();
      }

      $("#claimId").value = "";
      $("#claimPassword").value = "";
      $("#claimStatus").textContent = "";

      $("#claimDialog").showModal();
    }
  );

  // ------------------------------------------------------------
  // Search/filter
  // ------------------------------------------------------------

  $("#search").addEventListener(
    "input",
    render
  );

  $("#craft").addEventListener(
    "change",
    render
  );

  $("#type").addEventListener(
    "change",
    render
  );

  $("#reset").addEventListener(
    "click",
    () => {
      $("#search").value = "";
      $("#craft").value = "";
      $("#type").value = "";

      onlySaved = false;

      $("#saved").classList.remove(
        "active"
      );

      $("#explore").classList.add(
        "active"
      );

      render();
    }
  );

  $("#saved").addEventListener(
    "click",
    () => {
      onlySaved = true;

      $("#saved").classList.add(
        "active"
      );

      $("#explore").classList.remove(
        "active"
      );

      render();
    }
  );

  $("#explore").addEventListener(
    "click",
    () => {
      onlySaved = false;

      $("#explore").classList.add(
        "active"
      );

      $("#saved").classList.remove(
        "active"
      );

      render();
    }
  );

  // ------------------------------------------------------------
  // Demo mode
  // ------------------------------------------------------------

  $("#mode").addEventListener(
    "click",
    async () => {
      demo = !demo;

      writeStorage(
        "hp-demo",
        demo
      );

      if (demo) {
        $("#modeLabel").textContent =
          "Demo mode";

        $("#modeDescription").textContent =
          "Fictional profiles · changes stay in this browser";

        $("#mode").textContent =
          "Exit demo mode ↗";

      } else {
        $("#modeLabel").textContent =
          "Public directory";

        $("#modeDescription").textContent =
          "Verified Heritage Pins · updated automatically";

        $("#mode").textContent =
          "Try demo mode ↗";
      }

      await refresh();
    }
  );

  // ------------------------------------------------------------
  // Onboarding dialog
  // ------------------------------------------------------------

  $("#add").addEventListener(
    "click",
    () => {
      $("#onboard").showModal();
    }
  );

  $("#about").addEventListener(
    "click",
    () => {
      $("#aboutDialog").showModal();
    }
  );

  $("#formLocation").addEventListener(
    "click",
    () => {
      geolocate((lat, lng) => {
        const latitude =
          document.querySelector(
            '[name="lat"]'
          );

        const longitude =
          document.querySelector(
            '[name="lng"]'
          );

        if (latitude) {
          latitude.value = lat;
        }

        if (longitude) {
          longitude.value = lng;
        }
      });
    }
  );

  // ------------------------------------------------------------
  // Near me
  // ------------------------------------------------------------

  $("#locate").addEventListener(
    "click",
    () => {
      geolocate((lat, lng) => {
        if (!map) {
          return;
        }

        if (userMarker) {
          userMarker.remove();
        }

        userMarker =
          L.marker([
            lat,
            lng
          ]).addTo(map);

        userMarker
          .bindPopup("You are here.")
          .openPopup();

        map.flyTo(
          [lat, lng],
          13,
          {
            animate:
              !prefersReducedMotion()
          }
        );
      });
    }
  );

  // ------------------------------------------------------------
  // Fit map
  // ------------------------------------------------------------

  $("#fit").addEventListener(
    "click",
    fitMap
  );

  // ------------------------------------------------------------
  // Results click
  // ------------------------------------------------------------

  $("#results").addEventListener(
    "click",
    event => {
      const card =
        event.target.closest(
          "[data-id]"
        );

      if (!card) {
        return;
      }

      showDetail(
        card.dataset.id
      );
    }
  );

  // ------------------------------------------------------------
  // Website demo submission
  // ------------------------------------------------------------

  $("#submitForm").addEventListener(
    "submit",
    event => {
      event.preventDefault();

      const form =
        event.target;

      if (!form.reportValidity()) {
        return;
      }

      const formData =
        new FormData(form);

      if (!demo) {
        $("#submitStatus").textContent =
          "For a real verified Heritage Pin, use the Telegram onboarding flow.";

        return;
      }

      const record = {
        id:
          "demo-" +
          Date.now().toString(36) +
          "-" +
          Math.random()
            .toString(36)
            .slice(2, 8),

        name:
          formData.get("name"),

        craft:
          formData.get("craft"),

        place:
          formData.get("place"),

        lat:
          Number(
            formData.get("lat")
          ),

        lng:
          Number(
            formData.get("lng")
          ),

        type:
          "Artisan",

        status:
          "demo",

        claimed:
          false,

        story:
          formData.get("story"),

        profile: {
          bio: "",

          phone:
            formData.get("phone") ||
            "",

          whatsapp:
            formData.get("phone") ||
            "",

          website: "",

          photos: []
        },

        reviews: []
      };

      demoRecords.push(record);

      writeStorage(
        "hp-demo-records",
        demoRecords
      );

      $("#submitStatus").textContent =
        "Demo profile saved in this browser.";

      form.reset();

      refresh();
    }
  );

  // ------------------------------------------------------------
  // Dialog close buttons
  // ------------------------------------------------------------

  document.addEventListener(
    "click",
    event => {
      const button =
        event.target.closest(
          "[data-close]"
        );

      if (!button) {
        return;
      }

      const dialog =
        button.closest("dialog");

      if (dialog) {
        dialog.close();
      }
    }
  );

  // ------------------------------------------------------------
  // Theme
  // ------------------------------------------------------------

  const savedTheme =
    readStorage(
      "hp-theme",
      "light"
    );

  function applyTheme(theme) {
    document.documentElement.dataset.theme =
      theme;

    $("#theme").setAttribute(
      "aria-pressed",
      theme === "dark"
        ? "true"
        : "false"
    );

    // Auto-sync map layers to UI theme intelligently
    if (map) {
      const isDark = theme === "dark";

      // If user is currently viewing a Mapbox layer, swap Mapbox theme
      if (map.hasLayer(window.mapboxLight) || map.hasLayer(window.mapboxDark)) {
        map.removeLayer(window.mapboxLight);
        map.removeLayer(window.mapboxDark);
        map.addLayer(isDark ? window.mapboxDark : window.mapboxLight);
      }
      // If user is currently viewing a MapTiler layer, swap MapTiler theme
      else if (map.hasLayer(window.maptilerLight) || map.hasLayer(window.maptilerDark)) {
        map.removeLayer(window.maptilerLight);
        map.removeLayer(window.maptilerDark);
        map.addLayer(isDark ? window.maptilerDark : window.maptilerLight);
      }
      // Note: If they are on Satellite, we do nothing and let them keep Satellite.
    }
  }

  applyTheme(savedTheme);

  $("#theme").addEventListener(
    "click",
    () => {
      const next =
        document.documentElement.dataset.theme ===
        "dark"
          ? "light"
          : "dark";

      applyTheme(next);

      writeStorage(
        "hp-theme",
        next
      );
    }
  );

  // ------------------------------------------------------------
  // Start
  // ------------------------------------------------------------

  restoreClaimSession();

  if (
    window.L ||
    document.readyState ===
      "complete"
  ) {
    try {
      initMap();
    } catch (error) {
      showMapError(
        "Map could not start: " +
        error.message
      );
    }
  } else {
    window.addEventListener(
      "load",
      () => {
        try {
          initMap();
        } catch (error) {
          showMapError(
            "Map could not start: " +
            error.message
          );
        }
      },
      { once: true }
    );
  }

  loadDirectory().catch(
    error => {
      console.error(error);
      notify(error.message);
    }
  );

  // Refresh live pins every 10 seconds.
  setInterval(
    () => {
      if (
        !demo &&
        !document.hidden
      ) {
        refresh();
      }
    },
    10000
  );
}

if (
  document.readyState ===
  "loading"
) {
  document.addEventListener(
    "DOMContentLoaded",
    bootHeritagePin,
    { once: true }
  );
} else {
  bootHeritagePin();
}
