// scraper.js — DOM and network-level scraping utilities for Sora pages.
// Extracts video URLs, titles, prompts, and metadata from page content
// and intercepted fetch/XHR responses within the content script context.
//
// This file is loaded before content.js via the manifest content_scripts array,
// so all functions declared here are available in the same execution context.

// ---------------------------------------------------------------------------
// extractAuthToken()
// ---------------------------------------------------------------------------
// Tries multiple strategies to find the user's auth token.
// Returns { token, type } where type is 'bearer' or 'cookie', or null.
//
function extractAuthToken() {
  // Strategy 1: intercepted headers cache (populated by interceptFetch)
  if (window.__soraAuthToken) {
    return window.__soraAuthToken;
  }

  // Strategy 2: __NEXT_DATA__ embedded JSON (Next.js page data)
  try {
    const nextDataEl = document.getElementById('__NEXT_DATA__');
    if (nextDataEl) {
      const data = JSON.parse(nextDataEl.textContent);
      // Traverse common paths where OpenAI embeds session info
      const token =
        data?.props?.pageProps?.session?.accessToken ||
        data?.props?.pageProps?.accessToken ||
        data?.props?.session?.accessToken ||
        null;
      if (token) {
        return { token, type: 'bearer' };
      }
    }
  } catch (_) {
    // ignore parse errors
  }

  // Strategy 3: localStorage — OpenAI / Next-Auth store tokens here
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key) continue;
      const lowerKey = key.toLowerCase();
      if (
        lowerKey.includes('token') ||
        lowerKey.includes('session') ||
        lowerKey.includes('auth')
      ) {
        const raw = localStorage.getItem(key);
        if (!raw) continue;
        try {
          const parsed = JSON.parse(raw);
          const token =
            parsed?.accessToken ||
            parsed?.access_token ||
            parsed?.token ||
            null;
          if (token && typeof token === 'string' && token.length > 20) {
            return { token, type: 'bearer' };
          }
        } catch (_) {
          // raw string value — check if it looks like a JWT / bearer token
          if (
            typeof raw === 'string' &&
            raw.length > 20 &&
            !raw.includes(' ')
          ) {
            return { token: raw, type: 'bearer' };
          }
        }
      }
    }
  } catch (_) {
    // localStorage may be unavailable in some contexts
  }

  // Strategy 4: cookies — look for __Secure-next-auth.session-token or similar
  try {
    const cookies = document.cookie.split(';');
    for (const cookie of cookies) {
      const [rawName, ...rest] = cookie.trim().split('=');
      const name = rawName.trim().toLowerCase();
      if (
        name.includes('session') ||
        name.includes('token') ||
        name.includes('auth')
      ) {
        const value = rest.join('=').trim();
        if (value && value.length > 20) {
          return { token: value, type: 'cookie' };
        }
      }
    }
  } catch (_) {
    // ignore
  }

  return null;
}

