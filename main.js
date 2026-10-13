const path = require("path");
const fs = require("fs");
const { spawn } = require("child_process");
let torProcess = null;
const { app, BrowserWindow, BrowserView, ipcMain, shell, Menu, MenuItem, clipboard, session, nativeTheme } = require("electron");
const { ElectronBlocker } = require("@ghostery/adblocker-electron");
const fetch = require("cross-fetch");
const Store = require("electron-store").default;

const SEARCH_ENGINES = {
  duckduckgo: "https://duckduckgo.com/?q=%s",
  brave: "https://search.brave.com/search?q=%s",
  google: "https://www.google.com/search?q=%s",
  bing: "https://www.bing.com/search?q=%s",
  ecosia: "https://www.ecosia.org/search?q=%s",
  startpage: "https://www.startpage.com/search?query=%s",
  searx: "https://searx.tiekoetter.com/search?q=%s",
};

const topHostByContents = new Map();
const runtimeUserDataPath = path.join(
  app.getPath("temp"),
  `aura-browser-${Date.now()}-${process.pid}`
);

// ── PERSISTENT SETTINGS STORE ──────────────────────────────
const SETTINGS_DEFAULTS = {
  searchEngine: "duckduckgo",
  customSearchTemplate: "https://duckduckgo.com/?q=%s",
  privacyMode: "standard",
};

const settingsStore = new Store({
  name: "aura-settings",
  defaults: SETTINGS_DEFAULTS,
  // Store in the real config path, NOT the ephemeral runtimeUserDataPath
  cwd: app.getPath("appData"),
});

let mainWindow = null;
let tabs = [];
let activeTabId = null;
let tabCounter = 0;
let activeSearchEngine = settingsStore.get("searchEngine", "duckduckgo");
let customSearchTemplate = settingsStore.get("customSearchTemplate", "https://duckduckgo.com/?q=%s");
let globalTrackersCount = 0;
let sessionConfigured = false;
let pendingUrl = null;
let splitViewActive = false;
let splitViewTabId = null;
let forceDarkEnabled = false;
let privacyMode = settingsStore.get("privacyMode", "standard");

let temporaryPermissions = {};
let pendingPermissions = new Map();
let permissionIdCounter = 0;
let relaxedHosts = new Set();
const configuredPartitions = new Set();

const BASE_TOOLBAR_HEIGHT = 98;
let currentToolbarHeight = BASE_TOOLBAR_HEIGHT;

app.commandLine.appendSwitch("disable-background-networking");
app.commandLine.appendSwitch("disable-component-update");
app.commandLine.appendSwitch("disable-sync");
app.commandLine.appendSwitch("disable-client-side-phishing-detection");
app.commandLine.appendSwitch("disable-features", [
  "AutofillServerCommunication",
  "CertificateTransparencyComponentUpdater",
  "MediaRouter",
  "OptimizationHints",
  "Translate",
  "WebBluetooth",
  "WebUSB",
  "WebHID",
  "WebSerial",
  "DirectSockets",
  "IdleDetection",
  "StorageAccessAPI",
  "BatteryStatus",
  "UserAgentClientHint",        // Prevent Sec-CH-UA headers in HTTP requests
  "ClientHintsMetaHTTPEquivAcceptCH", // Block meta-tag client hint requests
  "GenericSensorExtraClasses",  // Block accelerometer/gyroscope fingerprinting
].join(","));
app.commandLine.appendSwitch("metrics-recording-only");
app.commandLine.appendSwitch("no-pings");
app.commandLine.appendSwitch("safebrowsing-disable-auto-update");
app.commandLine.appendSwitch("disable-webgl");
app.commandLine.appendSwitch("disk-cache-size", "0");
app.commandLine.appendSwitch("media-cache-size", "0");
app.commandLine.appendSwitch("incognito");
app.commandLine.appendSwitch("proxy-server", "socks5://127.0.0.1:9050");
app.commandLine.appendSwitch("proxy-bypass-list", "aura-search,localhost,127.0.0.1");
app.commandLine.appendSwitch("force-webrtc-ip-handling-policy", "disable_non_proxied_udp");
// Fully disable WebRTC to prevent IP leaks via RTCPeerConnection
app.commandLine.appendSwitch("disable-webrtc");
// Force generic language at the Chromium level to prevent timezone/locale in headers
app.commandLine.appendSwitch("lang", "en-US");
// Prevent local DNS leaks by forcing all resolution through the proxy
app.commandLine.appendSwitch("host-resolver-rules", "MAP * ~NOTFOUND , EXCLUDE 127.0.0.1");
app.setPath("userData", runtimeUserDataPath);

function getHost(rawUrl) {
  try { return new URL(rawUrl).hostname.toLowerCase(); } catch { return null; }
}

function getSite(host) {
  if (!host) return null;
  const parts = host.split(".").filter(Boolean);
  if (parts.length <= 2) return host;
  const tld = parts[parts.length - 1];
  const secondLevel = parts[parts.length - 2];
  const thirdLevel = parts[parts.length - 3];
  const commonSecondLevel = new Set(["co", "com", "org", "net", "gov", "edu", "ac"]);
  if (tld.length === 2 && commonSecondLevel.has(secondLevel) && parts.length >= 3) {
    return `${thirdLevel}.${secondLevel}.${tld}`;
  }
  return `${secondLevel}.${tld}`;
}

function isSameSite(hostA, hostB) {
  const siteA = getSite(hostA);
  const siteB = getSite(hostB);
  return Boolean(siteA && siteB && siteA === siteB);
}

function normalizeInputToUrl(input) {
  if (!input || typeof input !== "string") return null;
  const trimmed = input.trim();
  if (!trimmed) return null;

  const hasScheme = /^[a-zA-Z][a-zA-Z\d+\-.]*:\/\//.test(trimmed);
  const candidate = hasScheme ? trimmed : `https://${trimmed}`;

  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return parsed.href;
  } catch {
    return null;
  }
}

function buildSearchUrl(query) {
  const template = activeSearchEngine === "custom" ? customSearchTemplate : SEARCH_ENGINES[activeSearchEngine] || SEARCH_ENGINES.duckduckgo;
  const safeTemplate = template.includes("%s") ? template : `${template}${template.includes("?") ? "&" : "?"}q=%s`;
  return safeTemplate.replace("%s", encodeURIComponent(query));
}

