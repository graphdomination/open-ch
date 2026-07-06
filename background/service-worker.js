/**
 * Service Worker - Settings Manager & API Proxy
 *
 * This service worker handles settings management, API proxying,
 * authentication, and synchronization between popup and content scripts.
 */
// Debug mode - set to true to enable console logging
const _D = true;

const _log = _D ? console.log.bind(console) : () => {};

const _warn = _D ? console.warn.bind(console) : () => {};

const _err = _D ? console.error.bind(console) : () => {};

// ============================================================
// Auth Module (inline — MV3 service workers don't support importScripts for local modules easily)
// ============================================================
const AUTH_KEYS = {
  TOKEN: "extensionToken",
  USER_PROFILE: "userProfile",
  LAST_PROFILE_FETCH: "lastProfileFetch"
};

const PROFILE_CACHE_DURATION = 5 * 60 * 1e3;

 // 5 minutes
// Latest selector diagnostics from content script (stored in memory for popup)
let lastSelectorDiagnostics = null;

// Rate limit cooldown — second line of defense to prevent hammering the API.
// Maps userId/tabId to cooldown expiry timestamp.
let rateLimitCooldownUntil = 0;

// Lazy-load config.json (importScripts is unreliable in MV3 service workers)
let _configLoaded = false;

async function loadConfig() {
  if (_configLoaded) return;
  _configLoaded = true;
  try {
    const res = await fetch(chrome.runtime.getURL("config.json"));
    globalThis._cfg = await res.json();
  } catch {/* config.json not found */}
}

async function getToken() {
  const {[AUTH_KEYS.TOKEN]: token} = await chrome.storage.local.get(AUTH_KEYS.TOKEN);
  return token || null;
}

async function setToken(token) {
  await chrome.storage.local.set({
    [AUTH_KEYS.TOKEN]: token
  });
  await fetchProfile(true);
}

async function clearToken() {
  await chrome.storage.local.remove([ AUTH_KEYS.TOKEN, AUTH_KEYS.USER_PROFILE, AUTH_KEYS.LAST_PROFILE_FETCH ]);
}

async function isAuthenticated() {
  const token = await getToken();
  return !!token;
}

async function getCachedProfile() {
  const {[AUTH_KEYS.USER_PROFILE]: profile} = await chrome.storage.local.get(AUTH_KEYS.USER_PROFILE);
  return profile || null;
}

async function setCachedProfile(profile) {
  await chrome.storage.local.set({
    [AUTH_KEYS.USER_PROFILE]: profile,
    [AUTH_KEYS.LAST_PROFILE_FETCH]: Date.now()
  });
}

async function getApiBaseUrl() {
  // Config.json is the source of truth (baked in at build time)
  await loadConfig();
  if (globalThis._cfg?.APP_URL) {
    return globalThis._cfg.APP_URL;
  }
  const {apiBaseUrl: apiBaseUrl} = await chrome.storage.local.get("apiBaseUrl");
  if (apiBaseUrl) return apiBaseUrl;
  return "http://localhost:3000";
}

async function apiFetch(path, options = {}) {
  const baseUrl = await getApiBaseUrl();
  const token = await getToken();
  const headers = {
    "Content-Type": "application/json",
    ...options.headers || {}
  };
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }
  return fetch(`${baseUrl}${path}`, {
    ...options,
    headers: headers
  });
}

async function fetchProfile(force = false) {
  if (!await isAuthenticated()) return null;
  if (!force) {
    const {[AUTH_KEYS.LAST_PROFILE_FETCH]: lastFetch} = await chrome.storage.local.get(AUTH_KEYS.LAST_PROFILE_FETCH);
    if (lastFetch && Date.now() - lastFetch < PROFILE_CACHE_DURATION) {
      return getCachedProfile();
    }
  }
  try {
    const response = await apiFetch("/api/me");
    if (response.ok) {
      const data = await response.json();
      if (data.authenticated) {
        await setCachedProfile(data.user);
        return data.user;
      } else {
        await clearToken();
        return null;
      }
    }
    return getCachedProfile();
  } catch {
    return getCachedProfile();
  }
}

async function trackAnonymousGame(gameId) {
  const {anonymousGameIds: anonymousGameIds = []} = await chrome.storage.local.get("anonymousGameIds");
  if (!anonymousGameIds.includes(gameId)) {
    anonymousGameIds.push(gameId);
    await chrome.storage.local.set({
      anonymousGameIds: anonymousGameIds,
      anonymousGamesCount: anonymousGameIds.length
    });
  }
}

