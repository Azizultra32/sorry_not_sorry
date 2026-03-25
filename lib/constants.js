// constants.js — Shared constants for the Sora Video Archiver extension.
// Imported by background.js, content.js, popup.js, and lib modules.

// ---------------------------------------------------------------------------
// Message types (background <-> content <-> popup)
// ---------------------------------------------------------------------------
const MESSAGE_TYPES = {
  VIDEOS_DISCOVERED: 'VIDEOS_DISCOVERED',
  START_DOWNLOAD:    'START_DOWNLOAD',
  DOWNLOAD_PROGRESS: 'DOWNLOAD_PROGRESS',
  DOWNLOAD_COMPLETE: 'DOWNLOAD_COMPLETE',
  SCAN_LIBRARY:      'SCAN_LIBRARY',
  SCAN_STATUS:       'SCAN_STATUS',
  EXPORT_MANIFEST:   'EXPORT_MANIFEST',
  GET_STATUS:        'GET_STATUS',
  PAUSE_DOWNLOAD:    'PAUSE_DOWNLOAD',
  RESUME_DOWNLOAD:   'RESUME_DOWNLOAD',
  RETRY_FAILED:      'RETRY_FAILED',
};

// ---------------------------------------------------------------------------
// Video status enum
// ---------------------------------------------------------------------------
const VIDEO_STATUS = {
  QUEUED:      'QUEUED',
  DOWNLOADING: 'DOWNLOADING',
  COMPLETED:   'COMPLETED',
  FAILED:      'FAILED',
  SKIPPED:     'SKIPPED',
};

// ---------------------------------------------------------------------------
// Default settings
// ---------------------------------------------------------------------------
const DEFAULT_SETTINGS = {
  MAX_CONCURRENT_DOWNLOADS: 3,
  DOWNLOAD_FOLDER:          'sora-archive',
  THROTTLE_MS:              1000,
};

// ---------------------------------------------------------------------------
// Sora URLs and API endpoints
// ---------------------------------------------------------------------------
const SORA_URLS = {
  BASE:              'https://sora.chatgpt.com',
  BASE_LEGACY:       'https://sora.com',
  API_BASE:          'https://api.openai.com',
  VIDEO_CDN:         'https://videos.openai.com',
  LIBRARY_PAGE:      'https://sora.chatgpt.com/library',
  // Real Sora backend endpoints (same-origin, no API key required)
  FEED_ENDPOINT:     '/backend/project_y/feed',
  MY_POSTS_ENDPOINT: '/backend/project_y/me/posts',
  // Cross-origin API paths — only usable from background.js with API key,
  // NOT from content scripts (CORS blocks them from sora.chatgpt.com origin).
  API_VIDEOS:        'https://api.openai.com/v1/videos',
  API_GENERATIONS:   'https://api.openai.com/v1/videos/generations',
};
