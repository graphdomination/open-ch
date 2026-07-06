/**
 * Popup Script - Settings Handling, Auth UI & Chrome Storage Integration
 *
 * This script manages the extension popup UI, loading and saving settings
 * to chrome.storage.local, rendering auth state, and handling sign out.
 */
// Debug logging (Terser replaces _D with false in production builds)
var _D = true;

var _log = _D ? console.log.bind(console) : () => {};

// Default settings
const DEFAULT_SETTINGS = {
  extensionEnabled: true,
  analysisEnabled: true,
  depth: 15,
  autoplayEnabled: false,
  autoplayDelay: 1e3,
  autoplayDelayMin: 500,
  autoplayDelayMax: 2e3,
  autoplayVariationEnabled: true,
  antidetectEnabled: false,
  antidetectIntervalMin: 5,
  antidetectIntervalMax: 6
};

// DOM element references (populated on DOMContentLoaded)
let elements = {};

/**
 * Initialize DOM element references
 */ function initElements() {
  elements = {
    // Global controls
    popupContainer: document.querySelector(".popup-container"),
    enabledToggle: document.getElementById("enabled-toggle"),
    // Auth sections
    authLoading: document.getElementById("auth-loading"),
    authAnonymous: document.getElementById("auth-anonymous"),
    authFree: document.getElementById("auth-free"),
    authPro: document.getElementById("auth-pro"),
    // Anonymous elements
    anonUsageText: document.getElementById("anon-usage-text"),
    anonProgressBar: document.getElementById("anon-progress-bar"),
    signupBtn: document.getElementById("signup-btn"),
    connectToggleBtn: document.getElementById("connect-toggle-btn"),
    connectTokenSection: document.getElementById("connect-token-section"),
    tokenInput: document.getElementById("token-input"),
    connectBtn: document.getElementById("connect-btn"),
    connectError: document.getElementById("connect-error"),
    adminBtn: document.getElementById("admin-btn"),
    // Free tier elements
    freeUserName: document.getElementById("free-user-name"),
    freeDailyText: document.getElementById("free-daily-text"),
    freeDailyBar: document.getElementById("free-daily-bar"),
    freeWeeklyText: document.getElementById("free-weekly-text"),
    freeWeeklyBar: document.getElementById("free-weekly-bar"),
    upgradeBtn: document.getElementById("upgrade-btn"),
    // Pro tier elements
    proUserName: document.getElementById("pro-user-name"),
    // Account footer
    accountFooter: document.getElementById("account-footer"),
    accountEmail: document.getElementById("account-email"),
    signoutBtn: document.getElementById("signout-btn"),
    // Settings elements
    analysisToggle: document.getElementById("analysis-toggle"),
    depthInput: document.getElementById("depth-input"),
    depthValue: document.getElementById("depth-value"),
    autoplayToggle: document.getElementById("autoplay-toggle"),
    variationToggle: document.getElementById("variation-toggle"),
    delayInput: document.getElementById("delay-input"),
    delayValue: document.getElementById("delay-value"),
    delayMinInput: document.getElementById("delay-min-input"),
    delayMinValue: document.getElementById("delay-min-value"),
    delayMaxInput: document.getElementById("delay-max-input"),
    delayMaxValue: document.getElementById("delay-max-value"),
    delayMinSection: document.getElementById("delay-min-section"),
    delayMaxSection: document.getElementById("delay-max-section"),
    delayFixedSection: document.getElementById("delay-fixed-section"),
    antidetectToggle: document.getElementById("antidetect-toggle"),
    antidetectMinInput: document.getElementById("antidetect-min-input"),
    antidetectMinValue: document.getElementById("antidetect-min-value"),
    antidetectMaxInput: document.getElementById("antidetect-max-input"),
    antidetectMaxValue: document.getElementById("antidetect-max-value"),
    statusDot: document.querySelector(".status-dot"),
    statusText: document.querySelector(".status-text"),
    statusIndicator: document.getElementById("status"),
    domHealth: document.getElementById("dom-health"),
    domHealthDot: document.getElementById("dom-health-dot"),
    domHealthText: document.getElementById("dom-health-text")
  };
}