// ============================================================
// Game ID Management (per-tab, using chrome.storage.session)
// ============================================================
async function getOrCreateGameId(tabId) {
  const key = `gameId_${tabId}`;
  const {[key]: existing} = await chrome.storage.session.get(key);
  if (existing) return existing;
  const gameId = crypto.randomUUID();
  await chrome.storage.session.set({
    [key]: gameId
  });
  return gameId;
}

async function resetGameId(tabId) {
  const key = `gameId_${tabId}`;
  await chrome.storage.session.remove(key);
}

// ============================================================
// Message Handling
// ============================================================
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender, sendResponse);
  return true;
 // Keep channel open for async responses
});

async function handleMessage(message, sender, sendResponse) {
  const tabId = sender.tab?.id;
  _log("[Service Worker] Message received:", message.type, "from tab:", tabId);
  switch (message.type) {
   case "GET_SETTINGS":
    if (tabId) {
      await sendSettings(tabId);
    }
    break;

   case "API_ANALYZE":
    await handleApiAnalyze(message, sender, sendResponse);
    return;

   case "SET_EXTENSION_TOKEN":
    await handleSetToken(message, sender, sendResponse);
    return;

   case "CLEAR_TOKEN":
    await clearToken();
    sendResponse({
      success: true
    });
    return;

   case "GET_AUTH_STATE":
    await handleGetAuthState(sendResponse);
    return;

   case "GET_BASE_URL":
    {
      const baseUrl = await getApiBaseUrl();
      sendResponse({
        baseUrl: baseUrl
      });
      return;
    }

   case "FETCH_PROFILE":
    await handleFetchProfile(message, sendResponse);
    return;

   case "GET_GAME_ID":
    if (tabId) {
      const gameId = await getOrCreateGameId(tabId);
      sendResponse({
        gameId: gameId
      });
    }
    return;

   case "RESET_GAME_ID":
    rateLimitCooldownUntil = 0;
 // Allow fresh API calls for new game
        if (tabId) {
      await resetGameId(tabId);
      sendResponse({
        success: true
      });
    }
    return;

   case "TRACK_ANONYMOUS_GAME":
    if (message.gameId) {
      await trackAnonymousGame(message.gameId);
      sendResponse({
        success: true
      });
    }
    return;

   case "GAME_STARTED":
    rateLimitCooldownUntil = 0;
 // Allow fresh API calls for new game
    // Fire-and-forget: don't block on response
        handleGameStarted(message).catch(e => _warn("[Service Worker] GAME_STARTED failed:", e));
    sendResponse({
      success: true
    });
    return;

   case "GAME_ENDED":
    // Fire-and-forget: don't block on response
    handleGameEnded(message).catch(e => _warn("[Service Worker] GAME_ENDED failed:", e));
    sendResponse({
      success: true
    });
    return;

   case "DOM_HEALTH_REPORT":
    // Fire-and-forget: don't block on response
    handleDomHealthReport(message).catch(e => _warn("[Service Worker] DOM_HEALTH_REPORT failed:", e));
    sendResponse({
      success: true
    });
    return;

   case "SELECTOR_DIAGNOSTICS":
    // Store latest diagnostics for popup to read
    lastSelectorDiagnostics = {
      platform: message.platform,
      results: message.results,
      timestamp: Date.now()
    };
    sendResponse({
      success: true
    });
    return;

   case "GET_SELECTOR_DIAGNOSTICS":
    sendResponse({
      diagnostics: lastSelectorDiagnostics || null
    });
    return;

   case "OPEN_AUTH_TAB":
    await handleOpenAuthTab(message, sendResponse);
    return;

   case "CLOSE_CONNECT_TAB":
    await handleCloseConnectTab();
    return;

   case "API_CHECKOUT":
    await handleApiCheckout(message, sendResponse);
    return;

   default:
    _log("[Service Worker] Unknown message type:", message.type);
    break;
  }
}