// ---------------------------------------------------------------------------
// fetchVideoLibrary(authInfo, onBatch)
// ---------------------------------------------------------------------------
// Fetches all pages of the user's Sora video library via paginated API calls.
// Calls onBatch(normalizedVideos[]) for each page as it arrives.
// Returns the total count of videos discovered.
//
async function fetchVideoLibrary(authInfo, onBatch) {
  const LIMIT = 50;
  const MAX_RETRIES = 3;
  const RETRY_DELAY_MS = 2000;

  let cursor = null;
  let totalCount = 0;

  // Build request headers from the auth info
  function buildHeaders() {
    const headers = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };
    if (authInfo && authInfo.type === 'bearer') {
      headers['Authorization'] = `Bearer ${authInfo.token}`;
    }
    // Cookie-based auth is sent automatically by the browser; no explicit header needed.
    return headers;
  }

  // Fetch one page with retry logic
  async function fetchPage(url) {
    let lastError;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        const doFetch = window.__originalFetch || window.fetch.bind(window);
        const resp = await doFetch(url, {
          method: 'GET',
          headers: buildHeaders(),
          credentials: 'include',
        });
        if (!resp.ok) {
          throw new Error(`HTTP ${resp.status} ${resp.statusText}`);
        }
        return await resp.json();
      } catch (err) {
        lastError = err;
        console.warn(
          `[SoraArchiver] fetchPage attempt ${attempt}/${MAX_RETRIES} failed:`,
          err.message
        );
        if (attempt < MAX_RETRIES) {
          await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
        }
      }
    }
    throw lastError;
  }

  // Build candidate endpoints list:
  // 1. Endpoints discovered by the fetch interceptor (most reliable — these actually work)
  // 2. Common same-origin paths for sora.chatgpt.com
  // 3. Legacy hardcoded endpoints as last resort
  const discovered = (window.__soraDiscoveredEndpoints || []).slice();
  const origin = window.location.origin;
  const candidateEndpoints = [
    ...discovered,
    // Same-origin API paths (Sora/ChatGPT backend patterns)
    origin + '/backend-api/videos',
    origin + '/backend-api/generations',
    origin + '/backend-api/sora/videos',
    origin + '/backend-api/sora/generations',
    origin + '/api/videos',
    origin + '/api/generations',
    origin + '/api/sora/videos',
    origin + '/api/sora/generations',
    // Cross-origin fallbacks
    SORA_URLS.API_VIDEOS,
    SORA_URLS.API_GENERATIONS,
  ];

  // Deduplicate
  const uniqueEndpoints = [...new Set(candidateEndpoints)];

  let workingEndpoint = null;

  console.log(`[SoraArchiver] Probing ${uniqueEndpoints.length} candidate endpoint(s)...`);

  // Probe to find which endpoint returns video data
  for (const endpoint of uniqueEndpoints) {
    try {
      const probeUrl = `${endpoint}?limit=1`;
      const data = await fetchPage(probeUrl);
      // Accept if response looks like a video list
      if (data && (Array.isArray(data.data) || Array.isArray(data.videos) ||
                   Array.isArray(data.generations) || Array.isArray(data.results) ||
                   Array.isArray(data.items))) {
        workingEndpoint = endpoint;
        console.log('[SoraArchiver] Found working endpoint:', endpoint);
        break;
      }
    } catch (_) {
      // try next endpoint
    }
  }

  if (!workingEndpoint) {
    console.warn(
      '[SoraArchiver] No working API endpoint found during probe. ' +
      'Browse your Sora library page to let the interceptor discover the real API URLs, ' +
      'then try scanning again.'
    );
    return 0;
  }

  // Main pagination loop
  do {
    const url = cursor
      ? `${workingEndpoint}?limit=${LIMIT}&after=${encodeURIComponent(cursor)}`
      : `${workingEndpoint}?limit=${LIMIT}`;

    let data;
    try {
      data = await fetchPage(url);
    } catch (err) {
      console.error('[SoraArchiver] fetchVideoLibrary failed after retries:', err);
      break;
    }

    // Normalise the raw items list — APIs differ in response shape
    const rawItems =
      data.data ||
      data.videos ||
      data.generations ||
      data.results ||
      data.items ||
      (Array.isArray(data) ? data : []);

    if (!rawItems.length) break;

    const normalized = rawItems.map(normalizeVideoData).filter(Boolean);
    totalCount += normalized.length;

    try {
      onBatch(normalized);
    } catch (err) {
      console.error('[SoraArchiver] onBatch callback threw:', err);
    }

    // Advance cursor
    // Support: { has_more, next_cursor }, { next_cursor }, { after }
    const hasMore = data.has_more !== false && rawItems.length === LIMIT;
    cursor =
      data.next_cursor ||
      data.after ||
      (rawItems.length ? rawItems[rawItems.length - 1].id : null);

    if (!hasMore || !cursor) break;

    // Throttle between paginated requests to avoid rate-limiting
    await new Promise((r) => setTimeout(r, DEFAULT_SETTINGS.THROTTLE_MS));

  } while (true); // eslint-disable-line no-constant-condition

  return totalCount;
}

