// content-preload.js
// Injected into every BrowserView to mitigate fingerprinting.
// ══════════════════════════════════════════════════════════════
// BASELINE protections are ALWAYS active (all privacy modes).
// ADVANCED protections activate in Strong / Maximum mode only.
// ══════════════════════════════════════════════════════════════
const { ipcRenderer, contextBridge } = require("electron");
const privacyMode = ipcRenderer.sendSync("get-privacy-mode");

// ── Start Page API (only exposed on file:// start.html) ────
if (window.location.protocol === "file:" && window.location.pathname.endsWith("start.html")) {
  contextBridge.exposeInMainWorld("startAPI", {
    getStats: () => ipcRenderer.invoke("browser:get-stats"),
    getSearchUrl: (query) => ipcRenderer.invoke("browser:get-search-url", query),
    getTheme: () => ipcRenderer.invoke("browser:get-theme"),
    toggleTheme: () => ipcRenderer.invoke("browser:toggle-theme"),
    onThemeChanged: (handler) => {
      const listener = (_event, payload) => handler(payload);
      ipcRenderer.on("browser:theme-changed", listener);
      return () => ipcRenderer.removeListener("browser:theme-changed", listener);
    }
  });
}

// ═══════════════════════════════════════════════════════════════
// BASELINE PROTECTIONS — Always active in ALL privacy modes
// These block the most dangerous fingerprinting & tracking vectors.
// ═══════════════════════════════════════════════════════════════

// 1. WebRTC IP Leak Prevention
// Block RTCPeerConnection, RTCSessionDescription, and RTCIceCandidate
// to prevent websites from discovering the user's real IP address.
const webRTCBlocker = {
  construct() { throw new DOMException("Aura: WebRTC is disabled for privacy.", "NotAllowedError"); },
  apply() { throw new DOMException("Aura: WebRTC is disabled for privacy.", "NotAllowedError"); }
};

if (typeof RTCPeerConnection !== "undefined") {
  window.RTCPeerConnection = new Proxy(RTCPeerConnection, webRTCBlocker);
}
if (typeof webkitRTCPeerConnection !== "undefined") {
  window.webkitRTCPeerConnection = new Proxy(webkitRTCPeerConnection, webRTCBlocker);
}
if (typeof RTCSessionDescription !== "undefined") {
  window.RTCSessionDescription = new Proxy(RTCSessionDescription, webRTCBlocker);
}
if (typeof RTCIceCandidate !== "undefined") {
  window.RTCIceCandidate = new Proxy(RTCIceCandidate, webRTCBlocker);
}

// 2. Battery Status API — unique fingerprint via charge level + timing
if (navigator.getBattery) {
  Object.defineProperty(navigator, "getBattery", {
    value: () => Promise.reject(new DOMException("Aura: Battery API is disabled for privacy.", "NotAllowedError")),
    writable: false,
    configurable: false,
  });
}

// 3. Device Enumeration — leaks camera/mic hardware IDs
if (navigator.mediaDevices && navigator.mediaDevices.enumerateDevices) {
  const origEnumerate = navigator.mediaDevices.enumerateDevices.bind(navigator.mediaDevices);
  Object.defineProperty(navigator.mediaDevices, "enumerateDevices", {
    value: () => Promise.resolve([]),
    writable: false,
    configurable: false,
  });
}
// Also block getUserMedia and getDisplayMedia to prevent camera/mic/screen access
if (navigator.mediaDevices) {
  Object.defineProperty(navigator.mediaDevices, "getUserMedia", {
    value: () => Promise.reject(new DOMException("Aura: Media access is disabled for privacy.", "NotAllowedError")),
    writable: false,
    configurable: false,
  });
  Object.defineProperty(navigator.mediaDevices, "getDisplayMedia", {
    value: () => Promise.reject(new DOMException("Aura: Screen capture is disabled for privacy.", "NotAllowedError")),
    writable: false,
    configurable: false,
  });
}

// 4. Geolocation API — hard block (never expose real location)
if (navigator.geolocation) {
  Object.defineProperty(navigator, "geolocation", {
    value: Object.freeze({
      getCurrentPosition: (_s, err) => { if (err) err(new GeolocationPositionError(1, "Aura: Geolocation is disabled.")); },
      watchPosition: (_s, err) => { if (err) err(new GeolocationPositionError(1, "Aura: Geolocation is disabled.")); return 0; },
      clearWatch: () => {},
    }),
    writable: false,
    configurable: false,
  });
}

// 5. Delete Web Bluetooth, USB, HID, Serial API objects
// Their mere existence is a detectable fingerprint signal.
const dangerousNavProps = ["bluetooth", "usb", "hid", "serial"];
for (const prop of dangerousNavProps) {
  try {
    if (prop in navigator) {
      Object.defineProperty(navigator, prop, { get: () => undefined, configurable: false });
    }
  } catch { /* Property may not be configurable in all Electron versions */ }
}

// 6. Hardware Fingerprint Spoofing
// Spoof CPU core count and memory to common generic values.
try { Object.defineProperty(navigator, "hardwareConcurrency", { get: () => 4, configurable: false }); } catch {}
try { Object.defineProperty(navigator, "deviceMemory", { get: () => 8, configurable: false }); } catch {}

// 7. Platform Spoofing — hide the exact OS
try { Object.defineProperty(navigator, "platform", { get: () => "Win32", configurable: false }); } catch {}