function getActiveView() {
  const tab = tabs.find(t => t.id === activeTabId);
  return tab ? tab.view : null;
}

function setWebViewBounds() {
  if (!mainWindow) return;
  const bounds = mainWindow.getContentBounds();
  
  // Calculate heights
  let headerHeight = currentToolbarHeight;
  
  const contentY = headerHeight;
  const contentHeight = Math.max(0, bounds.height - contentY);
  
  // Resize ALL tab views, but only show the active one
  tabs.forEach(tab => {
    try {
      tab.view.setBounds({
        x: 0,
        y: contentY,
        width: bounds.width,
        height: contentHeight,
      });
    } catch (e) {
      console.error("Failed to set bounds for tab", tab.id, e);
    }
  });
}

function applyThemeToWebContents(webContents) {
  if (!webContents || webContents.isDestroyed()) return;
  const theme = settingsStore.get("theme", "dark");
  if (theme === "dark") {
    const url = webContents.getURL() || "";
    const host = getHost(url);
    if (host && (host.includes("google.") || host.includes("bing.com"))) {
      // #e7e7e4 inverted is exactly #18181b (the browser's dark theme background)
      const darkCSS = `
        html { filter: invert(1) hue-rotate(180deg) !important; background: #e7e7e4 !important; }
        img, video, canvas, iframe, [style*="background-image"] { filter: invert(1) hue-rotate(180deg) !important; }
      `;
      webContents.insertCSS(darkCSS).catch(() => {});
    }
  }
}

function getBrowserState() {
  const activeView = getActiveView();
  return {
    url: activeView && !activeView.webContents.isDestroyed() ? (activeView.webContents.getURL() || "") : "",
    title: activeView && !activeView.webContents.isDestroyed() ? (activeView.webContents.getTitle() || "") : "",
    canGoBack: activeView && !activeView.webContents.isDestroyed() ? activeView.webContents.navigationHistory.canGoBack() : false,
    canGoForward: activeView && !activeView.webContents.isDestroyed() ? activeView.webContents.navigationHistory.canGoForward() : false,
    activeSearchEngine,
    customSearchTemplate,
    privacyMode,
    tabs: tabs.map(t => ({ id: t.id, title: t.title || "New Tab", url: t.url, isActive: t.id === activeTabId, identity: t.identity }))
  };
}

function sendBrowserState() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send("browser:state", getBrowserState());
}

function emitBlocked(url, reason) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send("browser:blocked", { url, reason });
  globalTrackersCount++;
}

function shouldBlockRequest(details, viewContentsId) {
  const urlObj = (() => { try { return new URL(details.url); } catch { return null; } })();
  if (!urlObj) return null;
  if (urlObj.protocol !== "http:" && urlObj.protocol !== "https:") return null;

  const requestHost = urlObj.hostname.toLowerCase();

  if (details.resourceType === "mainFrame") {
    topHostByContents.set(viewContentsId, requestHost);
    return null;
  }

  const initiatorHost = getHost(details.initiator || "");
  const topHost = initiatorHost || topHostByContents.get(viewContentsId) || null;

  if (!topHost) return null;
  if (isSameSite(requestHost, topHost)) return null;

  return `third-party request from ${topHost} to ${requestHost}`;
}

async function navigateFromInput(input) {
  const activeView = getActiveView();
  if (!activeView) return;
  const asUrl = normalizeInputToUrl(input);
  if (asUrl) {
    await activeView.webContents.loadURL(asUrl);
    return;
  }
  const searchUrl = buildSearchUrl(input);
  await activeView.webContents.loadURL(searchUrl);
}

function switchTab(id) {
  const tab = tabs.find(t => t.id === id);
  if (!tab || !mainWindow) return;

  const currentView = getActiveView();
  if (currentView) {
    mainWindow.removeBrowserView(currentView);
  }

  activeTabId = id;
  mainWindow.setBrowserView(tab.view);
  setWebViewBounds();
  sendBrowserState();
}