/**
 * Handle SET_EXTENSION_TOKEN from content-connect.js
 */ async function handleSetToken(message, sender, sendResponse) {
  try {
    await setToken(message.token);
    // Clear anonymous game tracking (user now has an account)
        await chrome.storage.local.remove([ "anonymousGameIds", "anonymousGamesCount" ]);
    // Notify all open extension popups
        chrome.runtime.sendMessage({
      type: "TOKEN_CAPTURED"
    }).catch(() => {});
    // Notify content scripts on chess.com/lichess tabs so they can dismiss overlays
        notifyAllTabs({
      type: "TOKEN_CAPTURED"
    });
    // Show notification
        chrome.notifications.create({
      type: "basic",
      iconUrl: "icons/icon128.png",
      title: "Account Connected",
      message: "Your ChessHelper.ai account has been linked to the extension."
    });
    sendResponse({
      success: true
    });
  } catch (error) {
    _err("[Service Worker] Error setting token:", error);
    sendResponse({
      success: false,
      error: error.message
    });
  }
}

/**
 * Handle GET_AUTH_STATE — returns current auth and profile info
 */ async function handleGetAuthState(sendResponse) {
  try {
    const authenticated = await isAuthenticated();
    const profile = await getCachedProfile();
    const {anonymousGamesCount: anonymousGamesCount = 0} = await chrome.storage.local.get("anonymousGamesCount");
    sendResponse({
      authenticated: authenticated,
      profile: profile,
      anonymousGamesCount: anonymousGamesCount
    });
  } catch (error) {
    _err("[Service Worker] Error getting auth state:", error);
    sendResponse({
      authenticated: false,
      profile: null,
      anonymousGamesCount: 0
    });
  }
}

/**
 * Handle FETCH_PROFILE — fetch fresh profile data
 */ async function handleFetchProfile(message, sendResponse) {
  try {
    const profile = await fetchProfile(message.force || false);
    sendResponse({
      profile: profile
    });
  } catch (error) {
    _err("[Service Worker] Error fetching profile:", error);
    sendResponse({
      profile: null
    });
  }
}

