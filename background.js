// background.js — Service worker for the Sora Video Archiver extension.
// Handles download orchestration, message routing between popup and content scripts,
// and manages the download queue with concurrency and throttle controls.
//
// Constants and archive utilities are loaded via importScripts from the shared
// lib/ modules.  importScripts() is synchronous and reliable for local files in
// Chrome MV3 service workers when called at the top level.

importScripts('lib/constants.js', 'lib/archive.js', 'lib/api-client.js');

'use strict';

// ---------------------------------------------------------------------------
// Module-level state
// ---------------------------------------------------------------------------

/** All videos discovered across all scans, keyed by video id. */
let discoveredVideos = {}; // { [id]: videoObject }

/** User-configurable settings loaded from storage. */
let settings = { ...DEFAULT_SETTINGS };

/** Singleton DownloadManager — created on first START_DOWNLOAD. */
let downloadManager = null;

/** True while the content script is scanning the library. */
let isScanning = false;

// ---------------------------------------------------------------------------
// Service worker keepalive (MV3 — 30s idle timeout guard)
// ---------------------------------------------------------------------------

/**
 * Interval handle used by startKeepAlive / stopKeepAlive.
 * Accessing chrome.storage every 25 s prevents SW termination during
 * active operations (scanning and downloading).
 */
let keepAliveInterval = null;

function startKeepAlive() {
  if (keepAliveInterval) return;
  keepAliveInterval = setInterval(() => {
    chrome.storage.local.get(['__keepalive']);
  }, 25000);
}

function stopKeepAlive() {
  if (keepAliveInterval) {
    clearInterval(keepAliveInterval);
    keepAliveInterval = null;
  }
}

// ---------------------------------------------------------------------------
// DownloadManager
// ---------------------------------------------------------------------------

