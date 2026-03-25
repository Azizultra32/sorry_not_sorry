// popup.js — UI logic for the Sora Video Archiver popup.
// Communicates with the background service worker to trigger scans,
// display download progress, and allow the user to export the archive manifest.
//
// Depends on MESSAGE_TYPES and VIDEO_STATUS from ../lib/constants.js, which is
// loaded via a <script> tag in popup.html before this file.

'use strict';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/** Whether we are in the paused state. */
let isPaused = false;

/** The last received progress snapshot from the background. */
let lastStatus = {
  videosDiscovered: 0,
  total:            0,
  completed:        0,
  failed:           0,
  downloading:      0,
  queued:           0,
  isPaused:         false,
  videos:           {},
};

// ---------------------------------------------------------------------------
// State machine
// ---------------------------------------------------------------------------

/**
 * Determine which UI state to show based on the presence of a Sora tab and
 * the current download/scan status.
 *
 * @param {boolean} hasSoraTab
 * @param {object}  status  — shape returned by GET_STATUS / DOWNLOAD_PROGRESS
 * @returns {'not-on-sora'|'scanning'|'ready'|'downloading'|'complete'}
 */
function determineState(hasSoraTab, status) {
  if (!hasSoraTab) return 'not-on-sora';
  // If scanning but we already have discovered videos, show 'ready' so
  // download buttons remain visible (with scan indicator updated via scan-count).
  if (status.isScanning && (status.videosDiscovered || 0) > 0) return 'ready';
  if (status.isScanning) return 'scanning';
  if (status.downloading > 0 || status.queued > 0) return 'downloading';
  if ((status.completed > 0 || status.failed > 0) && status.queued === 0 && status.downloading === 0) return 'complete';
  if (status.videosDiscovered > 0) return 'ready';
  // On Sora tab but no videos found yet — show ready state with scan button
  return 'ready';
}

// ---------------------------------------------------------------------------
// DOM helpers
// ---------------------------------------------------------------------------

/**
 * Switch the visible state section.
 * @param {'not-on-sora'|'scanning'|'ready'|'downloading'|'complete'} stateName
 */
function showState(stateName) {
  const stateIds = [
    'state-not-on-sora',
    'state-scanning',
    'state-ready',
    'state-downloading',
    'state-complete',
  ];
  for (const id of stateIds) {
    const el = document.getElementById(id);
    if (el) {
      el.classList.remove('active');
      el.hidden = true;
    }
  }
  const target = document.getElementById(`state-${stateName}`);
  if (target) {
    target.hidden = false;
    target.classList.add('active');
  }
}

/** @param {string} id  @param {string|number} val */
function setText(id, val) {
  const el = document.getElementById(id);
  if (el) el.textContent = String(val);
}

/** @param {string} id  @param {boolean} hidden */
function setHidden(id, hidden) {
  const el = document.getElementById(id);
  if (el) el.hidden = hidden;
}

// ---------------------------------------------------------------------------
// Progress rendering
// ---------------------------------------------------------------------------

/**
 * Update all progress-related DOM elements from a status object.
 * @param {object} status
 */
function renderProgress(status) {
  const { total, completed, failed, downloading, queued } = status;
  const done    = completed + failed;
  const percent = total > 0 ? Math.round((done / total) * 100) : 0;

  setText('dl-progress-text', `${done} of ${total}`);
  setText('dl-percent', `${percent}%`);

  const fill = document.getElementById('dl-progress-fill');
  if (fill) fill.style.width = `${percent}%`;

  setText('dl-completed', completed);
  setText('dl-failed',    failed);
  setText('dl-queued',    queued + downloading);

  // Show/hide "Retry Failed" button in downloading state
  setHidden('btn-retry', failed === 0);

  // Update pause button label
  const pauseBtn = document.getElementById('btn-pause');
  if (pauseBtn) {
    pauseBtn.textContent = status.isPaused ? 'Resume' : 'Pause';
  }

  if (status.videos) {
    renderVideoList(status.videos);
  }
}

/**
 * Render the scrollable video list.
 * @param {Object.<string, {status: string, filename: string|null}>} videos
 */