// ============================================================
// Auth UI Rendering
// ============================================================
/**
 * Hide all auth sections
 */ function hideAllAuthSections() {
  if (elements.authLoading) elements.authLoading.style.display = "none";
  if (elements.authAnonymous) elements.authAnonymous.style.display = "none";
  if (elements.authFree) elements.authFree.style.display = "none";
  if (elements.authPro) elements.authPro.style.display = "none";
}

/**
 * Get the base URL for links
 * @returns {Promise<string>}
 */ async function getBaseUrl() {
  // Config.js is loaded before popup.js — use it as the source of truth
  if (globalThis._cfg?.APP_URL) return globalThis._cfg.APP_URL;
  const {apiBaseUrl: apiBaseUrl} = await chrome.storage.local.get("apiBaseUrl");
  if (apiBaseUrl) return apiBaseUrl;
  // Ask the service worker for the config-based URL
    try {
    const response = await chrome.runtime.sendMessage({
      type: "GET_BASE_URL"
    });
    if (response?.baseUrl) return response.baseUrl;
  } catch {/* service worker unavailable */}
  return "https://chesshelper.ai";
}

/**
 * Get the usage color class based on percentage
 * @param {number} pct - Usage percentage (0-100)
 * @returns {string} CSS class name
 */ function getUsageColor(pct) {
  if (pct > 90) return "progress-red";
  if (pct > 70) return "progress-yellow";
  return "progress-green";
}

/**
 * Render the anonymous (not signed in) state
 * @param {number} anonymousGamesCount - Number of anonymous games used
 */ async function renderAnonymousState(anonymousGamesCount) {
  hideAllAuthSections();
  if (elements.authAnonymous) elements.authAnonymous.style.display = "";
  const used = anonymousGamesCount || 0;
  const total = 3;
  const pct = Math.min(100, Math.round(used / total * 100));
  if (elements.anonUsageText) {
    elements.anonUsageText.textContent = `${used} / ${total} games used`;
  }
  if (elements.anonProgressBar) {
    elements.anonProgressBar.style.width = `${pct}%`;
    elements.anonProgressBar.className = `progress-bar ${getUsageColor(pct)}`;
  }
  const baseUrl = await getBaseUrl();
  const signupUrl = `${baseUrl}/register?callbackUrl=%2Fextension%2Fconnect`;
  if (elements.signupBtn) {
    elements.signupBtn.href = signupUrl;
    // Intercept click to track game tab before opening signup
        elements.signupBtn.addEventListener("click", e => {
      e.preventDefault();
      chrome.runtime.sendMessage({
        type: "OPEN_AUTH_TAB",
        url: signupUrl
      });
    });
  }
  // Show status indicator, hide account footer
    if (elements.statusIndicator) elements.statusIndicator.style.display = "";
  if (elements.accountFooter) elements.accountFooter.style.display = "none";
}

/**
 * Render the free tier state
 * @param {Object} profile - User profile data
 */ async function renderFreeState(profile) {
  hideAllAuthSections();
  if (elements.authFree) elements.authFree.style.display = "";
  const name = profile.name || profile.email || "User";
  if (elements.freeUserName) {
    elements.freeUserName.textContent = name;
  }
  // Usage data
    const usage = profile.usage || {};
  const daily = usage.daily || {
    used: 0,
    limit: 3
  };
  const weekly = usage.weekly || {
    used: 0,
    limit: 10
  };
  const dailyPct = Math.min(100, Math.round(daily.used / daily.limit * 100));
  const weeklyPct = Math.min(100, Math.round(weekly.used / weekly.limit * 100));
  if (elements.freeDailyText) {
    elements.freeDailyText.textContent = `${daily.used} / ${daily.limit}`;
  }
  if (elements.freeDailyBar) {
    elements.freeDailyBar.style.width = `${dailyPct}%`;
    elements.freeDailyBar.className = `progress-bar ${getUsageColor(dailyPct)}`;
  }
  if (elements.freeWeeklyText) {
    elements.freeWeeklyText.textContent = `${weekly.used} / ${weekly.limit}`;
  }
  if (elements.freeWeeklyBar) {
    elements.freeWeeklyBar.style.width = `${weeklyPct}%`;
    elements.freeWeeklyBar.className = `progress-bar ${getUsageColor(weeklyPct)}`;
  }
  const baseUrl = await getBaseUrl();
  if (elements.upgradeBtn) {
    elements.upgradeBtn.href = `${baseUrl}/pricing`;
  }
  // Show account footer
    renderAccountFooter(profile);
}