/**
 * Proxy API requests to bypass CSP restrictions on content scripts
 * Now includes Bearer token authentication and gameId
 */ async function handleApiAnalyze(message, sender, sendResponse) {
  const {fen: fen, depth: depth, apiUrl: apiUrl, gameId: gameId, maxTimeMs: maxTimeMs} = message;
  const MAX_RETRIES = 3;
  const tabId = sender.tab?.id;
  // Rate limit cooldown — if we recently got a 429, reject immediately
  // without hitting the server. This is a second line of defense in case
  // the content script's cooldown doesn't take effect (e.g. stale code).
    if (Date.now() < rateLimitCooldownUntil) {
    _warn("[Service Worker] Rate limit cooldown active, rejecting without API call");
    sendResponse({
      success: false,
      error: "Rate limit cooldown active",
      rateLimited: true,
      rateLimitData: {
        error: "Rate limit cooldown active"
      }
    });
    return;
  }
  _log("[Service Worker] Proxying API request:", {
    fen: fen,
    depth: depth,
    apiUrl: apiUrl,
    gameId: gameId,
    maxTimeMs: maxTimeMs
  });
  // Resolve the gameId: use provided one or get/create from session
    let resolvedGameId = gameId;
  if (!resolvedGameId && tabId) {
    resolvedGameId = await getOrCreateGameId(tabId);
  }
  // Build request body
    const requestBody = {
    fen: fen,
    depth: depth
  };
  if (resolvedGameId) {
    requestBody.gameId = resolvedGameId;
  }
  if (maxTimeMs) {
    requestBody.maxTimeMs = maxTimeMs;
  }
  // Determine the API URL — use apiFetch for authenticated requests
  // If apiUrl points to localhost (dev), use it directly; otherwise use apiFetch
    const token = await getToken();
  const baseUrl = await getApiBaseUrl();
  const headers = {
    "Content-Type": "application/json"
  };
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }
  // Determine the actual URL to call
  let analyzeUrl;
  if (apiUrl) {
    if (apiUrl.startsWith("http://") || apiUrl.startsWith("https://")) {
      analyzeUrl = apiUrl;
    } else if (apiUrl.startsWith("/")) {
      analyzeUrl = `${baseUrl}${apiUrl}`;
    } else {
      analyzeUrl = `${baseUrl}/${apiUrl}`;
    }
  } else {
    analyzeUrl = `${baseUrl}/api/analyze`;
  }
  const fetchOptions = {
    method: "POST",
    headers: headers,
    body: JSON.stringify(requestBody)
  };
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      _log("[Service Worker] Fetching analyzeUrl:", analyzeUrl, "with body:", requestBody);
      const response = await fetch(analyzeUrl, fetchOptions);
      _log("[Service Worker] Analyze response status:", response.status, "ok:", response.ok);
      // Handle rate limiting (429)
            if (response.status === 429) {
        const errorData = await response.json().catch(() => ({}));
        _warn("[Service Worker] Rate limited:", errorData);
        // Set cooldown to prevent further API calls for 30 seconds
                rateLimitCooldownUntil = Date.now() + 3e4;
        // Track anonymous game if not authenticated
                if (!errorData.authenticated && resolvedGameId) {
          await trackAnonymousGame(resolvedGameId);
        }
        // Refresh profile once (only if not recently fetched — avoid spam)
                if (await isAuthenticated()) {
          fetchProfile(false).catch(() => {});
        }
        sendResponse({
          success: false,
          error: errorData.error || "Rate limit exceeded",
          rateLimited: true,
          rateLimitData: errorData
        });
        return;
      }
      // Handle unauthorized (401) — token invalid
            if (response.status === 401) {
        _warn("[Service Worker] Unauthorized (401) — clearing token");
        await clearToken();
        sendResponse({
          success: false,
          error: "Session expired. Please reconnect your account.",
          unauthorized: true
        });
        return;
      }
      // Handle forbidden (403) - retry with backoff
            if (response.status === 403) {
        if (attempt < MAX_RETRIES) {
          _warn("[Service Worker] Forbidden (403), retry", attempt + 1, "of", MAX_RETRIES);
          await new Promise(resolve => setTimeout(resolve, 1e3 * (attempt + 1)));
          continue;
        }
        _warn("[Service Worker] Forbidden (403), all retries exhausted");
        sendResponse({
          success: false,
          error: "Access denied (403). Check API configuration.",
          forbidden: true
        });
        return;
      }
      // Handle server overloaded (503) - retry with backoff
            if (response.status === 503) {
        if (attempt < MAX_RETRIES) {
          const retryAfter = parseInt(response.headers.get("Retry-After"), 10);
          const delayMs = retryAfter && retryAfter > 0 ? retryAfter * 1e3 : 1e3 * (attempt + 1);
          _warn("[Service Worker] Server overloaded (503), retry", attempt + 1, "of", MAX_RETRIES, "in", delayMs, "ms");
          await new Promise(resolve => setTimeout(resolve, delayMs));
          continue;
        }
        _warn("[Service Worker] Server overloaded (503), all retries exhausted");
        sendResponse({
          success: false,
          error: "Server overloaded. Try again shortly.",
          serverOverloaded: true
        });
        return;
      }
      // Handle analysis timeout (504) - position too complex
            if (response.status === 504) {
        _warn("[Service Worker] Analysis timeout (504) - position may be too complex");
        sendResponse({
          success: false,
          error: "Analysis timed out. Position may be too complex.",
          timeout: true
        });
        return;
      }
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error || `HTTP ${response.status}`);
      }
      const data = await response.json();
      _log("[Service Worker] API response received:", data);
      // Track anonymous game usage on successful analysis
            if (!await isAuthenticated() && resolvedGameId) {
        await trackAnonymousGame(resolvedGameId);
      }
      sendResponse({
        success: true,
        data: data.data || data
      });
      return;
    } catch (error) {
      // Network errors on non-final attempt: retry
      if (attempt < MAX_RETRIES && error.name === "TypeError") {
        _warn("[Service Worker] Network error, retry", attempt + 1, "of", MAX_RETRIES);
        await new Promise(resolve => setTimeout(resolve, 1e3 * (attempt + 1)));
        continue;
      }
      _err("[Service Worker] API request failed:", error);
      sendResponse({
        success: false,
        error: error.message
      });
      return;
    }
  }
}

