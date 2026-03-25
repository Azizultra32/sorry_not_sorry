// api-client.js — Wrapper for the Sora/OpenAI API endpoints.
// Handles authenticated requests to fetch video metadata, generation history,
// and any paginated library endpoints exposed by the Sora platform.
//
// All functions are globals so they can be called from background.js
// (a service worker that cannot reliably use importScripts in MV3).
// This module is intended for "power user" mode where the caller supplies
// an OpenAI API key and bypasses web-scraping entirely.

'use strict';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const _API_BASE = 'https://api.openai.com/v1';

// Build standard JSON request headers for the OpenAI API.
function _buildApiHeaders(apiKey) {
  return {
    'Authorization': `Bearer ${apiKey}`,
    'Content-Type':  'application/json',
    'Accept':        'application/json',
  };
}

// Sleep for `ms` milliseconds — used for retry back-off.
function _sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Perform a GET request with retry logic (3 attempts, 2 s delay).
// Returns the parsed JSON body on success, throws on final failure.
async function _fetchWithRetry(url, apiKey) {
  const MAX_RETRIES   = 3;
  const RETRY_DELAY_MS = 2000;

  let lastError;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const resp = await fetch(url, {
        method:  'GET',
        headers: _buildApiHeaders(apiKey),
      });

      if (!resp.ok) {
        // Capture the error body for a more helpful message when possible.
        let errMsg = `HTTP ${resp.status} ${resp.statusText}`;
        try {
          const body = await resp.json();
          if (body && body.error && body.error.message) {
            errMsg = body.error.message;
          }
        } catch (_) {
          // ignore — use the status-line message
        }
        throw new Error(errMsg);
      }

      return await resp.json();
    } catch (err) {
      lastError = err;
      console.warn(
        `[SoraArchiver/api] Attempt ${attempt}/${MAX_RETRIES} failed for ${url}:`,
        err.message
      );
      if (attempt < MAX_RETRIES) {
        await _sleep(RETRY_DELAY_MS);
      }
    }
  }

  throw lastError;
}

// ---------------------------------------------------------------------------
// validateApiKey(apiKey)
// ---------------------------------------------------------------------------
// Tests whether the supplied API key is accepted by OpenAI by hitting the
// /v1/models endpoint (lightweight, always accessible with a valid key).
//
// @param {string} apiKey
// @returns {Promise<{ valid: boolean, error: string|null }>}
//
async function validateApiKey(apiKey) {
  if (!apiKey || typeof apiKey !== 'string' || !apiKey.trim()) {
    return { valid: false, error: 'API key must be a non-empty string.' };
  }

  try {
    await _fetchWithRetry(`${_API_BASE}/models`, apiKey);
    return { valid: true, error: null };
  } catch (err) {
    return { valid: false, error: err.message };
  }
}