/**
 * Render the pro tier state
 * @param {Object} profile - User profile data
 */ function renderProState(profile) {
  hideAllAuthSections();
  if (elements.authPro) elements.authPro.style.display = "";
  const name = profile.name || profile.email || "User";
  if (elements.proUserName) {
    elements.proUserName.textContent = name;
  }
  // Show account footer
    renderAccountFooter(profile);
}

/**
 * Render the account footer (email + sign out)
 * @param {Object} profile - User profile data
 */ function renderAccountFooter(profile) {
  if (elements.accountFooter) elements.accountFooter.style.display = "";
  if (elements.statusIndicator) elements.statusIndicator.style.display = "none";
  if (elements.accountEmail) {
    elements.accountEmail.textContent = profile.email || "";
  }
}

/**
 * Render the popup based on auth state
 */ async function renderAuthState() {
  // Show loading first
  hideAllAuthSections();
  if (elements.authLoading) elements.authLoading.style.display = "";
  try {
    // Get cached auth state immediately
    const authState = await chrome.runtime.sendMessage({
      type: "GET_AUTH_STATE"
    });
    if (authState.authenticated && authState.profile) {
      const profile = authState.profile;
      const tier = profile.subscriptionTier || profile.tier || "free";
      if (tier === "pro" || tier === "premium") {
        renderProState(profile);
      } else {
        await renderFreeState(profile);
      }
      // Refresh profile in background (force: true to get fresh usage data)
            chrome.runtime.sendMessage({
        type: "FETCH_PROFILE",
        force: true
      }).then(response => {
        if (response?.profile) {
          const freshTier = response.profile.subscriptionTier || response.profile.tier || "free";
          if (freshTier === "pro" || freshTier === "premium") {
            renderProState(response.profile);
          } else {
            renderFreeState(response.profile);
          }
        }
      }).catch(() => {});
    } else {
      await renderAnonymousState(authState.anonymousGamesCount);
    }
  } catch {
    // Fallback to anonymous state — try to read actual count from storage
    const {anonymousGamesCount: anonymousGamesCount = 0} = await chrome.storage.local.get("anonymousGamesCount");
    await renderAnonymousState(anonymousGamesCount);
  }
}

/**
 * Handle sign out
 */ async function handleSignOut() {
  await chrome.runtime.sendMessage({
    type: "CLEAR_TOKEN"
  });
  await renderAnonymousState(0);
}

/**
 * Handle manual token connect
 */ async function handleManualConnect() {
  const token = elements.tokenInput?.value?.trim();
  if (elements.connectError) elements.connectError.textContent = "";
  if (!token) {
    if (elements.connectError) elements.connectError.textContent = "Please paste your token";
    return;
  }
  if (!token.startsWith("chext_")) {
    if (elements.connectError) elements.connectError.textContent = "Invalid token format (should start with chext_)";
    return;
  }
  // Disable UI while connecting
    if (elements.connectBtn) elements.connectBtn.disabled = true;
  if (elements.connectBtn) elements.connectBtn.textContent = "...";
  try {
    const response = await chrome.runtime.sendMessage({
      type: "SET_EXTENSION_TOKEN",
      token: token
    });
    if (response?.success) {
      // Token set successfully — re-render as authenticated
      await renderAuthState();
    } else {
      if (elements.connectError) elements.connectError.textContent = "Failed to connect. Try again.";
    }
  } catch {
    if (elements.connectError) elements.connectError.textContent = "Connection error. Try again.";
  } finally {
    if (elements.connectBtn) {
      elements.connectBtn.disabled = false;
      elements.connectBtn.textContent = "Connect";
    }
  }
}