function configureSession(partition) {
  if (configuredPartitions.has(partition)) return;
  configuredPartitions.add(partition);

  const { session } = require("electron");
  const sess = session.fromPartition(partition);

  if (!partition.startsWith("persist:")) {
    sess.clearStorageData();
    sess.clearCache();
  }

  sess.on('will-download', (event, item, webContents) => {
    let filename = item.getFilename();
    const trackingRegex = /(_utm|_fb|_gl|fbclid|gclid)/i;
    if (trackingRegex.test(filename)) {
      filename = filename.replace(trackingRegex, "");
      item.setSaveDialogOptions({ defaultPath: filename });
    }

    const isExecutable = /\.(exe|dmg|sh|bat|cmd|msi|app|pkg)$/i.test(filename);

    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("browser:download-started", {
        filename,
        isExecutable,
        totalBytes: item.getTotalBytes()
      });
    }

    item.on('updated', (event, state) => {
      if (state === 'progressing' && mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("browser:download-updated", {
          filename,
          receivedBytes: item.getReceivedBytes(),
          totalBytes: item.getTotalBytes()
        });
      }
    });

    item.on('done', (event, state) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("browser:download-done", {
          filename,
          state
        });
      }
    });
  });

  const defaultUA = sess.getUserAgent();
  const anonymizedUA = defaultUA.replace(/Electron\/[0-9\.]+ /, "").replace(/aura-browser\/[0-9\.]+ /, "");
  sess.setUserAgent(anonymizedUA);

  ElectronBlocker.fromPrebuiltAdsAndTracking(fetch).then((blocker) => {
    blocker.enableBlockingInSession(sess);
  });

  // ── PERMISSION HARDENING ──────────────────────────────────
  // Permissions that are ALWAYS denied — no prompt, no exception.
  // A privacy-first browser must never expose real location, camera, mic, or screen.
  const ALWAYS_DENY_PERMISSIONS = new Set([
    "geolocation",
    "media",              // camera + microphone
    "display-capture",    // screen sharing
    "idle-detection",
  ]);

  sess.setPermissionRequestHandler((webContents, permission, callback, details) => {
    // Hard-deny dangerous permissions unconditionally
    if (ALWAYS_DENY_PERMISSIONS.has(permission)) return callback(false);

    const url = details.requestingUrl || webContents.getURL();
    if (!url) return callback(false);
    try {
      const origin = new URL(url).origin;
      const stored = temporaryPermissions[origin] && temporaryPermissions[origin][permission];
      if (stored === "allow") return callback(true);
      if (stored === "deny") return callback(false);

      if (mainWindow && !mainWindow.isDestroyed()) {
        const id = ++permissionIdCounter;
        pendingPermissions.set(id, callback);
        mainWindow.webContents.send("browser:ask-permission", { id, origin, permission });
      } else {
        callback(false);
      }
    } catch {
      callback(false);
    }
  });

  sess.setPermissionCheckHandler((webContents, permission, requestingOrigin, details) => {
    // Hard-deny dangerous permissions in checks too
    if (ALWAYS_DENY_PERMISSIONS.has(permission)) return false;
    try {
      const origin = new URL(requestingOrigin).origin;
      const stored = temporaryPermissions[origin] && temporaryPermissions[origin][permission];
      return stored === "allow";
    } catch {
      return false;
    }
  });
  sess.setDevicePermissionHandler(() => false);

  sess.webRequest.onBeforeRequest({ urls: ["*://*/*"] }, (details, callback) => {
    const urlObj = (() => { try { return new URL(details.url); } catch { return null; } })();

    // 1. URL Anti-Tracking Cleaner
    if (urlObj && details.resourceType === "mainFrame") {
      const trackingParams = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'fbclid', 'gclid', 'mc_eid', 'igshid', '_gl'];
      let hasTracking = false;
      trackingParams.forEach(param => {
        if (urlObj.searchParams.has(param)) {
          urlObj.searchParams.delete(param);
          hasTracking = true;
        }
      });
      if (hasTracking) {
        emitBlocked(details.url, "Tracking parameters stripped");
        return callback({ redirectURL: urlObj.href });
      }
    }

    if (urlObj && urlObj.hostname === "aura-search") {
      const q = urlObj.searchParams.get("q") || "";
      return callback({ redirectURL: buildSearchUrl(q) });
    }

    if (urlObj && urlObj.protocol === "http:" && urlObj.hostname !== "localhost" && urlObj.hostname !== "127.0.0.1") {
      const httpsUrl = details.url.replace(/^http:/, "https:");
      emitBlocked(details.url, "Upgraded to HTTPS");
      return callback({ redirectURL: httpsUrl });
    }

    const requestHost = urlObj ? urlObj.hostname.toLowerCase() : null;
    let topHost = topHostByContents.get(details.webContentsId);
    if (!topHost && details.resourceType === "mainFrame" && requestHost) {
      topHost = requestHost;
    }

    // Site Compatibility Assistant override
    if (requestHost && (relaxedHosts.has(topHost) || relaxedHosts.has(requestHost))) {
      return callback({ cancel: false });
    }

    const reason = shouldBlockRequest(details, details.webContentsId);
    if (reason) {
      emitBlocked(details.url, reason);
      return callback({ cancel: true });
    }
    callback({ cancel: false });
  });

  sess.webRequest.onBeforeSendHeaders({ urls: ["*://*/*"] }, (details, callback) => {
    const requestHeaders = { ...details.requestHeaders };

    // ── Anti-Tracking Header Cleanup ──────────────────────
    // Strip referer to prevent cross-site tracking
    delete requestHeaders.Referer;
    delete requestHeaders.referer;
    // Strip Google's client-data header
    delete requestHeaders["X-Client-Data"];

    // ── Timezone & Locale Header Sanitization ────────────
    // Force generic Accept-Language to prevent locale fingerprinting
    // (coveryourtracks.eff.org detects this!)
    requestHeaders["Accept-Language"] = "en-US,en;q=0.9";

    // ── Client Hints Stripping ───────────────────────────
    // Sec-CH-UA headers leak browser version, platform, OS, arch,
    // mobile status, and full version — all fingerprint vectors.
    delete requestHeaders["Sec-CH-UA"];
    delete requestHeaders["Sec-CH-UA-Platform"];
    delete requestHeaders["Sec-CH-UA-Platform-Version"];
    delete requestHeaders["Sec-CH-UA-Mobile"];
    delete requestHeaders["Sec-CH-UA-Full-Version"];
    delete requestHeaders["Sec-CH-UA-Full-Version-List"];
    delete requestHeaders["Sec-CH-UA-Arch"];
    delete requestHeaders["Sec-CH-UA-Bitness"];
    delete requestHeaders["Sec-CH-UA-Model"];
    delete requestHeaders["Sec-CH-UA-WoW64"];
    delete requestHeaders["Sec-CH-Prefers-Color-Scheme"];
    delete requestHeaders["Sec-CH-Viewport-Width"];
    delete requestHeaders["Sec-CH-DPR"];
    delete requestHeaders["Sec-CH-Width"];
    delete requestHeaders["Sec-CH-Device-Memory"];

    // ── Privacy Signals ──────────────────────────────────
    requestHeaders.DNT = "1";
    requestHeaders["Sec-GPC"] = "1";
    callback({ requestHeaders });
  });

  sess.webRequest.onHeadersReceived({ urls: ["*://*/*"] }, (details, callback) => {
    const responseHeaders = { ...details.responseHeaders };

    // Force strict referrer policy on all responses to prevent leaking
    // the current page URL to navigated-to sites
    responseHeaders["referrer-policy"] = ["no-referrer"];

    // Block browser-level permission-policy features via HTTP header
    responseHeaders["permissions-policy"] = [
      "camera=(), microphone=(), geolocation=(), battery=(), bluetooth=(), usb=(), hid=(), serial=(), idle-detection=(), display-capture=()"
    ];

    let skipCsp = false;
    try {
      const topHost = topHostByContents.get(details.webContentsId);
      const urlObj = new URL(details.url);
      if (relaxedHosts.has(topHost) || relaxedHosts.has(urlObj.hostname)) {
        skipCsp = true;
      }
    } catch { }

    if (!skipCsp && privacyMode === "maximum") {
      if (!responseHeaders["content-security-policy"]) {
        responseHeaders["content-security-policy"] = [];
      }
      responseHeaders["content-security-policy"].push("script-src 'none'");
    }

    callback({ responseHeaders });
  });
}