// 8. Language Spoofing — prevent locale fingerprinting
try { Object.defineProperty(navigator, "language", { get: () => "en-US", configurable: false }); } catch {}
try { Object.defineProperty(navigator, "languages", { get: () => Object.freeze(["en-US", "en"]), configurable: false }); } catch {}

// 9. Connection API — network type is a fingerprint vector
if (navigator.connection) {
  try {
    Object.defineProperty(navigator, "connection", { get: () => undefined, configurable: false });
  } catch {}
}

// 10. Plugins & MimeTypes — legacy but still used for fingerprinting
try { Object.defineProperty(navigator, "plugins", { get: () => [], configurable: false }); } catch {}
try { Object.defineProperty(navigator, "mimeTypes", { get: () => [], configurable: false }); } catch {}


// ═══════════════════════════════════════════════════════════════
// ADVANCED PROTECTIONS — Strong / Maximum mode only
// These provide deeper anti-fingerprinting but may affect some
// legitimate site functionality.
// ═══════════════════════════════════════════════════════════════

if (privacyMode === "strong" || privacyMode === "maximum") {

  // 11. Canvas Fingerprinting Spoofing
  // Overriding toDataURL and toBlob to return generic/empty data.
  const originalToDataURL = HTMLCanvasElement.prototype.toDataURL;
  HTMLCanvasElement.prototype.toDataURL = function () {
    return "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII="; // Returns a 1x1 transparent pixel
  };

  const originalToBlob = HTMLCanvasElement.prototype.toBlob;
  HTMLCanvasElement.prototype.toBlob = function (callback) {
    if (callback) {
      // Send a minimal dummy blob
      const dummyData = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0, 31, 21, 196, 137, 0, 0, 0, 10, 73, 68, 65, 84, 120, 156, 99, 0, 1, 0, 0, 5, 0, 1, 13, 10, 45, 180, 0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130]);
      callback(new Blob([dummyData], { type: 'image/png' }));
    }
  };

  // Override getImageData to add minor noise or block. We'll block it by returning zeros.
  const originalGetImageData = CanvasRenderingContext2D.prototype.getImageData;
  CanvasRenderingContext2D.prototype.getImageData = function (x, y, width, height) {
    const data = originalGetImageData.call(this, x, y, width, height);
    // Zero out the buffer
    for (let i = 0; i < data.data.length; i++) {
      data.data[i] = 0;
    }
    return data;
  };

  // 12. AudioContext Fingerprinting Spoofing
  // Overriding getChannelData to fill with zeros
  if (typeof AudioBuffer !== 'undefined' && AudioBuffer.prototype) {
    const originalGetChannelData = AudioBuffer.prototype.getChannelData;
    AudioBuffer.prototype.getChannelData = function (channel) {
      const data = originalGetChannelData.call(this, channel);
      // Zero out audio data to prevent audio fingerprinting
      for (let i = 0; i < data.length; i++) {
        data[i] = 0;
      };
      return data;
    };
  }

  // 13. Screen Resolution Spoofing
  // Spoof to the most common resolution to blend in with the crowd.
  try { Object.defineProperty(screen, "width", { get: () => 1920, configurable: false }); } catch {}
  try { Object.defineProperty(screen, "height", { get: () => 1080, configurable: false }); } catch {}
  try { Object.defineProperty(screen, "availWidth", { get: () => 1920, configurable: false }); } catch {}
  try { Object.defineProperty(screen, "availHeight", { get: () => 1040, configurable: false }); } catch {}
  try { Object.defineProperty(screen, "colorDepth", { get: () => 24, configurable: false }); } catch {}
  try { Object.defineProperty(screen, "pixelDepth", { get: () => 24, configurable: false }); } catch {}
  try { Object.defineProperty(window, "devicePixelRatio", { get: () => 1, configurable: false }); } catch {}
  try { Object.defineProperty(window, "outerWidth", { get: () => 1920, configurable: false }); } catch {}
  try { Object.defineProperty(window, "outerHeight", { get: () => 1040, configurable: false }); } catch {}

  // 14. Font Enumeration Blocking
  // Prevent websites from detecting installed fonts via document.fonts
  if (typeof document !== "undefined" && document.fonts) {
    try {
      Object.defineProperty(document, "fonts", {
        get: () => ({
          check: () => false,
          ready: Promise.resolve(),
          forEach: () => {},
          entries: () => [][Symbol.iterator](),
          keys: () => [][Symbol.iterator](),
          values: () => [][Symbol.iterator](),
          [Symbol.iterator]: () => [][Symbol.iterator](),
          has: () => false,
          add: () => {},
          delete: () => false,
          clear: () => {},
          size: 0,
          status: "loaded",
          onloading: null,
          onloadingdone: null,
          onloadingerror: null,
          load: () => Promise.resolve([]),
        }),
        configurable: false,
      });
    } catch {}
  }

  // 15. Timezone Spoofing — spoof to UTC to prevent timezone fingerprinting
  const OriginalDateTimeFormat = Intl.DateTimeFormat;
  Intl.DateTimeFormat = function (...args) {
    // Force timezone to UTC unless explicitly set
    if (args.length < 2 || !args[1] || !args[1].timeZone) {
      args[1] = { ...(args[1] || {}), timeZone: "UTC" };
    }
    return new OriginalDateTimeFormat(...args);
  };
  Intl.DateTimeFormat.prototype = OriginalDateTimeFormat.prototype;
  Intl.DateTimeFormat.supportedLocalesOf = OriginalDateTimeFormat.supportedLocalesOf;
}