// ============================================================
// Settings Management
// ============================================================
/**
 * Load settings from chrome.storage.local
 * @returns {Promise<Object>} Settings object
 */ async function loadSettings() {
  try {
    const result = await chrome.storage.local.get([ "extensionEnabled", "analysisEnabled", "depth", "autoplayEnabled", "autoplayDelay", "autoplayDelayMin", "autoplayDelayMax", "autoplayVariationEnabled", "antidetectEnabled", "antidetectIntervalMin", "antidetectIntervalMax" ]);
    // Merge with defaults for any missing values
        return {
      extensionEnabled: result.extensionEnabled !== undefined ? result.extensionEnabled : DEFAULT_SETTINGS.extensionEnabled,
      analysisEnabled: result.analysisEnabled !== undefined ? result.analysisEnabled : DEFAULT_SETTINGS.analysisEnabled,
      depth: result.depth !== undefined ? result.depth : DEFAULT_SETTINGS.depth,
      autoplayEnabled: result.autoplayEnabled !== undefined ? result.autoplayEnabled : DEFAULT_SETTINGS.autoplayEnabled,
      autoplayDelay: result.autoplayDelay !== undefined ? result.autoplayDelay : DEFAULT_SETTINGS.autoplayDelay,
      autoplayDelayMin: result.autoplayDelayMin !== undefined ? result.autoplayDelayMin : DEFAULT_SETTINGS.autoplayDelayMin,
      autoplayDelayMax: result.autoplayDelayMax !== undefined ? result.autoplayDelayMax : DEFAULT_SETTINGS.autoplayDelayMax,
      autoplayVariationEnabled: result.autoplayVariationEnabled !== undefined ? result.autoplayVariationEnabled : DEFAULT_SETTINGS.autoplayVariationEnabled,
      antidetectEnabled: result.antidetectEnabled !== undefined ? result.antidetectEnabled : DEFAULT_SETTINGS.antidetectEnabled,
      antidetectIntervalMin: result.antidetectIntervalMin !== undefined ? result.antidetectIntervalMin : DEFAULT_SETTINGS.antidetectIntervalMin,
      antidetectIntervalMax: result.antidetectIntervalMax !== undefined ? result.antidetectIntervalMax : DEFAULT_SETTINGS.antidetectIntervalMax
    };
  } catch (error) {
    // Return defaults if storage access fails
    return {
      ...DEFAULT_SETTINGS
    };
  }
}

/**
 * Convert engine depth (1-20) to approximate ELO rating
 * @param {number} depth - Engine depth (1-20)
 * @returns {string} Approximate ELO string (e.g., "~2600")
 */ function depthToElo(depth) {
  const eloMap = {
    1: 800,
    2: 1e3,
    3: 1200,
    4: 1350,
    5: 1500,
    6: 1600,
    7: 1700,
    8: 1800,
    9: 1900,
    10: 2e3,
    11: 2100,
    12: 2200,
    13: 2350,
    14: 2500,
    15: 2600,
    16: 2700,
    17: 2800,
    18: 2900,
    19: 3e3,
    20: 3200
  };
  return "~" + (eloMap[depth] || 2600);
}

/**
 * Save a setting to chrome.storage.local
 * @param {string} key - Setting key
 * @param {*} value - Setting value
 */ async function saveSetting(key, value) {
  try {
    await chrome.storage.local.set({
      [key]: value
    });
    updateStatus("Saved", "success");
  } catch (error) {
    updateStatus("Error saving", "error");
  }
}

