import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const OUT_DIR = import.meta.dirname || 'd:\\workspace\\instascrap';
const CHAT_FILE = process.argv[2] || path.join(OUT_DIR, 'KakaoTalkChats.txt');
const IMG_DIR = path.join(OUT_DIR, 'images');
const VID_DIR = path.join(OUT_DIR, 'videos');
const CACHE_FILE = path.join(OUT_DIR, 'data.json');
const DELETED_FILE = path.join(OUT_DIR, 'deleted.json');
const DRIVE_STATS_FILE = path.join(OUT_DIR, 'drive-stats.json');
const AUTH_CONFIG_FILE = path.join(OUT_DIR, 'auth-config.json');
const HTML_FILE = path.join(OUT_DIR, 'index.html');

fs.mkdirSync(IMG_DIR, { recursive: true });
fs.mkdirSync(VID_DIR, { recursive: true });

function decodeHtml(str = '') {
  return str
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&#064;/g, '@')
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .trim();
}

function parseChat(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const text = fs.readFileSync(filePath, 'utf8');
  const lines = text.split(/\r?\n/);
  const msgRe = /^(\d{4}년 \d+월 \d+일 (?:오전|오후) \d+:\d+), [^:]+ : (.*)$/;
  const igRe = /https?:\/\/(?:www\.)?instagram\.com\/(p|reel|reels|tv)\/([A-Za-z0-9_-]+)([^\s]*)/;
  const ytRe = /https?:\/\/(?:(?:www\.|m\.)?youtube\.com\/(?:watch\?[^\s]*v=|shorts\/)|youtu\.be\/)([A-Za-z0-9_-]{11})([^\s]*)/;

  const items = [];
  let lastItem = null;

  for (const line of lines) {
    const m = line.match(msgRe);
    if (!m) continue;
    const [, date, body] = m;
    const ig = body.match(igRe);
    const yt = !ig && body.match(ytRe);
    if (ig) {
      const [fullUrl, kind, shortcode, tail] = ig;
      const idxMatch = tail.match(/[?&]img_index=(\d+)/);
      lastItem = {
        shortcode,
        kind: kind === 'p' ? 'post' : 'reel',
        url: fullUrl,
        date,
        imgIndex: idxMatch ? parseInt(idxMatch[1], 10) : 1,
        memo: ''
      };
      items.push(lastItem);
    } else if (yt) {
      const [fullUrl, videoId] = yt;
      lastItem = {
        shortcode: `yt_${videoId}`,
        kind: 'youtube',
        url: fullUrl,
        date,
        imgIndex: 1,
        memo: ''
      };
      items.push(lastItem);
    } else if (/https?:\/\//.test(body)) {
      lastItem = null;
    } else if (lastItem) {
      lastItem.memo = lastItem.memo ? `${lastItem.memo} / ${body.trim()}` : body.trim();
    }
  }

  // Deduplicate by shortcode while preserving memos
  const byCode = new Map();
  for (const it of items) {
    if (byCode.has(it.shortcode)) {
      const prev = byCode.get(it.shortcode);
      if (it.memo && !prev.memo.includes(it.memo)) {
        prev.memo = prev.memo ? `${prev.memo} / ${it.memo}` : it.memo;
      }
    } else {
      byCode.set(it.shortcode, it);
    }
  }
  return [...byCode.values()];
}

async function fetchYouTube(shortcode) {
  const videoId = shortcode.replace(/^yt_/, '');
  const watchUrl = `https://www.youtube.com/watch?v=${videoId}`;
  let owner = '';
  let caption = '';
  try {
    const res = await fetch(`https://www.youtube.com/oembed?url=${encodeURIComponent(watchUrl)}&format=json`);
    if (res.ok) {
      const data = await res.json();
      owner = data.author_name || '';
      caption = data.title || '';
    }
  } catch {}
  return {
    owner,
    caption,
    imageUrls: [`https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`],
    isVideo: true
  };
}

async function fetchEmbed(shortcode) {
  if (shortcode.startsWith('yt_')) return fetchYouTube(shortcode);
  const url = `https://www.instagram.com/p/${shortcode}/embed/captioned/`;
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
    }
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const html = await res.text();

  let owner = '';
  let caption = '';
  let imageUrls = [];
  let videoUrl = '';
  let isVideo = false;

  const ctxMatch = html.match(/"contextJSON":("(?:\\.|[^"\\])*")/);
  if (ctxMatch) {
    try {
      const data = JSON.parse(JSON.parse(ctxMatch[1]));
      const sm = data.gql_data?.shortcode_media;
      if (sm) {
        owner = sm.owner?.username || '';
        caption = sm.edge_media_to_caption?.edges?.[0]?.node?.text || '';
        isVideo = !!sm.is_video;
        videoUrl = sm.video_url || '';
        if (sm.edge_sidecar_to_children?.edges?.length) {
          imageUrls = sm.edge_sidecar_to_children.edges
            .map(e => e.node?.display_url)
            .filter(Boolean);
          if (!videoUrl) {
            videoUrl = sm.edge_sidecar_to_children.edges.find(e => e.node?.video_url)?.node?.video_url || '';
          }
        } else if (sm.display_url) {
          imageUrls = [sm.display_url];
        }
      }
    } catch {}
  }

  if (!imageUrls.length) {
    imageUrls = [...html.matchAll(/class="EmbeddedMediaImage"[^>]*src="([^"]+)"/g)]
      .map(m => decodeHtml(m[1]));
  }
  if (!owner) {
    owner = html.match(/class="UsernameText"[^>]*>([^<]+)</)?.[1]?.trim() || '';
  }
  if (!caption) {
    const capBlock = html.match(/<div class="Caption">([\s\S]*?)<div class="CaptionComments">/)?.[1] || '';
    const withoutUser = capBlock.replace(/<a class="CaptionUsername"[\s\S]*?<\/a>/, '');
    caption = decodeHtml(withoutUser);
  }

  return { owner, caption, imageUrls, videoUrl, isVideo };
}

async function downloadImage(url, destPath) {
  if (fs.existsSync(destPath) && fs.statSync(destPath).size > 500) return true;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
  });
  if (!res.ok) return false;
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(destPath, buf);
  return true;
}