class DownloadManager {
  /**
   * @param {number} maxConcurrent  Max simultaneous chrome.downloads calls.
   */
  constructor(maxConcurrent = DEFAULT_SETTINGS.MAX_CONCURRENT_DOWNLOADS) {
    /** @type {Array<object>} Videos waiting to be downloaded. */
    this.queue = [];

    /** @type {Map<string, { downloadId: number, video: object }>}
     *  videoId -> active download info */
    this.active = new Map();

    /** @type {Object.<string, { status: string, downloadId: number|null, error: string|null, filename: string|null }>}
     *  videoId -> result record */
    this.results = {};

    this.maxConcurrent = maxConcurrent;
    this.isPaused = false;
    this._processing = false;
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Add a single video to the download queue and kick off processing.
   * @param {object} video
   */
  enqueue(video) {
    if (this._isTracked(video.id)) return;
    this.results[video.id] = {
      status:     VIDEO_STATUS.QUEUED,
      downloadId: null,
      error:      null,
      filename:   null,
    };
    this.queue.push(video);
    this._safeProcessNext();
    persistState();
  }

  /**
   * Add multiple videos, skipping any already tracked (in queue / active /
   * results).  Calls processNext() once after all videos are enqueued.
   * @param {object[]} videos
   */
  enqueueAll(videos) {
    let added = 0;
    for (const video of videos) {
      if (this._isTracked(video.id)) continue;

      // Skip videos with no downloadable URL (failed generations, etc.)
      if (!video.video_url) {
        this.results[video.id] = {
          status:     VIDEO_STATUS.SKIPPED,
          downloadId: null,
          error:      'No video_url available',
          filename:   null,
        };
        continue;
      }

      this.results[video.id] = {
        status:     VIDEO_STATUS.QUEUED,
        downloadId: null,
        error:      null,
        filename:   null,
      };
      this.queue.push(video);
      added++;
    }
    if (added > 0) {
      console.log(`[SoraArchiver/bg] Enqueued ${added} new video(s).`);
      this._safeProcessNext();
      persistState();
    }
  }

  /**
   * Start the next download(s) if slots are available.
   * Safe to call any time — returns early when conditions aren't met.
   */
  async processNext() {
    while (
      !this.isPaused &&
      this.active.size < this.maxConcurrent &&
      this.queue.length > 0
    ) {
      const video = this.queue.shift();

      // Guard: video may have been cancelled or already completed externally.
      if (this.results[video.id] &&
          this.results[video.id].status !== VIDEO_STATUS.QUEUED) {
        continue;
      }

      this.results[video.id].status = VIDEO_STATUS.DOWNLOADING;

      const filename = `${DEFAULT_SETTINGS.DOWNLOAD_FOLDER}/${sanitizeFilename(video)}.mp4`;
      this.results[video.id].filename = filename;

      try {
        const downloadId = await new Promise((resolve, reject) => {
          chrome.downloads.download(
            {
              url:            video.video_url,
              filename,
              conflictAction: 'uniquify',
            },
            (id) => {
              if (chrome.runtime.lastError) {
                reject(new Error(chrome.runtime.lastError.message));
              } else {
                resolve(id);
              }
            }
          );
        });

        this.results[video.id].downloadId = downloadId;
        this.active.set(video.id, { downloadId, video });
        console.log(
          `[SoraArchiver/bg] Started download ${downloadId} for video ${video.id}`
        );
      } catch (err) {
        console.error(
          `[SoraArchiver/bg] Failed to start download for ${video.id}:`, err
        );
        // TODO: Expired CDN URLs — if err indicates a 403/410-like auth failure,
        // we'd ideally ask the content script to re-fetch a fresh signed URL for
        // this video before marking it failed.  For now, mark as failed so the
        // user can retry after refreshing the Sora page (which re-fetches URLs).
        this.results[video.id].status = VIDEO_STATUS.FAILED;
        this.results[video.id].error  = err.message;
      }

      persistState();
      broadcastProgress();
    }
  }

  /**
   * Handler for chrome.downloads.onChanged events.
   * Looks up which video owns the changed download and updates state.
   * @param {chrome.downloads.DownloadDelta} delta
   */
  onDownloadChanged(delta) {
    // Find the video id that owns this chrome download id.
    let videoId = null;
    for (const [vid, info] of this.active.entries()) {
      if (info.downloadId === delta.id) {
        videoId = vid;
        break;
      }
    }
    if (!videoId) return; // Not one of ours.

    if (delta.state) {
      if (delta.state.current === 'complete') {
        this._markCompleted(videoId);
      } else if (delta.state.current === 'interrupted') {
        const reason = delta.error ? delta.error.current : 'UNKNOWN';
        this._markFailed(videoId, `Interrupted: ${reason}`);
      }
    } else if (delta.error && delta.error.current) {
      this._markFailed(videoId, delta.error.current);
    }
  }

  /**
   * Return a progress summary suitable for sending to the popup.
   * @returns {{ total: number, completed: number, failed: number, downloading: number, queued: number, videos: object }}
   */
  getProgress() {
    let completed = 0, failed = 0, downloading = 0, queued = 0;
    for (const r of Object.values(this.results)) {
      switch (r.status) {
        case VIDEO_STATUS.COMPLETED:   completed++;   break;
        case VIDEO_STATUS.FAILED:      failed++;      break;
        case VIDEO_STATUS.DOWNLOADING: downloading++; break;
        case VIDEO_STATUS.QUEUED:      queued++;      break;
      }
    }
    return {
      total:       Object.keys(this.results).length,
      completed,
      failed,
      downloading,
      queued,
      isPaused:    this.isPaused,
      videos:      this.results,
    };
  }

  /**
   * Re-queue all videos that are currently marked as FAILED.
   */
  retryFailed() {
    let retried = 0;
    for (const [videoId, result] of Object.entries(this.results)) {
      if (result.status !== VIDEO_STATUS.FAILED) continue;
      // Recover the video object from discoveredVideos.
      const video = discoveredVideos[videoId];
      if (!video) continue;
      result.status     = VIDEO_STATUS.QUEUED;
      result.error      = null;
      result.downloadId = null;
      this.queue.push(video);
      retried++;
    }
    if (retried > 0) {
      console.log(`[SoraArchiver/bg] Retrying ${retried} failed download(s).`);
      this._safeProcessNext();
      persistState();
      broadcastProgress();
    }
    return retried;
  }

  /** Pause the download queue (in-flight downloads are NOT cancelled). */
  pause() {
    this.isPaused = true;
    console.log('[SoraArchiver/bg] Download queue paused.');
    broadcastProgress();
  }

  /** Resume the download queue and start processing. */
  resume() {
    this.isPaused = false;
    console.log('[SoraArchiver/bg] Download queue resumed.');
    this._safeProcessNext();
    broadcastProgress();
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Safe wrapper around processNext that prevents re-entrant execution
   * and catches unhandled rejections.
   */
  _safeProcessNext() {
    if (this._processing) return;
    this._processing = true;
    this.processNext()
      .catch((err) => {
        console.error('[SoraArchiver/bg] processNext error:', err);
      })
      .finally(() => {
        this._processing = false;
      });
  }

  _isTracked(videoId) {
    if (this.active.has(videoId)) return true;
    if (videoId in this.results) return true;
    return this.queue.some((v) => v.id === videoId);
  }

  _markCompleted(videoId) {
    const info = this.active.get(videoId);
    if (!info) return;
    this.active.delete(videoId);
    this.results[videoId].status = VIDEO_STATUS.COMPLETED;
    console.log(`[SoraArchiver/bg] Download complete: ${videoId}`);
    persistState();
    broadcastProgress();
    this._safeProcessNext();
  }

  _markFailed(videoId, reason) {
    const info = this.active.get(videoId);
    if (!info) return;
    this.active.delete(videoId);
    this.results[videoId].status = VIDEO_STATUS.FAILED;
    this.results[videoId].error  = reason || 'Unknown error';
    console.warn(`[SoraArchiver/bg] Download failed: ${videoId} — ${reason}`);
    persistState();
    broadcastProgress();
    this._safeProcessNext();
  }
}

// ---------------------------------------------------------------------------
// Filename sanitizer
// ---------------------------------------------------------------------------

/**
 * Build a safe filesystem filename stem from a video object.
 * Returns "<id>_<sanitized_prompt_slug>" when a prompt exists, or just "<id>"
 * if the prompt is absent or empty after sanitization (no extension).
 * @param {object} video  Must have .id and optionally .prompt
 * @returns {string}
 */
function sanitizeFilename(video) {
  const prompt = (video.prompt || '').slice(0, 60)
    .replace(/[^a-zA-Z0-9 ]/g, '')
    .trim()
    .replace(/\s+/g, '_');
  return prompt ? `${video.id}_${prompt}` : video.id;
}

// ---------------------------------------------------------------------------
// State persistence
// ---------------------------------------------------------------------------

/**
 * Persist the current download results and discovered videos to
 * chrome.storage.local so they survive service worker restarts.
 */
function persistState() {
  const toStore = {
    discoveredVideos:  Object.values(discoveredVideos),
    downloadResults:   downloadManager ? downloadManager.results : {},
    settings,
  };
  chrome.storage.local.set(toStore).catch((err) => {
    console.error('[SoraArchiver/bg] Failed to persist state:', err);
  });
}

/**
 * Restore state from chrome.storage.local on service worker startup.
 * Called once at the top level so downloads survive SW restarts.
 */
async function restoreState() {
  try {
    const stored = await chrome.storage.local.get([
      'discoveredVideos',
      'downloadResults',
      'settings',
    ]);

    // Restore settings first so DownloadManager gets the right concurrency.
    if (stored.settings) {
      settings = { ...DEFAULT_SETTINGS, ...stored.settings };
    }

    // Rebuild the discoveredVideos map.
    if (Array.isArray(stored.discoveredVideos)) {
      for (const v of stored.discoveredVideos) {
        discoveredVideos[v.id] = v;
      }
      console.log(
        `[SoraArchiver/bg] Restored ${stored.discoveredVideos.length} discovered video(s).`
      );
    }

    // If there were in-progress downloads when the SW was killed, reinitialise
    // the manager with their results so the popup can show the right state.
    // We do NOT resume active/queued downloads automatically — the user should
    // press "Start" again.  Downloads that were in flight are marked FAILED so
    // the user can retry them.
    if (stored.downloadResults && Object.keys(stored.downloadResults).length) {
      downloadManager = new DownloadManager(
        settings.MAX_CONCURRENT_DOWNLOADS
      );
      downloadManager.results = stored.downloadResults;

      // Any DOWNLOADING status at restore time means the SW was killed mid-
      // download — treat those as failed so they can be retried.
      for (const result of Object.values(downloadManager.results)) {
        if (result.status === VIDEO_STATUS.DOWNLOADING) {
          result.status = VIDEO_STATUS.FAILED;
          result.error  = 'Service worker restarted';
        }
      }

      console.log('[SoraArchiver/bg] Restored previous download results.');
    }
  } catch (err) {
    console.error('[SoraArchiver/bg] Failed to restore state:', err);
  }
}

// ---------------------------------------------------------------------------
// Broadcast helper
// ---------------------------------------------------------------------------

/**
 * Send a DOWNLOAD_PROGRESS message to the popup (and any other extension
 * views).  Silently swallows "no receiver" errors — the popup may be closed.
 * Also broadcasts DOWNLOAD_COMPLETE when the queue drains entirely, and
 * stops the keepalive interval at that point.
 */
function broadcastProgress() {
  if (!downloadManager) return;
  const progress = downloadManager.getProgress();
  chrome.runtime.sendMessage({
    type: MESSAGE_TYPES.DOWNLOAD_PROGRESS,
    ...progress,
  }).catch(() => {
    // Popup may not be open — this is expected and harmless.
  });

  // Notify listeners that all downloads have finished.
  if (progress.total > 0 && progress.queued === 0 && progress.downloading === 0) {
    chrome.runtime.sendMessage({
      type: MESSAGE_TYPES.DOWNLOAD_COMPLETE,
      ...progress,
    }).catch(() => {});
    stopKeepAlive();
  }
}

// ---------------------------------------------------------------------------
// chrome.downloads.onChanged — global download state tracker
// ---------------------------------------------------------------------------

chrome.downloads.onChanged.addListener(function (delta) {
  if (downloadManager) {
    downloadManager.onDownloadChanged(delta);
  }
});

// ---------------------------------------------------------------------------
// chrome.runtime.onMessage — handle messages from popup and content scripts
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener(function (message, _sender, sendResponse) {
  if (!message || !message.type) return false;

  switch (message.type) {

    // -----------------------------------------------------------------------
    // VIDEOS_DISCOVERED — forwarded from content.js (isolated world)
    // -----------------------------------------------------------------------
    case MESSAGE_TYPES.VIDEOS_DISCOVERED: {
      const incoming = Array.isArray(message.videos) ? message.videos : [];
      let added = 0;
      for (const video of incoming) {
        if (!video.id) continue;
        if (!(video.id in discoveredVideos)) {
          discoveredVideos[video.id] = video;
          added++;
        }
      }

      const total = Object.keys(discoveredVideos).length;
      if (added > 0) {
        console.log(
          `[SoraArchiver/bg] VIDEOS_DISCOVERED: +${added} new, ` +
          `${total} total in manifest.`
        );
        persistState();
      }

      // Broadcast the updated count to any open popup.
      chrome.runtime.sendMessage({
        type:           MESSAGE_TYPES.VIDEOS_DISCOVERED,
        videosDiscovered: total,
        addedThisBatch:   added,
      }).catch(() => {});

      sendResponse({ ok: true, total });
      return false;
    }

    // -----------------------------------------------------------------------
    // START_DOWNLOAD — user pressed "Download All" in the popup
    // -----------------------------------------------------------------------
    case MESSAGE_TYPES.START_DOWNLOAD: {
      if (!downloadManager) {
        downloadManager = new DownloadManager(settings.MAX_CONCURRENT_DOWNLOADS);
      }

      const videos = Object.values(discoveredVideos);
      if (videos.length === 0) {
        sendResponse({ ok: false, error: 'No videos discovered yet.' });
        return false;
      }

      startKeepAlive();
      downloadManager.enqueueAll(videos);
      broadcastProgress();
      sendResponse({ ok: true, queued: videos.length });
      return false;
    }

    // -----------------------------------------------------------------------
    // PAUSE_DOWNLOAD — user pressed "Pause" in the popup
    // -----------------------------------------------------------------------
    case MESSAGE_TYPES.PAUSE_DOWNLOAD:
      if (downloadManager) downloadManager.pause();
      sendResponse({ ok: true });
      return false;

    // -----------------------------------------------------------------------
    // RESUME_DOWNLOAD — user pressed "Resume" in the popup
    // -----------------------------------------------------------------------
    case MESSAGE_TYPES.RESUME_DOWNLOAD:
      if (downloadManager) {
        startKeepAlive();
        downloadManager.resume();
      }
      sendResponse({ ok: true });
      return false;

    // -----------------------------------------------------------------------
    // RETRY_FAILED — user pressed "Retry Failed" in the popup
    // -----------------------------------------------------------------------
    case MESSAGE_TYPES.RETRY_FAILED:
      if (downloadManager) {
        startKeepAlive();
        const retried = downloadManager.retryFailed();
        sendResponse({ ok: true, retried });
      } else {
        sendResponse({ ok: false, error: 'No download manager active' });
      }
      return false;

    // -----------------------------------------------------------------------
    // GET_STATUS — popup requesting current state
    // -----------------------------------------------------------------------
    case MESSAGE_TYPES.GET_STATUS: {
      const videosCount = Object.keys(discoveredVideos).length;
      const progress    = downloadManager
        ? downloadManager.getProgress()
        : { total: 0, completed: 0, failed: 0, downloading: 0, queued: 0, videos: {} };

      sendResponse({
        ok:               true,
        videosDiscovered: videosCount,
        isScanning,
        ...progress,
      });
      return false;
    }

    // -----------------------------------------------------------------------
    // EXPORT_MANIFEST — generate and download a JSON or CSV manifest file
    // -----------------------------------------------------------------------
    case MESSAGE_TYPES.EXPORT_MANIFEST: {
      const format   = message.format === 'csv' ? 'csv' : 'json';
      const results  = downloadManager ? downloadManager.results : {};
      let dataUrl, filename;

      if (format === 'csv') {
        const csvString = buildManifestCSV(discoveredVideos, results);
        dataUrl  = 'data:text/csv;charset=utf-8,' + encodeURIComponent(csvString);
        filename = `${DEFAULT_SETTINGS.DOWNLOAD_FOLDER}/manifest.csv`;
      } else {
        const manifest = buildManifestJSON(discoveredVideos, results);
        const json     = JSON.stringify(manifest, null, 2);
        dataUrl  = 'data:application/json;charset=utf-8,' + encodeURIComponent(json);
        filename = `${DEFAULT_SETTINGS.DOWNLOAD_FOLDER}/manifest.json`;
      }

      chrome.downloads.download({
        url:            dataUrl,
        filename,
        conflictAction: 'uniquify',
        saveAs:         false,
      }, (id) => {
        if (chrome.runtime.lastError) {
          sendResponse({ ok: false, error: chrome.runtime.lastError.message });
        } else {
          sendResponse({ ok: true, downloadId: id });
        }
      });

      return true; // async response
    }

    // -----------------------------------------------------------------------
    // SCAN_LIBRARY — forward to the active Sora tab's content script
    // -----------------------------------------------------------------------
    case MESSAGE_TYPES.SCAN_LIBRARY: {
      isScanning = true;
      startKeepAlive();

      chrome.tabs.query(
        { url: ['https://sora.com/*', 'https://sora.chatgpt.com/*'] },
        function (tabs) {
          if (!tabs || tabs.length === 0) {
            isScanning = false;
            stopKeepAlive();
            sendResponse({
              ok:    false,
              error: 'No active Sora tab found. Open sora.chatgpt.com first.',
            });
            return;
          }

          // Send to the first matching tab.  The scan runs asynchronously in
          // content-main.js; isScanning stays true until a SCAN_STATUS message
          // arrives from content.js when the scan completes or errors out.
          chrome.tabs.sendMessage(
            tabs[0].id,
            { type: MESSAGE_TYPES.SCAN_LIBRARY },
            function (response) {
              if (chrome.runtime.lastError) {
                isScanning = false;
                stopKeepAlive();
                sendResponse({
                  ok:    false,
                  error: chrome.runtime.lastError.message,
                });
              } else {
                // scan_started — keep isScanning = true; SCAN_STATUS will clear it.
                sendResponse(response || { ok: true });
              }
            }
          );
        }
      );
      return true; // async response
    }

    // -----------------------------------------------------------------------
    // SCAN_STATUS — sent by content.js when the async scan finishes or fails
    // -----------------------------------------------------------------------
    case MESSAGE_TYPES.SCAN_STATUS: {
      isScanning = false;
      stopKeepAlive();
      sendResponse({ ok: true });
      return false;
    }

    default:
      return false;
  }
});

// ---------------------------------------------------------------------------
// Service worker lifecycle
// ---------------------------------------------------------------------------

// Restore persisted state when the service worker starts (or restarts).
restoreState().then(() => {
  console.log('[SoraArchiver/bg] Service worker ready.');
});
