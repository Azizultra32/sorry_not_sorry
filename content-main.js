// content-main.js — Runs in the MAIN world (see manifest.json).
// Because this script shares the page's window object with Sora's own JS,
// monkey-patching window.fetch here actually intercepts the real requests.
//
// Communication with the ISOLATED-world content.js is done via CustomEvents
// dispatched on `document`, which cross the world boundary safely.
//
// Execution context: lib/constants.js, lib/scraper.js are loaded first
// (same content_scripts entry), so MESSAGE_TYPES, SORA_URLS, DEFAULT_SETTINGS,
// interceptFetch, extractAuthToken, and fetchVideoLibrary are all globals here.

(function soraArchiverMainWorld() {
  'use strict';

  // -------------------------------------------------------------------------
  // CustomEvent channel name (shared with content.js)
  // -------------------------------------------------------------------------
  const CHANNEL = '__sora_archiver';

  // -------------------------------------------------------------------------
  // Helpers — dispatch events toward the isolated world
  // -------------------------------------------------------------------------
  function dispatchToIsolated(detail) {
    document.dispatchEvent(new CustomEvent(CHANNEL, { detail }));
  }

  // -------------------------------------------------------------------------
  // Interception — passive discovery as the user browses
  // Uses PerformanceObserver + fetch/XHR patching (with SES retry)
  // -------------------------------------------------------------------------
  interceptFetch(function onVideosPassivelyDiscovered(videos) {
    dispatchToIsolated({ type: 'VIDEOS_DISCOVERED', videos });
    console.log(
      '[SoraArchiver/main] Passively discovered ' + videos.length + ' video(s); forwarding.'
    );
  });
  console.log('[SoraArchiver/main] Interception active (PerformanceObserver + fetch/XHR).');

  // -------------------------------------------------------------------------
  // Active library scan — triggered by a CustomEvent from the isolated world
  // -------------------------------------------------------------------------
  async function runLibraryScan() {
    console.log('[SoraArchiver/main] Starting active library scan…');

    const authInfo = extractAuthToken();

    if (!authInfo) {
      console.warn(
        '[SoraArchiver/main] Auth token not found. ' +
        'Passive interception still active; browsing the library will discover videos.'
      );
      dispatchToIsolated({ type: 'SCAN_NO_AUTH' });
      return;
    }

    try {
      const total = await fetchVideoLibrary(authInfo, function onBatch(batch) {
        dispatchToIsolated({ type: 'VIDEOS_DISCOVERED', videos: batch });
      });
      console.log(`[SoraArchiver/main] Active scan complete — ${total} video(s) found.`);
      dispatchToIsolated({ type: 'SCAN_COMPLETE', total });
    } catch (err) {
      console.error('[SoraArchiver/main] Active scan failed:', err);
      dispatchToIsolated({ type: 'SCAN_ERROR', message: err.message });
    }
  }

  // -------------------------------------------------------------------------
  // Listen for commands coming FROM the isolated world
  // -------------------------------------------------------------------------
  document.addEventListener(CHANNEL + '_cmd', function (evt) {
    if (!evt.detail || !evt.detail.type) return;
    if (evt.detail.type === 'SCAN_LIBRARY') {
      runLibraryScan().catch(function (err) {
        console.error('[SoraArchiver/main] Unhandled scan error:', err);
      });
    }
  });

  console.log('[SoraArchiver/main] Ready on', window.location.href);
})();