function renderHtml(posts) {
  const jsonSafe = JSON.stringify(posts).replace(/</g, '\\u003c');
  let driveStats = {};
  if (fs.existsSync(DRIVE_STATS_FILE)) {
    try { driveStats = JSON.parse(fs.readFileSync(DRIVE_STATS_FILE, 'utf8')); } catch {}
  }
  const statsSafe = JSON.stringify(driveStats).replace(/</g, '\\u003c');
  let authConfig = { ownerEmail: '', googleClientId: '', encToken: '', users: {} };
  if (fs.existsSync(AUTH_CONFIG_FILE)) {
    try { authConfig = JSON.parse(fs.readFileSync(AUTH_CONFIG_FILE, 'utf8')); } catch {}
  }
  const authSafe = JSON.stringify(authConfig).replace(/</g, '\\u003c');
  return `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="theme-color" content="#ff4d79">
<link rel="manifest" href="manifest.json">
<script src="https://accounts.google.com/gsi/client" async defer></script>
<title>인스타 스크랩북 (${posts.length}개)</title>
<style>
  :root {
    --bg: #0f1115;
    --card: #181b22;
    --border: #282d39;
    --text: #eef0f6;
    --muted: #949ba8;
    --accent: #ff4d79;
    --accent-bg: rgba(255, 77, 121, 0.14);
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    font-family: -apple-system, BlinkMacSystemFont, 'Malgun Gothic', 'Apple SD Gothic Neo', sans-serif;
    background: var(--bg);
    color: var(--text);
  }
  header {
    position: sticky;
    top: 0;
    z-index: 30;
    background: rgba(15, 17, 21, 0.92);
    backdrop-filter: blur(10px);
    border-bottom: 1px solid var(--border);
    padding: 14px 20px;
    transition: transform 0.25s ease;
  }
  header.header-hidden {
    transform: translateY(-100%);
  }
  @media (max-width: 768px) {
    header { padding: 10px 12px; }
    .toolbar { gap: 6px; }
    .title { font-size: 15px; margin-right: 4px; }
    .search { min-width: 100%; order: 10; padding: 7px 11px; font-size: 13px; }
    .btn { padding: 6px 9px; font-size: 12px; }
    .tag-bar {
      flex-wrap: nowrap;
      overflow-x: auto;
      padding-bottom: 4px;
      -webkit-overflow-scrolling: touch;
      scrollbar-width: none;
    }
    .tag-bar::-webkit-scrollbar { display: none; }
    .tag-chip { flex-shrink: 0; }
    .grid { padding: 0 12px 48px; margin: 12px auto; gap: 14px; grid-template-columns: 1fr; }
  }
  .toolbar {
    max-width: 1440px;
    margin: 0 auto;
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
    align-items: center;
  }
  .title {
    font-weight: 800;
    font-size: 18px;
    margin-right: 10px;
    white-space: nowrap;
  }
  .search {
    flex: 1;
    min-width: 220px;
    background: var(--card);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 9px 14px;
    font-size: 14px;
  }
  .btn {
    background: var(--card);
    color: var(--muted);
    border: 1px solid var(--border);
    padding: 8px 13px;
    border-radius: 8px;
    cursor: pointer;
    font-size: 13px;
    font-weight: 600;
  }
  .btn.active {
    background: var(--accent-bg);
    color: var(--accent);
    border-color: var(--accent);
  }
  .count {
    font-size: 13px;
    color: var(--muted);
    margin-left: auto;
  }
  .grid {
    max-width: 1440px;
    margin: 20px auto;
    padding: 0 20px 60px;
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(330px, 1fr));
    gap: 18px;
  }
  .card {
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: 14px;
    overflow: hidden;
    display: flex;
    flex-direction: column;
  }
  .card-head {
    padding: 12px 14px;
    border-bottom: 1px solid var(--border);
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: 8px;
  }
  .memo {
    font-size: 16px;
    font-weight: 700;
    color: #fff;
    line-height: 1.35;
    word-break: keep-all;
  }
  .memo.empty { color: var(--muted); font-weight: 500; font-size: 14px; }
  .meta {
    font-size: 12px;
    color: var(--muted);
    margin-top: 4px;
  }
  .star-btn, .del-btn, .share-btn {
    background: none;
    border: none;
    color: var(--muted);
    font-size: 18px;
    cursor: pointer;
    padding: 2px 5px;
    line-height: 1;
  }
  .star-btn.starred { color: #ffcc00; }
  .share-btn:hover { color: var(--accent); }
  .del-btn:hover { color: #ff4d4f; }
  .memo { cursor: pointer; }
  .memo:hover { text-decoration: underline; }
  .tag-bar {
    max-width: 1440px;
    margin: 8px auto 0;
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    align-items: center;
  }
  .tag-chip {
    background: rgba(255, 77, 121, 0.12);
    color: #ff7aa2;
    border: 1px solid rgba(255, 77, 121, 0.3);
    border-radius: 99px;
    padding: 3px 9px;
    font-size: 12px;
    font-weight: 600;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    gap: 4px;
  }
  .tag-chip:hover, .tag-chip.active {
    background: var(--accent);
    color: #fff;
    border-color: var(--accent);
  }
  .tag-add {
    background: transparent;
    color: var(--muted);
    border: 1px dashed var(--border);
    border-radius: 99px;
    padding: 2px 8px;
    font-size: 11px;
    cursor: pointer;
  }
  .tag-add:hover { color: #fff; border-color: var(--muted); }
  .card-tags {
    display: flex;
    flex-wrap: wrap;
    gap: 5px;
    margin-top: 6px;
  }
  .viewer {
    position: relative;
    background: #08090c;
    aspect-ratio: 4 / 5;
    display: flex;
    align-items: center;
    justify-content: center;
    overflow: hidden;
  }
  .viewer img, .viewer video {
    width: 100%;
    height: 100%;
    object-fit: contain;
    cursor: pointer;
  }
  .slide-track {
    width: 100%;
    height: 100%;
    display: flex;
    overflow-x: auto;
    scroll-snap-type: x mandatory;
    scroll-behavior: smooth;
    scrollbar-width: none;
    -webkit-overflow-scrolling: touch;
  }
  .slide-track::-webkit-scrollbar { display: none; }
  .slide-track img {
    flex: 0 0 100%;
    width: 100%;
    height: 100%;
    object-fit: contain;
    scroll-snap-align: center;
    cursor: pointer;
  }
  .top-btn {
    position: fixed;
    bottom: 22px;
    right: 18px;
    z-index: 40;
    width: 46px;
    height: 46px;
    border-radius: 50%;
    background: var(--accent);
    color: #fff;
    border: none;
    box-shadow: 0 4px 14px rgba(0,0,0,0.5);
    font-size: 20px;
    font-weight: 800;
    cursor: pointer;
    display: none;
    align-items: center;
    justify-content: center;
  }
  .top-btn.show { display: flex; }
  .nav-btn {
    position: absolute;
    top: 50%;
    transform: translateY(-50%);
    background: rgba(0, 0, 0, 0.65);
    color: #fff;
    border: 1px solid rgba(255,255,255,0.2);
    width: 34px;
    height: 34px;
    border-radius: 50%;
    cursor: pointer;
    font-size: 16px;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .nav-btn.prev { left: 8px; }
  .nav-btn.next { right: 8px; }
  .badge {
    position: absolute;
    top: 10px;
    right: 10px;
    background: rgba(0, 0, 0, 0.72);
    color: #fff;
    padding: 3px 9px;
    border-radius: 99px;
    font-size: 12px;
    font-weight: 600;
  }
  .kind-badge {
    position: absolute;
    top: 10px;
    left: 10px;
    background: rgba(0, 0, 0, 0.72);
    color: #fff;
    padding: 3px 8px;
    border-radius: 6px;
    font-size: 11px;
  }
  .card-body {
    padding: 12px 14px;
    display: flex;
    flex-direction: column;
    gap: 8px;
    flex: 1;
  }
  .caption {
    font-size: 13px;
    line-height: 1.55;
    color: #d3d7e2;
    white-space: pre-wrap;
    word-break: break-word;
    max-height: 96px;
    overflow: hidden;
    position: relative;
  }
  .caption.expanded { max-height: none; }
  .more-btn {
    background: none;
    border: none;
    color: var(--accent);
    padding: 0;
    font-size: 12px;
    cursor: pointer;
    align-self: flex-start;
  }
  .card-foot {
    margin-top: auto;
    padding-top: 8px;
    border-top: 1px solid var(--border);
    display: flex;
    justify-content: space-between;
    align-items: center;
    font-size: 12px;
  }
  .card-foot a {
    color: var(--accent);
    text-decoration: none;
    font-weight: 600;
  }
  .no-img {
    color: var(--muted);
    font-size: 13px;
    padding: 20px;
    text-align: center;
  }
  dialog {
    max-width: 94vw;
    max-height: 92vh;
    background: var(--card);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: 14px;
    padding: 16px;
  }
  dialog::backdrop { background: rgba(0,0,0,0.82); }
  .modal-imgs {
    display: flex;
    flex-direction: column;
    gap: 12px;
    max-height: 80vh;
    overflow-y: auto;
  }
  .modal-imgs img {
    max-width: 100%;
    max-height: 78vh;
    object-fit: contain;
    border-radius: 8px;
  }
</style>
</head>
<body>
<header>
  <div class="toolbar">
    <div class="title">📸 인스타 스크랩북</div>
    <input id="q" class="search" type="search" placeholder="메모, 본문 키워드, 작성자, 날짜 검색... (예: 발성, 클로드, 안양, adhd)" />
    <button class="btn active" data-filter="all">전체</button>
    <button class="btn" data-filter="post">카드뉴스·사진</button>
    <button class="btn" data-filter="reel">릴스·영상</button>
    <button class="btn" data-filter="youtube">▶️ 유튜브</button>
    <button class="btn" data-filter="starred">⭐ 즐겨찾기</button>
    <button class="btn" data-filter="trash">🗑️ 휴지통</button>
    <button id="sortBtn" class="btn" title="정렬 순서 변경">🔽 최신순</button>
    <button id="addBtn" class="btn" style="background:var(--accent);color:#fff;border-color:var(--accent);">➕ 링크 추가</button>
    <button id="userBtn" class="btn" title="구글 계정 로그인 / 전환">🔑 구글 로그인</button>
    <span id="syncStatus" style="font-size:12px;padding:5px 10px;border-radius:99px;background:#1f2430;color:#949ba8;"></span>
    <span id="count" class="count"></span>
  </div>
  <div id="tagBar" class="tag-bar"></div>
</header>
<main id="grid" class="grid"></main>
<button id="topBtn" class="top-btn" title="맨 위로 이동">↑</button>
<dialog id="authModal" style="width:min(440px,92vw);">
  <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
    <strong>🔐 구글 계정 로그인 / 회원가입</strong>
    <button id="authCloseBtn" class="btn" onclick="document.getElementById('authModal').close()">닫기</button>
  </div>
  <div style="display:flex;flex-direction:column;gap:10px;">
    <div style="font-size:13px;color:var(--muted);line-height:1.45;">
      구글 계정별로 스크랩북과 #태그가 완전히 분리되어 내 스크랩만 볼 수 있습니다.
    </div>
    <div id="googleGsiBtn" style="display:flex;justify-content:center;margin:4px 0;"></div>
    <div id="savedAccountsWrap" style="display:none;flex-direction:column;gap:6px;">
      <div style="font-size:12px;color:var(--muted);">등록된 가족 구글 계정 (클릭하여 선택):</div>
      <div id="savedAccountsList" style="display:flex;flex-wrap:wrap;gap:6px;"></div>
    </div>
    <input id="authEmail" class="search" type="email" placeholder="구글 이메일 (예: myid@gmail.com)" />
    <input id="authName" class="search" type="text" placeholder="이름 또는 닉네임 (신규 가입 시 입력)" />
    <input id="authPin" class="search" type="password" placeholder="간편 비밀번호 (4자리 이상)" />
    <label id="authClaimWrap" style="display:flex;align-items:center;gap:8px;font-size:13px;color:#d3d7e2;cursor:pointer;">
      <input id="authClaimOwner" type="checkbox" />
      <span>기존에 저장된 스크랩을 이 계정으로 연결 (본인 계정)</span>
    </label>
    <button id="authSubmit" class="btn" style="background:#4285F4;color:#fff;border-color:#4285F4;padding:11px;font-size:14px;">G 구글 계정으로 시작하기</button>
    <button id="logoutBtn" class="btn" style="display:none;color:#ff4d4f;border-color:#ff4d4f;padding:9px;">현재 계정 로그아웃</button>
    <details style="margin-top:4px;font-size:12px;color:var(--muted);">
      <summary style="cursor:pointer;">⚙️ Google 공식 원클릭 팝업(OAuth Client ID) 설정</summary>
      <div style="display:flex;flex-direction:column;gap:6px;margin-top:8px;">
        <input id="oauthClientIdInput" class="search" type="text" placeholder="xxxx.apps.googleusercontent.com" style="font-size:12px;padding:7px 10px;" />
        <button id="saveOauthBtn" class="btn" style="padding:7px;">Client ID 저장</button>
      </div>
    </details>
  </div>
</dialog>
<dialog id="addModal" style="width:min(480px,92vw);">
  <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
    <strong>➕ 인스타 / 유튜브 링크 추가</strong>
    <button class="btn" onclick="document.getElementById('addModal').close()">닫기</button>
  </div>
  <div style="display:flex;flex-direction:column;gap:10px;">
    <input id="addUrl" class="search" type="url" placeholder="https://www.instagram.com/p/... 또는 유튜브 링크" />
    <input id="addMemo" class="search" type="text" list="tagSuggestions" placeholder="메모 및 #태그 (예: 발성연습 #노래발성)" />
    <div id="addTagSuggestions" style="display:flex;flex-wrap:wrap;gap:5px;"></div>
    <button id="addSubmit" class="btn" style="background:var(--accent);color:#fff;border-color:var(--accent);padding:11px;">저장 및 스크랩 실행</button>
  </div>
</dialog>
<dialog id="tagModal" style="width:min(440px,92vw);">
  <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
    <strong id="tagModalTitle">🏷️ #태그 추가 / 메모 수정</strong>
    <button class="btn" onclick="document.getElementById('tagModal').close()">닫기</button>
  </div>
  <div style="display:flex;flex-direction:column;gap:10px;">
    <input id="tagInput" class="search" type="text" list="tagSuggestions" placeholder="새 태그 입력 또는 아래 기존 태그 클릭..." />
    <div style="font-size:12px;color:var(--muted);">기존 태그 클릭 시 바로 추가/해제됩니다:</div>
    <div id="modalTagChips" style="display:flex;flex-wrap:wrap;gap:6px;max-height:180px;overflow-y:auto;"></div>
    <button id="tagSaveBtn" class="btn" style="background:var(--accent);color:#fff;border-color:var(--accent);padding:10px;">저장</button>
  </div>
</dialog>
<datalist id="tagSuggestions"></datalist>
<dialog id="modal">
  <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;gap:16px;">
    <strong id="modalTitle"></strong>
    <button class="btn" onclick="document.getElementById('modal').close()">닫기 (ESC)</button>
  </div>
  <div id="modalBody" class="modal-imgs"></div>
</dialog>
<script>
let POSTS = ${jsonSafe};
let DRIVE_STATS = ${statsSafe};
let AUTH_CONFIG = ${authSafe};
let currentUser = null;
try { currentUser = JSON.parse(localStorage.getItem('ig_user') || 'null'); } catch {}

const TOKEN_KEY = 'instascrap_family_sync_2026';
function encodePat(str) {
  if (!str) return '';
  return Array.from(str).map((c, i) => (c.charCodeAt(0) ^ TOKEN_KEY.charCodeAt(i % TOKEN_KEY.length)).toString(16).padStart(2, '0')).join('');
}
function decodePat(hex) {
  if (!hex || hex.length % 2 !== 0) return '';
  let out = '';
  for (let i = 0; i < hex.length; i += 2) {
    out += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16) ^ TOKEN_KEY.charCodeAt((i / 2) % TOKEN_KEY.length));
  }
  return out;
}
function simpleHash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16);
}

const starred = new Set();
const deleted = new Set();
let customMemos = {};

function userKey(base) {
  return currentUser?.email ? (base + '_' + currentUser.email.toLowerCase()) : base;
}
function isOwnerUser() {
  if (!currentUser?.email) return false;
  const owner = (AUTH_CONFIG.ownerEmail || '').toLowerCase();
  return !owner || owner === currentUser.email.toLowerCase();
}
function isMyPost(p) {
  if (!currentUser?.email) return false;
  const myEmail = currentUser.email.toLowerCase();
  const postUser = (p.user || '').toLowerCase();
  if (postUser) return postUser === myEmail;
  return isOwnerUser();
}
function loadUserState() {
  starred.clear();
  deleted.clear();
  const starRaw = localStorage.getItem(userKey('ig_starred')) || (isOwnerUser() ? localStorage.getItem('ig_starred') : null) || '[]';
  const delRaw = localStorage.getItem(userKey('ig_deleted')) || (isOwnerUser() ? localStorage.getItem('ig_deleted') : null) || '[]';
  const memoRaw = localStorage.getItem(userKey('ig_memos')) || (isOwnerUser() ? localStorage.getItem('ig_memos') : null) || '{}';
  for (const s of JSON.parse(starRaw)) starred.add(s);
  for (const d of JSON.parse(delRaw)) deleted.add(d);
  customMemos = JSON.parse(memoRaw);
  for (const p of POSTS) {
    if (isMyPost(p) && customMemos[p.shortcode] !== undefined) p.memo = customMemos[p.shortcode];
  }
}
loadUserState();

let filter = 'all';
let query = '';
let newestFirst = true;
const isLocal = location.protocol === 'file:' || /^(localhost|127\.|10\.|192\.168\.)/.test(location.hostname);

function saveStars() {
  localStorage.setItem(userKey('ig_starred'), JSON.stringify([...starred]));
}
function saveDeleted() {
  localStorage.setItem(userKey('ig_deleted'), JSON.stringify([...deleted]));
}
function dispatchGitHub(inputs, promptIfMissing = false) {
  let pat = localStorage.getItem('gh_pat') || decodePat(AUTH_CONFIG.encToken || '');
  if (!pat && promptIfMissing) {
    pat = (prompt('GitHub에서 바로 실행하려면 GitHub Personal Access Token (repo/workflow 권한)을 1회 입력해 주세요.\\n(1회 입력 시 가족 계정에도 자동 연동됩니다)') || '').trim();
    if (pat) localStorage.setItem('gh_pat', pat);
  }
  if (!pat) return Promise.resolve(false);
  return fetch('https://api.github.com/repos/jhpark01/instascrap/actions/workflows/scrap.yml/dispatches', {
    method: 'POST',
    headers: {
      'Accept': 'application/vnd.github+json',
      'Authorization': 'Bearer ' + pat,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ ref: 'main', inputs: { ...inputs, user: currentUser?.email || '' } })
  }).then(r => {
    if (r.status === 401 || r.status === 403) {
      localStorage.removeItem('gh_pat');
      alert('GitHub 토큰 권한이 올바르지 않습니다. 다시 시도해 주세요.');
      return false;
    }
    return r.ok;
  }).catch(() => false);
}

function syncApi(action, payload) {
  const fullPayload = { ...payload, user: currentUser?.email || '' };
  if (!isLocal) {
    dispatchGitHub({
      action,
      shortcode: fullPayload.shortcode || '',
      url: fullPayload.url || '',
      memo: fullPayload.memo || '',
      user: fullPayload.user || ''
    }, action === 'add' || action === 'auth');
    return;
  }
  const base = location.protocol.startsWith('http') ? '' : 'http://127.0.0.1:4077';
  fetch(base + '/' + action, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(fullPayload)
  }).catch(() => {});
}

function openModal(p) {
  const modal = document.getElementById('modal');
  document.getElementById('modalTitle').textContent = (p.memo || '메모 없음') + (p.owner ? ' (@' + p.owner + ')' : '');
  const body = document.getElementById('modalBody');
  const imgs = (!isLocal && p.driveImages?.length) ? p.driveImages : (p.localImages || []);
  body.innerHTML = imgs.map((src, i) =>
    '<div><div style="font-size:12px;color:#949ba8;margin-bottom:4px;">슬라이드 ' + (i+1) + ' / ' + imgs.length + '</div><img src="' + src + '" referrerpolicy="no-referrer" loading="lazy"></div>'
  ).join('');
  modal.showModal();
}

function getTags(memo) {
  return [...(memo || '').matchAll(/#([^\\s#]+)/g)].map(m => m[1]);
}
function stripTags(memo) {
  return (memo || '').replace(/#[^\\s#]+/g, '').replace(/\\s+/g, ' ').trim();
}
function saveMemo(p, nextMemo) {
  p.memo = nextMemo.trim();
  customMemos[p.shortcode] = p.memo;
  localStorage.setItem(userKey('ig_memos'), JSON.stringify(customMemos));
  syncApi('memo', { shortcode: p.shortcode, memo: p.memo });
  render();
}
let allSortedTags = [];
let editingPost = null;

function renderTagBar() {
  const counts = new Map();
  for (const p of POSTS) {
    if (!isMyPost(p) || deleted.has(p.shortcode)) continue;
    for (const t of getTags(p.memo)) counts.set(t, (counts.get(t) || 0) + 1);
  }
  const bar = document.getElementById('tagBar');
  bar.innerHTML = '';
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  allSortedTags = sorted.map(([t]) => t);

  const dl = document.getElementById('tagSuggestions');
  if (dl) {
    dl.innerHTML = allSortedTags.map(t => '<option value="#' + t + '"></option><option value="' + t + '"></option>').join('');
  }

  for (const [tag, cnt] of sorted) {
    const chip = document.createElement('button');
    const isAct = query.trim().toLowerCase() === ('#' + tag).toLowerCase();
    chip.className = 'tag-chip' + (isAct ? ' active' : '');
    chip.textContent = '#' + tag + ' (' + cnt + ')';
    chip.onclick = () => {
      const qEl = document.getElementById('q');
      qEl.value = isAct ? '' : '#' + tag;
      query = qEl.value;
      render();
    };
    bar.appendChild(chip);
  }
}

function openTagEditor(p, mode = 'tag') {
  editingPost = p;
  const modal = document.getElementById('tagModal');
  const inp = document.getElementById('tagInput');
  document.getElementById('tagModalTitle').textContent = mode === 'memo' ? '📝 메모 및 #태그 수정' : '🏷️ #태그 추가 (' + (stripTags(p.memo) || p.shortcode) + ')';
  inp.value = mode === 'memo' ? (p.memo || '') : '';
  inp.placeholder = mode === 'memo' ? '메모와 #태그 입력...' : '추가할 태그 입력 (자동완성)...';

  const renderModalChips = () => {
    const wrap = document.getElementById('modalTagChips');
    wrap.innerHTML = '';
    const currentText = mode === 'memo' ? inp.value : ((p.memo || '') + ' ' + inp.value);
    const activeSet = new Set(getTags(currentText));
    const filterKw = mode === 'tag' ? inp.value.replace(/^#+/, '').trim().toLowerCase() : '';
    const list = filterKw ? allSortedTags.filter(t => t.toLowerCase().includes(filterKw)) : allSortedTags;

    for (const t of list) {
      const chip = document.createElement('button');
      chip.type = 'button';
      const has = activeSet.has(t);
      chip.className = 'tag-chip' + (has ? ' active' : '');
      chip.textContent = (has ? '✓ #' : '+ #') + t;
      chip.onclick = () => {
        if (mode === 'memo') {
          if (has) inp.value = inp.value.replace('#' + t, '').replace(/\\s+/g, ' ').trim();
          else inp.value = (inp.value.trim() + ' #' + t).trim();
          renderModalChips();
        } else {
          const curTags = new Set(getTags(p.memo));
          if (curTags.has(t)) saveMemo(p, (p.memo || '').replace('#' + t, ''));
          else saveMemo(p, ((p.memo || '') + ' #' + t).trim());
          renderModalChips();
        }
      };
      wrap.appendChild(chip);
    }
  };

  inp.oninput = renderModalChips;
  inp.onkeydown = e => {
    if (e.key === 'Enter') { e.preventDefault(); document.getElementById('tagSaveBtn').click(); }
  };
  document.getElementById('tagSaveBtn').onclick = () => {
    if (mode === 'memo') {
      saveMemo(p, inp.value);
    } else {
      const raw = inp.value.trim();
      if (raw) {
        const newTags = raw.split(/[\\s,]+/).map(s => s.replace(/^#+/, '').trim()).filter(Boolean);
        const existing = new Set(getTags(p.memo));
        const toAdd = newTags.filter(t => !existing.has(t)).map(t => '#' + t).join(' ');
        if (toAdd) saveMemo(p, ((p.memo || '') + ' ' + toAdd).trim());
      }
    }
    modal.close();
  };

  renderModalChips();
  modal.showModal();
  inp.focus();
}

const cardCache = new Map();
let activeVideoReset = null;
const videoObserver = new IntersectionObserver((entries) => {
  for (const entry of entries) {
    if (!entry.isIntersecting) {
      const v = entry.target.querySelector('video');
      if (v && !v.paused) v.pause();
      if (entry.target._stopVideo) entry.target._stopVideo();
    }
  }
}, { threshold: 0.05 });

function render() {
  const uBtn = document.getElementById('userBtn');
  if (uBtn) {
    uBtn.textContent = currentUser?.email ? ('👤 ' + (currentUser.name || currentUser.email.split('@')[0])) : '🔑 구글 로그인';
  }
  renderTagBar();
  const q = query.trim().toLowerCase();
  const myPosts = POSTS.filter(p => isMyPost(p));
  const list = myPosts.filter(p => {
    const isDel = deleted.has(p.shortcode);
    if (filter === 'trash') return isDel;
    if (isDel) return false;
    if (filter === 'post' && p.kind !== 'post') return false;
    if (filter === 'reel' && p.kind !== 'reel') return false;
    if (filter === 'youtube' && p.kind !== 'youtube') return false;
    if (filter === 'starred' && !starred.has(p.shortcode)) return false;
    if (!q) return true;
    const hay = ((p.memo || '') + ' ' + (p.caption || '') + ' ' + (p.owner || '') + ' ' + (p.date || '')).toLowerCase();
    return hay.includes(q);
  });
  if (newestFirst) list.reverse();

  const activeTotal = myPosts.filter(p => !deleted.has(p.shortcode)).length;
  document.getElementById('count').textContent = list.length + ' / ' + activeTotal + '개';
  const grid = document.getElementById('grid');

  if (!currentUser?.email) {
    grid.innerHTML = '<div style="grid-column:1/-1;text-align:center;padding:60px 20px;color:var(--muted);">🔐 상단 <b>구글 로그인</b> 버튼을 눌러 본인 구글 계정으로 로그인해 주세요.<br><span style="font-size:13px;">계정별로 각자의 스크랩북이 분리되어 표시됩니다.</span></div>';
    return;
  }
  for (const child of [...grid.children]) {
    if (!child.dataset.code) child.remove();
  }

  // 표시 대상이 아닌 카드는 DOM에서 제거
  const visibleCodes = new Set(list.map(p => (p.user || '') + ':' + p.shortcode));
  for (const child of [...grid.children]) {
    if (!visibleCodes.has(child.dataset.code)) child.remove();
  }

  for (let i = 0; i < list.length; i++) {
    const p = list[i];
    const cardKey = (p.user || '') + ':' + p.shortcode;
    const sig = JSON.stringify([
      cardKey,
      p.memo || '',
      p.caption || '',
      p.driveImages || [],
      p.driveVideo || '',
      p.localImages || [],
      p.localVideo || '',
      starred.has(p.shortcode),
      deleted.has(p.shortcode)
    ]);
    let cached = cardCache.get(cardKey);
    if (!cached || cached.sig !== sig) {
      const card = buildCard(p);
      card.dataset.code = cardKey;
      if (cached?.el?.parentNode === grid) {
        grid.replaceChild(card, cached.el);
      }
      cached = { el: card, sig };
      cardCache.set(cardKey, cached);
    }
    if (grid.children[i] !== cached.el) {
      grid.insertBefore(cached.el, grid.children[i] || null);
    }
  }
}

function buildCard(p) {
    const hasLocal = p.localImages?.length > 0;
    const hasDrive = p.driveImages?.length > 0;
    const pendingDrive = !isLocal && hasLocal && !hasDrive;
    const imgs = (!isLocal && hasDrive) ? p.driveImages : (isLocal ? (p.localImages || []) : []);
    let idx = 0;

    const card = document.createElement('article');
    card.className = 'card';

    const head = document.createElement('div');
    head.className = 'card-head';
    const headLeft = document.createElement('div');
    const memoEl = document.createElement('div');
    const firstCaptionLine = (p.caption || '').split('\\n').map(s => s.trim()).find(Boolean) || '';
    const cleanMemo = stripTags(p.memo);
    const tags = getTags(p.memo);
    memoEl.className = 'memo' + (cleanMemo ? '' : ' empty');
    memoEl.title = '클릭하여 메모 및 #태그 수정';
    memoEl.textContent = cleanMemo || (firstCaptionLine ? firstCaptionLine.slice(0, 42) : '(제목/메모 없음)');
    memoEl.onclick = () => openTagEditor(p, 'memo');
    const metaEl = document.createElement('div');
    metaEl.className = 'meta';
    metaEl.textContent = p.date + (p.owner ? ' · @' + p.owner : '');

    const tagWrap = document.createElement('div');
    tagWrap.className = 'card-tags';
    for (const t of tags) {
      const chip = document.createElement('span');
      chip.className = 'tag-chip';
      chip.textContent = '#' + t;
      chip.title = '클릭 시 이 태그만 보기 (우클릭 시 태그 삭제)';
      chip.onclick = () => {
        const qEl = document.getElementById('q');
        qEl.value = '#' + t;
        query = qEl.value;
        render();
      };
      const rm = document.createElement('span');
      rm.textContent = '×';
      rm.style.opacity = '0.7';
      rm.title = '태그 삭제';
      rm.onclick = (e) => {
        e.stopPropagation();
        saveMemo(p, (p.memo || '').replace('#' + t, ''));
      };
      chip.appendChild(rm);
      tagWrap.appendChild(chip);
    }
    const addTagBtn = document.createElement('button');
    addTagBtn.className = 'tag-add';
    addTagBtn.textContent = '+ #태그';
    addTagBtn.onclick = () => openTagEditor(p, 'tag');
    tagWrap.appendChild(addTagBtn);

    headLeft.append(memoEl, tagWrap, metaEl);

    const actions = document.createElement('div');
    actions.style.display = 'flex';
    actions.style.alignItems = 'center';

    const sharePost = async (btnEl, copiedLabel) => {
      const shareTitle = cleanMemo || firstCaptionLine.slice(0, 40) || '인스타 스크랩';
      if (navigator.share) {
        try {
          await navigator.share({ title: shareTitle, url: p.url });
          return;
        } catch (err) {
          if (err && err.name === 'AbortError') return;
        }
      }
      try {
        await navigator.clipboard.writeText(p.url);
        const orig = btnEl.textContent;
        btnEl.textContent = copiedLabel;
        setTimeout(() => { btnEl.textContent = orig; }, 1500);
      } catch {
        prompt('아래 원본 링크를 복사해 주세요:', p.url);
      }
    };

    const shareBtn = document.createElement('button');
    shareBtn.className = 'share-btn';
    shareBtn.textContent = '📤';
    shareBtn.title = '원본 링크 공유하기';
    shareBtn.onclick = () => sharePost(shareBtn, '✅');

    const starBtn = document.createElement('button');
    starBtn.className = 'star-btn' + (starred.has(p.shortcode) ? ' starred' : '');
    starBtn.textContent = '★';
    starBtn.title = '즐겨찾기';
    starBtn.onclick = () => {
      if (starred.has(p.shortcode)) starred.delete(p.shortcode);
      else starred.add(p.shortcode);
      saveStars();
      starBtn.classList.toggle('starred', starred.has(p.shortcode));
    };

    const delBtn = document.createElement('button');
    delBtn.className = 'del-btn';
    const isTrash = deleted.has(p.shortcode);
    delBtn.textContent = isTrash ? '↩️' : '🗑️';
    delBtn.title = isTrash ? '복구하기' : '삭제하기';
    delBtn.onclick = () => {
      if (isTrash) {
        deleted.delete(p.shortcode);
        saveDeleted();
        syncApi('restore', { shortcode: p.shortcode });
      } else {
        deleted.add(p.shortcode);
        saveDeleted();
        syncApi('delete', { shortcode: p.shortcode });
      }
      render();
      checkSyncStatus();
    };

    actions.append(shareBtn, starBtn, delBtn);
    head.append(headLeft, actions);

    const viewer = document.createElement('div');
    viewer.className = 'viewer';

    const kindBadge = document.createElement('span');
    kindBadge.className = 'kind-badge';
    kindBadge.textContent = p.kind === 'youtube' ? '▶️ 유튜브' : (p.kind === 'reel' ? '🎬 릴스' : (imgs.length > 1 ? '📑 카드뉴스' : '🖼️ 사진'));
    viewer.appendChild(kindBadge);

    if (isLocal && p.localVideo) {
      const vidEl = document.createElement('video');
      vidEl.controls = true;
      vidEl.preload = 'none';
      if (imgs[0]) vidEl.poster = imgs[0];
      vidEl.src = p.localVideo;
      vidEl.onplay = () => {
        if (activeVideoReset && activeVideoReset !== viewer._stopVideo) activeVideoReset();
        activeVideoReset = () => { if (!vidEl.paused) vidEl.pause(); };
      };
      viewer.appendChild(vidEl);
      videoObserver.observe(viewer);
    } else if (!isLocal && p.driveVideo) {
      const mountDrivePoster = () => {
        viewer.innerHTML = '';
        const imgEl = document.createElement('img');
        imgEl.loading = 'lazy';
        imgEl.referrerPolicy = 'no-referrer';
        imgEl.src = imgs[0] || '';
        const playBadge = document.createElement('span');
        playBadge.className = 'badge';
        playBadge.style.cursor = 'pointer';
        playBadge.textContent = '▶ 클릭하여 영상 재생';
        const playInFrame = () => {
          if (activeVideoReset) activeVideoReset();
          viewer.innerHTML = '<iframe src="' + p.driveVideo + '" style="width:100%;height:100%;border:0;" allow="autoplay; encrypted-media; fullscreen" allowfullscreen></iframe>';
          viewer._stopVideo = () => {
            viewer._stopVideo = null;
            if (activeVideoReset === stopFn) activeVideoReset = null;
            mountDrivePoster();
          };
          const stopFn = viewer._stopVideo;
          activeVideoReset = stopFn;
          videoObserver.observe(viewer);
        };
        imgEl.onclick = playInFrame;
        playBadge.onclick = playInFrame;
        viewer.append(kindBadge, imgEl, playBadge);
      };
      mountDrivePoster();
    } else if (imgs.length > 0) {
      const isExternalVid = p.kind === 'reel' || p.kind === 'youtube' || p.isVideo;
      if (isExternalVid || imgs.length === 1) {
        const mountExtPoster = () => {
          viewer.innerHTML = '';
          const imgEl = document.createElement('img');
          imgEl.loading = 'lazy';
          imgEl.referrerPolicy = 'no-referrer';
          imgEl.src = imgs[idx];
          imgEl.title = isExternalVid ? '클릭 시 프레임 안에서 영상 재생' : '클릭 시 크게 보기';
          const playExternalInFrame = () => {
            if (activeVideoReset) activeVideoReset();
            const embedSrc = p.kind === 'youtube'
              ? 'https://www.youtube.com/embed/' + p.shortcode.replace(/^yt_/, '') + '?autoplay=1&playsinline=1'
              : 'https://www.instagram.com/p/' + p.shortcode + '/embed/';
            viewer.innerHTML = '<iframe src="' + embedSrc + '" style="width:100%;height:100%;border:0;background:#000;" allow="autoplay; encrypted-media; picture-in-picture; fullscreen" allowfullscreen scrolling="no"></iframe>';
            viewer._stopVideo = () => {
              viewer._stopVideo = null;
              if (activeVideoReset === stopFn) activeVideoReset = null;
              mountExtPoster();
            };
            const stopFn = viewer._stopVideo;
            activeVideoReset = stopFn;
            videoObserver.observe(viewer);
          };
          imgEl.onclick = () => {
            if (isExternalVid) playExternalInFrame();
            else openModal(p);
          };
          viewer.append(kindBadge, imgEl);
          if (isExternalVid) {
            const badge = document.createElement('span');
            badge.className = 'badge';
            badge.style.cursor = 'pointer';
            badge.textContent = '▶ 클릭하여 영상 재생';
            badge.onclick = playExternalInFrame;
            viewer.appendChild(badge);
          }
        };
        mountExtPoster();
      } else {
        const track = document.createElement('div');
        track.className = 'slide-track';
        for (let i = 0; i < imgs.length; i++) {
          const sImg = document.createElement('img');
          sImg.loading = 'lazy';
          sImg.referrerPolicy = 'no-referrer';
          sImg.src = imgs[i];
          sImg.title = '좌우로 밀어서 넘기기 · 클릭 시 전체보기';
          sImg.onclick = () => openModal(p);
          track.appendChild(sImg);
        }
        const badge = document.createElement('span');
        badge.className = 'badge';
        badge.textContent = (idx + 1) + ' / ' + imgs.length;

        const goToSlide = (nextIdx) => {
          idx = (nextIdx + imgs.length) % imgs.length;
          track.scrollTo({ left: idx * track.clientWidth, behavior: 'smooth' });
          badge.textContent = (idx + 1) + ' / ' + imgs.length;
        };
        track.addEventListener('scroll', () => {
          if (!track.clientWidth) return;
          const cur = Math.round(track.scrollLeft / track.clientWidth);
          if (cur >= 0 && cur < imgs.length && cur !== idx) {
            idx = cur;
            badge.textContent = (idx + 1) + ' / ' + imgs.length;
          }
        }, { passive: true });
        if (idx > 0) {
          requestAnimationFrame(() => { track.scrollLeft = idx * track.clientWidth; });
        }

        const prev = document.createElement('button');
        prev.className = 'nav-btn prev';
        prev.textContent = '‹';
        prev.onclick = (e) => { e.stopPropagation(); goToSlide(idx - 1); };

        const next = document.createElement('button');
        next.className = 'nav-btn next';
        next.textContent = '›';
        next.onclick = (e) => { e.stopPropagation(); goToSlide(idx + 1); };

        viewer.append(track, prev, next, badge);
      }
    } else {
      const noImg = document.createElement('div');
      noImg.className = 'no-img';
      if (pendingDrive) {
        noImg.innerHTML = '⏳ <b>구글 드라이브 업로드 대기/진행 중...</b><br><span style="font-size:12px;">완료되면 이미지가 자동으로 표시됩니다</span><br><br><a href="' + p.url + '" target="_blank" rel="noopener" style="color:var(--accent);">원본 링크 바로가기 ↗</a>';
      } else {
        noImg.innerHTML = '미디어를 불러오지 못했습니다<br><a href="' + p.url + '" target="_blank" rel="noopener" style="color:var(--accent);">원본 링크 바로가기 ↗</a>';
      }
      viewer.appendChild(noImg);
    }

    const body = document.createElement('div');
    body.className = 'card-body';
    if (p.caption) {
      const cap = document.createElement('div');
      cap.className = 'caption';
      cap.textContent = p.caption;
      body.appendChild(cap);
      if (p.caption.length > 110 || p.caption.split('\\n').length > 4) {
        const more = document.createElement('button');
        more.className = 'more-btn';
        more.textContent = '본문 더보기';
        more.onclick = () => {
          const exp = cap.classList.toggle('expanded');
          more.textContent = exp ? '접기' : '본문 더보기';
        };
        body.appendChild(more);
      }
    }

    const foot = document.createElement('div');
    foot.className = 'card-foot';
    const slideInfo = document.createElement('span');
    slideInfo.style.color = '#949ba8';
    slideInfo.textContent = imgs.length > 1 ? ('총 ' + imgs.length + '장 (클릭 시 전체보기)') : '';
    const footRight = document.createElement('div');
    footRight.style.display = 'flex';
    footRight.style.alignItems = 'center';
    footRight.style.gap = '10px';
    const footShareBtn = document.createElement('button');
    footShareBtn.className = 'more-btn';
    footShareBtn.style.fontWeight = '600';
    footShareBtn.textContent = '📤 공유';
    footShareBtn.onclick = () => sharePost(footShareBtn, '✅ 링크 복사됨');
    const link = document.createElement('a');
    link.href = p.url;
    link.target = '_blank';
    link.rel = 'noopener';
    link.textContent = p.kind === 'youtube' ? '유튜브 원본 열기 ↗' : '인스타 원본 열기 ↗';
    footRight.append(footShareBtn, link);
    foot.append(slideInfo, footRight);
    body.appendChild(foot);

    card.append(head, viewer, body);
    return card;
}

document.getElementById('q').addEventListener('input', e => {
  query = e.target.value;
  render();
});

document.querySelectorAll('.btn[data-filter]').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.btn[data-filter]').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    filter = btn.dataset.filter;
    render();
  });
});

document.getElementById('sortBtn').addEventListener('click', e => {
  newestFirst = !newestFirst;
  e.target.textContent = newestFirst ? '🔽 최신순' : '🔼 오래된순';
  render();
});

function populateAddModalTags() {
  const wrap = document.getElementById('addTagSuggestions');
  const memoInp = document.getElementById('addMemo');
  if (!wrap || !memoInp) return;
  wrap.innerHTML = '';
  const active = new Set(getTags(memoInp.value));
  for (const t of allSortedTags) {
    const chip = document.createElement('button');
    chip.type = 'button';
    const has = active.has(t);
    chip.className = 'tag-chip' + (has ? ' active' : '');
    chip.textContent = (has ? '✓ #' : '+ #') + t;
    chip.onclick = () => {
      if (has) memoInp.value = memoInp.value.replace('#' + t, '').replace(/\\s+/g, ' ').trim();
      else memoInp.value = (memoInp.value.trim() + ' #' + t).trim();
      populateAddModalTags();
    };
    wrap.appendChild(chip);
  }
}

function syncAuthConfig(extra = {}) {
  const pat = localStorage.getItem('gh_pat') || '';
  const payload = {
    email: currentUser?.email || '',
    name: currentUser?.name || '',
    pinHash: currentUser?.pinHash || '',
    picture: currentUser?.picture || '',
    encToken: pat ? encodePat(pat) : (AUTH_CONFIG.encToken || ''),
    googleClientId: AUTH_CONFIG.googleClientId || '',
    ...extra
  };
  syncApi('auth', { memo: JSON.stringify(payload) });
}

function loginWithUserObj(u, claimOwner = false, shouldSync = true) {
  const email = (u.email || '').trim().toLowerCase();
  if (!email) return;
  if (!AUTH_CONFIG.users) AUTH_CONFIG.users = {};
  const existing = AUTH_CONFIG.users[email] || {};
  const userObj = {
    email,
    name: u.name || existing.name || email.split('@')[0],
    pinHash: u.pinHash || existing.pinHash || '',
    picture: u.picture || existing.picture || ''
  };
  AUTH_CONFIG.users[email] = userObj;
  if (claimOwner || !AUTH_CONFIG.ownerEmail) {
    AUTH_CONFIG.ownerEmail = email;
  }
  currentUser = userObj;
  localStorage.setItem('ig_user', JSON.stringify(currentUser));
  loadUserState();
  render();
  if (shouldSync) {
    syncAuthConfig({ claimOwner: claimOwner || AUTH_CONFIG.ownerEmail === email });
  }
}

function initGoogleGsi() {
  const cid = (AUTH_CONFIG.googleClientId || '').trim();
  const wrap = document.getElementById('googleGsiBtn');
  if (!cid || !wrap || !window.google?.accounts?.id) return;
  try {
    window.google.accounts.id.initialize({
      client_id: cid,
      callback: (resp) => {
        try {
          const base64Url = resp.credential.split('.')[1];
          const base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');
          const jsonPayload = decodeURIComponent(atob(base64).split('').map(c => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2)).join(''));
          const info = JSON.parse(jsonPayload);
          if (info.email) {
            const claim = document.getElementById('authClaimOwner')?.checked || !AUTH_CONFIG.ownerEmail;
            loginWithUserObj({ email: info.email, name: info.name || info.email.split('@')[0], picture: info.picture || '' }, claim, true);
            document.getElementById('authModal').close();
          }
        } catch {}
      }
    });
    wrap.innerHTML = '';
    window.google.accounts.id.renderButton(wrap, { theme: 'filled_blue', size: 'large', text: 'continue_with', shape: 'pill' });
  } catch {}
}

function openAuthModal() {
  const modal = document.getElementById('authModal');
  const emailInp = document.getElementById('authEmail');
  const nameInp = document.getElementById('authName');
  const pinInp = document.getElementById('authPin');
  const claimWrap = document.getElementById('authClaimWrap');
  const claimChk = document.getElementById('authClaimOwner');
  const logoutBtn = document.getElementById('logoutBtn');
  const savedWrap = document.getElementById('savedAccountsWrap');
  const savedList = document.getElementById('savedAccountsList');
  const cidInp = document.getElementById('oauthClientIdInput');

  if (cidInp) cidInp.value = AUTH_CONFIG.googleClientId || '';
  emailInp.value = currentUser?.email || '';
  nameInp.value = currentUser?.name || '';
  pinInp.value = '';

  const hasOwner = !!AUTH_CONFIG.ownerEmail;
  claimChk.checked = !hasOwner || (currentUser?.email && AUTH_CONFIG.ownerEmail.toLowerCase() === currentUser.email.toLowerCase());
  claimWrap.style.display = (!hasOwner || isOwnerUser()) ? 'flex' : 'none';
  logoutBtn.style.display = currentUser?.email ? 'block' : 'none';

  const usersArr = Object.values(AUTH_CONFIG.users || {});
  if (usersArr.length > 0) {
    savedWrap.style.display = 'flex';
    savedList.innerHTML = '';
    for (const u of usersArr) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'tag-chip' + (currentUser?.email === u.email ? ' active' : '');
      chip.textContent = '👤 ' + (u.name || u.email.split('@')[0]) + ' (' + u.email + ')';
      chip.onclick = () => {
        emailInp.value = u.email;
        nameInp.value = u.name || '';
        pinInp.focus();
      };
      savedList.appendChild(chip);
    }
  } else {
    savedWrap.style.display = 'none';
  }

  initGoogleGsi();
  modal.showModal();
}

document.getElementById('userBtn').addEventListener('click', openAuthModal);

document.getElementById('authSubmit').addEventListener('click', () => {
  let email = document.getElementById('authEmail').value.trim().toLowerCase();
  const name = document.getElementById('authName').value.trim();
  const pin = document.getElementById('authPin').value.trim();
  if (!email) { alert('구글 이메일 주소를 입력해 주세요.'); return; }
  if (!email.includes('@')) email += '@gmail.com';
  if (pin.length < 4) { alert('간편 비밀번호를 4자리 이상 입력해 주세요.'); return; }

  const pinHash = simpleHash(email + ':' + pin);
  const existing = AUTH_CONFIG.users?.[email];
  if (existing && existing.pinHash && existing.pinHash !== pinHash) {
    alert('비밀번호가 일치하지 않습니다.');
    return;
  }
  const claim = document.getElementById('authClaimOwner').checked;
  loginWithUserObj({ email, name: name || existing?.name || email.split('@')[0], pinHash }, claim, true);
  document.getElementById('authModal').close();
});

document.getElementById('logoutBtn').addEventListener('click', () => {
  currentUser = null;
  localStorage.removeItem('ig_user');
  loadUserState();
  render();
  document.getElementById('authModal').close();
  openAuthModal();
});

document.getElementById('saveOauthBtn').addEventListener('click', () => {
  const cid = document.getElementById('oauthClientIdInput').value.trim();
  AUTH_CONFIG.googleClientId = cid;
  syncAuthConfig({ googleClientId: cid });
  initGoogleGsi();
  alert('Google OAuth Client ID가 저장되었습니다.');
});

document.getElementById('addBtn').addEventListener('click', () => {
  if (!currentUser?.email) {
    alert('스크랩을 분리 저장하려면 먼저 구글 계정으로 로그인해 주세요.');
    openAuthModal();
    return;
  }
  document.getElementById('addUrl').value = '';
  document.getElementById('addMemo').value = '';
  populateAddModalTags();
  document.getElementById('addModal').showModal();
  document.getElementById('addUrl').focus();
});
document.getElementById('addMemo').addEventListener('input', populateAddModalTags);

document.getElementById('addSubmit').addEventListener('click', async () => {
  const url = document.getElementById('addUrl').value.trim();
  const memo = document.getElementById('addMemo').value.trim();
  if (!url) { alert('링크를 입력해 주세요.'); return; }
  if (isLocal) {
    const base = location.protocol.startsWith('http') ? '' : 'http://127.0.0.1:4077';
    const res = await fetch(base + '/add', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, memo, user: currentUser?.email || '' })
    }).catch(() => null);
    if (res?.ok) {
      document.getElementById('addModal').close();
      await refreshData();
      checkSyncStatus();
    } else {
      alert('로컬 봇 서버(start-bot.bat)가 실행 중인지 확인해 주세요.');
    }
  } else {
    const ok = await dispatchGitHub({ action: 'add', url, memo, shortcode: '' }, true);
    if (ok) {
      if (localStorage.getItem('gh_pat') && !AUTH_CONFIG.encToken) {
        syncAuthConfig();
      }
      document.getElementById('addModal').close();
      setTimeout(checkSyncStatus, 2500);
      alert('✅ 등록 요청 완료! 약 1분 뒤 페이지 새로고침 없이 내 스크랩북에 자동으로 추가됩니다.');
    }
  }
});

let wasServerRunning = false;
let lastScrollY = window.scrollY;
const headerEl = document.querySelector('header');
const topBtn = document.getElementById('topBtn');
topBtn.addEventListener('click', () => {
  headerEl.classList.remove('header-hidden');
  window.scrollTo({ top: 0, behavior: 'smooth' });
});
window.addEventListener('scroll', () => {
  const curY = window.scrollY;
  topBtn.classList.toggle('show', curY > 300);
  if (curY <= 80) {
    headerEl.classList.remove('header-hidden');
  } else if (curY > lastScrollY + 6) {
    headerEl.classList.add('header-hidden');
  }
  lastScrollY = curY;
}, { passive: true });
render();

if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

// 모바일 공유하기(Web Share Target / 단축어)로 진입 시 자동으로 추가 창 열기
const params = new URLSearchParams(location.search);
const sharedRaw = [params.get('url'), params.get('text'), params.get('title')].filter(Boolean).join(' ');
if (sharedRaw) {
  const urlMatch = sharedRaw.match(new RegExp('https?://\\\\S+'));
  if (urlMatch) {
    document.getElementById('addUrl').value = urlMatch[0];
    document.getElementById('addMemo').value = sharedRaw.replace(urlMatch[0], '').trim();
    populateAddModalTags();
    document.getElementById('addModal').showModal();
    document.getElementById('addMemo').focus();
    history.replaceState({}, '', location.pathname);
  }
}
async function fetchJsonLive(fileName) {
  const ts = '?t=' + Date.now();
  if (!isLocal) {
    try {
      const r = await fetch('https://raw.githubusercontent.com/jhpark01/instascrap/main/' + fileName + ts, { cache: 'no-store' });
      if (r.ok) return await r.json();
    } catch {}
  }
  if (location.protocol.startsWith('http')) {
    const r = await fetch(fileName + ts, { cache: 'no-store' });
    if (r.ok) return await r.json();
  }
  return null;
}

async function refreshData() {
  if (!location.protocol.startsWith('http')) return;
  try {
    const [nextPosts, nextStats, nextDeleted, nextAuth] = await Promise.all([
      fetchJsonLive('data.json').catch(() => null),
      fetchJsonLive('drive-stats.json').catch(() => null),
      fetchJsonLive('deleted.json').catch(() => null),
      fetchJsonLive('auth-config.json').catch(() => null)
    ]);
    if (nextAuth && typeof nextAuth === 'object') {
      AUTH_CONFIG = {
        ownerEmail: nextAuth.ownerEmail || AUTH_CONFIG.ownerEmail || '',
        googleClientId: nextAuth.googleClientId || AUTH_CONFIG.googleClientId || '',
        encToken: nextAuth.encToken || AUTH_CONFIG.encToken || '',
        users: { ...(AUTH_CONFIG.users || {}), ...(nextAuth.users || {}) }
      };
    }
    if (nextStats && nextStats.scrapBytes !== undefined) {
      DRIVE_STATS = nextStats;
    }
    if (Array.isArray(nextDeleted) && isOwnerUser()) {
      for (const code of nextDeleted) deleted.add(code);
      saveDeleted();
    }
    if (Array.isArray(nextPosts) && nextPosts.length > 0) {
      for (const p of nextPosts) {
        if (isMyPost(p) && customMemos[p.shortcode] !== undefined) p.memo = customMemos[p.shortcode];
      }
      POSTS = nextPosts;
      render();
    }
  } catch {}
}

function fmtBytes(b) {
  if (!b) return '0MB';
  const tb = b / (1024 ** 4);
  if (tb >= 1) return tb.toFixed(1) + 'TB';
  const gb = b / (1024 ** 3);
  if (gb >= 1) return gb.toFixed(2) + 'GB';
  return (b / (1024 ** 2)).toFixed(0) + 'MB';
}
async function checkSyncStatus() {
  const el = document.getElementById('syncStatus');
  const activePosts = POSTS.filter(p => isMyPost(p) && !deleted.has(p.shortcode) && p.localImages?.length > 0);
  const syncedPosts = activePosts.filter(p => p.driveImages?.length > 0);
  const pendingCount = activePosts.length - syncedPosts.length;
  const usageShort = DRIVE_STATS.scrapBytes
    ? ' · 📦 ' + fmtBytes(DRIVE_STATS.scrapBytes) + (DRIVE_STATS.total ? ' (전체 ' + fmtBytes(DRIVE_STATS.used) + '/' + fmtBytes(DRIVE_STATS.total) + ')' : '')
    : '';
  if (DRIVE_STATS.scrapBytes) {
    el.title = '인스타 스크랩 폴더: ' + fmtBytes(DRIVE_STATS.scrapBytes) + ' (' + (DRIVE_STATS.fileCount || 0) + '개 파일)'
      + (DRIVE_STATS.total ? '\\n구글 드라이브 전체 사용량: ' + fmtBytes(DRIVE_STATS.used) + ' / ' + fmtBytes(DRIVE_STATS.total) + ' (여유 ' + fmtBytes(DRIVE_STATS.free) + ')' : '');
  }
  try {
    const r = await fetch('https://api.github.com/repos/jhpark01/instascrap/actions/runs?per_page=1', { cache: 'no-store' });
    if (r.ok) {
      const d = await r.json();
      const run = d.workflow_runs?.[0];
      if (run && (run.status === 'in_progress' || run.status === 'queued')) {
        wasServerRunning = true;
        el.style.background = 'rgba(255, 170, 0, 0.18)';
        el.style.color = '#ffaa00';
        el.textContent = '🔄 서버 동기화 진행 중...' + (pendingCount > 0 ? ' (대기 ' + pendingCount + '건)' : '') + usageShort;
        setTimeout(checkSyncStatus, 8000);
        return;
      } else if (wasServerRunning) {
        wasServerRunning = false;
        await refreshData();
      }
    }
  } catch {}
  const activeAfter = POSTS.filter(p => isMyPost(p) && !deleted.has(p.shortcode) && p.localImages?.length > 0);
  const syncedAfter = activeAfter.filter(p => p.driveImages?.length > 0);
  const pendingAfter = activeAfter.length - syncedAfter.length;
  const usageAfter = DRIVE_STATS.scrapBytes
    ? ' · 📦 ' + fmtBytes(DRIVE_STATS.scrapBytes) + (DRIVE_STATS.total ? ' (전체 ' + fmtBytes(DRIVE_STATS.used) + '/' + fmtBytes(DRIVE_STATS.total) + ')' : '')
    : '';
  if (pendingAfter > 0) {
    el.style.background = 'rgba(255, 170, 0, 0.18)';
    el.style.color = '#ffaa00';
    el.textContent = '⏳ 드라이브 업로드 중 (' + syncedAfter.length + '/' + activeAfter.length + ' 완료, 남은 ' + pendingAfter + '건)' + usageAfter;
  } else {
    el.style.background = 'rgba(46, 204, 113, 0.16)';
    el.style.color = '#2ecc71';
    el.textContent = '☁️ 드라이브 동기화 완료 (' + syncedAfter.length + '건)' + usageAfter;
  }
}
refreshData().then(() => {
  checkSyncStatus();
  if (!currentUser?.email) {
    openAuthModal();
  } else if (localStorage.getItem('gh_pat') && !AUTH_CONFIG.encToken) {
    syncAuthConfig();
  }
});
</script>
</body>
</html>`;
}