/**
 * Update the UI to reflect current settings
 * @param {Object} settings - Current settings object
 */ function updateSettingsUI(settings) {
  // Extension enabled toggle
  if (elements.enabledToggle) {
    elements.enabledToggle.checked = settings.extensionEnabled;
  }
  // Apply disabled state to popup
    if (elements.popupContainer) {
    elements.popupContainer.classList.toggle("popup-disabled", !settings.extensionEnabled);
  }
  // Analysis toggle
    if (elements.analysisToggle) {
    elements.analysisToggle.checked = settings.analysisEnabled;
  }
  // Depth slider and value
    if (elements.depthInput) {
    elements.depthInput.value = settings.depth;
  }
  if (elements.depthValue) {
    elements.depthValue.textContent = depthToElo(settings.depth);
  }
  // Autoplay toggle
    if (elements.autoplayToggle) {
    elements.autoplayToggle.checked = settings.autoplayEnabled;
  }
  // Variation toggle
    if (elements.variationToggle) {
    elements.variationToggle.checked = settings.autoplayVariationEnabled;
  }
  // Variation settings visibility
    updateVariationSettingsVisibility(settings.autoplayVariationEnabled);
  // Fixed delay slider and value
    if (elements.delayInput) {
    elements.delayInput.value = settings.autoplayDelay;
  }
  if (elements.delayValue) {
    elements.delayValue.textContent = `${settings.autoplayDelay}ms`;
  }
  // Min delay slider and value
    if (elements.delayMinInput) {
    elements.delayMinInput.value = settings.autoplayDelayMin;
  }
  if (elements.delayMinValue) {
    elements.delayMinValue.textContent = `${settings.autoplayDelayMin}ms`;
  }
  // Max delay slider and value
    if (elements.delayMaxInput) {
    elements.delayMaxInput.value = settings.autoplayDelayMax;
  }
  if (elements.delayMaxValue) {
    elements.delayMaxValue.textContent = `${settings.autoplayDelayMax}ms`;
  }
  // Antidetect toggle
    if (elements.antidetectToggle) {
    elements.antidetectToggle.checked = settings.antidetectEnabled;
  }
  // Antidetect interval sliders
    if (elements.antidetectMinInput) {
    elements.antidetectMinInput.value = settings.antidetectIntervalMin;
  }
  if (elements.antidetectMinValue) {
    elements.antidetectMinValue.textContent = settings.antidetectIntervalMin;
  }
  if (elements.antidetectMaxInput) {
    elements.antidetectMaxInput.value = settings.antidetectIntervalMax;
  }
  if (elements.antidetectMaxValue) {
    elements.antidetectMaxValue.textContent = settings.antidetectIntervalMax;
  }
}

/**
 * Show/hide variation-specific settings (min/max vs fixed delay)
 * @param {boolean} variationEnabled - Whether time variation is enabled
 */ function updateVariationSettingsVisibility(variationEnabled) {
  if (elements.delayMinSection) {
    elements.delayMinSection.style.display = variationEnabled ? "block" : "none";
  }
  if (elements.delayMaxSection) {
    elements.delayMaxSection.style.display = variationEnabled ? "block" : "none";
  }
  if (elements.delayFixedSection) {
    elements.delayFixedSection.style.display = variationEnabled ? "none" : "block";
  }
}

/**
 * Update status indicator
 * @param {string} text - Status text
 * @param {string} type - Status type ('ready', 'success', 'error')
 */ function updateStatus(text, type = "ready") {
  if (elements.statusText) {
    elements.statusText.textContent = text;
  }
  if (elements.statusDot) {
    // Remove existing status classes
    elements.statusDot.classList.remove("status-success", "status-error");
    // Add appropriate class
        if (type === "success") {
      elements.statusDot.classList.add("status-success");
    } else if (type === "error") {
      elements.statusDot.classList.add("status-error");
    }
  }
  // Reset to ready after delay
    if (type !== "ready") {
    setTimeout(() => {
      updateStatus("Ready", "ready");
    }, 2e3);
  }
}