/**
 * Handle GAME_STARTED — send game metadata to server (fire-and-forget, async)
 * Never blocks or retries — if it fails, we silently move on.
 */ async function handleGameStarted(message) {
  const token = await getToken();
  if (!token) {
    _log("[Service Worker] GAME_STARTED skipped — not authenticated");
    return;
  }
  const baseUrl = await getApiBaseUrl();
  const body = {
    gameId: message.gameId,
    platform: message.platform,
    timeControl: message.timeControl || null,
    playerColor: message.playerColor || null,
    opponentName: message.opponentName || null,
    platformGameId: message.platformGameId || null
  };
  _log("[Service Worker] GAME_STARTED sending:", body);
  const response = await fetch(`${baseUrl}/api/games`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`
    },
    body: JSON.stringify(body)
  });
  if (!response.ok) {
    _warn("[Service Worker] GAME_STARTED failed:", response.status);
  } else {
    _log("[Service Worker] GAME_STARTED success");
  }
}

/**
 * Handle GAME_ENDED — update game record on server (fire-and-forget, async)
 * Never blocks or retries — if it fails, we silently move on.
 */ async function handleGameEnded(message) {
  const token = await getToken();
  if (!token) {
    _log("[Service Worker] GAME_ENDED skipped — not authenticated");
    return;
  }
  const baseUrl = await getApiBaseUrl();
  const body = {
    gameId: message.gameId,
    result: message.result || null,
    status: message.status || "finished",
    pgn: message.pgn || null,
    lastFen: message.lastFen || null,
    timeControl: message.timeControl || null
  };
  _log("[Service Worker] GAME_ENDED sending:", body);
  const response = await fetch(`${baseUrl}/api/games`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`
    },
    body: JSON.stringify(body)
  });
  if (!response.ok) {
    _warn("[Service Worker] GAME_ENDED failed:", response.status);
  } else {
    _log("[Service Worker] GAME_ENDED success");
  }
}