async function main() {
  const deletedSet = new Set(
    fs.existsSync(DELETED_FILE) ? JSON.parse(fs.readFileSync(DELETED_FILE, 'utf8')) : []
  );
  const parsed = parseChat(CHAT_FILE).filter(it => !deletedSet.has(it.shortcode));
  console.log(`Parsed ${parsed.length} unique links from ${CHAT_FILE}`);

  let cache = {};
  const extraItems = [];
  const parsedCodes = new Set(parsed.map(it => it.shortcode));
  if (fs.existsSync(CACHE_FILE)) {
    try {
      for (const p of JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'))) {
        if (!p.user && deletedSet.has(p.shortcode)) continue;
        const key = (p.user || '') + ':' + p.shortcode;
        cache[key] = p;
        if (p.user || !parsedCodes.has(p.shortcode)) extraItems.push(p);
      }
    } catch {}
  }
  const items = [...parsed, ...extraItems];

  let done = 0;
  const CONCURRENCY = 12;
  const queue = [...items];

  async function worker() {
    while (queue.length) {
      const item = queue.shift();
      const key = (item.user || '') + ':' + item.shortcode;
      const cached = cache[key] || cache[':' + item.shortcode];
      const hasDriveImgs = cached && cached.driveImages?.length > 0;
      const imgsOk = hasDriveImgs || (cached && cached.localImages?.length && cached.localImages.every(rel => fs.existsSync(path.join(OUT_DIR, rel))));
      const isIgVideo = (item.kind === 'reel' || cached?.isVideo) && item.kind !== 'youtube';
      const hasVid = (cached && cached.driveVideo) || (cached && cached.localVideo && fs.existsSync(path.join(OUT_DIR, cached.localVideo)));
      const needsVid = isIgVideo && !hasVid && !cached?.videoChecked;
      if (imgsOk && !needsVid) {
        Object.assign(item, {
          user: item.user || cached.user || '',
          memo: item.user ? (item.memo || cached.memo) : (cached.memo || item.memo),
          owner: cached.owner,
          caption: cached.caption,
          localImages: cached.localImages,
          driveImages: cached.driveImages,
          localVideo: cached.localVideo || '',
          driveVideo: cached.driveVideo || '',
          videoChecked: cached.videoChecked,
          isVideo: cached.isVideo
        });
      } else {
        try {
          const meta = await fetchEmbed(item.shortcode);
          const localImages = imgsOk ? cached.localImages : [];
          if (!imgsOk) {
            for (let i = 0; i < meta.imageUrls.length; i++) {
              const ext = meta.imageUrls[i].includes('.webp') ? 'webp' : 'jpg';
              const rel = `images/${item.shortcode}_${i + 1}.${ext}`;
              const ok = await downloadImage(meta.imageUrls[i], path.join(OUT_DIR, rel));
              if (ok) localImages.push(rel);
            }
          }
          let localVideo = cached?.localVideo || '';
          if (meta.videoUrl) {
            const vRel = `videos/${item.shortcode}.mp4`;
            const vOk = await downloadImage(meta.videoUrl, path.join(OUT_DIR, vRel));
            if (vOk) localVideo = vRel;
          }
          Object.assign(item, {
            owner: meta.owner || cached?.owner || '',
            caption: meta.caption || cached?.caption || '',
            localImages,
            localVideo,
            videoChecked: true,
            isVideo: meta.isVideo
          });
        } catch (err) {
          item.localImages = cached?.localImages || [];
          item.localVideo = cached?.localVideo || '';
          item.videoChecked = true;
          item.error = err.message;
        }
      }
      done++;
      if (done === items.length) { console.log(done + '/' + items.length);
        fs.writeFileSync(CACHE_FILE, JSON.stringify(items, null, 2), 'utf8');
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
  fs.writeFileSync(CACHE_FILE, JSON.stringify(items, null, 2), 'utf8');
  fs.writeFileSync(HTML_FILE, renderHtml(items), 'utf8');
  console.log(`Saved ${HTML_FILE} and ${CACHE_FILE}`);
}

export async function downloadPost(item) {
  const meta = await fetchEmbed(item.shortcode);
  const localImages = [];
  for (let i = 0; i < meta.imageUrls.length; i++) {
    const ext = meta.imageUrls[i].includes('.webp') ? 'webp' : 'jpg';
    const rel = `images/${item.shortcode}_${i + 1}.${ext}`;
    const ok = await downloadImage(meta.imageUrls[i], path.join(OUT_DIR, rel));
    if (ok) localImages.push(rel);
  }
  let localVideo = '';
  if (meta.videoUrl) {
    const vRel = `videos/${item.shortcode}.mp4`;
    const vOk = await downloadImage(meta.videoUrl, path.join(OUT_DIR, vRel));
    if (vOk) localVideo = vRel;
  }
  return Object.assign(item, {
    owner: meta.owner,
    caption: meta.caption,
    localImages,
    localVideo,
    videoChecked: true,
    isVideo: meta.isVideo
  });
}

export { OUT_DIR, CACHE_FILE, DELETED_FILE, DRIVE_STATS_FILE, HTML_FILE, fetchEmbed, downloadImage, renderHtml };

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