/**
 * Set up event listeners for settings controls
 */ function setupEventListeners() {
  // Extension enabled toggle
  if (elements.enabledToggle) {
    elements.enabledToggle.addEventListener("change", e => {
      const enabled = e.target.checked;
      saveSetting("extensionEnabled", enabled);
      if (elements.popupContainer) {
        elements.popupContainer.classList.toggle("popup-disabled", !enabled);
      }
    });
  }
  // Analysis toggle
    if (elements.analysisToggle) {
    elements.analysisToggle.addEventListener("change", e => {
      saveSetting("analysisEnabled", e.target.checked);
    });
  }
  // Depth slider
    if (elements.depthInput) {
    elements.depthInput.addEventListener("input", e => {
      const value = parseInt(e.target.value, 10);
      if (elements.depthValue) {
        elements.depthValue.textContent = depthToElo(value);
      }
    });
    elements.depthInput.addEventListener("change", e => {
      const value = parseInt(e.target.value, 10);
      saveSetting("depth", value);
    });
  }
  // Autoplay toggle
    if (elements.autoplayToggle) {
    elements.autoplayToggle.addEventListener("change", e => {
      saveSetting("autoplayEnabled", e.target.checked);
    });
  }
  // Fixed delay slider
    if (elements.delayInput) {
    elements.delayInput.addEventListener("input", e => {
      const value = parseInt(e.target.value, 10);
      if (elements.delayValue) {
        elements.delayValue.textContent = `${value}ms`;
      }
    });
    elements.delayInput.addEventListener("change", e => {
      const value = parseInt(e.target.value, 10);
      saveSetting("autoplayDelay", value);
    });
  }
  // Variation toggle
    if (elements.variationToggle) {
    elements.variationToggle.addEventListener("change", e => {
      const enabled = e.target.checked;
      saveSetting("autoplayVariationEnabled", enabled);
      updateVariationSettingsVisibility(enabled);
    });
  }
  // Min delay slider
    if (elements.delayMinInput) {
    elements.delayMinInput.addEventListener("input", e => {
      const value = parseInt(e.target.value, 10);
      if (elements.delayMinValue) {
        elements.delayMinValue.textContent = `${value}ms`;
      }
      // Ensure min doesn't exceed max
            if (elements.delayMaxInput) {
        const maxValue = parseInt(elements.delayMaxInput.value, 10);
        if (value >= maxValue) {
          const newMax = value + 100;
          elements.delayMaxInput.value = newMax;
          if (elements.delayMaxValue) {
            elements.delayMaxValue.textContent = `${newMax}ms`;
          }
        }
      }
    });
    elements.delayMinInput.addEventListener("change", e => {
      const value = parseInt(e.target.value, 10);
      saveSetting("autoplayDelayMin", value);
      // Also save adjusted max if needed
            if (elements.delayMaxInput) {
        const maxValue = parseInt(elements.delayMaxInput.value, 10);
        if (value >= maxValue) {
          saveSetting("autoplayDelayMax", value + 100);
        }
      }
    });
  }
  // Max delay slider
    if (elements.delayMaxInput) {
    elements.delayMaxInput.addEventListener("input", e => {
      const value = parseInt(e.target.value, 10);
      if (elements.delayMaxValue) {
        elements.delayMaxValue.textContent = `${value}ms`;
      }
      // Ensure max doesn't go below min
            if (elements.delayMinInput) {
        const minValue = parseInt(elements.delayMinInput.value, 10);
        if (value <= minValue) {
          const newMin = Math.max(100, value - 100);
          elements.delayMinInput.value = newMin;
          if (elements.delayMinValue) {
            elements.delayMinValue.textContent = `${newMin}ms`;
          }
        }
      }
    });
    elements.delayMaxInput.addEventListener("change", e => {
      const value = parseInt(e.target.value, 10);
      saveSetting("autoplayDelayMax", value);
      // Also save adjusted min if needed
            if (elements.delayMinInput) {
        const minValue = parseInt(elements.delayMinInput.value, 10);
        if (value <= minValue) {
          saveSetting("autoplayDelayMin", Math.max(100, value - 100));
        }
      }
    });
  }
  // Antidetect toggle
    if (elements.antidetectToggle) {
    elements.antidetectToggle.addEventListener("change", e => {
      saveSetting("antidetectEnabled", e.target.checked);
    });
  }
  // Antidetect min interval slider
    if (elements.antidetectMinInput) {
    elements.antidetectMinInput.addEventListener("input", e => {
      const value = parseInt(e.target.value, 10);
      if (elements.antidetectMinValue) {
        elements.antidetectMinValue.textContent = value;
      }
      // Ensure min doesn't exceed max
            if (elements.antidetectMaxInput) {
        const maxValue = parseInt(elements.antidetectMaxInput.value, 10);
        if (value >= maxValue) {
          elements.antidetectMaxInput.value = value + 1;
          if (elements.antidetectMaxValue) {
            elements.antidetectMaxValue.textContent = value + 1;
          }
        }
      }
    });
    elements.antidetectMinInput.addEventListener("change", e => {
      const value = parseInt(e.target.value, 10);
      saveSetting("antidetectIntervalMin", value);
      if (elements.antidetectMaxInput) {
        const maxValue = parseInt(elements.antidetectMaxInput.value, 10);
        if (value >= maxValue) {
          saveSetting("antidetectIntervalMax", value + 1);
        }
      }
    });
  }
  // Antidetect max interval slider
    if (elements.antidetectMaxInput) {
    elements.antidetectMaxInput.addEventListener("input", e => {
      const value = parseInt(e.target.value, 10);
      if (elements.antidetectMaxValue) {
        elements.antidetectMaxValue.textContent = value;
      }
      // Ensure max doesn't go below min
            if (elements.antidetectMinInput) {
        const minValue = parseInt(elements.antidetectMinInput.value, 10);
        if (value <= minValue) {
          const newMin = Math.max(1, value - 1);
          elements.antidetectMinInput.value = newMin;
          if (elements.antidetectMinValue) {
            elements.antidetectMinValue.textContent = newMin;
          }
        }
      }
    });
    elements.antidetectMaxInput.addEventListener("change", e => {
      const value = parseInt(e.target.value, 10);
      saveSetting("antidetectIntervalMax", value);
      if (elements.antidetectMinInput) {
        const minValue = parseInt(elements.antidetectMinInput.value, 10);
        if (value <= minValue) {
          saveSetting("antidetectIntervalMin", Math.max(1, value - 1));
        }
      }
    });
  }
  // Sign out button
    if (elements.signoutBtn) {
    elements.signoutBtn.addEventListener("click", handleSignOut);
  }
  // Admin panel button
    if (elements.adminBtn) {
    elements.adminBtn.addEventListener("click", async () => {
      const cfg = globalThis._cfg || {};
      let baseUrl = cfg.APP_URL || cfg.API_URL || "http://localhost:3000";
      if (baseUrl.includes("/api/")) {
        baseUrl = baseUrl.replace(/\/api\/.*$/, "");
      }
      baseUrl = baseUrl.replace(/\/+$/, "");
      const adminUrl = `${baseUrl}/admin?adminSecret=${encodeURIComponent("local-admin-secret")}`;
      chrome.runtime.sendMessage({
        type: "OPEN_AUTH_TAB",
        url: adminUrl
      });
    });
  }
  // Manual token connect toggle
    if (elements.connectToggleBtn) {
    elements.connectToggleBtn.addEventListener("click", () => {
      const section = elements.connectTokenSection;
      if (section) {
        const visible = section.style.display !== "none";
        section.style.display = visible ? "none" : "";
        if (!visible && elements.tokenInput) {
          elements.tokenInput.focus();
        }
      }
    });
  }
  // Manual token connect button
    if (elements.connectBtn) {
    elements.connectBtn.addEventListener("click", handleManualConnect);
  }
  // Allow Enter key in token input
    if (elements.tokenInput) {
    elements.tokenInput.addEventListener("keydown", e => {
      if (e.key === "Enter") {
        handleManualConnect();
      }
    });
  }
  // Listen for token capture events (refresh popup when user connects)
    chrome.runtime.onMessage.addListener(message => {
    if (message.type === "TOKEN_CAPTURED") {
      renderAuthState();
    }
  });
}