// ---------------------------------------------------------------------------
// normalizeVideoData(rawVideo)
// ---------------------------------------------------------------------------
// Maps raw API response objects (which differ between Sora 1 and Sora 2) to a
// consistent internal schema.
//
function normalizeVideoData(raw) {
  if (!raw || typeof raw !== 'object') return null;

  // Sora 2 wraps the actual generation inside a "generation" key in some
  // responses; unwrap if present.
  const v = raw.generation || raw;

  // id
  const id = v.id || v.generation_id || v.video_id || null;

  // prompt / caption
  const prompt =
    v.prompt ||
    v.caption ||
    v.description ||
    v.metadata?.prompt ||
    '';

  // created_at — prefer ISO string, fall back to unix timestamp
  let created_at = v.created_at || v.created || v.timestamp || null;
  if (typeof created_at === 'number') {
    created_at = new Date(created_at * 1000).toISOString();
  }

  // model
  const model =
    v.model ||
    v.model_name ||
    v.metadata?.model ||
    'unknown';

  // duration in seconds
  const duration_seconds =
    v.duration_seconds ??
    v.duration ??
    v.metadata?.duration_seconds ??
    null;

  // resolution  — "1920x1080" or { width, height }
  let resolution = v.resolution || v.metadata?.resolution || null;
  if (!resolution && (v.width || v.height)) {
    resolution = `${v.width || 0}x${v.height || 0}`;
  }

  // status
  const status =
    v.status ||
    v.generation_status ||
    (v.video_url || v.mp4_url || v.download_url ? 'completed' : 'unknown');

  // thumbnail
  const thumbnail_url =
    v.thumbnail_url ||
    v.thumbnail ||
    v.preview_url ||
    v.metadata?.thumbnail_url ||
    null;

  // video URL — try several common field names
  const video_url =
    v.video_url ||
    v.mp4_url ||
    v.download_url ||
    v.url ||
    v.assets?.mp4 ||
    null;

  // audio / cameo flags
  const has_audio =
    v.has_audio ??
    v.metadata?.has_audio ??
    (typeof v.audio_enabled === 'boolean' ? v.audio_enabled : null) ??
    null;

  const has_cameo =
    v.has_cameo ??
    v.metadata?.has_cameo ??
    (typeof v.cameo_enabled === 'boolean' ? v.cameo_enabled : null) ??
    null;

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

// ---------------------------------------------------------------------------
// Discovered API endpoints — populated by interceptFetch as the page makes
// requests, then reused by fetchVideoLibrary for active scanning.
// ---------------------------------------------------------------------------
window.__soraDiscoveredEndpoints = window.__soraDiscoveredEndpoints || [];

// ---------------------------------------------------------------------------
// interceptFetch(onVideoData)
// ---------------------------------------------------------------------------
// Monkey-patches window.fetch to observe ALL API responses and detect ones
// that contain video/generation data.  Also captures auth headers and
// records working API endpoint URLs for active scanning.
//
// The original response is returned untouched so the page keeps working.
//
function interceptFetch(onVideoData) {
  // Preserve a reference to the original fetch for use by fetchVideoLibrary
  window.__originalFetch = window.__originalFetch || window.fetch.bind(window);

  // URL patterns that are LIKELY to contain video data (checked first)
  const LIKELY_PATTERNS = [
    '/videos', '/generations', '/sora', '/library',
    '/backend-api', '/api/',
  ];

  // URLs to SKIP (static assets, analytics, etc.)
  const SKIP_PATTERNS = [
    '.js', '.css', '.png', '.jpg', '.svg', '.woff', '.ico',
    'analytics', 'tracking', 'telemetry', 'fonts.', 'cdn.',
    'accounts.', 'auth0.', 'login', 'logout',
  ];

  function shouldInspect(url) {
    try {
      const u = new URL(url);
      const lower = u.pathname.toLowerCase() + u.search.toLowerCase();
      // Skip obvious non-API URLs
      if (SKIP_PATTERNS.some(p => lower.includes(p))) return false;
      // Always inspect likely API patterns
      if (LIKELY_PATTERNS.some(p => lower.includes(p))) return true;
      // Also inspect same-origin JSON API calls (the Sora app's own backend)
      if (u.origin === window.location.origin) return true;
      // Inspect openai.com calls
      if (u.hostname.includes('openai.com')) return true;
      return false;
    } catch (_) {
      return false;
    }
  }

  // Check if a parsed JSON response looks like it contains video data
  function extractVideoItems(data) {
    if (!data || typeof data !== 'object') return null;

    // Try common response shapes
    const candidates = [
      data.data,
      data.videos,
      data.generations,
      data.results,
      data.items,
      Array.isArray(data) ? data : null,
    ];

    for (const arr of candidates) {
      if (!Array.isArray(arr) || arr.length === 0) continue;
      // Check if items look like video objects (have id + some video-ish field)
      const sample = arr[0];
      if (sample && typeof sample === 'object') {
        const hasId = sample.id || sample.generation_id || sample.video_id;
        const hasVideoField =
          sample.prompt || sample.caption || sample.description ||
          sample.video_url || sample.mp4_url || sample.download_url ||
          sample.thumbnail_url || sample.thumbnail || sample.preview_url ||
          sample.status || sample.generation_status ||
          sample.duration || sample.duration_seconds ||
          sample.model || sample.model_name ||
          sample.generation; // nested generation wrapper
        if (hasId && hasVideoField) return arr;
      }
    }
    return null;
  }

  window.fetch = async function soraArchiverFetch(...args) {
    const request = args[0];
    const url =
      typeof request === 'string'
        ? request
        : request instanceof Request
        ? request.url
        : String(request);

    // Capture the Authorization header from any outgoing request
    try {
      const init = args[1] || (request instanceof Request ? {} : {});
      let authHeader = null;
      if (init.headers) {
        if (init.headers instanceof Headers) {
          authHeader = init.headers.get('Authorization');
        } else if (typeof init.headers === 'object') {
          authHeader = init.headers['Authorization'] || init.headers['authorization'];
        }
      }
      if (!authHeader && request instanceof Request) {
        authHeader = request.headers.get('Authorization');
      }
      if (authHeader && authHeader.startsWith('Bearer ')) {
        window.__soraAuthToken = {
          token: authHeader.slice(7),
          type: 'bearer',
        };
      }
    } catch (_) {
      // header inspection errors are non-fatal
    }

    // Perform the actual fetch
    const responsePromise = window.__originalFetch(...args);

    // Inspect responses that might contain video data
    if (shouldInspect(url)) {
      responsePromise
        .then(async (response) => {
          // Only inspect JSON responses
          const ct = response.headers.get('content-type') || '';
          if (!ct.includes('json')) return;

          try {
            const clone = response.clone();
            const data = await clone.json();
            const items = extractVideoItems(data);
            if (items && items.length) {
              // Record this endpoint as a working video API URL
              const baseUrl = url.split('?')[0];
              if (!window.__soraDiscoveredEndpoints.includes(baseUrl)) {
                window.__soraDiscoveredEndpoints.push(baseUrl);
                console.log('[SoraArchiver] Discovered video API endpoint:', baseUrl);
              }

              const normalized = items.map(normalizeVideoData).filter(Boolean);
              if (normalized.length) {
                onVideoData(normalized);
              }
            }
          } catch (_) {
            // Response may not be parseable — ignore silently
          }
        })
        .catch(() => {
          // Network errors are the page's problem, not ours
        });
    }

    return responsePromise;
  };
}
