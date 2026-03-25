// archive.js — Archive management utilities.
// Builds, reads, and writes the local JSON manifest that tracks every
// downloaded video (metadata, local path, download status, timestamps).
//
// All functions are globals so they can be called from background.js
// (a service worker that cannot reliably use importScripts in MV3).

'use strict';

// ---------------------------------------------------------------------------
// buildManifestJSON(videos, downloadResults)
// ---------------------------------------------------------------------------
// Builds a structured JSON manifest object from the discovered-videos map
// and the DownloadManager.results object.
//
// @param {Object.<string, object>} videos         — discoveredVideos map
// @param {Object.<string, { status: string, filename: string|null, error: string|null }>} downloadResults
// @returns {object}
//
function buildManifestJSON(videos, downloadResults) {
  const results = downloadResults || {};

  const videoList = Object.values(videos).map((video) => {
    const result = results[video.id] || {};
    return {
      id:               video.id,
      prompt:           video.prompt           ?? null,
      created_at:       video.created_at       ?? null,
      model:            video.model            ?? null,
      duration_seconds: video.duration_seconds ?? null,
      resolution:       video.resolution       ?? null,
      status:           video.status           ?? null,
      local_filename:   result.filename        ?? null,
      has_audio:        video.has_audio        ?? null,
      has_cameo:        video.has_cameo        ?? null,
      download_status:  result.status          ?? null,
      download_error:   result.error           ?? null,
    };
  });

  const completed = videoList.filter((v) => v.download_status === 'COMPLETED').length;
  const failed    = videoList.filter((v) => v.download_status === 'FAILED').length;
  const skipped   = videoList.filter((v) => !v.download_status || v.download_status === 'SKIPPED').length;

  return {
    exported_at:   new Date().toISOString(),
    total_videos:  videoList.length,
    completed,
    failed,
    skipped,
    videos:        videoList,
  };
}

// ---------------------------------------------------------------------------
// buildManifestCSV(videos, downloadResults)
// ---------------------------------------------------------------------------
// Builds a CSV string from the discovered-videos map and download results.
// Values are properly escaped to handle commas, double-quotes, and newlines
// that may appear inside video prompts.
//
// @param {Object.<string, object>} videos
// @param {Object.<string, { status: string, filename: string|null, error: string|null }>} downloadResults
// @returns {string}
//
function buildManifestCSV(videos, downloadResults) {
  const results = downloadResults || {};

  const HEADERS = [
    'id',
    'prompt',
    'created_at',
    'model',
    'duration_seconds',
    'resolution',
    'status',
    'local_filename',
    'has_audio',
    'has_cameo',
    'download_status',
    'download_error',
  ];

  // Escape a single CSV field value per RFC 4180:
  // - Wrap in double-quotes if the value contains a comma, double-quote, or newline.
  // - Escape any embedded double-quotes by doubling them ("").
  function escapeCSVField(value) {
    if (value === null || value === undefined) return '';
    const str = String(value);
    if (str.includes('"') || str.includes(',') || str.includes('\n') || str.includes('\r')) {
      return '"' + str.replace(/"/g, '""') + '"';
    }
    return str;
  }

  const rows = [HEADERS.join(',')];

  for (const video of Object.values(videos)) {
    const result = results[video.id] || {};
    const fields = [
      video.id,
      video.prompt           ?? '',
      video.created_at       ?? '',
      video.model            ?? '',
      video.duration_seconds ?? '',
      video.resolution       ?? '',
      video.status           ?? '',
      result.filename        ?? '',
      video.has_audio        ?? '',
      video.has_cameo        ?? '',
      result.status          ?? '',
      result.error           ?? '',
    ];
    rows.push(fields.map(escapeCSVField).join(','));
  }

  return rows.join('\n');
}

// ---------------------------------------------------------------------------
// downloadManifest(manifest, format)
// ---------------------------------------------------------------------------
// Triggers a browser download of the manifest content using chrome.downloads.
//
// @param {object|string} manifest  — JSON object for 'json', CSV string for 'csv'
// @param {'json'|'csv'} format
// @returns {Promise<number>}       — resolves with the chrome download ID
//
function downloadManifest(manifest, format) {
  return new Promise((resolve, reject) => {
    let dataUrl;
    let filename;

    if (format === 'csv') {
      const csvString = typeof manifest === 'string' ? manifest : buildManifestCSV({}, {});
      dataUrl  = 'data:text/csv;charset=utf-8,' + encodeURIComponent(csvString);
      filename = 'sora-archive/manifest.csv';
    } else {
      // Default: JSON
      const jsonString = JSON.stringify(manifest, null, 2);
      dataUrl  = 'data:application/json;charset=utf-8,' + encodeURIComponent(jsonString);
      filename = 'sora-archive/manifest.json';
    }

    chrome.downloads.download(
      {
        url:            dataUrl,
        filename,
        conflictAction: 'uniquify',
        saveAs:         false,
      },
      (downloadId) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else {
          resolve(downloadId);
        }
      }
    );
  });
}
