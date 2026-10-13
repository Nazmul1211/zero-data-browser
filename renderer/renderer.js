// ── DOM REFS ──────────────────────────────────────────────
const addressInput        = document.getElementById("addressInput");
const backButton          = document.getElementById("backButton");
const forwardButton       = document.getElementById("forwardButton");
const reloadButton        = document.getElementById("reloadButton");
const homeButton          = document.getElementById("homeButton");
const readerModeBtn       = document.getElementById("readerModeBtn");

const settingsToggleBtn   = document.getElementById("settingsToggleBtn");
const securityIndicator   = document.getElementById("securityIndicator");
const privacyShieldBtn    = document.getElementById("privacyShieldBtn");

const downloadToast       = document.getElementById("downloadToast");
const dlFilename          = document.getElementById("dlFilename");
const dlBar               = document.getElementById("dlBar");
const dlStatus            = document.getElementById("dlStatus");
const dlIcon              = document.getElementById("dlIcon");

const captchaToast        = document.getElementById("captchaToast");
const captchaSwitchBtn    = document.getElementById("captchaSwitchBtn");

const tabsContainer       = document.getElementById("tabsContainer");
const newTabBtn           = document.getElementById("newTabBtn");

const identityBadge       = document.getElementById("identityBadge");

const permissionPrompt    = document.getElementById("permissionPrompt");
const permTitle           = document.getElementById("permTitle");
const permDesc            = document.getElementById("permDesc");
const permAllow           = document.getElementById("permAllow");
const permDeny            = document.getElementById("permDeny");

const splitViewBtn        = document.getElementById("splitViewBtn");

const burnBtn             = document.getElementById("burnBtn");
const burnOverlay         = document.getElementById("burnOverlay");
const burnConfirm         = document.getElementById("burnConfirm");
const burnCancel          = document.getElementById("burnCancel");
const burnFlash           = document.getElementById("burnFlash");

const torSplash           = document.getElementById("torSplash");
const torStatusText       = document.getElementById("torStatusText");
const privacyModeSelector = document.getElementById("privacyModeSelector");

const TOOLBAR_BASE_HEIGHT = 98;
const TOOLBAR_PANEL_HEIGHT = 560;
const TOOLBAR_SECURITY_HEIGHT = 360;

// ── LOCAL STATE ───────────────────────────────────────────
let currentTabs   = [];
let splitActive   = false;
let readerActive  = false;
let settingsOpen  = false;
let privacyOpen   = false;
let securityOpen  = false;
let currentPermissionReq = null;
let trackersBlockedCount = 0;
let lastTrackedUrl = "";
let currentPrivacyMode = "standard";

// ── HELPERS ───────────────────────────────────────────────
function updateIdentityUI(val) {
  if (!identityBadge) return;
  
  const identities = {
    personal: "👤 Personal",
    work: "💼 Work",
    banking: "🏦 Banking",
    shopping: "🛒 Shopping",
    anonymous: "🕵️ Anonymous"
  };
  
  const text = identities[val] || val;
  const iconMatch = text.match(/^([\uD800-\uDBFF][\uDC00-\uDFFF]|\S)\s+(.*)/);
  
  if (iconMatch) {
    identityBadge.querySelector(".id-icon").textContent = iconMatch[1];
    identityBadge.querySelector(".id-text").textContent = iconMatch[2];
  } else {
    identityBadge.querySelector(".id-text").textContent = val;
  }
  
  identityBadge.style.background = val === "anonymous" ? "rgba(239, 68, 68, 0.16)" : "rgba(45, 212, 191, 0.11)";
  identityBadge.style.borderColor = val === "anonymous" ? "rgba(239, 68, 68, 0.35)" : "rgba(45, 212, 191, 0.2)";
  identityBadge.style.color = val === "anonymous" ? "#fecaca" : "#ccfbf1";
}

// ── TAB RENDERING ─────────────────────────────────────────
function renderTabs(tabs) {
  Array.from(tabsContainer.children).forEach(c => {
    if (c !== newTabBtn) c.remove();
  });
  tabs.forEach(tab => {
    const el = document.createElement("div");
    el.className = `tab ${tab.isActive ? "active" : ""}`;

    const title = document.createElement("span");
    title.className = "tab-title";
    title.textContent = tab.title || "New Tab";

    const close = document.createElement("button");
    close.className = "close-tab-btn";
    close.innerHTML = "×";
    close.title = "Close tab";
    close.addEventListener("click", async e => {
      e.stopPropagation();
      await window.auraAPI.closeTab(tab.id);
    });

    el.appendChild(title);
    el.appendChild(close);
    el.addEventListener("click", async () => {
      if (!tab.isActive) await window.auraAPI.switchTab(tab.id);
    });
    tabsContainer.insertBefore(el, newTabBtn);
  });
}

