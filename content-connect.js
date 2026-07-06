/**
 * Content Script - Token Auto-Capture
 *
 * Runs only on the /extension/connect page of chesshelper.ai.
 * Reads the auth token from a <meta name="extension-token"> tag
 * and sends it to the background service worker.
 */
function captureToken() {
  const meta = document.querySelector('meta[name="extension-token"]');
  if (meta) {
    const token = meta.getAttribute("content");
    if (token && token.startsWith("chext_")) {
      // Send token to background script and wait for confirmation
      chrome.runtime.sendMessage({
        type: "SET_EXTENSION_TOKEN",
        token: token
      }, response => {
        if (response?.success) {
          // Tell the web page the extension captured the token
          // This triggers the "Connected!" UI and auto-close countdown
          window.dispatchEvent(new CustomEvent("extension-connected", {
            detail: {
              success: true
            }
          }));
          // Fallback tab close — in case window.close() from the web page fails
                    setTimeout(() => {
            chrome.runtime.sendMessage({
              type: "CLOSE_CONNECT_TAB"
            });
          }, 4e3);
        }
      });
      return true;
    }
  }
  return false;
}

// Try immediately
if (!captureToken()) {
  // Meta tag might not be rendered yet — observe DOM mutations
  const observer = new MutationObserver(() => {
    if (captureToken()) {
      observer.disconnect();
    }
  });
  observer.observe(document.head, {
    childList: true,
    subtree: true
  });
  // Timeout after 10 seconds
    setTimeout(() => observer.disconnect(), 1e4);
}