function renderVideoList(videos) {
  const list = document.getElementById('video-list');
  if (!list) return;

  list.innerHTML = '';

  for (const [videoId, result] of Object.entries(videos)) {
    const item = document.createElement('div');
    const statusLower = (result.status || '').toLowerCase();
    item.className = `video-item ${statusLower}`;

    const icon =
      result.status === VIDEO_STATUS.COMPLETED   ? '✓' :
      result.status === VIDEO_STATUS.FAILED       ? '✗' :
      result.status === VIDEO_STATUS.DOWNLOADING  ? '↓' : '⋯';

    // Prefer the filename slug; fall back to video id.
    const label = result.filename
      ? result.filename.replace(/^sora-archive\//, '')
      : videoId;

    item.textContent = `${icon} ${label}`;
    list.appendChild(item);
  }
}

// ---------------------------------------------------------------------------
// Full UI refresh
// ---------------------------------------------------------------------------

/**
 * Refresh the entire popup UI from a combined status + hasSoraTab value.
 * @param {boolean} hasSoraTab
 * @param {object}  status
 */
function refreshUI(hasSoraTab, status) {
  lastStatus = { ...lastStatus, ...status };
  isPaused   = !!status.isPaused;

  const state = determineState(hasSoraTab, lastStatus);
  showState(state);

  switch (state) {
    case 'scanning':
      setText('scan-count', lastStatus.videosDiscovered || 0);
      break;

    case 'ready':
      setText('total-count', lastStatus.videosDiscovered || lastStatus.total || 0);
      break;

    case 'downloading':
      renderProgress(lastStatus);
      break;

    case 'complete': {
      const { completed, failed } = lastStatus;
      setText('complete-count', completed);
      setText('complete-failed-count', failed);
      setHidden('complete-failed', failed === 0);
      setHidden('btn-retry-final', failed === 0);
      break;
    }

    default:
      break;
  }
}

// ---------------------------------------------------------------------------
// Message helpers
// ---------------------------------------------------------------------------

/**
 * Send a message to the background service worker.
 * Returns a promise that resolves with the response.
 * @param {object} msg
 * @returns {Promise<object>}
 */
function sendMessage(msg) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(msg, (response) => {
      if (chrome.runtime.lastError) {
        console.warn('[SoraArchiver/popup]', chrome.runtime.lastError.message);
        resolve({ ok: false, error: chrome.runtime.lastError.message });
      } else {
        resolve(response || { ok: true });
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Button handlers
// ---------------------------------------------------------------------------

function onScanClick() {
  // Hide any previous error
  setHidden('error-banner', true);

  lastStatus.isScanning = true;
  showState('scanning');
  setText('scan-count', 0);
  sendMessage({ type: MESSAGE_TYPES.SCAN_LIBRARY }).then((resp) => {
    lastStatus.isScanning = false;
    if (!resp.ok) {
      console.error('[SoraArchiver/popup] Scan error:', resp.error);
      if (resp.error && (resp.error.includes('Receiving end does not exist') ||
                         resp.error.includes('Could not establish connection'))) {
        // Content script not injected — show error banner
        setHidden('error-banner', false);
        showState('ready');
        return;
      }
    }
    // Re-evaluate state now that scanning is done.
    refreshUI(true, lastStatus);
  });
}

function onDownloadAllClick() {
  sendMessage({ type: MESSAGE_TYPES.START_DOWNLOAD }).then((resp) => {
    if (resp.ok) {
      showState('downloading');
    } else {
      console.error('[SoraArchiver/popup] Start download error:', resp.error);
    }
  });
}

function onExportJson() {
  sendMessage({ type: MESSAGE_TYPES.EXPORT_MANIFEST, format: 'json' });
}

function onExportCsv() {
  sendMessage({ type: MESSAGE_TYPES.EXPORT_MANIFEST, format: 'csv' });
}

function onPauseResume() {
  if (isPaused) {
    sendMessage({ type: MESSAGE_TYPES.RESUME_DOWNLOAD });
    isPaused = false;
  } else {
    sendMessage({ type: MESSAGE_TYPES.PAUSE_DOWNLOAD });
    isPaused = true;
  }
  const pauseBtn = document.getElementById('btn-pause');
  if (pauseBtn) pauseBtn.textContent = isPaused ? 'Resume' : 'Pause';
}

function onRetryFailed() {
  sendMessage({ type: MESSAGE_TYPES.RETRY_FAILED });
}

// ---------------------------------------------------------------------------
// Real-time progress listener
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener(function (message) {
  if (!message || !message.type) return;

  if (message.type === MESSAGE_TYPES.DOWNLOAD_PROGRESS) {
    // Update status and re-evaluate which state to show.
    const updated = {
      total:       message.total       ?? lastStatus.total,
      completed:   message.completed   ?? lastStatus.completed,
      failed:      message.failed      ?? lastStatus.failed,
      downloading: message.downloading ?? lastStatus.downloading,
      queued:      message.queued      ?? lastStatus.queued,
      isPaused:    message.isPaused    ?? lastStatus.isPaused,
      isScanning:  message.isScanning  ?? lastStatus.isScanning,
      videos:      message.videos      ?? lastStatus.videos,
    };
    // Keep videosDiscovered in sync (total covers discovered when downloading)
    updated.videosDiscovered = Math.max(
      lastStatus.videosDiscovered,
      updated.total
    );
    refreshUI(true, updated);
  }

  if (message.type === MESSAGE_TYPES.DOWNLOAD_COMPLETE) {
    // All downloads finished — force a full status refresh so the popup
    // transitions to the 'complete' state even if it missed individual progress events.
    const updated = {
      total:       message.total       ?? lastStatus.total,
      completed:   message.completed   ?? lastStatus.completed,
      failed:      message.failed      ?? lastStatus.failed,
      downloading: 0,
      queued:      0,
      isPaused:    false,
      isScanning:  false,
      videos:      message.videos      ?? lastStatus.videos,
    };
    updated.videosDiscovered = Math.max(lastStatus.videosDiscovered, updated.total);
    refreshUI(true, updated);
  }

  if (message.type === MESSAGE_TYPES.VIDEOS_DISCOVERED) {
    // Content script found more videos during a scan.
    const count = message.videosDiscovered ?? 0;
    lastStatus.videosDiscovered = count;
    setText('scan-count', count);
    setText('total-count', count);

    // Append newly discovered video URLs to the log panel.
    if (message.videos && Array.isArray(message.videos)) {
      const logPanel = document.getElementById('log-panel');
      if (logPanel) {
        for (const video of message.videos) {
          if (video.video_url) {
            const entry = document.createElement('div');
            entry.className = 'log-entry';
            entry.textContent = video.video_url;
            entry.title = video.video_url;
            logPanel.appendChild(entry);
            // Auto-scroll to bottom
            logPanel.scrollTop = logPanel.scrollHeight;
          }
        }
      }
    }

    // If we were scanning, check whether to switch to ready state.
    if (count > 0) {
      // Only auto-transition if not already downloading.
      const inDownload = lastStatus.downloading > 0 || lastStatus.queued > 0;
      if (!inDownload) {
        lastStatus.videosDiscovered = count;
        refreshUI(true, lastStatus);
      }
    }
  }
});

// ---------------------------------------------------------------------------
// Initialisation
// ---------------------------------------------------------------------------

document.addEventListener('DOMContentLoaded', async function () {
  // 1. Check for an active Sora tab.
  let tabs = [];
  try {
    tabs = await new Promise((resolve, reject) => {
      chrome.tabs.query(
        { url: ['https://sora.com/*', 'https://sora.chatgpt.com/*'] },
        function(result) {
          if (chrome.runtime.lastError) {
            reject(chrome.runtime.lastError);
          } else {
            resolve(result || []);
          }
        }
      );
    });
  } catch (e) {
    console.warn('[SoraArchiver/popup] tabs.query failed:', e.message);
  }
  const hasSoraTab = tabs && tabs.length > 0;

  // 2. Fetch current background state (service worker may need to wake up).
  let status = { ok: false, videosDiscovered: 0, total: 0, completed: 0,
                 failed: 0, downloading: 0, queued: 0, videos: {} };
  try {
    status = await sendMessage({ type: MESSAGE_TYPES.GET_STATUS });
    if (!status.ok && status.error && status.error.includes('Receiving end')) {
      // Background service worker is not running
      console.warn('[SoraArchiver/popup] Background service worker not reachable');
      setHidden('error-banner', false);
      var banner = document.getElementById('error-banner');
      if (banner) banner.querySelector('p').innerHTML =
        'Extension not fully loaded. Please <strong>reload this page</strong> (Ctrl+Shift+R) and reopen the popup.';
    }
  } catch (e) {
    console.warn('[SoraArchiver/popup] Could not reach background:', e.message);
  }

  // 3. Show the right state.
  refreshUI(hasSoraTab, status);

  // 4. Wire up settings inputs.
  const concurrencyInput = document.getElementById('setting-concurrency');

  // Restore saved settings.
  chrome.storage.local.get(['settings'], (stored) => {
    const saved = stored.settings || {};
    if (saved.MAX_CONCURRENT_DOWNLOADS && concurrencyInput) {
      concurrencyInput.value = saved.MAX_CONCURRENT_DOWNLOADS;
    }
  });

  if (concurrencyInput) {
    concurrencyInput.addEventListener('change', () => {
      const val = parseInt(concurrencyInput.value, 10);
      if (val >= 1 && val <= 10) {
        chrome.storage.local.get(['settings'], (stored) => {
          const s = stored.settings || {};
          s.MAX_CONCURRENT_DOWNLOADS = val;
          chrome.storage.local.set({ settings: s });
        });
      }
    });
  }

  // 5. Wire up buttons.
  document.getElementById('btn-scan')
    ?.addEventListener('click', onScanClick);

  document.getElementById('btn-download-all')
    ?.addEventListener('click', onDownloadAllClick);

  document.getElementById('btn-export-json')
    ?.addEventListener('click', onExportJson);

  document.getElementById('btn-export-csv')
    ?.addEventListener('click', onExportCsv);

  document.getElementById('btn-export-json-final')
    ?.addEventListener('click', onExportJson);

  document.getElementById('btn-export-csv-final')
    ?.addEventListener('click', onExportCsv);

  document.getElementById('btn-pause')
    ?.addEventListener('click', onPauseResume);

  document.getElementById('btn-retry')
    ?.addEventListener('click', onRetryFailed);

  document.getElementById('btn-retry-final')
    ?.addEventListener('click', onRetryFailed);
});
