// content.js — Runs in the default ISOLATED world (see manifest.json).
// Has access to chrome.runtime APIs but shares NO window with the page.
//
// Responsibilities:
//   1. Listen for CustomEvents from content-main.js (MAIN world) and forward
//      video data / status updates to the background service worker.
//   2. Handle chrome.runtime.onMessage commands from the popup / background
//      (SCAN_LIBRARY, GET_STATUS) by either dispatching a CustomEvent command
//      to content-main.js or responding directly with cached status.
//
// Execution context: lib/constants.js is loaded first (same content_scripts
// entry), so MESSAGE_TYPES and DEFAULT_SETTINGS are available as globals.

(function soraArchiverContentScript() {
  'use strict';

  // -------------------------------------------------------------------------
  // CustomEvent channel names (shared with content-main.js)
  // -------------------------------------------------------------------------
  const CHANNEL     = '__sora_archiver';      // main  → isolated
  const CHANNEL_CMD = '__sora_archiver_cmd';  // isolated → main

  // -------------------------------------------------------------------------
  // Internal state
  // -------------------------------------------------------------------------
  let scanStatus = 'idle'; // 'idle' | 'scanning' | 'done' | 'error'
  let videosFound = 0;
  let scanError   = null;

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  /** Send a message to the background service worker (fire-and-forget). */
  function sendToBackground(type, payload) {
    try {
      chrome.runtime.sendMessage({ type, ...payload });
    } catch (err) {
      // Extension context may be invalidated during page navigation — ignore.
      console.warn('[SoraArchiver] sendMessage failed:', err.message);
    }
  }

  /** Dispatch a command CustomEvent toward the MAIN world (content-main.js). */
  function dispatchToMain(detail) {
    document.dispatchEvent(new CustomEvent(CHANNEL_CMD, { detail }));
  }

  // -------------------------------------------------------------------------
  // Listen for events from the MAIN world (content-main.js)
  // -------------------------------------------------------------------------
  document.addEventListener(CHANNEL, function (evt) {
    if (!evt.detail || !evt.detail.type) return;

    switch (evt.detail.type) {
      case 'VIDEOS_DISCOVERED': {
        const videos = evt.detail.videos;
        if (!videos || !videos.length) break;
        videosFound += videos.length;
        sendToBackground(MESSAGE_TYPES.VIDEOS_DISCOVERED, { videos });
        console.log(
          `[SoraArchiver] Forwarded ${videos.length} video(s) to background ` +
          `(total: ${videosFound})`
        );
        break;
      }

      case 'SCAN_NO_AUTH':
        // Auth token not yet available — stay idle; passive interception handles discovery.
        scanStatus = 'idle';
        console.warn(
          '[SoraArchiver] Auth token not found. ' +
          'Browse the Sora library page to trigger passive video discovery.'
        );
        sendToBackground(MESSAGE_TYPES.SCAN_STATUS, { status: 'no_auth' });
        break;

      case 'SCAN_COMPLETE':
        scanStatus = 'done';
        console.log(
          `[SoraArchiver] Library scan complete. ${evt.detail.total} video(s) discovered.`
        );
        sendToBackground(MESSAGE_TYPES.SCAN_STATUS, { status: 'done', total: evt.detail.total });
        break;

      case 'SCAN_ERROR':
        scanStatus = 'error';
        scanError  = evt.detail.message || 'Unknown error';
        console.error('[SoraArchiver] Library scan failed:', scanError);
        sendToBackground(MESSAGE_TYPES.SCAN_STATUS, { status: 'error', error: scanError });
        break;

      default:
        break;
    }
  });

  // -------------------------------------------------------------------------
  // Message listener — handle commands from the popup / background
  // -------------------------------------------------------------------------
  chrome.runtime.onMessage.addListener(function (message, _sender, sendResponse) {
    if (!message || !message.type) return false;

    switch (message.type) {
      case MESSAGE_TYPES.SCAN_LIBRARY:
        if (scanStatus === 'scanning') {
          console.log('[SoraArchiver] Scan already in progress — ignoring duplicate request.');
          sendResponse({ ok: true, status: 'already_scanning' });
          return false;
        }
        // Transition to scanning and delegate to the MAIN world.
        scanStatus = 'scanning';
        scanError  = null;
        dispatchToMain({ type: 'SCAN_LIBRARY' });
        sendResponse({ ok: true, status: 'scan_started' });
        return false;

      case MESSAGE_TYPES.GET_STATUS:
        sendResponse({
          ok: true,
          status: scanStatus,
          videosFound,
          error: scanError,
        });
        return false;

      default:
        return false;
    }
  });

  console.log('[SoraArchiver] Content script (isolated world) ready on', window.location.href);
})();
