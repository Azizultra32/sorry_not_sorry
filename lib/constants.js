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
  BASE:           'https://sora.com',
  BASE_CHATGPT:   'https://sora.chatgpt.com',
  API_BASE:       'https://api.openai.com',
  LIBRARY_PAGE:   'https://sora.com/library',
  // Known API paths (may need updating as the platform evolves)
  API_VIDEOS:     'https://api.openai.com/v1/sora/videos',
  API_GENERATIONS:'https://api.openai.com/v1/sora/generations',
};
