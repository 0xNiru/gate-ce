# GATE CE practice prototype

This is a static, browser-based prototype connected to the supplied GATE CE scraper dataset.

## Run locally

For Telegram backup support, run the included local app and backup service:

```sh
node server.mjs
```

Open `http://localhost:8000`. The question bank is fetched as `data/questions.json.gz` and decompressed in the browser. `data/questions.json` is the uncompressed fallback. Attempt history, bookmarks, notes, mistakes, and theme remain in browser local storage. When Telegram is connected, the app sends a copy of that data to the local service, which stores the bot token and latest backup under `.runtime/` with owner-only file permissions. `.runtime/` is excluded from Git.

Telegram backups are sent at 00:00 Asia/Kolkata while `node server.mjs` is running and the computer is awake. This is a local service, not a hosted always-on service: it cannot send while the device is off. Use the Backup button to create a bot with BotFather, enter the token, open the bot and send `/start`, then use “Send backup now” to confirm delivery. The service binds only to localhost. To disable Telegram, use Disconnect in the Backup dialog and stop the service with Ctrl+C.

## Dataset

`data/questions.json` is a compact rendering copy of the scraper's `questions.json`. It omits the original full-page question HTML and keeps question markup, choices, answer keys, explanations, source metadata, and image references. `data/images/` contains the corresponding local figures. The original scraper directory remains unchanged.

Questions with an unverified NAT key and the six MCQ records with no `correctAnswer` are marked pending and excluded from automatic scoring. The matching question IDs and metadata are listed in `outputs/answer-backlog.json`.