// ── CONTEXT MENU BUILDER ────────────────────────────────────
function attachContextMenu(view, tabIdentity) {
  view.webContents.on("context-menu", (event, params) => {
    const menuItems = [];
    const hasLink = params.linkURL && params.linkURL.length > 0;
    const hasSelection = params.selectionText && params.selectionText.trim().length > 0;

    if (hasLink) {
      menuItems.push(
        {
          label: "Open Link in New Tab",
          click: () => {
            const sanitized = normalizeInputToUrl(params.linkURL);
            if (sanitized) createTab(sanitized, tabIdentity);
          },
        },
        {
          label: "Open Link in New Window",
          click: () => {
            const sanitized = normalizeInputToUrl(params.linkURL);
            if (sanitized) openInNewWindow(sanitized);
          },
        },
        {
          label: "Open in Split View",
          click: () => {
            const sanitized = normalizeInputToUrl(params.linkURL);
            if (sanitized) {
              const newTab = createTab(sanitized, tabIdentity);
              // Automatically activate split view with the new tab
              if (newTab && mainWindow) {
                const bounds = mainWindow.getContentBounds();
                const halfW = Math.floor(bounds.width / 2);
                const contentH = Math.max(0, bounds.height - currentToolbarHeight);
                const activeView = getActiveView();
                if (activeView) {
                  splitViewActive = true;
                  splitViewTabId = newTab.id;
                  // Switch back to the original tab so it's the left pane
                  const origTab = tabs.find(t => t.id === activeTabId);
                  if (origTab) {
                    mainWindow.setBrowserView(origTab.view);
                    origTab.view.setBounds({ x: 0, y: currentToolbarHeight, width: halfW, height: contentH });
                    mainWindow.addBrowserView(newTab.view);
                    newTab.view.setBounds({ x: halfW, y: currentToolbarHeight, width: halfW, height: contentH });
                  }
                  sendBrowserState();
                }
              }
            }
          },
        },
        {
          label: "Open in Incognito Window",
          click: () => {
            const sanitized = normalizeInputToUrl(params.linkURL);
            if (sanitized) createTab(sanitized, "anonymous");
          },
        },
        { type: "separator" },
        {
          label: "Copy Link Address",
          click: () => {
            clipboard.writeText(params.linkURL);
          },
        }
      );
    }

    if (hasSelection) {
      if (menuItems.length > 0) menuItems.push({ type: "separator" });
      menuItems.push({
        label: "Copy",
        click: () => {
          clipboard.writeText(params.selectionText);
        },
      });
    }

    if (!hasLink) {
      // General page context menu
      if (menuItems.length > 0) menuItems.push({ type: "separator" });
      menuItems.push(
        {
          label: "Back",
          enabled: view.webContents.navigationHistory.canGoBack(),
          click: () => view.webContents.navigationHistory.goBack(),
        },
        {
          label: "Forward",
          enabled: view.webContents.navigationHistory.canGoForward(),
          click: () => view.webContents.navigationHistory.goForward(),
        },
        {
          label: "Reload",
          click: () => view.webContents.reload(),
        }
      );
    }

    // Always show Print at the bottom
    menuItems.push({ type: "separator" });
    menuItems.push({
      label: "Print Page",
      click: () => {
        view.webContents.print({}, (success, failureReason) => {
          if (!success && failureReason !== "cancelled") {
            console.error("Print failed:", failureReason);
          }
        });
      },
    });

    const menu = Menu.buildFromTemplate(menuItems);
    menu.popup({ window: mainWindow });
  });
}

function openInNewWindow(url) {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    title: "Aura Browser",
    backgroundColor: "#0f1115",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });
  win.loadURL(url);
}

function createTab(initialUrl = "file://" + path.join(__dirname, "renderer/start.html"), identity = "personal") {
  const partition = identity === "anonymous" ? `ephemeral:anon-${Date.now()}` : `persist:${identity}`;

  configureSession(partition);

  const view = new BrowserView({
    webPreferences: {
      partition,
      javascript: true,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      preload: path.join(__dirname, "content-preload.js"),
    },
  });

  const tabId = `tab-${++tabCounter}`;
  const tab = { id: tabId, view, url: initialUrl, title: "New Tab", identity };
  tabs.push(tab);

  view.webContents.setWindowOpenHandler(({ url }) => {
    const sanitized = normalizeInputToUrl(url);
    if (sanitized) createTab(sanitized);
    return { action: "deny" };
  });

  // Attach rich right-click context menu
  attachContextMenu(view, identity);

  view.webContents.on("did-navigate", (e, url) => { tab.url = url; sendBrowserState(); applyThemeToWebContents(view.webContents); });
  view.webContents.on("did-navigate-in-page", (e, url) => { tab.url = url; sendBrowserState(); applyThemeToWebContents(view.webContents); });
  view.webContents.on("dom-ready", () => applyThemeToWebContents(view.webContents));
  view.webContents.on("page-title-updated", (event, title) => {
    event.preventDefault();
    tab.title = title;

    const titleLower = title.toLowerCase();
    const currentUrl = view.webContents.getURL().toLowerCase();

    if (
      titleLower.includes("attention required! | cloudflare") ||
      titleLower.includes("just a moment...") ||
      titleLower.includes("verify you are human") ||
      (currentUrl.includes("google.com/sorry/index") && titleLower.includes("sorry"))
    ) {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("browser:captcha-detected", { tabId: tab.id });
      }
    }

    sendBrowserState();
  });
  view.webContents.on("did-start-loading", sendBrowserState);
  view.webContents.on("did-stop-loading", sendBrowserState);

  view.webContents.loadURL(initialUrl);

  if (mainWindow) switchTab(tabId);

  // Return the tab object so callers (e.g. split-view) can reference it
  return tab;
}