// ── STATE UPDATE ──────────────────────────────────────────
function updateState(state) {
  if (!state) return;

  backButton.disabled    = !state.canGoBack;
  forwardButton.disabled = !state.canGoForward;

  if (state.url && document.activeElement !== addressInput) {
    // Don't show the local start page path in the address bar
    addressInput.value = (state.url.startsWith("file://") || state.url === "about:blank") ? "" : state.url;
    addressInput.placeholder = (state.url.startsWith("file://") || state.url === "about:blank")
      ? "Search or enter web address  (⌘K)"
      : state.url;
  }

  if (state.tabs) {
    currentTabs = state.tabs;
    renderTabs(state.tabs);
    
    const activeTab = state.tabs.find(t => t.isActive);
    if (activeTab) {
      updateIdentityUI(activeTab.identity || "personal");
      if (activeTab.url !== lastTrackedUrl) {
         lastTrackedUrl = activeTab.url;
      }
    }
  }
}

// ── NAVIGATION ────────────────────────────────────────────
async function goFromInput() {
  const value = addressInput.value.trim();
  if (!value) return;
  await window.auraAPI.go(value);
}

addressInput.addEventListener("keydown", async e => {
  if (e.key === "Enter") await goFromInput();
});
backButton.addEventListener("click",    () => window.auraAPI.action("back"));
forwardButton.addEventListener("click", () => window.auraAPI.action("forward"));
reloadButton.addEventListener("click",  () => window.auraAPI.action("reload"));
homeButton.addEventListener("click",    () => window.auraAPI.action("home"));
newTabBtn.addEventListener("click",     () => window.auraAPI.newTab());

// ── DELETED DOM PANEL LOGIC REMOVED ─────────────────────────

// ── PERMISSIONS LOGIC ──────────────────────────────────────
window.auraAPI.onAskPermission(({ id, origin, permission }) => {
  currentPermissionReq = { id, origin, permission };
  permTitle.textContent = origin;
  permDesc.textContent = permission;
  permissionPrompt.classList.remove("hidden");
});

function answerPermission(action) {
  if (currentPermissionReq) {
    window.auraAPI.answerPermission({ ...currentPermissionReq, action });
    currentPermissionReq = null;
  }
  permissionPrompt.classList.add("hidden");
}

if (permAllow) permAllow.addEventListener("click", () => answerPermission("allow"));
if (permDeny) permDeny.addEventListener("click", () => answerPermission("deny"));

// ── DOWNLOADS LOGIC ────────────────────────────────────────
window.auraAPI.onDownloadStarted((payload) => {
  const { filename, isExecutable, totalBytes } = payload;
  dlFilename.textContent = filename;
  dlBar.style.width = "0%";
  dlBar.style.background = "#3b82f6";
  
  if (isExecutable) {
    dlIcon.textContent = "⚠️";
    dlStatus.innerHTML = "<span class='dl-warning'>Executable file detected!</span>";
    dlIcon.style.background = "rgba(251, 191, 36, 0.15)";
  } else {
    dlIcon.textContent = "⬇️";
    dlStatus.textContent = "Starting...";
    dlIcon.style.background = "rgba(59, 130, 246, 0.15)";
  }
  
  downloadToast.classList.remove("hidden");
});

window.auraAPI.onDownloadUpdated((payload) => {
  const { receivedBytes, totalBytes } = payload;
  if (totalBytes > 0) {
    const percent = Math.floor((receivedBytes / totalBytes) * 100);
    dlBar.style.width = `${percent}%`;
    if (!dlStatus.querySelector('.dl-warning')) {
      dlStatus.textContent = `${percent}% - ${Math.round(receivedBytes / 1024 / 1024)} MB`;
    }
  }
});

window.auraAPI.onDownloadDone((payload) => {
  const { state } = payload;
  if (state === "completed") {
    dlBar.style.width = "100%";
    dlBar.style.background = "#10b981"; // success green
    if (!dlStatus.querySelector('.dl-warning')) dlStatus.textContent = "Completed";
  } else {
    dlBar.style.background = "#ef4444"; // error red
    dlStatus.textContent = `Failed: ${state}`;
  }
  
  setTimeout(() => {
    downloadToast.classList.add("hidden");
    setTimeout(() => { dlBar.style.background = "#3b82f6"; }, 300);
  }, 4000);
});

// ── CAPTCHA LOGIC ──────────────────────────────────────────
window.auraAPI.onCaptchaDetected((payload) => {
  if (captchaToast) {
    captchaToast.classList.remove("hidden");
  }
});

if (captchaSwitchBtn) {
  captchaSwitchBtn.addEventListener("click", async () => {
    captchaSwitchBtn.textContent = "Switching...";
    const nextIdentity = (identitySelect.value === "anonymous") ? "personal" : "anonymous";
    await window.auraAPI.setIdentityContainer(nextIdentity);
    captchaToast.classList.add("hidden");
    captchaSwitchBtn.textContent = "Switch Identity";
  });
}

// ── NATIVE MENUS ───────────────────────────────────────────
settingsToggleBtn.addEventListener("click", () => {
  const rect = settingsToggleBtn.getBoundingClientRect();
  window.auraAPI.showSettingsMenu({ x: rect.left, y: rect.top, width: rect.width, height: rect.height });
});

