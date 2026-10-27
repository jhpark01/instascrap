import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { OUT_DIR, CACHE_FILE, DELETED_FILE, DRIVE_STATS_FILE, HTML_FILE, renderHtml } from './build.mjs';

const RCLONE = process.platform === 'win32' ? path.join(OUT_DIR, 'rclone.exe') : 'rclone';
const CONF = path.join(OUT_DIR, 'rclone.conf');
const REMOTE = 'gdrive:instascrap';

function runRclone(args, stdio = 'pipe') {
  return execFileSync(RCLONE, ['--config', CONF, ...args], {
    encoding: 'utf8',
    stdio,
    maxBuffer: 50 * 1024 * 1024
  });
}

export function isDriveConfigured() {
  if (!fs.existsSync(CONF)) return false;
  let txt = fs.readFileSync(CONF, 'utf8').trim();
  if (!txt) return false;
  if (!txt.includes('[gdrive]')) {
    if (txt.startsWith('{')) txt = `[gdrive]\ntype = drive\ntoken = ${txt}\n`;
    else txt = `[gdrive]\ntype = drive\n${txt}\n`;
    fs.writeFileSync(CONF, txt, 'utf8');
  }
  return true;
}

export function ensureDriveAuth() {
  if (isDriveConfigured()) return;
  console.log('🌐 브라우저에서 구글 계정 로그인 창이 열립니다. 로그인 후 권한을 허용해 주세요...');
  runRclone(['config', 'create', 'gdrive', 'drive'], 'inherit');
  try {
    runRclone(['mkdir', REMOTE]);
    const shareUrl = runRclone(['link', REMOTE]).trim();
    console.log('✅ 구글 드라이브 폴더 공개 링크 설정 완료:', shareUrl);
  } catch {}
}

export function deleteFromDrive(shortcode) {
  if (!isDriveConfigured() || !shortcode) return;
  try {
    console.log(`🗑️ 구글 드라이브에서 삭제 중: ${shortcode}`);
    runRclone(['delete', REMOTE, '--include', `${shortcode}*`]);
  } catch (err) {
    console.error('Drive delete error:', err.message);
  }
}

export function syncDrive(singleShortcode = null) {
  if (!isDriveConfigured()) return false;
  try {
    if (singleShortcode) {
      runRclone(['copy', path.join(OUT_DIR, 'images'), `${REMOTE}/images`, '--include', `${singleShortcode}*`]);
      runRclone(['copy', path.join(OUT_DIR, 'videos'), `${REMOTE}/videos`, '--include', `${singleShortcode}*`]);
    } else {
      console.log('☁️ 구글 드라이브로 이미지/동영상 업로드 중 (변경된 파일만 전송)...');
      runRclone(['mkdir', REMOTE]);
      try { runRclone(['link', REMOTE]); } catch {}
      runRclone(['copy', path.join(OUT_DIR, 'images'), `${REMOTE}/images`, '--transfers', '16', '--checkers', '16'], 'inherit');
      runRclone(['copy', path.join(OUT_DIR, 'videos'), `${REMOTE}/videos`, '--transfers', '8', '--checkers', '8'], 'inherit');
    }

    const raw = runRclone(['lsjson', REMOTE, '-R', '--files-only', '--no-modtime', '--no-mimetype']);
    let files = JSON.parse(raw);

    // 삭제된 스크랩(deleted.json)의 파일이 구글 드라이브에 남아있다면 함께 삭제
    const deletedCodes = fs.existsSync(DELETED_FILE)
      ? JSON.parse(fs.readFileSync(DELETED_FILE, 'utf8'))
      : [];
    for (const code of deletedCodes) {
      if (code && files.some(f => f.Name.startsWith(code))) {
        deleteFromDrive(code);
        files = files.filter(f => !f.Name.startsWith(code));
      }
    }

    // 구글 드라이브 용량 조회 (스크랩 폴더 크기 + 전체 계정 용량)
    const scrapBytes = files.reduce((sum, f) => sum + (f.Size || 0), 0);
    let quota = {};
    try {
      quota = JSON.parse(runRclone(['about', 'gdrive:', '--json']));
    } catch {}
    const driveStats = {
      scrapBytes,
      fileCount: files.length,
      used: quota.used || 0,
      total: quota.total || 0,
      free: quota.free || 0,
      trashed: quota.trashed || 0,
      updatedAt: new Date().toISOString()
    };
    fs.writeFileSync(DRIVE_STATS_FILE, JSON.stringify(driveStats, null, 2), 'utf8');

    const idMap = new Map(files.map(f => [f.Path.replace(/\\/g, '/'), f.ID]));

    const posts = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    let mappedImgs = 0;
    let mappedVids = 0;
    for (const p of posts) {
      if (p.localImages?.length) {
        p.driveImages = p.localImages
          .map(rel => idMap.get(rel))
          .filter(Boolean)
          .map(id => `https://lh3.googleusercontent.com/d/${id}=w1000`);
        mappedImgs += p.driveImages.length;
      }
      if (p.localVideo) {
        const vidId = idMap.get(p.localVideo);
        if (vidId) {
          p.driveVideo = `https://drive.google.com/file/d/${vidId}/preview`;
          mappedVids++;
        }
      }
    }

    fs.writeFileSync(CACHE_FILE, JSON.stringify(posts, null, 2), 'utf8');
    fs.writeFileSync(HTML_FILE, renderHtml(posts), 'utf8');
    console.log(`✅ 구글 드라이브 연동 완료: 이미지 ${mappedImgs}장, 동영상 ${mappedVids}개 링크 매핑됨`);
    return true;
  } catch (err) {
    console.error('Drive sync error:', err.message);
    return false;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  ensureDriveAuth();
  syncDrive();
}