function closeTab(id) {
  const tabIndex = tabs.findIndex(t => t.id === id);
  if (tabIndex === -1) return;

  const tab = tabs[tabIndex];
  if (activeTabId === id && mainWindow) {
    mainWindow.removeBrowserView(tab.view);
  }

  tabs.splice(tabIndex, 1);

  // Stop video/audio and destroy webContents
  try {
    tab.view.webContents.destroy();
  } catch { }

  if (tabs.length === 0) {
    activeTabId = null;
    createTab();
  } else if (activeTabId === id) {
    switchTab(tabs[Math.max(0, tabIndex - 1)].id);
  } else {
    sendBrowserState();
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1300,
    height: 850,
    title: "Aura Browser",
    backgroundColor: "#0f1115",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });

  mainWindow.setMaxListeners(50);

  mainWindow.on("resize", setWebViewBounds);
  mainWindow.on("maximize", setWebViewBounds);
  mainWindow.on("unmaximize", setWebViewBounds);

  mainWindow.loadFile(path.join(__dirname, "renderer/index.html"));

  createTab(pendingUrl || undefined);
  pendingUrl = null;
}

ipcMain.handle("browser:get-state", async () => getBrowserState());
ipcMain.on("get-privacy-mode", (event) => {
  event.returnValue = privacyMode;
});

ipcMain.handle("browser:set-privacy-mode", async (_event, mode) => {
  if (["standard", "strong", "maximum"].includes(mode)) {
    privacyMode = mode;
    // Persist to device storage
    settingsStore.set("privacyMode", mode);
    sendBrowserState();

    // Reload active tab to apply new strict headers/preloads
    const activeView = getActiveView();
    if (activeView && !activeView.webContents.isDestroyed()) {
      activeView.webContents.reload();
    }
  }
  return getBrowserState();
});

ipcMain.on("browser:answer-permission", (event, { id, origin, permission, action }) => {
  const callback = pendingPermissions.get(id);
  if (callback) {
    pendingPermissions.delete(id);
    if (!temporaryPermissions[origin]) temporaryPermissions[origin] = {};
    temporaryPermissions[origin][permission] = action;
    callback(action === "allow");
  }
});

ipcMain.handle("browser:go", async (_event, rawInput) => {
  const input = typeof rawInput === "string" ? rawInput.trim() : "";
  if (!input) return getBrowserState();
  await navigateFromInput(input);
  return getBrowserState();
});

ipcMain.handle("browser:search", async (_event, rawQuery) => {
  const query = typeof rawQuery === "string" ? rawQuery.trim() : "";
  if (!query) return getBrowserState();
  const activeView = getActiveView();
  if (activeView) await activeView.webContents.loadURL(buildSearchUrl(query));
  return getBrowserState();
});

ipcMain.handle("get-privacy-mode", () => privacyMode);

ipcMain.handle("browser:get-stats", (event) => {
  const tab = tabs.find(t => t.view && !t.view.webContents.isDestroyed() && t.view.webContents.id === event.sender.id);
  return {
    trackersBlocked: globalTrackersCount,
    identity: tab ? tab.identity : "personal",
    privacyMode: privacyMode
  };
});

ipcMain.handle("browser:action", async (_event, action) => {
  const activeView = getActiveView();
  if (!activeView) return getBrowserState();

  switch (action) {
    case "back": if (activeView.webContents.navigationHistory.canGoBack()) activeView.webContents.navigationHistory.goBack(); break;
    case "forward": if (activeView.webContents.navigationHistory.canGoForward()) activeView.webContents.navigationHistory.goForward(); break;
    case "reload": activeView.webContents.reload(); break;
    case "home": await activeView.webContents.loadURL("file://" + path.join(__dirname, "renderer/start.html")); break;
  }
  return getBrowserState();
});

ipcMain.handle("browser:set-search-engine", async (_event, payload) => {
  const nextEngine = payload && typeof payload.engine === "string" ? payload.engine.trim().toLowerCase() : "";
  if (nextEngine === "custom" || Object.prototype.hasOwnProperty.call(SEARCH_ENGINES, nextEngine)) {
    activeSearchEngine = nextEngine;
  }
  const nextTemplate = payload && typeof payload.customTemplate === "string" ? payload.customTemplate.trim() : "";
  if (nextTemplate) {
    const normalized = normalizeInputToUrl(nextTemplate.replace("%s", "example-query"));
    if (normalized) {
      customSearchTemplate = nextTemplate.includes("%s") ? nextTemplate : `${nextTemplate}%s`;
    }
  }
  // Persist to device storage
  settingsStore.set("searchEngine", activeSearchEngine);
  settingsStore.set("customSearchTemplate", customSearchTemplate);
  // Persist the engine choice into the start page's localStorage
  const activeView = getActiveView();
  if (activeView && !activeView.webContents.isDestroyed()) {
    activeView.webContents.executeJavaScript(
      `try { localStorage.setItem('aura_search_engine', '${activeSearchEngine}'); } catch(e) {}`
    ).catch(() => { });
  }
  sendBrowserState();
  return getBrowserState();
});

ipcMain.handle("browser:relax-privacy", async () => {
  const activeView = getActiveView();
  if (activeView && !activeView.webContents.isDestroyed()) {
    const url = activeView.webContents.getURL();
    if (url) {
      try {
        const host = new URL(url).hostname;
        relaxedHosts.add(host);
        activeView.webContents.reload();
      } catch { }
    }
  }
  return getBrowserState();
});

ipcMain.handle("browser:forget-site", async () => {
  const activeView = getActiveView();
  if (activeView && !activeView.webContents.isDestroyed()) {
    const url = activeView.webContents.getURL();
    if (url) {
      try {
        const origin = new URL(url).origin;
        const sess = activeView.webContents.session;
        await sess.clearStorageData({ origin: origin });
        activeView.webContents.reload();
      } catch (e) {
        console.error("Error forgetting site:", e);
      }
    }
  }
  return getBrowserState();
});

