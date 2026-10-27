import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { OUT_DIR, CACHE_FILE, DELETED_FILE, HTML_FILE, downloadPost, renderHtml } from './build.mjs';
import { syncDrive } from './sync-drive.mjs';

const ENV_FILE = path.join(OUT_DIR, '.env');
const OFFSET_FILE = path.join(OUT_DIR, '.tg_offset');

function loadEnv() {
  if (!fs.existsSync(ENV_FILE)) return {};
  return Object.fromEntries(
    fs.readFileSync(ENV_FILE, 'utf8')
      .split(/\r?\n/)
      .map(l => l.trim())
      .filter(l => l && !l.startsWith('#') && l.includes('='))
      .map(l => {
        const i = l.indexOf('=');
        return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^['"]|['"]$/g, '')];
      })
  );
}

const env = loadEnv();
const TOKEN = process.env.TELEGRAM_BOT_TOKEN || env.TELEGRAM_BOT_TOKEN;
const ALLOWED_CHAT_ID = process.env.ALLOWED_CHAT_ID || env.ALLOWED_CHAT_ID || '';

if (!TOKEN || TOKEN === '여기에_봇_토큰_입력') {
  if (!fs.existsSync(ENV_FILE)) {
    fs.writeFileSync(ENV_FILE, 'TELEGRAM_BOT_TOKEN=여기에_봇_토큰_입력\n# 선택사항: 특정 채팅방 ID만 허용하려면 아래 주석 해제\n# ALLOWED_CHAT_ID=\n', 'utf8');
  }
  console.error(`[안내] ${ENV_FILE} 파일에 TELEGRAM_BOT_TOKEN을 입력한 뒤 다시 실행해 주세요.`);
  process.exit(1);
}

const API = `https://api.telegram.org/bot${TOKEN}`;
const igRe = /https?:\/\/(?:www\.)?instagram\.com\/(p|reel|reels|tv)\/([A-Za-z0-9_-]+)([^\s]*)/;
const ytRe = /https?:\/\/(?:(?:www\.|m\.)?youtube\.com\/(?:watch\?[^\s]*v=|shorts\/)|youtu\.be\/)([A-Za-z0-9_-]{11})([^\s]*)/;

function formatKstDate(unixSec) {
  const d = new Date((unixSec || Math.floor(Date.now() / 1000)) * 1000);
  const parts = new Intl.DateTimeFormat('ko-KR', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true
  }).formatToParts(d);
  const get = t => parts.find(p => p.type === t)?.value || '';
  return `${get('year')}년 ${get('month')}월 ${get('day')}일 ${get('dayPeriod')} ${get('hour')}:${get('minute')}`;
}

