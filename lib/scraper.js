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
  // 1. Endpoints discovered by the interceptor (most reliable — these actually work)
  // 2. Common same-origin paths for sora.chatgpt.com
  // NOTE: Cross-origin endpoints (api.openai.com) are excluded — they fail
  // with CORS when called from the page context. The developer API requires
  // the api-client.js path with a user-supplied API key from the background.
  const discovered = (window.__soraDiscoveredEndpoints || []).slice();
  const origin = window.location.origin;
  const candidateEndpoints = [
    ...discovered,
    // Same-origin API paths (Sora/ChatGPT backend patterns)
    origin + '/backend-api/videos',
    origin + '/backend-api/generations',
    origin + '/backend-api/sora/videos',
    origin + '/backend-api/sora/generations',
    origin + '/backend-api/video/generations',
    origin + '/backend-api/video-gen/generations',
    origin + '/api/videos',
    origin + '/api/generations',
    origin + '/api/sora/videos',
    origin + '/api/sora/generations',
    origin + '/api/v1/videos',
    origin + '/api/v1/generations',
  ];

  // Deduplicate
  const uniqueEndpoints = [...new Set(candidateEndpoints)];

  let workingEndpoint = null;

  console.log(`[SoraArchiver] Probing ${uniqueEndpoints.length} candidate endpoint(s)...`);

  // Quick probe helper — single attempt, short timeout for probing
  async function probePage(url) {
    const doFetch = window.__originalFetch || window.fetch.bind(window);
    const resp = await doFetch(url, {
      method: 'GET',
      headers: buildHeaders(),
      credentials: 'include',
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return await resp.json();
  }

  // Probe to find which endpoint returns video data
  for (const endpoint of uniqueEndpoints) {
    try {
      const probeUrl = `${endpoint}?limit=1`;
      const data = await probePage(probeUrl);
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
// Discovered API endpoints — populated by the interceptor as the page makes
// requests, then reused by fetchVideoLibrary for active scanning.
// ---------------------------------------------------------------------------
window.__soraDiscoveredEndpoints = window.__soraDiscoveredEndpoints || [];

// ---------------------------------------------------------------------------
// Shared helper: check if parsed JSON looks like it contains video data
// ---------------------------------------------------------------------------
function extractVideoItems(data) {
  if (!data || typeof data !== 'object') return null;

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
        sample.generation;
      if (hasId && hasVideoField) return arr;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// interceptFetch(onVideoData)
// ---------------------------------------------------------------------------
// Sets up multiple interception strategies to survive SES lockdown:
//
//   1. PerformanceObserver — watches all resource fetches for API-like URLs,
//      then re-fetches them to read the response. SES cannot block this.
//   2. Fetch monkey-patch with retry — patches window.fetch, and re-applies
//      the patch periodically in case SES overwrites it.
//   3. XMLHttpRequest interception — fallback if fetch patching is blocked.
//
// The original network calls are never disrupted.
//
function interceptFetch(onVideoData) {
  window.__originalFetch = window.__originalFetch || window.fetch.bind(window);

  // Track URLs we've already processed to avoid duplicates
  const processedUrls = new Set();

  // URL patterns that are likely to contain video data
  const LIKELY_PATTERNS = [
    '/videos', '/generations', '/sora', '/library',
    '/backend-api', '/api/',
  ];
  const SKIP_PATTERNS = [
    '.js', '.css', '.png', '.jpg', '.svg', '.woff', '.ico', '.woff2',
    'analytics', 'tracking', 'telemetry', 'fonts.', 'cdn-lfs.',
    'accounts.', 'auth0.', 'login', 'logout', 'favicon',
    '_next/static', '_next/data', 'webpack', 'sourcemap',
    'oaistatic', 'intercom', 'sentry', 'segment',
  ];

  function isLikelyVideoApiUrl(urlStr) {
    try {
      const u = new URL(urlStr);
      const lower = (u.pathname + u.search).toLowerCase();
      if (SKIP_PATTERNS.some(function(p) { return lower.includes(p); })) return false;
      if (LIKELY_PATTERNS.some(function(p) { return lower.includes(p); })) return true;
      return false;
    } catch (_) {
      return false;
    }
  }

  function recordEndpoint(url) {
    var baseUrl = url.split('?')[0];
    if (window.__soraDiscoveredEndpoints.indexOf(baseUrl) === -1) {
      window.__soraDiscoveredEndpoints.push(baseUrl);
      console.log('[SoraArchiver] Discovered video API endpoint:', baseUrl);
    }
  }

  function processVideoData(url, data) {
    var items = extractVideoItems(data);
    if (items && items.length) {
      recordEndpoint(url);
      var normalized = items.map(normalizeVideoData).filter(Boolean);
      if (normalized.length) {
        onVideoData(normalized);
      }
    }
  }

  // -------------------------------------------------------------------
  // Strategy 1: PerformanceObserver — SES-proof URL discovery
  // -------------------------------------------------------------------
  // Watches all network requests. When we see an API-like URL, we
  // re-fetch it ourselves to read the response body.
  try {
    var perfObserver = new PerformanceObserver(function(list) {
      var entries = list.getEntries();
      for (var i = 0; i < entries.length; i++) {
        var entry = entries[i];
        if (entry.initiatorType !== 'fetch' && entry.initiatorType !== 'xmlhttprequest') continue;
        var url = entry.name;
        if (processedUrls.has(url)) continue;
        if (!isLikelyVideoApiUrl(url)) continue;

        processedUrls.add(url);

        // Re-fetch the URL to read the response (the browser will serve from cache)
        (function(fetchUrl) {
          var doFetch = window.__originalFetch || window.fetch.bind(window);
          doFetch(fetchUrl, { credentials: 'include' })
            .then(function(resp) {
              var ct = resp.headers.get('content-type') || '';
              if (!ct.includes('json')) return;
              return resp.json();
            })
            .then(function(data) {
              if (data) processVideoData(fetchUrl, data);
            })
            .catch(function() {
              // Non-fatal — the URL may have expired or require special headers
            });
        })(url);
      }
    });
    perfObserver.observe({ type: 'resource', buffered: true });
    console.log('[SoraArchiver] PerformanceObserver active (SES-proof).');
  } catch (e) {
    console.warn('[SoraArchiver] PerformanceObserver not available:', e.message);
  }

  // -------------------------------------------------------------------
  // Strategy 2: Fetch monkey-patch with SES retry
  // -------------------------------------------------------------------
  var fetchPatchInstalled = false;
  var patchAttempts = 0;
  var maxPatchRetries = 10;

  function installFetchPatch() {
    // Check if our patch is still in place
    if (window.fetch && window.fetch.name === 'soraArchiverFetch') {
      fetchPatchInstalled = true;
      return;
    }

    // Save current fetch as original (SES may have replaced it)
    if (!fetchPatchInstalled) {
      window.__originalFetch = window.fetch.bind(window);
    }

    try {
      window.fetch = function soraArchiverFetch() {
        var args = arguments;
        var request = args[0];
        var url =
          typeof request === 'string' ? request :
          (request && request.url) ? request.url :
          String(request);

        // Capture auth headers
        try {
          var init = args[1] || {};
          var authHeader = null;
          if (init.headers) {
            if (init.headers instanceof Headers) {
              authHeader = init.headers.get('Authorization');
            } else if (typeof init.headers === 'object') {
              authHeader = init.headers['Authorization'] || init.headers['authorization'];
            }
          }
          if (!authHeader && request && typeof request.headers === 'object' && request.headers.get) {
            authHeader = request.headers.get('Authorization');
          }
          if (authHeader && authHeader.indexOf('Bearer ') === 0) {
            window.__soraAuthToken = { token: authHeader.slice(7), type: 'bearer' };
          }
        } catch (_) {}

        var responsePromise = window.__originalFetch.apply(window, args);

        // Inspect response for video data
        if (isLikelyVideoApiUrl(url)) {
          responsePromise.then(function(response) {
            var ct = response.headers.get('content-type') || '';
            if (!ct.includes('json')) return;
            try {
              var clone = response.clone();
              clone.json().then(function(data) {
                processVideoData(url, data);
              }).catch(function() {});
            } catch (_) {}
          }).catch(function() {});
        }

        return responsePromise;
      };
      fetchPatchInstalled = true;
      console.log('[SoraArchiver] Fetch patch installed.');
    } catch (e) {
      console.warn('[SoraArchiver] Could not patch fetch:', e.message);
    }
  }

  // Install immediately
  installFetchPatch();

  // Re-apply after SES lockdown (retries every 500ms for up to 5s)
  var retryInterval = setInterval(function() {
    patchAttempts++;
    if (patchAttempts >= maxPatchRetries) {
      clearInterval(retryInterval);
      return;
    }
    if (window.fetch && window.fetch.name !== 'soraArchiverFetch') {
      console.log('[SoraArchiver] Fetch was overwritten (likely SES), re-patching...');
      window.__originalFetch = window.fetch.bind(window);
      installFetchPatch();
    }
  }, 500);

  // -------------------------------------------------------------------
  // Strategy 3: XMLHttpRequest interception (fallback)
  // -------------------------------------------------------------------
  try {
    var origXHROpen = XMLHttpRequest.prototype.open;
    var origXHRSend = XMLHttpRequest.prototype.send;

    XMLHttpRequest.prototype.open = function(method, url) {
      this.__soraUrl = url;
      // Capture auth from setRequestHeader
      var origSetHeader = this.setRequestHeader;
      this.setRequestHeader = function(name, value) {
        if (name.toLowerCase() === 'authorization' && value.indexOf('Bearer ') === 0) {
          window.__soraAuthToken = { token: value.slice(7), type: 'bearer' };
        }
        return origSetHeader.apply(this, arguments);
      };
      return origXHROpen.apply(this, arguments);
    };

    XMLHttpRequest.prototype.send = function() {
      var xhr = this;
      var url = xhr.__soraUrl;

      if (url && isLikelyVideoApiUrl(url)) {
        xhr.addEventListener('load', function() {
          try {
            var ct = xhr.getResponseHeader('content-type') || '';
            if (!ct.includes('json')) return;
            var data = JSON.parse(xhr.responseText);
            processVideoData(url, data);
          } catch (_) {}
        });
      }
      return origXHRSend.apply(this, arguments);
    };
    console.log('[SoraArchiver] XHR interception active.');
  } catch (e) {
    console.warn('[SoraArchiver] Could not patch XHR:', e.message);
  }
}