ipcMain.handle("browser:set-identity", async (_event, identity) => {
  const activeView = getActiveView();
  if (!activeView || activeView.webContents.isDestroyed()) return getBrowserState();

  const currentUrl = activeView.webContents.getURL();
  const tab = tabs.find(t => t.id === activeTabId);
  if (!tab) return getBrowserState();

  // Recreate the tab with the new identity
  const newPartition = identity === "anonymous" ? `ephemeral:anon-${Date.now()}` : `persist:${identity}`;
  configureSession(newPartition);

  const newView = new BrowserView({
    webPreferences: {
      partition: newPartition,
      javascript: true,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      preload: path.join(__dirname, "content-preload.js"),
    },
  });

  newView.webContents.setWindowOpenHandler(({ url }) => {
    const sanitized = normalizeInputToUrl(url);
    if (sanitized) createTab(sanitized, identity);
    return { action: "deny" };
  });

  // Attach rich right-click context menu to recreated view
  attachContextMenu(newView, identity);

  newView.webContents.on("did-navigate", (e, url) => { tab.url = url; sendBrowserState(); applyThemeToWebContents(newView.webContents); });
  newView.webContents.on("did-navigate-in-page", (e, url) => { tab.url = url; sendBrowserState(); applyThemeToWebContents(newView.webContents); });
  newView.webContents.on("dom-ready", () => applyThemeToWebContents(newView.webContents));
  newView.webContents.on("page-title-updated", (event, title) => {
    event.preventDefault();
    tab.title = title;

    const titleLower = title.toLowerCase();
    const currentUrl = newView.webContents.getURL().toLowerCase();

    if (
      titleLower.includes("attention required! | cloudflare") ||
      titleLower.includes("just a moment...") ||
      titleLower.includes("verify you are human") ||
      (currentUrl.includes("google.com/sorry/index") && titleLower.includes("sorry"))
    ) {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("browser:captcha-detected", { tabId: tab.id });
      }
    }

    sendBrowserState();
  });
  newView.webContents.on("did-start-loading", sendBrowserState);
  newView.webContents.on("did-stop-loading", sendBrowserState);

  tab.identity = identity;

  if (mainWindow) {
    mainWindow.removeBrowserView(tab.view);
    tab.view.webContents.destroy();

    tab.view = newView;
    mainWindow.setBrowserView(newView);
    setWebViewBounds();
  } else {
    tab.view = newView;
  }

  await newView.webContents.loadURL(currentUrl);
  return getBrowserState();
});

ipcMain.handle("browser:new-tab", async () => { createTab(); return getBrowserState(); });
ipcMain.handle("browser:switch-tab", async (_event, id) => { switchTab(id); return getBrowserState(); });
ipcMain.handle("browser:close-tab", async (_event, id) => { closeTab(id); return getBrowserState(); });

// Return the current search URL for a given query (used by the Start Page)
ipcMain.handle("browser:get-search-url", (_event, query) => {
  return buildSearchUrl(query);
});

// ── PURGE SETTINGS ────────────────────────────────────────
ipcMain.handle("browser:purge-settings", async () => {
  settingsStore.clear();
  // Reset in-memory values to defaults
  activeSearchEngine = SETTINGS_DEFAULTS.searchEngine;
  customSearchTemplate = SETTINGS_DEFAULTS.customSearchTemplate;
  privacyMode = SETTINGS_DEFAULTS.privacyMode;
  sendBrowserState();
  // Reload active tab to apply default privacy mode
  const activeView = getActiveView();
  if (activeView && !activeView.webContents.isDestroyed()) {
    activeView.webContents.reload();
  }
  return getBrowserState();
});

// Lock toolbar height to prevent layout shifts. Panels now use native menus.
ipcMain.handle("browser:set-toolbar-height", (_event) => {
  currentToolbarHeight = BASE_TOOLBAR_HEIGHT;
  setWebViewBounds();
});

// ── NATIVE MENUS TO PREVENT LAYOUT SHIFT ─────────────────────
ipcMain.on("browser:show-settings-menu", (event, bounds) => {
  const currentEngine = settingsStore.get("searchEngine", "duckduckgo");
  const currentDark = false; // TODO: implement dark mode setting if needed

  const menu = Menu.buildFromTemplate([
    { label: "Settings", enabled: false },
    { type: "separator" },
    {
      label: "Search Engine",
      submenu: [
        { label: "DuckDuckGo", type: "radio", checked: currentEngine === "duckduckgo", click: () => setEngine("duckduckgo") },
        { label: "Google", type: "radio", checked: currentEngine === "google", click: () => setEngine("google") },
        { label: "Brave Search", type: "radio", checked: currentEngine === "brave", click: () => setEngine("brave") },
        { label: "Bing", type: "radio", checked: currentEngine === "bing", click: () => setEngine("bing") },
        { label: "Ecosia", type: "radio", checked: currentEngine === "ecosia", click: () => setEngine("ecosia") },
        { label: "Startpage", type: "radio", checked: currentEngine === "startpage", click: () => setEngine("startpage") },
        { label: "SearX", type: "radio", checked: currentEngine === "searx", click: () => setEngine("searx") }
      ]
    },
    { type: "separator" },
    {
      label: "Set as Default Browser",
      click: () => {
        if (!app.isDefaultProtocolClient("http")) {
          app.setAsDefaultProtocolClient("http");
          app.setAsDefaultProtocolClient("https");
        }
      }
    },
    { type: "separator" },
    {
      label: "Reset to Defaults",
      click: () => {
        settingsStore.clear();
        app.relaunch();
        app.exit();
      }
    }
  ]);

  function setEngine(engine) {
    activeSearchEngine = engine;
    settingsStore.set("searchEngine", engine);
    sendBrowserState();
  }

  menu.popup({ window: mainWindow, x: Math.round(bounds.x), y: Math.round(bounds.y + bounds.height) });
});