/**
 * Check if extension is connected to a chess.com tab
 * @returns {Promise<boolean>}
 */ async function checkConnection() {
  try {
    const chessTabs = await chrome.tabs.query({
      url: "*://*.chess.com/*"
    });
    const lichessTabs = await chrome.tabs.query({
      url: "*://*.lichess.org/*"
    });
    return chessTabs.length + lichessTabs.length > 0;
  } catch (error) {
    return false;
  }
}

/**
 * Initialize the popup
 */
/**
 * Fetch selector diagnostics from the background and display health status
 */ async function fetchSelectorDiagnostics() {
  try {
    const response = await chrome.runtime.sendMessage({
      type: "GET_SELECTOR_DIAGNOSTICS"
    });
    const diag = response?.diagnostics;
    if (!diag || !diag.results || !elements.domHealth) return;
    const results = diag.results;
    // Only consider core/game selectors — event selectors (game-over, promotion)
    // are only present during specific game events and are expected to be missing.
        const nonEventKeys = Object.keys(results).filter(k => results[k].category !== "event");
    const criticalKeys = [ "board", "pieces" ];
    const broken = nonEventKeys.filter(k => !results[k].working);
    const criticalBroken = broken.filter(k => criticalKeys.includes(k));
    elements.domHealth.style.display = "flex";
    elements.domHealth.classList.remove("health-ok", "health-warn", "health-error");
    if (criticalBroken.length > 0) {
      elements.domHealth.classList.add("health-error");
      elements.domHealthText.textContent = `DOM: ${criticalBroken.length} critical selector(s) broken`;
      elements.domHealth.title = `Broken: ${broken.join(", ")}`;
    } else if (broken.length > 0) {
      // Non-critical missing selectors: log to console only, don't show in UI
      // Non-critical: suppressed in production (Terser global_defs _D=false)
      _log(`[Chess Helper] DOM: ${broken.length} non-critical selector(s) missing:`, broken.join(", "));
      elements.domHealth.style.display = "none";
    } else {
      elements.domHealth.classList.add("health-ok");
      elements.domHealthText.textContent = `DOM: All selectors OK (${diag.platform})`;
      elements.domHealth.title = "All selectors matched successfully";
    }
    // Click to show details in console
        elements.domHealth.onclick = () => {
      _log("[Chess Helper] Selector Diagnostics:", JSON.stringify(results, null, 2));
    };
  } catch (e) {
    // No diagnostics available yet (no game page open)
  }
}

async function init() {
  // Initialize DOM elements
  initElements();
  // Set brand link to APP_URL
    const brandLink = document.getElementById("brand-link");
  if (brandLink) {
    const baseUrl = await getBaseUrl();
    brandLink.href = baseUrl;
  }
  // Load and display current settings
    const settings = await loadSettings();
  updateSettingsUI(settings);
  // Set up event listeners
    setupEventListeners();
  // Render auth state (shows loading, then resolves)
    await renderAuthState();
  // Check connection status (only relevant for anonymous state)
    const isConnected = await checkConnection();
  if (isConnected) {
    updateStatus("Connected", "success");
    setTimeout(() => updateStatus("Ready", "ready"), 1500);
  } else {
    updateStatus("Open chess.com or lichess.org", "ready");
  }
  // Fetch and display DOM selector health
    fetchSelectorDiagnostics();
}

// Initialize when DOM is ready
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}