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
  // Passive discovery callback — shared by all strategies
  // -------------------------------------------------------------------------
  function onVideosPassivelyDiscovered(videos) {
    dispatchToIsolated({ type: 'VIDEOS_DISCOVERED', videos });
    console.log(
      '[SoraArchiver/main] Discovered ' + videos.length + ' video(s); forwarding.'
    );
  }

  // -------------------------------------------------------------------------
  // Strategy A: Network interception (PerformanceObserver + fetch/XHR patch)
  // -------------------------------------------------------------------------
  interceptFetch(onVideosPassivelyDiscovered);
  console.log('[SoraArchiver/main] Network interception active.');

  // -------------------------------------------------------------------------
  // Strategy B: DOM scraping — find <video> elements with videos.openai.com URLs
  // This is the most reliable strategy and works regardless of SES lockdown.
  // -------------------------------------------------------------------------
  var rescanDOM = null;

  function initDOMScraper() {
    if (rescanDOM) return; // already initialized
    if (!document.body) {
      // Body not ready yet — retry
      setTimeout(initDOMScraper, 200);
      return;
    }
    rescanDOM = scrapeVideosFromDOM(onVideosPassivelyDiscovered);
    console.log('[SoraArchiver/main] DOM scraper active — watching for video elements.');
  }

  // Start DOM scraping when body is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initDOMScraper);
  } else {
    initDOMScraper();
  }

  // -------------------------------------------------------------------------
  // Active library scan — triggered by a CustomEvent from the isolated world
  // -------------------------------------------------------------------------
  async function runLibraryScan() {
    console.log('[SoraArchiver/main] Starting active library scan…');

    // Always do a DOM rescan first — this is the most reliable method
    var domCount = 0;
    if (rescanDOM) {
      domCount = rescanDOM();
      console.log('[SoraArchiver/main] DOM rescan found ' + domCount + ' video URL(s).');
    }

    // Then try the API-based scan
    var authInfo = extractAuthToken();

    if (!authInfo) {
      // If DOM scraping found videos, that's still a success
      if (domCount > 0) {
        console.log('[SoraArchiver/main] No API auth, but DOM scraping found ' + domCount + ' video(s).');
        dispatchToIsolated({ type: 'SCAN_COMPLETE', total: domCount });
        return;
      }
      console.warn(
        '[SoraArchiver/main] Auth token not found and no videos in DOM. ' +
        'Browse your Sora library to discover videos.'
      );
      dispatchToIsolated({ type: 'SCAN_NO_AUTH' });
      return;
    }

    try {
      var apiTotal = await fetchVideoLibrary(authInfo, function onBatch(batch) {
        dispatchToIsolated({ type: 'VIDEOS_DISCOVERED', videos: batch });
      });
      var total = Math.max(apiTotal, domCount);
      console.log('[SoraArchiver/main] Active scan complete — ' + total + ' video(s) found (API: ' + apiTotal + ', DOM: ' + domCount + ').');
      dispatchToIsolated({ type: 'SCAN_COMPLETE', total: total });
    } catch (err) {
      // API scan failed, but DOM scraping may have found videos
      if (domCount > 0) {
        console.warn('[SoraArchiver/main] API scan failed but DOM found ' + domCount + ' video(s).');
        dispatchToIsolated({ type: 'SCAN_COMPLETE', total: domCount });
      } else {
        console.error('[SoraArchiver/main] Active scan failed:', err);
        dispatchToIsolated({ type: 'SCAN_ERROR', message: err.message });
      }
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