privacyShieldBtn.addEventListener("click", () => {
  const rect = privacyShieldBtn.getBoundingClientRect();
  window.auraAPI.showPrivacyMenu({ x: rect.left, y: rect.top, width: rect.width, height: rect.height });
});

securityIndicator.addEventListener("click", () => {
  const rect = securityIndicator.getBoundingClientRect();
  window.auraAPI.showSecurityMenu({ x: rect.left, y: rect.top, width: rect.width, height: rect.height });
});

if (splitViewBtn) {
  splitViewBtn.addEventListener("click", () => {
    const rect = splitViewBtn.getBoundingClientRect();
    window.auraAPI.showSplitMenu({ x: rect.left, y: rect.top, width: rect.width, height: rect.height });
  });
}

// ── 🔥 BURN BUTTON ────────────────────────────────────────
if (burnBtn) {
  burnBtn.addEventListener("click", e => {
    e.stopPropagation();
    if (burnOverlay) burnOverlay.classList.remove("hidden");
  });
}

if (burnCancel) {
  burnCancel.addEventListener("click", () => {
    burnOverlay.classList.add("hidden");
  });
}

if (burnConfirm) {
  burnConfirm.addEventListener("click", async () => {
    burnOverlay.classList.add("hidden");
    if (burnFlash) burnFlash.classList.add("visible");
    await window.auraAPI.burn();
    splitActive  = false;
    readerActive = false;
    if (readerModeBtn) readerModeBtn.classList.remove("active");
    if (splitViewBtn) splitViewBtn.classList.remove("active");
    setTimeout(() => {
      if (burnFlash) burnFlash.classList.remove("visible");
    }, 400);
  });
}

// ── 📖 READER MODE ────────────────────────────────────────
if (readerModeBtn) {
  readerModeBtn.addEventListener("click", async () => {
    readerActive = !readerActive;
    readerModeBtn.classList.toggle("active", readerActive);
    readerModeBtn.title = readerActive ? "Exit Reader Mode" : "Toggle Reader Mode";
    await window.auraAPI.readerMode();
  });
}

// ── ADDRESS BAR INTERACTION ─────────────────────────────────
addressInput.addEventListener("mousedown", e => {
  e.stopPropagation();
});

document.addEventListener("keydown", e => {
  if ((e.metaKey || e.ctrlKey) && (e.key === "k" || e.key === "l")) {
    e.preventDefault();
    addressInput.focus();
    addressInput.select();
  }
  if (e.key === "Escape") {
    if (burnOverlay) burnOverlay.classList.add("hidden");
    addressInput.blur();
  }
});

// ── TOR STATUS SPLASH ────────────────────────────────────
let torWarningBanner = null;

function showTorWarning(message) {
  if (!torWarningBanner) {
    torWarningBanner = document.createElement("div");
    torWarningBanner.id = "torWarningBanner";
    torWarningBanner.style.cssText = [
      "position:fixed", "top:0", "left:0", "right:0", "z-index:99999",
      "background:#dc2626", "color:#fff", "text-align:center",
      "padding:6px 16px", "font-size:12px", "font-weight:600",
      "font-family:-apple-system,BlinkMacSystemFont,sans-serif",
      "letter-spacing:0.02em",
      "box-shadow:0 2px 8px rgba(220,38,38,0.4)",
    ].join(";");
    document.body.appendChild(torWarningBanner);
  }
  torWarningBanner.textContent = message;
  torWarningBanner.classList.remove("hidden");
}

function hideTorWarning() {
  if (torWarningBanner) torWarningBanner.classList.add("hidden");
}

window.auraAPI.onTorStatus(status => {
  if (status === "ready") {
    // Tor is fully connected — all good
    hideTorWarning();
    if (torStatusText) torStatusText.textContent = "✅ Secure tunnel established!";
    if (torSplash) setTimeout(() => torSplash.classList.add("hidden"), 600);
  } else if (status === "tor-unavailable" || status === "tor-disconnected") {
    showTorWarning("⚠ WARNING: Tor is not connected. Your traffic is NOT routed through a secure tunnel.");
  } else if (status === "ready-no-tor") {
    // Let the splash close, but keep the warning banner
    if (torStatusText) torStatusText.textContent = "⚠ Tor unavailable — running without secure tunnel";
    if (torSplash) setTimeout(() => torSplash.classList.add("hidden"), 1200);
  } else {
    if (torStatusText) torStatusText.textContent = status;
  }
});

// ── STATE SUBSCRIPTIONS ───────────────────────────────────
window.auraAPI.onState(state => updateState(state));
window.auraAPI.onBlocked(blocked => {
  console.log(`[Aura] Blocked — ${blocked.reason}: ${blocked.url}`);
});
window.auraAPI.getState().then(state => updateState(state));

// ── THEME INITIALIZATION ──────────────────────────────────
if (window.auraAPI.getTheme) {
  window.auraAPI.getTheme().then(theme => {
    document.documentElement.classList.toggle("theme-light", theme === "light");
  });
}

if (window.auraAPI.onThemeChanged) {
  window.auraAPI.onThemeChanged(theme => {
    document.documentElement.classList.toggle("theme-light", theme === "light");
  });
}

