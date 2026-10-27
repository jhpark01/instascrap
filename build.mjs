import fs from 'node:fs';
import path from 'node:path';

const OUT_DIR = import.meta.dirname || 'd:\\workspace\\instascrap';
const CHAT_FILE = process.argv[2] || path.join(OUT_DIR, 'KakaoTalkChats.txt');
const IMG_DIR = path.join(OUT_DIR, 'images');
const VID_DIR = path.join(OUT_DIR, 'videos');
const CACHE_FILE = path.join(OUT_DIR, 'data.json');
const DELETED_FILE = path.join(OUT_DIR, 'deleted.json');
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
  return `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
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
  .star-btn, .del-btn {
    background: none;
    border: none;
    color: var(--muted);
    font-size: 18px;
    cursor: pointer;
    padding: 2px 5px;
    line-height: 1;
  }
  .star-btn.starred { color: #ffcc00; }
  .del-btn:hover { color: #ff4d4f; }
  .memo { cursor: pointer; }
  .memo:hover { text-decoration: underline; }
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
    <span id="count" class="count"></span>
  </div>
</header>
<main id="grid" class="grid"></main>
<dialog id="modal">
  <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;gap:16px;">
    <strong id="modalTitle"></strong>
    <button class="btn" onclick="document.getElementById('modal').close()">닫기 (ESC)</button>
  </div>
  <div id="modalBody" class="modal-imgs"></div>
</dialog>
<script>
const POSTS = ${jsonSafe};
const starred = new Set(JSON.parse(localStorage.getItem('ig_starred') || '[]'));
const deleted = new Set(JSON.parse(localStorage.getItem('ig_deleted') || '[]'));
const customMemos = JSON.parse(localStorage.getItem('ig_memos') || '{}');
for (const p of POSTS) {
  if (customMemos[p.shortcode] !== undefined) p.memo = customMemos[p.shortcode];
}
let filter = 'all';
let query = '';
let newestFirst = true;
const isLocal = location.protocol === 'file:' || /^(localhost|127\.|10\.|192\.168\.)/.test(location.hostname);

function saveStars() {
  localStorage.setItem('ig_starred', JSON.stringify([...starred]));
}
function saveDeleted() {
  localStorage.setItem('ig_deleted', JSON.stringify([...deleted]));
}
function syncApi(action, payload) {
  const base = location.protocol.startsWith('http') ? '' : 'http://127.0.0.1:4077';
  fetch(base + '/' + action, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
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

function render() {
  const q = query.trim().toLowerCase();
  const list = POSTS.filter(p => {
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

  const activeTotal = POSTS.filter(p => !deleted.has(p.shortcode)).length;
  document.getElementById('count').textContent = list.length + ' / ' + activeTotal + '개';
  const grid = document.getElementById('grid');
  grid.innerHTML = '';

  for (const p of list) {
    const imgs = (!isLocal && p.driveImages?.length) ? p.driveImages : (p.localImages?.length ? p.localImages : (p.driveImages || []));
    let idx = Math.min(Math.max((p.imgIndex || 1) - 1, 0), Math.max(imgs.length - 1, 0));

    const card = document.createElement('article');
    card.className = 'card';

    const head = document.createElement('div');
    head.className = 'card-head';
    const headLeft = document.createElement('div');
    const memoEl = document.createElement('div');
    const firstCaptionLine = (p.caption || '').split('\\n').map(s => s.trim()).find(Boolean) || '';
    memoEl.className = 'memo' + (p.memo ? '' : ' empty');
    memoEl.title = '클릭하여 메모 수정';
    memoEl.textContent = p.memo || (firstCaptionLine ? firstCaptionLine.slice(0, 42) : '(제목/메모 없음)');
    memoEl.onclick = () => {
      const next = prompt('메모 수정:', p.memo || '');
      if (next === null) return;
      p.memo = next.trim();
      customMemos[p.shortcode] = p.memo;
      localStorage.setItem('ig_memos', JSON.stringify(customMemos));
      syncApi('memo', { shortcode: p.shortcode, memo: p.memo });
      render();
    };
    const metaEl = document.createElement('div');
    metaEl.className = 'meta';
    metaEl.textContent = p.date + (p.owner ? ' · @' + p.owner : '');
    headLeft.append(memoEl, metaEl);

    const actions = document.createElement('div');
    actions.style.display = 'flex';
    actions.style.alignItems = 'center';

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
    };

    actions.append(starBtn, delBtn);
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
      viewer.appendChild(vidEl);
    } else if (!isLocal && p.driveVideo) {
      const imgEl = document.createElement('img');
      imgEl.loading = 'lazy';
      imgEl.referrerPolicy = 'no-referrer';
      imgEl.src = imgs[0] || '';
      const playBadge = document.createElement('span');
      playBadge.className = 'badge';
      playBadge.textContent = '▶ 클릭하여 드라이브 영상 재생';
      imgEl.onclick = () => {
        viewer.innerHTML = '<iframe src="' + p.driveVideo + '" style="width:100%;height:100%;border:0;" allow="autoplay; encrypted-media" allowfullscreen></iframe>';
      };
      viewer.append(imgEl, playBadge);
    } else if (imgs.length > 0) {
      const imgEl = document.createElement('img');
      imgEl.loading = 'lazy';
      imgEl.referrerPolicy = 'no-referrer';
      imgEl.src = imgs[idx];
      const isExternalVid = p.kind === 'reel' || p.kind === 'youtube' || p.isVideo;
      imgEl.title = isExternalVid ? '클릭 시 원본 영상 열기' : '클릭 시 슬라이드 전체보기';
      imgEl.onclick = () => {
        if (isExternalVid) window.open(p.url, '_blank', 'noopener');
        else openModal(p);
      };
      viewer.appendChild(imgEl);

      if (isExternalVid) {
        const badge = document.createElement('span');
        badge.className = 'badge';
        badge.textContent = '↗ 클릭 시 영상 열기';
        viewer.appendChild(badge);
      } else if (imgs.length > 1) {
        const badge = document.createElement('span');
        badge.className = 'badge';
        const updateSlide = (nextIdx) => {
          idx = (nextIdx + imgs.length) % imgs.length;
          imgEl.src = imgs[idx];
          badge.textContent = (idx + 1) + ' / ' + imgs.length;
        };
        updateSlide(idx);

        const prev = document.createElement('button');
        prev.className = 'nav-btn prev';
        prev.textContent = '‹';
        prev.onclick = (e) => { e.stopPropagation(); updateSlide(idx - 1); };

        const next = document.createElement('button');
        next.className = 'nav-btn next';
        next.textContent = '›';
        next.onclick = (e) => { e.stopPropagation(); updateSlide(idx + 1); };

        viewer.append(prev, next, badge);
      }
    } else {
      const noImg = document.createElement('div');
      noImg.className = 'no-img';
      noImg.innerHTML = '미디어를 불러오지 못했습니다<br><a href="' + p.url + '" target="_blank" rel="noopener" style="color:var(--accent);">원본 링크 바로가기 ↗</a>';
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
    const link = document.createElement('a');
    link.href = p.url;
    link.target = '_blank';
    link.rel = 'noopener';
    link.textContent = p.kind === 'youtube' ? '유튜브 원본 열기 ↗' : '인스타 원본 열기 ↗';
    foot.append(slideInfo, link);
    body.appendChild(foot);

    card.append(head, viewer, body);
    grid.appendChild(card);
  }
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

render();
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
        if (deletedSet.has(p.shortcode)) continue;
        cache[p.shortcode] = p;
        if (!parsedCodes.has(p.shortcode)) extraItems.push(p);
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
      const cached = cache[item.shortcode];
      const hasDrive = cached && cached.driveImages?.length > 0;
      const imgsOk = hasDrive || (cached && cached.localImages?.length && cached.localImages.every(rel => fs.existsSync(path.join(OUT_DIR, rel))));
      const needsVid = !hasDrive && (item.kind === 'reel' || cached?.isVideo) && item.kind !== 'youtube' && !cached?.videoChecked;
      if (imgsOk && !needsVid) {
        Object.assign(item, {
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
      if (done % 25 === 0 || done === items.length) {
        console.log(`Progress: ${done}/${items.length}`);
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

export { OUT_DIR, CACHE_FILE, DELETED_FILE, HTML_FILE, fetchEmbed, downloadImage, renderHtml };

if (import.meta.url === `file:///${process.argv[1].replace(/\\/g, '/')}`) {
  main();
}