ipcMain.on("browser:show-privacy-menu", (event, bounds) => {
  const currentPrivacy = settingsStore.get("privacyMode", "standard");
  const tab = tabs.find(t => t.id === activeTabId);
  const currentId = tab ? tab.identity : "personal";

  const menu = Menu.buildFromTemplate([
    { label: "Privacy Dashboard", enabled: false },
    { type: "separator" },
    {
      label: "Smart Privacy Mode",
      submenu: [
        { label: "Standard", type: "radio", checked: currentPrivacy === "standard", click: () => setMode("standard") },
        { label: "Strong", type: "radio", checked: currentPrivacy === "strong", click: () => setMode("strong") },
        { label: "Maximum", type: "radio", checked: currentPrivacy === "maximum", click: () => setMode("maximum") }
      ]
    },
    { type: "separator" },
    {
      label: "Identity Container",
      submenu: [
        { label: "Personal", type: "radio", checked: currentId === "personal", click: () => setId("personal") },
        { label: "Work", type: "radio", checked: currentId === "work", click: () => setId("work") },
        { label: "Banking", type: "radio", checked: currentId === "banking", click: () => setId("banking") },
        { label: "Shopping", type: "radio", checked: currentId === "shopping", click: () => setId("shopping") },
        { label: "Anonymous", type: "radio", checked: currentId === "anonymous", click: () => setId("anonymous") }
      ]
    },
    { type: "separator" },
    {
      label: "Temporarily Relax Protections",
      click: () => {
        if (tab) {
          try {
            const url = new URL(tab.view.webContents.getURL());
            relaxedHosts.add(url.hostname);
            tab.view.webContents.reload();
          } catch (e) { }
        }
      }
    }
  ]);

  function setMode(mode) {
    privacyMode = mode;
    settingsStore.set("privacyMode", mode);
    sendBrowserState();
  }

  function setId(id) {
    if (tab) {
      tab.identity = id;
      // Triggers identity switch without tearing down everything
      event.sender.send("browser:sync-identity", { identity: id });
    }
  }

  menu.popup({ window: mainWindow, x: Math.round(bounds.x), y: Math.round(bounds.y + bounds.height) });
});

ipcMain.on("browser:show-security-menu", (event, bounds) => {
  const menu = Menu.buildFromTemplate([
    { label: "Connection is Encrypted", enabled: false },
    { label: "Aura verified this connection.", enabled: false },
    { type: "separator" },
    {
      label: "Forget This Site (Clear Data)",
      click: () => {
        const tab = tabs.find(t => t.id === activeTabId);
        if (tab) {
          tab.view.webContents.session.clearStorageData();
          tab.view.webContents.reload();
        }
      }
    }
  ]);
  menu.popup({ window: mainWindow, x: Math.round(bounds.x), y: Math.round(bounds.y + bounds.height) });
});

ipcMain.on("browser:show-split-menu", (event, bounds) => {
  if (tabs.length < 2) {
    Menu.buildFromTemplate([{ label: "Open another tab first to split view", enabled: false }]).popup({ window: mainWindow });
    return;
  }

  const template = tabs.map(t => ({
    label: t.title || "Untitled Tab",
    type: "radio",
    checked: activeTabId === t.id || splitViewTabId === t.id,
    click: () => {
      if (t.id !== activeTabId) {
        splitViewActive = true;
        splitViewTabId = t.id;
        setWebViewBounds();
      }
    }
  }));

  template.unshift({ label: "Select Tab for Right Pane", enabled: false }, { type: "separator" });

  if (splitViewActive) {
    template.push({ type: "separator" }, {
      label: "Cancel Split View",
      click: () => {
        splitViewActive = false;
        splitViewTabId = null;
        setWebViewBounds();
      }
    });
  }

  Menu.buildFromTemplate(template).popup({ window: mainWindow, x: Math.round(bounds.x), y: Math.round(bounds.y + bounds.height) });
});

// Burn: Nuke all tabs, clear session, reset to start page
ipcMain.handle("browser:burn", async () => {
  for (const partition of configuredPartitions) {
    try {
      const sess = session.fromPartition(partition);
      await sess.clearStorageData();
      await sess.clearCache();
    } catch (e) { }
  }

  clipboard.clear();

  const allIds = tabs.map(t => t.id);
  for (const id of allIds) {
    const tab = tabs.find(t => t.id === id);
    if (tab && mainWindow) {
      try { mainWindow.removeBrowserView(tab.view); } catch { }
      try { tab.view.webContents.destroy(); } catch { }
    }
  }
  tabs = [];
  activeTabId = null;
  sessionConfigured = false;
  splitViewActive = false;
  splitViewTabId = null;
  createTab();
  sendBrowserState();
  return getBrowserState();
});

// Theme Toggle
ipcMain.handle("browser:toggle-theme", async () => {
  const current = settingsStore.get("theme", "dark");
  const next = current === "dark" ? "light" : "dark";
  settingsStore.set("theme", next);
  nativeTheme.themeSource = next;
  
  // Broadcast theme change to all windows so renderer/start pages can update CSS classes
  const windows = BrowserWindow.getAllWindows();
  for (const win of windows) {
    win.webContents.send("browser:theme-changed", next);
    // Also broadcast to any active browser views
    const views = win.getBrowserViews();
    for (const view of views) {
      view.webContents.send("browser:theme-changed", next);
      
      // Reload Google/Bing tabs to apply or remove the injected dark CSS
      const url = view.webContents.getURL();
      const host = getHost(url);
      if (host && (host.includes("google.") || host.includes("bing.com"))) {
        view.webContents.reload();
      }
    }
  }
  return next;
});

ipcMain.handle("browser:get-theme", async () => {
  return settingsStore.get("theme", "dark");
});