// ---------------------------------------------------------------------------
// fetchVideosViaApi(apiKey, onBatch)
// ---------------------------------------------------------------------------
// Paginates through all videos available to the API key using cursor-based
// pagination.  Calls onBatch(normalizedVideos) for each page as it arrives.
//
// Normalised video shape mirrors the schema used by scraper.js:
//   { id, prompt, created_at, model, duration_seconds, resolution,
//     status, thumbnail_url, video_url, has_audio, has_cameo }
//
// @param {string}   apiKey
// @param {function(object[]):void} onBatch  — called with each page of results
// @returns {Promise<number>}  — total videos discovered
//
async function fetchVideosViaApi(apiKey, onBatch) {
  const LIMIT         = 50;
  const THROTTLE_MS   = 1000;

  let cursor     = null;
  let totalCount = 0;

  // Normalise a raw API video object to the internal schema.
  function normalizeApiVideo(raw) {
    if (!raw || typeof raw !== 'object') return null;

    const v = raw.generation || raw;

    const id = v.id || v.generation_id || v.video_id || null;
    if (!id) return null;

    const prompt =
      v.prompt      ||
      v.caption     ||
      v.description ||
      (v.metadata && v.metadata.prompt) ||
      '';

    let created_at = v.created_at || v.created || v.timestamp || null;
    if (typeof created_at === 'number') {
      created_at = new Date(created_at * 1000).toISOString();
    }

    const model =
      v.model      ||
      v.model_name ||
      (v.metadata && v.metadata.model) ||
      'unknown';

    const duration_seconds =
      (v.duration_seconds !== undefined ? v.duration_seconds : null) ??
      (v.duration          !== undefined ? v.duration          : null) ??
      (v.metadata && v.metadata.duration_seconds !== undefined ? v.metadata.duration_seconds : null) ??
      null;

    let resolution = v.resolution || (v.metadata && v.metadata.resolution) || null;
    if (!resolution && (v.width || v.height)) {
      resolution = `${v.width || 0}x${v.height || 0}`;
    }

    const status =
      v.status            ||
      v.generation_status ||
      (v.video_url || v.mp4_url || v.download_url ? 'completed' : 'unknown');

    const thumbnail_url =
      v.thumbnail_url ||
      v.thumbnail     ||
      v.preview_url   ||
      (v.metadata && v.metadata.thumbnail_url) ||
      null;

    const video_url =
      v.video_url    ||
      v.mp4_url      ||
      v.download_url ||
      v.url          ||
      (v.assets && v.assets.mp4) ||
      null;

    const has_audio =
      v.has_audio !== undefined ? v.has_audio :
      (v.metadata && v.metadata.has_audio !== undefined ? v.metadata.has_audio :
      (typeof v.audio_enabled === 'boolean' ? v.audio_enabled : null));

    const has_cameo =
      v.has_cameo !== undefined ? v.has_cameo :
      (v.metadata && v.metadata.has_cameo !== undefined ? v.metadata.has_cameo :
      (typeof v.cameo_enabled === 'boolean' ? v.cameo_enabled : null));

    return {
      id,
      prompt,
      created_at,
      model,
      duration_seconds,
      resolution,
      status,
      thumbnail_url,
      video_url,
      has_audio,
      has_cameo,
    };
  }

  do {
    const url = cursor
      ? `${_API_BASE}/videos?limit=${LIMIT}&after=${encodeURIComponent(cursor)}`
      : `${_API_BASE}/videos?limit=${LIMIT}`;

    let data;
    try {
      data = await _fetchWithRetry(url, apiKey);
    } catch (err) {
      console.error('[SoraArchiver/api] fetchVideosViaApi failed after retries:', err);
      break;
    }

    // Support both OpenAI list-response shapes: { data: [...] } or { videos: [...] }
    const rawItems =
      data.data    ||
      data.videos  ||
      (Array.isArray(data) ? data : []);

    if (!rawItems.length) break;

    const normalized = rawItems.map(normalizeApiVideo).filter(Boolean);
    totalCount += normalized.length;

    try {
      onBatch(normalized);
    } catch (err) {
      console.error('[SoraArchiver/api] onBatch callback threw:', err);
    }

    // Advance cursor using the standard OpenAI pagination envelope.
    const hasMore = data.has_more !== false && rawItems.length === LIMIT;
    cursor =
      data.next_cursor ||
      data.after       ||
      (rawItems.length ? rawItems[rawItems.length - 1].id : null);

    if (!hasMore || !cursor) break;

    await _sleep(THROTTLE_MS);

  } while (true); // eslint-disable-line no-constant-condition

  return totalCount;
}

// ---------------------------------------------------------------------------
// getVideoDownloadUrl(apiKey, videoId)
// ---------------------------------------------------------------------------
// Fetches a fresh download URL for a specific video by its ID.  Useful when
// CDN URLs have expired and need to be refreshed before downloading.
//
// Tries the direct video endpoint first; falls back to the /content sub-path
// if the direct response does not include a downloadable URL.
//
// @param {string} apiKey
// @param {string} videoId
// @returns {Promise<string>}  — resolves with the download URL
//
async function getVideoDownloadUrl(apiKey, videoId) {
  if (!videoId) {
    throw new Error('videoId is required.');
  }

  // Try the direct video resource first.
  let data;
  try {
    data = await _fetchWithRetry(`${_API_BASE}/videos/${videoId}`, apiKey);
  } catch (err) {
    // Fall through to the /content endpoint below.
    data = null;
    console.warn(
      `[SoraArchiver/api] GET /videos/${videoId} failed, trying /content:`,
      err.message
    );
  }

  // Extract URL from the direct response if available.
  if (data) {
    const v = data.generation || data;
    const url =
      v.video_url    ||
      v.mp4_url      ||
      v.download_url ||
      v.url          ||
      (v.assets && v.assets.mp4) ||
      null;
    if (url) return url;
  }

  // Fallback: GET /v1/videos/{videoId}/content
  const contentData = await _fetchWithRetry(
    `${_API_BASE}/videos/${videoId}/content`,
    apiKey
  );

  const cv = contentData.generation || contentData;
  const contentUrl =
    cv.video_url    ||
    cv.mp4_url      ||
    cv.download_url ||
    cv.url          ||
    (cv.assets && cv.assets.mp4) ||
    null;

  if (!contentUrl) {
    throw new Error(`No download URL found for video ${videoId}.`);
  }

  return contentUrl;
}