function loadPosts() {
  if (!fs.existsSync(CACHE_FILE)) return [];
  try { return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')); } catch { return []; }
}

function savePosts(posts) {
  fs.writeFileSync(CACHE_FILE, JSON.stringify(posts, null, 2), 'utf8');
  fs.writeFileSync(HTML_FILE, renderHtml(posts), 'utf8');
}

async function reply(chatId, text, replyToMessageId) {
  try {
    await fetch(`${API}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        reply_to_message_id: replyToMessageId,
        disable_web_page_preview: true
      })
    });
  } catch {}
}

let offset = fs.existsSync(OFFSET_FILE) ? parseInt(fs.readFileSync(OFFSET_FILE, 'utf8'), 10) || 0 : 0;
let lastShortcodeByChat = new Map();

function loadDeleted() {
  if (!fs.existsSync(DELETED_FILE)) return new Set();
  try { return new Set(JSON.parse(fs.readFileSync(DELETED_FILE, 'utf8'))); } catch { return new Set(); }
}
function saveDeletedSet(set) {
  fs.writeFileSync(DELETED_FILE, JSON.stringify([...set], null, 2), 'utf8');
}

const IS_ONCE = process.argv.includes('--once');
const MIME = { '.html': 'text/html; charset=utf-8', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.mp4': 'video/mp4', '.json': 'application/json' };

if (!IS_ONCE) {
  http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  if (req.method === 'GET') {
    const reqPath = decodeURIComponent(req.url.split('?')[0]);
    const rel = reqPath === '/' ? 'index.html' : reqPath.replace(/^\/+/, '');
    const filePath = path.resolve(OUT_DIR, rel);
    if (!filePath.startsWith(path.resolve(OUT_DIR)) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      res.writeHead(404); res.end('Not found'); return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    fs.createReadStream(filePath).pipe(res);
    return;
  }

  if (req.method !== 'POST') { res.writeHead(404); res.end(); return; }

  let body = '';
  req.on('data', chunk => { body += chunk; });
  req.on('end', async () => {
    try {
      const { shortcode, memo, url } = JSON.parse(body || '{}');
      const posts = loadPosts();
      const delSet = loadDeleted();

      if (req.url === '/add' && url) {
        const ig = url.match(igRe);
        const yt = !ig && url.match(ytRe);
        if (!ig && !yt) { res.writeHead(400); res.end(); return; }
        const code = ig ? ig[2] : `yt_${yt[1]}`;
        const kind = ig ? (ig[1] === 'p' ? 'post' : 'reel') : 'youtube';
        const idxMatch = (ig ? ig[3] : '').match(/[?&]img_index=(\d+)/);
        let item = posts.find(p => p.shortcode === code);
        if (!item) {
          item = { shortcode: code, kind, url, date: formatKstDate(), imgIndex: idxMatch ? parseInt(idxMatch[1], 10) : 1, memo: memo || '' };
          posts.push(item);
        } else if (memo) {
          item.memo = memo;
        }
        await downloadPost(item);
        savePosts(posts);
        syncDrive(code);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, shortcode: code }));
        return;
      }

      if (!shortcode) { res.writeHead(400); res.end(); return; }

      if (req.url === '/delete') {
        delSet.add(shortcode);
        saveDeletedSet(delSet);
        const idx = posts.findIndex(p => p.shortcode === shortcode);
        if (idx !== -1) {
          for (const rel of posts[idx].localImages || []) {
            const pth = path.join(OUT_DIR, rel);
            if (fs.existsSync(pth)) try { fs.unlinkSync(pth); } catch {}
          }
          if (posts[idx].localVideo) {
            const vpth = path.join(OUT_DIR, posts[idx].localVideo);
            if (fs.existsSync(vpth)) try { fs.unlinkSync(vpth); } catch {}
          }
          posts.splice(idx, 1);
          savePosts(posts);
        }
        console.log(`[삭제] ${shortcode}`);
      } else if (req.url === '/restore') {
        delSet.delete(shortcode);
        saveDeletedSet(delSet);
      } else if (req.url === '/memo') {
        const target = posts.find(p => p.shortcode === shortcode);
        if (target) {
          target.memo = memo || '';
          savePosts(posts);
          console.log(`[메모수정] ${shortcode} -> ${target.memo}`);
        }
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    } catch {
      res.writeHead(500);
      res.end();
    }
  });
  }).listen(4077, '0.0.0.0');
}

console.log('🤖 인스타그램 스크랩 텔레그램 봇 대기 중... (인스타 링크와 메모를 보내주세요)');

// GitHub Actions workflow_dispatch로 직접 전달된 입력(추가/삭제/메모수정) 처리
if (process.env.INPUT_ACTION) {
  const act = process.env.INPUT_ACTION;
  const inUrl = (process.env.INPUT_URL || '').trim();
  const inMemo = (process.env.INPUT_MEMO || '').trim();
  const inCode = (process.env.INPUT_SHORTCODE || '').trim();
  const posts = loadPosts();
  const delSet = loadDeleted();

  if (act === 'add' && inUrl) {
    const ig = inUrl.match(igRe);
    const yt = !ig && inUrl.match(ytRe);
    if (ig || yt) {
      const code = ig ? ig[2] : `yt_${yt[1]}`;
      const kind = ig ? (ig[1] === 'p' ? 'post' : 'reel') : 'youtube';
      const idxMatch = (ig ? ig[3] : '').match(/[?&]img_index=(\d+)/);
      let item = posts.find(p => p.shortcode === code);
      if (!item) {
        item = { shortcode: code, kind, url: inUrl, date: formatKstDate(), imgIndex: idxMatch ? parseInt(idxMatch[1], 10) : 1, memo: inMemo };
        posts.push(item);
      } else if (inMemo) {
        item.memo = inMemo;
      }
      await downloadPost(item);
      savePosts(posts);
      syncDrive(code);
    }
  } else if (act === 'delete' && inCode) {
    delSet.add(inCode);
    saveDeletedSet(delSet);
    const idx = posts.findIndex(p => p.shortcode === inCode);
    if (idx !== -1) { posts.splice(idx, 1); savePosts(posts); }
  } else if (act === 'restore' && inCode) {
    delSet.delete(inCode);
    saveDeletedSet(delSet);
  } else if (act === 'memo' && inCode) {
    const target = posts.find(p => p.shortcode === inCode);
    if (target) { target.memo = inMemo; savePosts(posts); }
  }
}

while (true) {
  try {
    const res = await fetch(`${API}/getUpdates?timeout=${IS_ONCE ? 0 : 30}&offset=${offset}`);
    const data = await res.json();
    if (!data.ok) {
      console.error('Telegram API Error:', data.description);
      await new Promise(r => setTimeout(r, 5000));
      continue;
    }

    for (const upd of data.result) {
      offset = upd.update_id + 1;
      fs.writeFileSync(OFFSET_FILE, String(offset), 'utf8');

      const msg = upd.message || upd.channel_post;
      if (!msg?.text) continue;

      const chatId = String(msg.chat.id);
      if (ALLOWED_CHAT_ID && chatId !== String(ALLOWED_CHAT_ID)) continue;

      const text = msg.text.trim();
      const ig = text.match(igRe);
      const yt = !ig && text.match(ytRe);

      if (ig || yt) {
        const fullUrl = ig ? ig[0] : yt[0];
        const kind = ig ? (ig[1] === 'p' ? 'post' : 'reel') : 'youtube';
        const shortcode = ig ? ig[2] : `yt_${yt[1]}`;
        const tail = ig ? ig[3] : '';
        const idxMatch = tail.match(/[?&]img_index=(\d+)/);
        const inlineMemo = text.replace(fullUrl, '').trim();

        const posts = loadPosts();
        let item = posts.find(p => p.shortcode === shortcode);
        const isNew = !item;

        if (!item) {
          item = {
            shortcode,
            kind,
            url: fullUrl,
            date: formatKstDate(msg.date),
            imgIndex: idxMatch ? parseInt(idxMatch[1], 10) : 1,
            memo: inlineMemo
          };
          posts.push(item);
        } else if (inlineMemo && !item.memo.includes(inlineMemo)) {
          item.memo = item.memo ? `${item.memo} / ${inlineMemo}` : inlineMemo;
        }

        await downloadPost(item);
        savePosts(posts);
        syncDrive(shortcode);
        lastShortcodeByChat.set(chatId, shortcode);

        const title = item.memo || (item.caption || '').split('\n')[0]?.slice(0, 35) || shortcode;
        const imgCnt = item.localImages?.length || 0;
        console.log(`[저장] ${shortcode} (${imgCnt}장) - ${title}`);
        await reply(
          chatId,
          `✅ ${isNew ? '스크랩 저장' : '업데이트'} 완료 (${imgCnt}장)\n📌 ${title}\n이어서 메시지를 보내면 이 게시물의 메모로 저장됩니다.`,
          msg.message_id
        );
      } else if (!/https?:\/\//.test(text) && !text.startsWith('/')) {
        // 카톡처럼 링크 보낸 직후 텍스트만 보내면 방금 보낸 인스타 링크의 메모로 등록
        const posts = loadPosts();
        const targetCode = lastShortcodeByChat.get(chatId) || posts[posts.length - 1]?.shortcode;
        const target = posts.find(p => p.shortcode === targetCode);
        if (target) {
          target.memo = target.memo ? `${target.memo} / ${text}` : text;
          savePosts(posts);
          console.log(`[메모] ${target.shortcode} -> ${target.memo}`);
          await reply(chatId, `📝 메모 저장됨: "${target.memo}"`, msg.message_id);
        }
      }
    }
  } catch (err) {
    console.error('Polling error:', err.message);
    if (!IS_ONCE) await new Promise(r => setTimeout(r, 3000));
  }
  if (IS_ONCE) break;
}