/**
 * Handle API_CHECKOUT — create a Stripe checkout session and return the URL
 * Opens the checkout URL in a new tab so the user can subscribe.
 */ async function handleApiCheckout(message, sendResponse) {
  const token = await getToken();
  if (!token) {
    sendResponse({
      success: false,
      error: "Not authenticated"
    });
    return;
  }
  const baseUrl = await getApiBaseUrl();
  const priceId = message.priceId;
 // "pro-monthly" or "pro-yearly"
    try {
    const response = await fetch(`${baseUrl}/api/stripe/create-checkout`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`
      },
      body: JSON.stringify({
        priceId: priceId
      })
    });
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      _warn("[Service Worker] API_CHECKOUT failed:", response.status, errorData);
      sendResponse({
        success: false,
        error: errorData.error || "Checkout failed"
      });
      return;
    }
    const data = await response.json();
    if (data.url) {
      // Open checkout URL in a new tab
      chrome.tabs.create({
        url: data.url
      });
      sendResponse({
        success: true,
        url: data.url
      });
    } else {
      sendResponse({
        success: false,
        error: "No checkout URL returned"
      });
    }
  } catch (error) {
    _err("[Service Worker] API_CHECKOUT error:", error);
    sendResponse({
      success: false,
      error: "Network error"
    });
  }
}

/**
 * Handle DOM_HEALTH_REPORT — send DOM health check to API (fire-and-forget)
 * Reports whether chess.com/lichess DOM selectors are still working.
 */ async function handleDomHealthReport(message) {
  const baseUrl = await getApiBaseUrl();
  const token = await getToken();
  const headers = {
    "Content-Type": "application/json"
  };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  try {
    await fetch(`${baseUrl}/api/extension/dom-health`, {
      method: "POST",
      headers: headers,
      body: JSON.stringify(message.report)
    });
  } catch (e) {
    // Silently ignore — this is purely diagnostic
    _warn("[Service Worker] DOM health report failed:", e.message);
  }
}

/**
 * Handle OPEN_AUTH_TAB — stores game tab, opens signup/login in a new tab
 */ async function handleOpenAuthTab(message, sendResponse) {
  try {
    // Get the current active tab (the chess game tab)
    const [activeTab] = await chrome.tabs.query({
      active: true,
      currentWindow: true
    });
    if (activeTab?.id) {
      await chrome.storage.session.set({
        gameTabId: activeTab.id
      });
    }
    // Open the auth page in a new tab
        const newTab = await chrome.tabs.create({
      url: message.url
    });
    // Store the connect flow tab ID
        await chrome.storage.session.set({
      connectTabId: newTab.id
    });
    sendResponse({
      success: true
    });
  } catch (error) {
    _err("[Service Worker] Error opening auth tab:", error);
    // Fallback: open URL directly
        try {
      await chrome.tabs.create({
        url: message.url
      });
    } catch {/* ignore */}
    sendResponse({
      success: false,
      error: error.message
    });
  }
}

/**
 * Handle CLOSE_CONNECT_TAB — closes the signup/connect tab and refocuses the game tab
 */ async function handleCloseConnectTab() {
  const {connectTabId: connectTabId, gameTabId: gameTabId} = await chrome.storage.session.get([ "connectTabId", "gameTabId" ]);
  // Close the connect tab
    if (connectTabId) {
    try {
      await chrome.tabs.remove(connectTabId);
    } catch {
      // Tab may already be closed by window.close()
    }
  }
  // Refocus the game tab
    if (gameTabId) {
    try {
      await chrome.tabs.update(gameTabId, {
        active: true
      });
    } catch {
      // Game tab may have been closed
    }
  }
  // Clean up session storage
    await chrome.storage.session.remove([ "connectTabId", "gameTabId" ]);
}

// ============================================================
// Settings Management
// ============================================================
async function sendSettings(tabId) {
  try {
    const settings = await chrome.storage.local.get([ "extensionEnabled", "analysisEnabled", "depth", "autoplayEnabled", "autoplayDelay", "autoplayDelayMin", "autoplayDelayMax", "autoplayVariationEnabled", "antidetectEnabled", "antidetectIntervalMin", "antidetectIntervalMax" ]);
    chrome.tabs.sendMessage(tabId, {
      type: "SETTINGS_RESPONSE",
      settings: {
        extensionEnabled: settings.extensionEnabled !== false,
        analysisEnabled: settings.analysisEnabled !== false,
        depth: settings.depth || 15,
        autoplayEnabled: settings.autoplayEnabled || false,
        autoplayDelay: settings.autoplayDelay || 1e3,
        autoplayDelayMin: settings.autoplayDelayMin || 500,
        autoplayDelayMax: settings.autoplayDelayMax || 2e3,
        autoplayVariationEnabled: settings.autoplayVariationEnabled !== false,
        antidetectEnabled: settings.antidetectEnabled || false,
        antidetectIntervalMin: settings.antidetectIntervalMin || 5,
        antidetectIntervalMax: settings.antidetectIntervalMax || 6
      }
    }).catch(() => {});
  } catch (error) {
    _err("[Service Worker] Error sending settings:", error);
  }
}

async function notifyAllTabs(message) {
  try {
    const chessTabs = await chrome.tabs.query({
      url: "*://*.chess.com/*"
    });
    const lichessTabs = await chrome.tabs.query({
      url: "*://*.lichess.org/*"
    });
    const allTabs = [ ...chessTabs, ...lichessTabs ];
    for (const tab of allTabs) {
      if (tab.id) {
        chrome.tabs.sendMessage(tab.id, message).catch(() => {});
      }
    }
  } catch (error) {
    _err("[Service Worker] Error notifying tabs:", error);
  }
}

// Only propagate actual user-facing settings to tabs — ignore metadata
// like lastProfileFetch, extensionToken, anonymousGameIds, etc.
const SETTINGS_KEYS = new Set([ "extensionEnabled", "analysisEnabled", "depth", "autoplayEnabled", "autoplayDelay", "autoplayDelayMin", "autoplayDelayMax", "autoplayVariationEnabled", "antidetectEnabled", "antidetectIntervalMin", "antidetectIntervalMax" ]);

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === "local") {
    const newSettings = {};
    for (const key in changes) {
      if (SETTINGS_KEYS.has(key)) {
        newSettings[key] = changes[key].newValue;
      }
    }
    // Only notify tabs if an actual setting changed
        if (Object.keys(newSettings).length > 0) {
      _log("[Service Worker] Settings changed:", newSettings);
      notifyAllTabs({
        type: "SETTINGS_CHANGED",
        settings: newSettings
      });
    }
  }
});

// ============================================================
// Extension Installation
// ============================================================
chrome.runtime.onInstalled.addListener(async details => {
  if (details.reason === "install") {
    _log("[Service Worker] Extension installed, setting defaults");
    await chrome.storage.local.set({
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
    });
  } else if (details.reason === "update") {
    _log("[Service Worker] Extension updated to version", chrome.runtime.getManifest().version);
  }
});

// ============================================================
// Tab cleanup — remove game IDs when tabs close
// ============================================================
chrome.tabs.onRemoved.addListener(async tabId => {
  try {
    const key = `gameId_${tabId}`;
    await chrome.storage.session.remove(key);
  } catch {
    // Ignore errors for session storage cleanup
  }
});

_log("[Service Worker] Service worker initialized");