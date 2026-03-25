# Sora Video Archiver

Chrome extension to download and archive all your Sora AI videos before the shutdown.

## Features

- Automatically discovers all videos in your Sora library
- Downloads all videos as MP4 files to a local folder
- Exports metadata (prompts, dates, settings) as JSON/CSV
- Progress tracking with pause/resume support
- Retry failed downloads
- Optional API key mode for direct API access

## Installation

1. Clone this repository
2. Open Chrome and go to `chrome://extensions/`
3. Enable "Developer mode" (top right)
4. Click "Load unpacked" and select this directory
5. Navigate to [sora.chatgpt.com](https://sora.chatgpt.com) and click the extension icon

## Usage

1. Open sora.chatgpt.com and log in to your account
2. Click the Sora Video Archiver extension icon
3. Click "Scan Library" to discover all your videos
4. Click "Download All" to start downloading
5. Export metadata using the JSON/CSV export buttons

Videos are saved to your default downloads folder in a `sora-archive/` subdirectory.

## Privacy

- No data is sent to any third-party server
- Everything stays on your local machine
- No telemetry or analytics
- Open source — audit the code yourself

## License

MIT