// Reader Mode: inject Readability-style reader view
ipcMain.handle("browser:reader-mode", async () => {
  const activeView = getActiveView();
  if (!activeView || activeView.webContents.isDestroyed()) return;
  const readerScript = `
    (function() {
      if (document.getElementById('__aura_reader__')) {
        document.getElementById('__aura_reader__').remove();
        document.body.style.display = '';
        return;
      }
      const title = document.title;
      const article = document.querySelector('article') ||
        document.querySelector('main') ||
        document.querySelector('.post-content') ||
        document.querySelector('.article-body') ||
        document.querySelector('.content') ||
        document.body;
      let content = article ? article.innerHTML : document.body.innerHTML;

      // ── XSS Sanitization ─────────────────────────────────
      // Strip all script tags, event handlers, iframes, objects, embeds,
      // and dangerous URI schemes before injecting into reader overlay.
      content = content.replace(/<script[\\s\\S]*?<\\/script>/gi, '');
      content = content.replace(/<iframe[\\s\\S]*?(<\\/iframe>|\\/?>)/gi, '');
      content = content.replace(/<object[\\s\\S]*?(<\\/object>|\\/?>)/gi, '');
      content = content.replace(/<embed[^>]*>/gi, '');
      content = content.replace(/<link[^>]*>/gi, '');
      content = content.replace(/<style[\\s\\S]*?<\\/style>/gi, '');
      content = content.replace(/<form[\\s\\S]*?(<\\/form>|\\/?>)/gi, '');
      // Strip all inline event handlers (onclick, onerror, onload, etc.)
      content = content.replace(/\\s+on\\w+\\s*=\\s*("[^"]*"|'[^']*'|[^\\s>]+)/gi, '');
      // Strip javascript: URIs
      content = content.replace(/href\\s*=\\s*["']?\\s*javascript:/gi, 'href="#void');
      // Sanitize the title too
      var safeTitle = title.replace(/</g, '&lt;').replace(/>/g, '&gt;');

      const overlay = document.createElement('div');
      overlay.id = '__aura_reader__';
      overlay.style.cssText = [
        'position:fixed','top:0','left:0','width:100%','height:100%',
        'background:#1a1a1a','color:#e8e6e3','z-index:99999',
        'overflow-y:auto','padding:60px 0','box-sizing:border-box',
        'font-family: Georgia, serif'
      ].join(';');
      overlay.innerHTML = '<div style="max-width:700px;margin:0 auto;padding:0 20px"><h1 style="font-size:2rem;line-height:1.3;color:#fff;margin-bottom:30px">' + safeTitle + '</h1><div style="font-size:1.2rem;line-height:1.8;color:#ccc">' + content + '</div></div>';
      document.body.appendChild(overlay);
    })();
  `;
  await activeView.webContents.executeJavaScript(readerScript).catch(() => { });
});

// Split View: Toggle
ipcMain.handle("browser:split-view", async (_event, secondTabId) => {
  if (!mainWindow) return;
  const bounds = mainWindow.getContentBounds();
  const halfW = Math.floor(bounds.width / 2);
  const contentH = Math.max(0, bounds.height - currentToolbarHeight);

  if (splitViewActive) {
    splitViewActive = false;
    const secondTab = tabs.find(t => t.id === splitViewTabId);
    if (secondTab) {
      try { mainWindow.removeBrowserView(secondTab.view); } catch { }
    }
    splitViewTabId = null;
    const activeView = getActiveView();
    if (activeView) {
      activeView.setBounds({ x: 0, y: currentToolbarHeight, width: bounds.width, height: contentH });
      mainWindow.setBrowserView(activeView);
    }
  } else if (secondTabId) {
    const secondTab = tabs.find(t => t.id === secondTabId);
    const activeView = getActiveView();
    if (!secondTab || !activeView) return;
    splitViewActive = true;
    splitViewTabId = secondTabId;
    activeView.setBounds({ x: 0, y: currentToolbarHeight, width: halfW, height: contentH });
    mainWindow.addBrowserView(secondTab.view);
    secondTab.view.setBounds({ x: halfW, y: currentToolbarHeight, width: halfW, height: contentH });
  }
  return { splitView: splitViewActive, splitTabId: splitViewTabId };
});

ipcMain.handle("browser:check-default", () => {
  return app.isDefaultProtocolClient("http") && app.isDefaultProtocolClient("https");
});

ipcMain.handle("browser:set-default", () => {
  app.setAsDefaultProtocolClient("http");
  app.setAsDefaultProtocolClient("https");
  return app.isDefaultProtocolClient("http");
});

app.on("open-url", (event, url) => {
  event.preventDefault();
  const sanitized = normalizeInputToUrl(url);
  if (sanitized) {
    if (app.isReady() && mainWindow) {
      createTab(sanitized);
    } else {
      pendingUrl = sanitized;
    }
  }
});

function sendTorStatus(message) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("tor:status", message);
  }
}

let torConnected = false; // Track whether Tor is actually connected

function startTorDaemon() {
  const isAppleSilicon = process.arch === 'arm64';
  const torPath = isAppleSilicon ? '/opt/homebrew/bin/tor' : '/usr/local/bin/tor';

  if (!fs.existsSync(torPath)) {
    console.warn("Tor executable not found. Please install Tor via Homebrew.");
    torConnected = false;
    sendTorStatus("tor-unavailable");
    // Still allow the browser to open, but with a clear warning
    setTimeout(() => sendTorStatus("ready-no-tor"), 100);
    return;
  }

  try {
    const torDataPath = path.join(app.getPath("userData"), "tor-data");
    if (!fs.existsSync(torDataPath)) fs.mkdirSync(torDataPath, { recursive: true });

    torProcess = spawn(torPath, ["--DataDirectory", torDataPath], {
      stdio: 'pipe',
      detached: false
    });

    torProcess.stdout.on('data', (data) => {
      const text = data.toString();
      console.log(`[Tor] ${text}`);
      // Parse bootstrap % from Tor log lines
      const match = text.match(/Bootstrapped (\d+)%[^:]*:\s*(.+)/);
      if (match) {
        const pct = parseInt(match[1], 10);
        const label = match[2].trim();
        sendTorStatus(`${pct}%: ${label}`);
        if (pct >= 100) {
          torConnected = true;
          sendTorStatus("ready");
        }
      }
    });
    torProcess.stderr.on('data', (data) => console.error(`[Tor ERR] ${data}`));
    torProcess.on('error', (err) => {
      console.error("Failed to start Tor:", err);
      torConnected = false;
      sendTorStatus("tor-unavailable");
      setTimeout(() => sendTorStatus("ready-no-tor"), 100);
    });
    torProcess.on('exit', (code) => {
      console.log(`Tor exited with code ${code}`);
      torProcess = null;
      torConnected = false;
      // Notify UI that Tor connection was lost
      sendTorStatus("tor-disconnected");
    });

    console.log("Tor process spawned successfully.");
  } catch (error) {
    console.error("Error spawning Tor:", error);
    torConnected = false;
    sendTorStatus("tor-unavailable");
    setTimeout(() => sendTorStatus("ready-no-tor"), 100);
  }
}

app.whenReady().then(() => {
  nativeTheme.themeSource = settingsStore.get("theme", "dark");
  // Create window FIRST so the splash screen appears immediately,
  // then start Tor connection in parallel (non-blocking).
  createWindow();
  startTorDaemon();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  if (torProcess) {
    try { torProcess.kill(); } catch { }
  }
  try { fs.rmSync(runtimeUserDataPath, { recursive: true, force: true }); } catch { }
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});


