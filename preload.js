const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("auraAPI", {
  getState: () => ipcRenderer.invoke("browser:get-state"),
  go: (value) => ipcRenderer.invoke("browser:go", value),
  search: (query) => ipcRenderer.invoke("browser:search", query),
  action: (name) => ipcRenderer.invoke("browser:action", name),
  setSearchEngine: (payload) => ipcRenderer.invoke("browser:set-search-engine", payload),
  setPrivacyMode: (mode) => ipcRenderer.invoke("browser:set-privacy-mode", mode),
  relaxPrivacyForCurrentSite: () => ipcRenderer.invoke("browser:relax-privacy"),
  setIdentityContainer: (identity) => ipcRenderer.invoke("browser:set-identity", identity),
  forgetSite: () => ipcRenderer.invoke("browser:forget-site"),
  
  // Tab Management
  newTab: () => ipcRenderer.invoke("browser:new-tab"),
  switchTab: (id) => ipcRenderer.invoke("browser:switch-tab", id),
  closeTab: (id) => ipcRenderer.invoke("browser:close-tab", id),
  checkDefaultBrowser: () => ipcRenderer.invoke("browser:check-default"),
  setDefaultBrowser: () => ipcRenderer.invoke("browser:set-default"),
  burn: () => ipcRenderer.invoke("browser:burn"),
  toggleTheme: () => ipcRenderer.invoke("browser:toggle-theme"),
  getTheme: () => ipcRenderer.invoke("browser:get-theme"),
  readerMode: () => ipcRenderer.invoke("browser:reader-mode"),
  splitView: (secondTabId) => ipcRenderer.invoke("browser:split-view", secondTabId),
  getSearchUrl: (query) => ipcRenderer.invoke("browser:get-search-url", query),
  setToolbarHeight: (h) => ipcRenderer.invoke("browser:set-toolbar-height", h),
  purgeSettings: () => ipcRenderer.invoke("browser:purge-settings"),
  
  showSettingsMenu: (bounds) => ipcRenderer.send("browser:show-settings-menu", bounds),
  showPrivacyMenu: (bounds) => ipcRenderer.send("browser:show-privacy-menu", bounds),
  showSecurityMenu: (bounds) => ipcRenderer.send("browser:show-security-menu", bounds),
  showSplitMenu: (bounds) => ipcRenderer.send("browser:show-split-menu", bounds),

  onState: (handler) => {
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on("browser:state", listener);
    return () => ipcRenderer.removeListener("browser:state", listener);
  },
  onBlocked: (handler) => {
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on("browser:blocked", listener);
    return () => ipcRenderer.removeListener("browser:blocked", listener);
  },
  onTorStatus: (handler) => {
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on("tor:status", listener);
    return () => ipcRenderer.removeListener("tor:status", listener);
  },
  onAskPermission: (handler) => {
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on("browser:ask-permission", listener);
    return () => ipcRenderer.removeListener("browser:ask-permission", listener);
  },
  answerPermission: (payload) => ipcRenderer.send("browser:answer-permission", payload),

  onDownloadStarted: (handler) => {
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on("browser:download-started", listener);
    return () => ipcRenderer.removeListener("browser:download-started", listener);
  },
  onDownloadUpdated: (handler) => {
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on("browser:download-updated", listener);
    return () => ipcRenderer.removeListener("browser:download-updated", listener);
  },
  onDownloadDone: (handler) => {
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on("browser:download-done", listener);
    return () => ipcRenderer.removeListener("browser:download-done", listener);
  },

  onCaptchaDetected: (handler) => {
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on("browser:captcha-detected", listener);
    return () => ipcRenderer.removeListener("browser:captcha-detected", listener);
  },
  onThemeChanged: (handler) => {
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on("browser:theme-changed", listener);
    return () => ipcRenderer.removeListener("browser:theme-changed", listener);
  },
});
