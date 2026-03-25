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
  // Strategy 1: cached token from a previous call
  if (window.__soraAuthToken) {
    return window.__soraAuthToken;
  }

  // Strategy 2: __NEXT_DATA__ embedded JSON (Next.js page data)
  try {
    var nextDataEl = document.getElementById('__NEXT_DATA__');
    if (nextDataEl) {
      var data = JSON.parse(nextDataEl.textContent);
      var token =
        data?.props?.pageProps?.session?.accessToken ||
        data?.props?.pageProps?.accessToken ||
        data?.props?.session?.accessToken ||
        null;
      if (token) {
        window.__soraAuthToken = { token: token, type: 'bearer' };
        return window.__soraAuthToken;
      }
    }
  } catch (_) {}

  // Strategy 3: localStorage
  try {
    for (var i = 0; i < localStorage.length; i++) {
      var key = localStorage.key(i);
      if (!key) continue;
      var lowerKey = key.toLowerCase();
      if (lowerKey.includes('token') || lowerKey.includes('session') || lowerKey.includes('auth')) {
        var raw = localStorage.getItem(key);
        if (!raw) continue;
        try {
          var parsed = JSON.parse(raw);
          var t = parsed?.accessToken || parsed?.access_token || parsed?.token || null;
          if (t && typeof t === 'string' && t.length > 20) {
            window.__soraAuthToken = { token: t, type: 'bearer' };
            return window.__soraAuthToken;
          }
        } catch (_) {
          if (typeof raw === 'string' && raw.length > 20 && !raw.includes(' ')) {
            window.__soraAuthToken = { token: raw, type: 'bearer' };
            return window.__soraAuthToken;
          }
        }
      }
    }
  } catch (_) {}

  return null;
}

