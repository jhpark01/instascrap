# Project Architecture & Deployment Preferences

- **Static Web Hosting**: GitHub Pages (`index.html`, `data.json`, PWA `manifest.json` + `sw.js`).
- **Media CDN / Storage**: Google Drive via `rclone` (`gdrive:<folder>`).
  - Images use direct CDN links: `https://lh3.googleusercontent.com/d/{FILE_ID}=w1000` (with `referrerpolicy="no-referrer"`).
  - Videos use Drive preview iframe: `https://drive.google.com/file/d/{FILE_ID}/preview`.
- **Serverless Sync & Automation**: GitHub Actions (`workflow_dispatch`, `push`, `schedule`) executes `rclone` uploads/deletions and commits updated `data.json`, `drive-stats.json`, and `index.html`.
- **Network Constraint**: Local office network blocks/throttles `drive.google.com` and `rclone` uploads. Always run `rclone` operations via GitHub Actions rather than locally.