// ---------------------------------------------------------------------------
// extractAuthTokenAsync()
// ---------------------------------------------------------------------------
// Calls /api/auth/session to get the access token. This is how the Sora
// web app authenticates — it uses Next-Auth session cookies to get a
// bearer token, then uses that token for /backend/ API calls.
//
async function extractAuthTokenAsync() {
  // Return cached token if we have one
  if (window.__soraAuthToken) {
    return window.__soraAuthToken;
  }

  // Try sync strategies first
  var syncResult = extractAuthToken();
  if (syncResult) return syncResult;

  // Call /api/auth/session to get the access token
  try {
    var resp = await window.fetch('/api/auth/session', { credentials: 'include' });
    if (resp.ok) {
      var data = await resp.json();
      // Log the response keys so we can see what's available
      console.log('[SoraArchiver] /api/auth/session keys:', Object.keys(data || {}));
      var token = data?.accessToken || data?.access_token || data?.token ||
                  data?.session?.accessToken || data?.user?.accessToken || null;
      if (token && typeof token === 'string' && token.length > 10) {
        console.log('[SoraArchiver] Got auth token from /api/auth/session (' + token.substring(0, 20) + '...)');
        window.__soraAuthToken = { token: token, type: 'bearer' };
        return window.__soraAuthToken;
      }
      // Even if no token found, mark as cookie-auth (the session cookies may be sufficient)
      console.log('[SoraArchiver] No access token in session response, trying cookie-only auth');
      window.__soraAuthToken = { token: null, type: 'cookie' };
      return window.__soraAuthToken;
    }
  } catch (e) {
    console.warn('[SoraArchiver] /api/auth/session failed:', e.message);
  }

  // Last resort: cookie-only auth (browser sends session cookies automatically)
  console.log('[SoraArchiver] Using cookie-only auth');
  window.__soraAuthToken = { token: null, type: 'cookie' };
  return window.__soraAuthToken;

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

  // Build request headers with Bearer token
  function buildHeaders() {
    const headers = {};
    if (authInfo && authInfo.token && authInfo.type === 'bearer') {
      headers['Authorization'] = 'Bearer ' + authInfo.token;
    }
    return headers;
  }

  // Use the pre-SES fetch for API calls — SES's fetch may strip custom
  // headers. The raw browser fetch + explicit Bearer header works.
  var apiFetch = window.__originalFetch || window.fetch.bind(window);

  // Fetch one page with retry logic and Bearer auth
  async function fetchPage(url) {
    let lastError;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        const resp = await apiFetch(url, {
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
    // User's own videos (highest priority — this is what we want to archive)
    origin + '/backend/project_y/profile_feed/me',
    // Other real Sora API endpoints
    origin + '/backend/project_y/feed',
    origin + '/backend/project_y/me/posts',
    origin + '/backend/project_y/me/generations',
  ];

  // Deduplicate
  const uniqueEndpoints = [...new Set(candidateEndpoints)];

  let workingEndpoint = null;

  console.log(`[SoraArchiver] Probing ${uniqueEndpoints.length} candidate endpoint(s)...`);

  // Quick probe helper — single attempt with Bearer auth
  async function probePage(url) {
    const resp = await apiFetch(url, {
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
      // Sora API requires cut=nf2 parameter
      const probeUrl = `${endpoint}?limit=1&cut=nf2`;
      const data = await probePage(probeUrl);
      // Accept any valid response shape — even empty items[] means the endpoint works
      const hasItems = data && Array.isArray(data.items);
      const hasOther = data && (Array.isArray(data.data) || Array.isArray(data.videos) ||
                   Array.isArray(data.generations) || Array.isArray(data.results));
      if (hasItems || hasOther) {
        workingEndpoint = endpoint;
        var count = hasItems ? data.items.length : 0;
        console.log('[SoraArchiver] Found working endpoint:', endpoint, '(' + count + ' items in probe)');
        // If this endpoint returned items, use it; otherwise keep looking
        // for one that has content (but remember this one as fallback)
        if (count > 0) break;
        // Empty endpoint — save as fallback and keep probing
        if (!workingEndpoint) workingEndpoint = endpoint;
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
    // Sora API uses 'cursor' and requires 'cut=nf2'
    const url = cursor
      ? `${workingEndpoint}?limit=${LIMIT}&cut=nf2&cursor=${encodeURIComponent(cursor)}`
      : `${workingEndpoint}?limit=${LIMIT}&cut=nf2`;

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

    // Detect real Sora feed format: items[].post.attachments[]
    const isPostFeed = rawItems.length > 0 && rawItems[0].post && rawItems[0].post.attachments;
    const normalized = isPostFeed
      ? rawItems.map(normalizePostData).filter(Boolean)
      : rawItems.map(normalizeVideoData).filter(Boolean);
    totalCount += normalized.length;

    try {
      onBatch(normalized);
    } catch (err) {
      console.error('[SoraArchiver] onBatch callback threw:', err);
    }

    // Advance cursor
    // Support: { cursor } (Sora API), { next_cursor }, { has_more, next_cursor }, { after }
    const hasMore = data.has_more !== false && rawItems.length === LIMIT;
    cursor =
      data.cursor ||
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
// normalizePostData(item)
// ---------------------------------------------------------------------------
// Maps a Sora feed item ({ post, profile }) — as returned by the real
// /backend/project_y/feed and /backend/project_y/me/posts endpoints — to
// the same normalised schema used by normalizeVideoData().
//
function normalizePostData(item) {
  if (!item || !item.post) return null;
  var post = item.post;
  var attachment = null;

  // Find the sora video attachment
  if (post.attachments && post.attachments.length) {
    for (var i = 0; i < post.attachments.length; i++) {
      if (post.attachments[i].kind === 'sora') {
        attachment = post.attachments[i];
        break;
      }
    }
  }
  if (!attachment) return null;

  return {
    id: attachment.generation_id || post.id,
    prompt: post.text || attachment.prompt || '',
    created_at: post.posted_at ? new Date(post.posted_at * 1000).toISOString() : null,
    model: 'sora',
    duration_seconds: attachment.duration_s || null,
    resolution: (attachment.width && attachment.height) ? attachment.width + 'x' + attachment.height : null,
    status: 'completed',
    thumbnail_url: attachment.encodings && attachment.encodings.thumbnail ? attachment.encodings.thumbnail.path : null,
    video_url: attachment.downloadable_url || (attachment.download_urls && attachment.download_urls.watermark) || attachment.url || null,
    has_audio: null,
    has_cameo: !!(post.cameo_profiles && post.cameo_profiles.length),
  };
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
      // Real Sora API format: { post: { id, attachments: [{ kind: 'sora', ... }] }, profile }
      if (sample.post && sample.post.attachments && Array.isArray(sample.post.attachments)) {
        return arr;
      }

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
    '/backend-api', '/api/', '/backend/',
  ];
  const SKIP_PATTERNS = [
    '.js', '.css', '.png', '.jpg', '.svg', '.woff', '.ico', '.woff2',
    '.gif', '.webp', '.map', '.ttf', '.eot',
    'analytics', 'tracking', 'telemetry', 'fonts.', 'cdn-lfs.',
    'accounts.', 'auth0.', 'login', 'logout', 'favicon',
    '_next/static', '_next/data', 'webpack', 'sourcemap',
    'oaistatic', 'intercom', 'sentry', 'segment',
    'datadoghq', 'datadog', 'browser-intake',
    'statsig', 'launchdarkly', 'amplitude', 'mixpanel',
    'google-analytics', 'googletagmanager', 'gtag',
    'cloudflare', 'challenges', 'turnstile',
    'ab.chatgpt.com',
  ];

  function isLikelyVideoApiUrl(urlStr) {
    try {
      var u = new URL(urlStr);
      var lower = (u.hostname + u.pathname + u.search).toLowerCase();
      if (SKIP_PATTERNS.some(function(p) { return lower.includes(p); })) return false;
      if (LIKELY_PATTERNS.some(function(p) { return lower.includes(p); })) return true;
      return false;
    } catch (_) {
      return false;
    }
  }

  // Non-video backend endpoints to ignore (auth, billing, settings, etc.)
  var ENDPOINT_SKIP = [
    '/authenticate', '/billing', '/models', '/parameters', '/mailbox',
    '/nf/', '/initialize', '/v2/me', '/drafts', '/auth/',
  ];

  function recordEndpoint(url) {
    var baseUrl = url.split('?')[0];
    // Skip non-video endpoints
    var lower = baseUrl.toLowerCase();
    for (var s = 0; s < ENDPOINT_SKIP.length; s++) {
      if (lower.includes(ENDPOINT_SKIP[s])) return;
    }
    if (window.__soraDiscoveredEndpoints.indexOf(baseUrl) === -1) {
      window.__soraDiscoveredEndpoints.push(baseUrl);
      console.log('[SoraArchiver] Discovered video API endpoint:', baseUrl);
    }
  }

  function processVideoData(url, data) {
    var items = extractVideoItems(data);
    if (items && items.length) {
      recordEndpoint(url);
      // Detect real Sora feed format: items[].post.attachments[]
      var isPostFeed = items[0].post && items[0].post.attachments;
      var normalized = isPostFeed
        ? items.map(normalizePostData).filter(Boolean)
        : items.map(normalizeVideoData).filter(Boolean);
      if (normalized.length) {
        onVideoData(normalized);
      }
    }
  }

  // -------------------------------------------------------------------
  // Strategy 1: PerformanceObserver — SES-proof URL discovery
  // -------------------------------------------------------------------
  // Watches all network requests. For API-like URLs, re-fetches to read
  // the response. For videos.openai.com URLs, records them directly as
  // discovered video download URLs.
  try {
    var perfObserver = new PerformanceObserver(function(list) {
      var entries = list.getEntries();
      for (var i = 0; i < entries.length; i++) {
        var entry = entries[i];
        var url = entry.name;
        if (processedUrls.has(url)) continue;

        // Direct video URL discovery (videos.openai.com/*.mp4)
        if (url.indexOf('videos.openai.com') !== -1 && url.indexOf('.mp4') !== -1) {
          processedUrls.add(url);
          var videoId = url.match(/genid_([a-f0-9-]+)/i);
          var taskId = url.match(/task_([a-z0-9]+)/i);
          var id = videoId ? videoId[1] : (taskId ? taskId[1] : 'perf_' + Date.now().toString(36));
          var video = {
            id: id,
            prompt: '',
            created_at: null,
            model: 'sora',
            duration_seconds: null,
            resolution: null,
            status: 'completed',
            thumbnail_url: null,
            video_url: url,
            has_audio: null,
            has_cameo: null,
          };
          console.log('[SoraArchiver] PerformanceObserver found video URL:', url.substring(0, 80) + '...');
          onVideoData([video]);
          continue;
        }

        // Record same-origin API endpoints for use by the active scanner.
        // We do NOT re-fetch them here — the SES-hardened fetch adds auth
        // headers we can't replicate, so re-fetching causes 401 errors.
        // Instead, we just record the base URL as a discovered endpoint.
        if (entry.initiatorType !== 'fetch' && entry.initiatorType !== 'xmlhttprequest') continue;
        if (!isLikelyVideoApiUrl(url)) continue;

        try {
          var urlOrigin = new URL(url).origin;
          if (urlOrigin !== window.location.origin) continue;
        } catch (_) { continue; }

        processedUrls.add(url);
        recordEndpoint(url);
      }
    });
    perfObserver.observe({ type: 'resource', buffered: true });
    console.log('[SoraArchiver] PerformanceObserver active (SES-proof).');
  } catch (e) {
    console.warn('[SoraArchiver] PerformanceObserver not available:', e.message);
  }

  // -------------------------------------------------------------------
  // Strategy 2: Fetch monkey-patch — REMOVED
  // -------------------------------------------------------------------
  // OpenAI uses SES (Secure EcmaScript) lockdown which overwrites
  // window.fetch. Any attempt to patch or re-patch causes infinite
  // recursion because SES's hardened wrapper internally references
  // window.fetch. PerformanceObserver + DOM scraping + XHR interception
  // handle all discovery without needing to touch window.fetch.

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

// ---------------------------------------------------------------------------
// scrapeVideosFromDOM(onVideoData)
// ---------------------------------------------------------------------------
// Scrapes video URLs directly from the page DOM.  This is the most reliable
// strategy — it doesn't depend on API interception or endpoint guessing.
//
// Sora hosts video files at videos.openai.com with Azure SAS signed URLs.
// The library page renders <video> elements (or elements with video
// background/poster attributes) that contain these URLs.
//
// Also uses a MutationObserver to discover videos as the user scrolls and
// new content loads (infinite scroll / lazy loading).
//
function scrapeVideosFromDOM(onVideoData) {
  var discoveredVideoUrls = new Set();

  // Extract a usable ID from a videos.openai.com URL
  // Path looks like: /az/vg-assets/task_XXXX/task_XXXX_genid_YYYY/.../md.mp4
  function extractIdFromUrl(url) {
    try {
      var u = new URL(url);
      // Look for genid pattern
      var genidMatch = u.pathname.match(/genid_([a-f0-9-]+)/i);
      if (genidMatch) return genidMatch[1];
      // Look for task_id pattern
      var taskMatch = u.pathname.match(/task_([a-z0-9]+)/i);
      if (taskMatch) return taskMatch[1];
      // Fallback: hash the pathname
      var hash = 0;
      for (var i = 0; i < u.pathname.length; i++) {
        hash = ((hash << 5) - hash) + u.pathname.charCodeAt(i);
        hash |= 0;
      }
      return 'dom_' + Math.abs(hash).toString(36);
    } catch (_) {
      return 'dom_' + Date.now().toString(36);
    }
  }

  // Check if a URL is a Sora video URL
  function isSoraVideoUrl(url) {
    if (!url) return false;
    return url.includes('videos.openai.com') && url.includes('.mp4');
  }

  // Extract metadata from nearby DOM elements (prompt text, dates, etc.)
  function extractMetadataFromContext(element) {
    var metadata = { prompt: '', created_at: null };
    try {
      // Walk up to find a container (card/item) element
      var container = element.closest('[class*="card"], [class*="item"], [class*="video"], [class*="generation"], [class*="grid"], article, li');
      if (!container) container = element.parentElement;
      if (!container) return metadata;

      // Look for prompt/description text
      var textEls = container.querySelectorAll('p, span, [class*="prompt"], [class*="caption"], [class*="description"], [class*="text"]');
      for (var i = 0; i < textEls.length; i++) {
        var text = (textEls[i].textContent || '').trim();
        // Skip very short text (buttons, labels) and very long text (code dumps)
        if (text.length > 10 && text.length < 2000) {
          metadata.prompt = text;
          break;
        }
      }

      // Look for date text
      var dateEls = container.querySelectorAll('time, [class*="date"], [class*="time"], [datetime]');
      for (var j = 0; j < dateEls.length; j++) {
        var dateText = dateEls[j].getAttribute('datetime') || dateEls[j].textContent;
        if (dateText) {
          metadata.created_at = dateText.trim();
          break;
        }
      }
    } catch (_) {}
    return metadata;
  }

  // Process a single video URL found in the DOM
  function processVideoUrl(url, sourceElement) {
    if (discoveredVideoUrls.has(url)) return;
    discoveredVideoUrls.add(url);

    var id = extractIdFromUrl(url);
    var meta = sourceElement ? extractMetadataFromContext(sourceElement) : { prompt: '', created_at: null };

    var video = {
      id: id,
      prompt: meta.prompt,
      created_at: meta.created_at,
      model: 'sora',
      duration_seconds: null,
      resolution: null,
      status: 'completed',
      thumbnail_url: null,
      video_url: url,
      has_audio: null,
      has_cameo: null,
    };

    // Try to get duration/resolution from the video element
    if (sourceElement && sourceElement.tagName === 'VIDEO') {
      if (sourceElement.duration && isFinite(sourceElement.duration)) {
        video.duration_seconds = Math.round(sourceElement.duration);
      }
      if (sourceElement.videoWidth && sourceElement.videoHeight) {
        video.resolution = sourceElement.videoWidth + 'x' + sourceElement.videoHeight;
      }
    }

    console.log('[SoraArchiver] Found video in DOM:', id, url.substring(0, 80) + '...');
    onVideoData([video]);
  }

  // Scan an element (and its children) for video URLs
  function scanElement(root) {
    if (!root || !root.querySelectorAll) return;

    // Find <video> elements
    var videos = root.querySelectorAll('video');
    for (var i = 0; i < videos.length; i++) {
      var vid = videos[i];
      // Check src attribute
      if (isSoraVideoUrl(vid.src)) {
        processVideoUrl(vid.src, vid);
      }
      // Check <source> children
      var sources = vid.querySelectorAll('source');
      for (var j = 0; j < sources.length; j++) {
        if (isSoraVideoUrl(sources[j].src)) {
          processVideoUrl(sources[j].src, vid);
        }
      }
      // Check currentSrc
      if (isSoraVideoUrl(vid.currentSrc)) {
        processVideoUrl(vid.currentSrc, vid);
      }
    }

    // Also check for video URLs in data attributes, style backgrounds, etc.
    var allEls = root.querySelectorAll('[data-src], [data-video-url], [data-video], [data-mp4]');
    for (var k = 0; k < allEls.length; k++) {
      var el = allEls[k];
      var attrs = ['data-src', 'data-video-url', 'data-video', 'data-mp4'];
      for (var a = 0; a < attrs.length; a++) {
        var val = el.getAttribute(attrs[a]);
        if (isSoraVideoUrl(val)) {
          processVideoUrl(val, el);
        }
      }
    }

    // Check anchor elements that link to video downloads
    var links = root.querySelectorAll('a[href*="videos.openai.com"]');
    for (var l = 0; l < links.length; l++) {
      if (isSoraVideoUrl(links[l].href)) {
        processVideoUrl(links[l].href, links[l]);
      }
    }
  }

  // Initial scan of the full page
  scanElement(document.body);

  // Watch for dynamically added content (infinite scroll, lazy loading)
  try {
    var observer = new MutationObserver(function(mutations) {
      for (var i = 0; i < mutations.length; i++) {
        var added = mutations[i].addedNodes;
        for (var j = 0; j < added.length; j++) {
          if (added[j].nodeType === Node.ELEMENT_NODE) {
            scanElement(added[j]);
          }
        }
        // Also check if existing elements got new src attributes
        if (mutations[i].type === 'attributes' && mutations[i].target) {
          var target = mutations[i].target;
          if (target.tagName === 'VIDEO' || target.tagName === 'SOURCE') {
            var src = target.src || target.currentSrc;
            if (isSoraVideoUrl(src)) {
              processVideoUrl(src, target);
            }
          }
        }
      }
    });
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['src', 'data-src', 'data-video-url'],
    });
    console.log('[SoraArchiver] DOM MutationObserver active — watching for video elements.');
  } catch (e) {
    console.warn('[SoraArchiver] MutationObserver failed:', e.message);
  }

  // Return a function to trigger a manual re-scan
  return function rescan() {
    scanElement(document.body);
    return discoveredVideoUrls.size;
  };
}
