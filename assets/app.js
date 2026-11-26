/* Pickle PC — 정적 프런트엔드
 * 모든 데이터 접근은 사용자가 입력한 GitHub 토큰으로 브라우저에서 직접 이뤄집니다.
 * 서버 없음 · 토큰은 localStorage에만 보관 · 공개 저장소에는 아무 데이터도 남지 않습니다.
 */
(function () {
  'use strict';

  var API = 'https://api.github.com';
  var LS_TOKEN = 'picklePc.token.v1';
  var LS_CFG = 'picklePc.cfg.v1';
  var DEFAULT_CFG = { owner: 'sogic8-web', repo: 'pickle-workspace' };
  var WARN_BYTES = 20 * 1024 * 1024;
  var BLOCK_BYTES = 95 * 1024 * 1024;
  var TEXT_PREVIEW_LIMIT = 400000;

  var IMAGE_EXT = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'avif', 'ico'];
  var TEXT_EXT = ['md', 'markdown', 'txt', 'csv', 'tsv', 'json', 'log', 'yaml', 'yml', 'xml',
    'html', 'htm', 'css', 'js', 'ts', 'py', 'sh', 'ini', 'conf', 'sql'];

  var state = {
    token: '',
    cfg: Object.assign({}, DEFAULT_CFG),
    conn: 'idle',          // idle | checking | ok | error
    connMessage: '',
    repoInfo: null,
    files: [],             // 첨부 대기 파일
    lastSent: null,        // { path, copyText }
    loaded: { outbox: false, inbox: false, inboxFiles: false },
    preview: null          // { path, name, sha }
  };

  // ---------------------------------------------------------------- utils
  function $(id) { return document.getElementById(id); }

  function on(el, ev, fn) { if (el) el.addEventListener(ev, fn); }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  var KST_FMT = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
  });

  function kstParts(d) {
    var o = {};
    KST_FMT.formatToParts(d || new Date()).forEach(function (p) {
      if (p.type !== 'literal') o[p.type] = p.value;
    });
    return o;
  }

  function stampKST(d) {
    var p = kstParts(d);
    return p.year + p.month + p.day + '_' + p.hour + p.minute + p.second;
  }

  function stampToKst(stamp) {
    if (!/^\d{8}_\d{6}$/.test(stamp || '')) return '';
    return stamp.slice(0, 4) + '-' + stamp.slice(4, 6) + '-' + stamp.slice(6, 8) +
      ' ' + stamp.slice(9, 11) + ':' + stamp.slice(11, 13) + ':' + stamp.slice(13, 15);
  }

  function fmtDate(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    var p = kstParts(d);
    return p.month + '-' + p.day + ' ' + p.hour + ':' + p.minute;
  }

  function fmtSize(bytes) {
    if (typeof bytes !== 'number' || bytes < 0) return '';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / 1024 / 1024).toFixed(1) + ' MB';
  }

  function ext(name) {
    var s = String(name || '');
    var i = s.lastIndexOf('.');
    return i > -1 ? s.slice(i + 1).toLowerCase() : '';
  }

  function fileIcon(name) {
    var e = ext(name);
    if (IMAGE_EXT.indexOf(e) > -1) return '🖼️';
    if (e === 'pdf') return '📕';
    if (e === 'md' || e === 'markdown') return '📝';
    if (e === 'docx' || e === 'doc' || e === 'hwp' || e === 'hwpx') return '📄';
    if (e === 'xlsx' || e === 'xls' || e === 'csv') return '📊';
    if (e === 'zip' || e === '7z' || e === 'tar' || e === 'gz') return '🗜️';
    if (e === 'json' || e === 'xml' || e === 'yaml' || e === 'yml') return '🧾';
    return '📎';
  }

  function safeFileName(name) {
    var s = String(name || 'file').replace(/[\\/:*?"<>|]/g, '_').replace(/[\u0000-\u001f]/g, '');
    s = s.replace(/^\.+/, '').trim();
    if (!s) s = 'file';
    if (s.length > 90) {
      var e = ext(s);
      var base = s.slice(0, 90 - (e ? e.length + 1 : 0));
      s = e ? base + '.' + e : base;
    }
    return s;
  }

  function slug(name) {
    var s = String(name || '')
      .replace(/[\r\n\t]+/g, ' ')
      .replace(/[\\/:*?"<>|]/g, '')
      .replace(/[^\uAC00-\uD7A3a-zA-Z0-9 _-]/g, '')
      .trim()
      .replace(/\s+/g, '_')
      .replace(/_+/g, '_')
      .replace(/^_|_$/g, '');
    if (s.length > 40) s = s.slice(0, 40).replace(/_+$/, '');
    return s || '요청';
  }

  function encPath(path) {
    return String(path).split('/').map(encodeURIComponent).join('/');
  }

  function bytesToBase64(bytes) {
    var CHUNK = 0x8000;
    var out = '';
    for (var i = 0; i < bytes.length; i += CHUNK) {
      out += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    return btoa(out);
  }

  function repoBase() {
    return '/repos/' + encodeURIComponent(state.cfg.owner) + '/' + encodeURIComponent(state.cfg.repo);
  }

  function repoUrl() {
    return 'https://github.com/' + state.cfg.owner + '/' + state.cfg.repo;
  }

  // ---------------------------------------------------------------- storage
  function loadStored() {
    try {
      var t = localStorage.getItem(LS_TOKEN);
      if (t) state.token = t;
      var c = localStorage.getItem(LS_CFG);
      if (c) {
        var parsed = JSON.parse(c);
        if (parsed && parsed.owner && parsed.repo) {
          state.cfg = { owner: String(parsed.owner), repo: String(parsed.repo) };
        }
      }
    } catch (e) { /* 저장소 접근 불가 시 기본값 사용 */ }
  }

  function saveToken(t) {
    state.token = t || '';
    try {
      if (state.token) localStorage.setItem(LS_TOKEN, state.token);
      else localStorage.removeItem(LS_TOKEN);
    } catch (e) { /* 무시 */ }
  }

  function saveCfg(cfg) {
    state.cfg = { owner: cfg.owner, repo: cfg.repo };
    try { localStorage.setItem(LS_CFG, JSON.stringify(state.cfg)); } catch (e) { /* 무시 */ }
  }

  // ---------------------------------------------------------------- api
  function ApiError(status, message, payload) {
    var err = new Error(message);
    err.name = 'ApiError';
    err.status = status;
    err.payload = payload || null;
    return err;
  }

  function messageFor(status, payload) {
    var msg = payload && payload.message ? String(payload.message) : '';
    if (status === 401) return '토큰이 유효하지 않습니다. 설정에서 토큰을 다시 확인해 주세요.';
    if (status === 403) {
      if (/rate limit/i.test(msg)) return 'GitHub 요청 한도를 넘었습니다. 잠시(최대 1시간) 후 다시 시도해 주세요.';
      return '권한이 없습니다. 토큰의 저장소 접근 범위와 Contents 권한(Read and write)을 확인해 주세요.';
    }
    if (status === 404) return '저장소나 파일을 찾을 수 없습니다. 저장소 이름과 토큰의 저장소 선택을 확인해 주세요.';
    if (status === 409 || status === 422) return '요청을 처리할 수 없습니다. 같은 이름의 파일이 있거나 형식이 맞지 않습니다.';
    if (status === 413) return '파일이 너무 큽니다. 20MB 이하로 나누어 보내 주세요.';
    if (status === 429) return '요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.';
    if (status >= 500) return 'GitHub 서버가 응답하지 않습니다. 잠시 후 다시 시도해 주세요.';
    return msg || ('요청이 실패했습니다 (HTTP ' + status + ').');
  }

  async function api(path, opts) {
    opts = opts || {};
    var headers = {
      'Accept': opts.raw ? 'application/vnd.github.raw' : 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28'
    };
    if (opts.headers) Object.keys(opts.headers).forEach(function (k) { headers[k] = opts.headers[k]; });
    if (state.token) headers['Authorization'] = 'Bearer ' + state.token;
    var res = await fetch(API + path, {
      method: opts.method || 'GET',
      headers: headers,
      body: opts.body,
      cache: 'no-store'
    });
    if (!res.ok) {
      var payload = null;
      try { payload = await res.json(); } catch (e) { payload = null; }
      throw ApiError(res.status, messageFor(res.status, payload), payload);
    }
    return res;
  }

  async function putContent(path, bytes, message, sha) {
    var body = { message: message, content: bytesToBase64(bytes) };
    if (sha) body.sha = sha;
    var res = await api(repoBase() + '/contents/' + encPath(path), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    return res.json();
  }

  /** 새 파일 업로드. 같은 경로가 이미 있으면 sha를 받아 덮어쓴다. */
  async function putNewFile(path, bytes, message) {
    try {
      return await putContent(path, bytes, message);
    } catch (e) {
      if (e.status !== 409 && e.status !== 422) throw e;
      var sha = null;
      try {
        var r = await api(repoBase() + '/contents/' + encPath(path));
        var j = await r.json();
        if (j && j.sha) sha = j.sha;
      } catch (e2) { sha = null; }
      if (!sha) throw e;
      return putContent(path, bytes, message, sha);
    }
  }

  async function listDir(path) {
    try {
      var res = await api(repoBase() + '/contents/' + encPath(path));
      var data = await res.json();
      if (!Array.isArray(data)) return [];
      return data;
    } catch (e) {
      if (e.status === 404) return [];
      throw e;
    }
  }

  var WORKSPACE_README = [
    '# pickle-workspace (비공개)',
    '',
    'Pickle PC 화면(<https://sogic8-web.github.io/pickle-pc/>)이 쓰는 **비공개 작업 공간**입니다.',
    '프롬프트와 첨부 파일, 결과물이 모두 여기에만 저장됩니다.',
    '',
    '## 구조',
    '',
    '```',
    'inbox/                          PC 화면에서 보낸 요청',
    '  {YYYYMMDD_HHMMSS}_{제목}.md      요청 본문 + 첨부 링크',
    '  files/                          첨부 파일 원본',
    'outbox/                         피클이 올려 두는 결과물 (PC 화면에서 바로 내려받기)',
    '```',
    '',
    '- 모든 시각은 한국시간(KST) 기준입니다.',
    '- 이 저장소는 **비공개**여야 합니다. 공개로 바뀌면 PC 화면이 경고를 띄웁니다.',
    ''
  ].join('\n');

  /** 처음 연결할 때 inbox/ · outbox/ 폴더와 README를 준비한다 */
  async function ensureWorkspace() {
    var rootItems = null;
    try {
      var rootRes = await api(repoBase() + '/contents/');
      rootItems = await rootRes.json();
    } catch (e) {
      if (e.status === 404) rootItems = [];
      else return;
    }
    if (Array.isArray(rootItems) && rootItems.length === 0) {
      try {
        await putNewFile('README.md', new TextEncoder().encode(WORKSPACE_README), 'docs: workspace README (Pickle PC)');
      } catch (e3) { /* 권한이 없으면 조용히 넘어감 */ }
    }
    var dirs = ['inbox', 'outbox', 'inbox/files'];
    for (var i = 0; i < dirs.length; i++) {
      var dir = dirs[i];
      try {
        await api(repoBase() + '/contents/' + encPath(dir));
      } catch (e) {
        if (e.status !== 404) continue;
        try {
          await putNewFile(dir + '/.gitkeep', new Uint8Array(0), 'chore: create ' + dir + '/');
        } catch (e2) { /* 권한이 없으면 조용히 넘어감 */ }
      }
    }
  }

  // ---------------------------------------------------------------- UI 기본
  var toastTimer = null;
  function toast(msg, kind) {
    var el = $('toast');
    if (!el) return;
    el.textContent = msg;
    el.className = 'toast' + (kind === 'error' ? ' is-err' : kind === 'ok' ? ' is-ok' : '');
    el.hidden = false;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.hidden = true; }, 3600);
  }

  function setPill(kind, text, title) {
    var el = $('statusPill');
    if (!el) return;
    el.className = 'pill pill-' + kind;
    el.textContent = text;
    el.title = title || text;
  }

  function refreshConnUI() {
    if (state.conn === 'ok') {
      setPill('ok', '연결됨 ✅', (state.repoInfo && state.repoInfo.full_name ? state.repoInfo.full_name : state.cfg.owner + '/' + state.cfg.repo) + ' (비공개)');
    } else if (state.conn === 'checking') {
      setPill('busy', '확인 중…', 'GitHub에 연결을 확인하는 중입니다');
    } else if (state.conn === 'error') {
      setPill('err', '연결 오류', state.connMessage || '연결에 실패했습니다');
    } else {
      setPill('idle', state.token ? '미확인' : '미연결', state.token ? '토큰은 저장됐지만 아직 확인하지 않았습니다' : '설정에서 GitHub 토큰을 연결해 주세요');
    }

    var banner = $('setupBanner');
    if (banner) banner.hidden = (state.conn === 'ok');

    var privacy = $('privacyBanner');
    if (privacy) {
      var isPublic = state.conn === 'ok' && state.repoInfo && state.repoInfo.private === false;
      privacy.hidden = !isPublic;
      if (isPublic) {
        var pl = $('privacyLink');
        if (pl) pl.href = repoUrl() + '/settings';
      }
    }

    var footer = $('footerConn');
    if (footer) {
      footer.textContent = state.conn === 'ok'
        ? '연결: ' + (state.repoInfo && state.repoInfo.full_name ? state.repoInfo.full_name : state.cfg.owner + '/' + state.cfg.repo)
        : '';
    }

    var link = $('repoLink');
    var flink = $('footerRepoLink');
    if (link) { link.href = repoUrl(); link.textContent = repoUrl(); }
    if (flink) flink.href = repoUrl();
  }

  function showTab(name) {
    var panels = document.querySelectorAll('.panel');
    for (var i = 0; i < panels.length; i++) {
      panels[i].hidden = (panels[i].id !== 'tab-' + name);
    }
    var tabs = document.querySelectorAll('.tab');
    for (var j = 0; j < tabs.length; j++) {
      var active = tabs[j].getAttribute('data-tab') === name;
      tabs[j].classList.toggle('is-active', active);
      tabs[j].setAttribute('aria-selected', active ? 'true' : 'false');
    }
    if (name === 'outbox' && !state.loaded.outbox) loadOutbox();
    if (name === 'inbox') {
      if (!state.loaded.inbox) loadInbox();
      if (!state.loaded.inboxFiles) loadInboxFiles();
    }
    if (name === 'settings') {
      var ti = $('tokenInput');
      if (ti) ti.value = state.token;
      var co = $('cfgOwner'), cr = $('cfgRepo');
      if (co) co.value = state.cfg.owner;
      if (cr) cr.value = state.cfg.repo;
      refreshConnUI();
    }
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  // ---------------------------------------------------------------- 연결
  async function connect(silent) {
    if (!state.token) {
      state.conn = 'idle';
      refreshConnUI();
      if (!silent) {
        $('connResult').className = 'conn-result err';
        $('connResult').textContent = '먼저 토큰을 입력하고 저장해 주세요.';
      }
      return false;
    }
    state.conn = 'checking';
    refreshConnUI();
    try {
      var res = await api(repoBase());
      var info = await res.json();
      state.repoInfo = info;
      state.conn = 'ok';
      state.connMessage = '';
      refreshConnUI();
      var ok = $('connResult');
      if (ok) {
        ok.className = 'conn-result ok';
        var push = info && info.permissions ? info.permissions.push : true;
        ok.textContent = '연결되었습니다 ✅ ' + (info.full_name || '') +
          (info.private ? ' (비공개 저장소)' : ' — 경고: 이 저장소는 공개 상태입니다!') +
          (push === false ? ' · 경고: 쓰기 권한이 없습니다(Contents: Read and write 확인).' : '');
      }
      if (!silent) toast('GitHub 연결 확인 완료', 'ok');
      ensureWorkspace();
      return true;
    } catch (e) {
      state.conn = 'error';
      state.connMessage = e.message || '연결 실패';
      refreshConnUI();
      var err = $('connResult');
      if (err) {
        err.className = 'conn-result err';
        err.textContent = '연결 실패: ' + state.connMessage;
      }
      if (!silent) toast(state.connMessage, 'error');
      return false;
    }
  }

  // ---------------------------------------------------------------- 첨부
  function addFiles(fileList) {
    var incoming = Array.prototype.slice.call(fileList || []);
    var blocked = 0;
    var big = 0;
    incoming.forEach(function (f) {
      if (f.size > BLOCK_BYTES) { blocked++; return; }
      if (f.size > WARN_BYTES) big++;
      var dup = state.files.some(function (x) {
        return x.name === f.name && x.size === f.size && x.lastModified === f.lastModified;
      });
      if (!dup) state.files.push(f);
    });
    renderFiles();
    if (blocked) toast(blocked + '개 파일이 너무 커서(95MB 초과) 제외했습니다.', 'error');
    else if (big) toast(big + '개 파일이 20MB를 넘습니다. 업로드가 느리거나 실패할 수 있습니다.', 'error');
  }

  function renderFiles() {
    var ul = $('fileList');
    if (!ul) return;
    ul.innerHTML = '';
    ul.hidden = state.files.length === 0;
    state.files.forEach(function (f, idx) {
      var li = document.createElement('li');
      var icon = document.createElement('span');
      icon.textContent = fileIcon(f.name);
      var name = document.createElement('span');
      name.className = 'fname';
      name.textContent = f.name;
      var size = document.createElement('span');
      size.className = 'fsize';
      size.textContent = fmtSize(f.size) + (f.size > WARN_BYTES ? ' · 큼' : '');
      var rm = document.createElement('button');
      rm.type = 'button';
      rm.className = 'fremove';
      rm.setAttribute('aria-label', f.name + ' 제거');
      rm.textContent = '✕';
      rm.addEventListener('click', function () {
        state.files.splice(idx, 1);
        renderFiles();
      });
      li.appendChild(icon); li.appendChild(name); li.appendChild(size); li.appendChild(rm);
      ul.appendChild(li);
    });
  }

  function buildMarkdown(title, body, uploaded, stamp) {
    var now = new Date();
    var p = kstParts(now);
    var lines = [];
    lines.push('# ' + (title || 'PC 요청'));
    lines.push('');
    lines.push('- 보낸 시각: ' + p.year + '-' + p.month + '-' + p.day + ' ' + p.hour + ':' + p.minute + ' (KST)');
    lines.push('- 보낸 곳: Pickle PC 웹 (pickle-pc)');
    lines.push('- 요청 파일: `inbox/' + stamp + '_' + slug(title) + '.md`');
    lines.push('');
    lines.push('## 요청 내용');
    lines.push('');
    lines.push(body && body.trim() ? body.trim() : '_(본문 없이 파일만 보냈습니다.)_');
    lines.push('');
    if (uploaded && uploaded.length) {
      lines.push('## 첨부 파일 (' + uploaded.length + '개)');
      lines.push('');
      uploaded.forEach(function (f) {
        lines.push('- [' + f.name + '](files/' + encodeURIComponent(f.original) + ') · ' + fmtSize(f.size) + ' · `' + f.path + '`');
      });
      lines.push('');
      var imgs = uploaded.filter(function (f) { return IMAGE_EXT.indexOf(ext(f.name)) > -1; });
      if (imgs.length) {
        lines.push('## 이미지 미리보기');
        lines.push('');
        imgs.forEach(function (f) {
          lines.push('![' + f.name + '](files/' + encodeURIComponent(f.original) + ')');
        });
        lines.push('');
      }
    }
    lines.push('---');
    lines.push('_이 파일은 Pickle PC 웹 화면에서 자동으로 만들어졌습니다. 결과물은 `outbox/`에 올려 주세요._');
    lines.push('');
    return lines.join('\n');
  }

  async function sendPrompt() {
    var bodyEl = $('promptBody');
    var titleEl = $('promptTitle');
    var body = bodyEl ? bodyEl.value : '';
    var title = titleEl ? titleEl.value.trim() : '';

    if (!state.token) {
      showTab('settings');
      toast('먼저 GitHub 토큰을 연결해 주세요.', 'error');
      return;
    }
    if (!body.trim() && state.files.length === 0) {
      toast('프롬프트나 파일을 하나 이상 넣어 주세요.', 'error');
      bodyEl && bodyEl.focus();
      return;
    }
    if (state.conn !== 'ok') {
      var okConn = await connect(true);
      if (!okConn) {
        toast('GitHub 연결을 확인하지 못했습니다. 설정을 확인해 주세요.', 'error');
        return;
      }
    }
    if (state.repoInfo && state.repoInfo.private === false) {
      var goOn = window.confirm('연결된 저장소(' + state.cfg.owner + '/' + state.cfg.repo + ')가 공개 상태입니다.\n' +
        '지금 보내는 프롬프트와 파일을 누구나 볼 수 있습니다.\n\n그래도 보낼까요?');
      if (!goOn) return;
    }

    var btn = $('btnSend');
    var status = $('sendStatus');
    var label = btn.querySelector('.btn-label');
    btn.disabled = true;
    label.textContent = '보내는 중…';
    status.className = 'send-status';
    status.textContent = '업로드 준비 중…';

    var stamp = stampKST();
    if (!title) {
      var firstLine = (body.split('\n').map(function (s) { return s.trim(); }).filter(Boolean)[0] || '');
      title = firstLine ? firstLine.slice(0, 40) : (state.files[0] ? state.files[0].name : 'PC 요청');
    }
    var mdPath = 'inbox/' + stamp + '_' + slug(title) + '.md';
    var uploaded = [];
    var total = state.files.length;

    try {
      for (var i = 0; i < total; i++) {
        var f = state.files[i];
        status.textContent = '파일 업로드 중… (' + (i + 1) + '/' + total + ') ' + truncate(f.name, 40);
        var path = 'inbox/files/' + stamp + '_' + safeFileName(f.name);
        var bytes = new Uint8Array(await f.arrayBuffer());
        await putNewFile(path, bytes, 'add: ' + f.name + ' (Pickle PC)');
        uploaded.push({ path: path, name: f.name, original: safeFileName(f.name), size: f.size });
      }

      status.textContent = '요청 파일 작성 중…';
      var md = buildMarkdown(title, body, uploaded, stamp);
      await putNewFile(mdPath, new TextEncoder().encode(md), 'add: ' + title + ' (Pickle PC)');

      state.lastSent = { path: mdPath, copyText: 'PC 입력함 확인해 줘 — ' + mdPath };
      showResult(mdPath, uploaded.length);

      bodyEl.value = '';
      if (titleEl) titleEl.value = '';
      state.files = [];
      renderFiles();
      updateCounter();
      status.className = 'send-status is-ok';
      status.textContent = '완료 — inbox/' + stamp + ' 로 저장했습니다.';
      toast('보냈습니다 ✅', 'ok');
      state.loaded.inbox = false;
      state.loaded.inboxFiles = false;
    } catch (e) {
      status.className = 'send-status is-err';
      status.textContent = e.message || '업로드에 실패했습니다.';
      toast(e.message || '업로드에 실패했습니다.', 'error');
    } finally {
      btn.disabled = false;
      label.textContent = '보내기';
    }
  }

  function truncate(s, n) {
    s = String(s || '');
    return s.length > n ? s.slice(0, n - 1) + '…' : s;
  }

  function showResult(mdPath, fileCount) {
    var card = $('resultCard');
    if (!card) return;
    card.hidden = false;
    $('resultPath').textContent = mdPath + (fileCount ? ' · 첨부 ' + fileCount + '개' : '');
    $('copyText').textContent = state.lastSent.copyText;
    card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  async function copyLastSent() {
    if (!state.lastSent) return;
    var text = state.lastSent.copyText;
    var btn = $('btnCopy');
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        var ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
      }
      btn.textContent = '복사됨 ✓';
      toast('복사했습니다. 피클 앱에 붙여넣어 주세요.', 'ok');
      setTimeout(function () { btn.textContent = '한 줄 복사'; }, 2200);
    } catch (e) {
      toast('복사에 실패했습니다. 아래 문구를 직접 선택해 복사해 주세요.', 'error');
    }
  }

  // ---------------------------------------------------------------- 목록
  function itemRow(opts) {
    var li = document.createElement('li');
    li.className = 'item';

    var icon = document.createElement('div');
    icon.className = 'item-icon';
    icon.textContent = opts.icon || fileIcon(opts.name);

    var main = document.createElement('div');
    main.className = 'item-main';
    var nm = document.createElement('div');
    nm.className = 'item-name';
    nm.textContent = opts.displayName || opts.name;
    nm.title = opts.name;
    var meta = document.createElement('div');
    meta.className = 'item-meta';
    meta.textContent = opts.meta || '';
    main.appendChild(nm);
    main.appendChild(meta);

    var actions = document.createElement('div');
    actions.className = 'item-actions';

    (opts.actions || []).forEach(function (a) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'btn btn-sm ' + (a.variant || 'btn-ghost');
      b.textContent = a.label;
      b.addEventListener('click', a.onClick);
      actions.appendChild(b);
    });

    li.appendChild(icon);
    li.appendChild(main);
    li.appendChild(actions);
    return li;
  }

  function emptyState(ul, text, kind) {
    ul.innerHTML = '';
    var li = document.createElement('li');
    li.className = kind || 'empty';
    li.textContent = text;
    ul.appendChild(li);
  }

  /** 목록을 불러오기 전에 연결 상태를 확인한다 */
  async function readyForList(ul, emptyHint) {
    if (!state.token) { emptyState(ul, emptyHint); return false; }
    if (state.conn !== 'ok') {
      var ok = await connect(true);
      if (!ok) { emptyState(ul, state.connMessage || 'GitHub 연결을 확인하지 못했습니다.', 'error'); return false; }
    }
    return true;
  }

  async function loadOutbox() {
    var ul = $('outboxList');
    if (!ul) return;
    if (!(await readyForList(ul, 'GitHub 토큰을 연결하면 피클이 올려둔 결과물이 여기에 나타납니다. (설정 탭)'))) return;
    emptyState(ul, '불러오는 중…', 'loading');
    try {
      var items = await listDir('outbox');
      items = items.filter(function (it) { return it.type === 'file'; })
        .sort(function (a, b) { return String(b.name).localeCompare(String(a.name)); });
      if (!items.length) {
        emptyState(ul, '아직 받은 결과물이 없습니다. 피클이 outbox/에 파일을 올리면 여기에 보입니다.');
      } else {
        ul.innerHTML = '';
        items.forEach(function (it) { ul.appendChild(outboxRow(it)); });
      }
      state.loaded.outbox = true;
    } catch (e) {
      emptyState(ul, e.message || '목록을 불러오지 못했습니다.', 'error');
    }
  }

  function outboxRow(it) {
    var actions = [];
    if (isPreviewable(it.name)) {
      actions.push({
        label: '미리보기',
        onClick: function () { previewFile(it.path, it.name); }
      });
    }
    actions.push({
      label: '다운로드',
      variant: 'btn-secondary',
      onClick: function () { downloadFile(it.path, it.name); }
    });
    actions.push({
      label: '삭제',
      variant: 'btn-danger-ghost',
      onClick: function () { deleteFile(it.path, it.name, function () { loadOutbox(); }); }
    });
    return itemRow({
      name: it.name,
      displayName: prettyName(it.name),
      icon: fileIcon(it.name),
      meta: [fmtSize(it.size), fmtDate(it.updated_at || it.created_at), 'outbox/' + it.name].filter(Boolean).join(' · '),
      actions: actions
    });
  }

  function prettyName(name) {
    var m = /^(\d{8}_\d{6})_(.+)$/.exec(name || '');
    if (m) return m[2].replace(/_/g, ' ');
    return name;
  }

  function isPreviewable(name) {
    var e = ext(name);
    return IMAGE_EXT.indexOf(e) > -1 || e === 'pdf' || TEXT_EXT.indexOf(e) > -1;
  }

  async function loadInbox() {
    var ul = $('inboxList');
    if (!ul) return;
    if (!(await readyForList(ul, 'GitHub 토큰을 연결하면 보낸 요청 기록이 여기에 나타납니다. (설정 탭)'))) return;
    emptyState(ul, '불러오는 중…', 'loading');
    try {
      var items = await listDir('inbox');
      items = items.filter(function (it) { return it.type === 'file' && /\.md$/i.test(it.name); })
        .sort(function (a, b) { return String(b.name).localeCompare(String(a.name)); });
      if (!items.length) {
        emptyState(ul, '아직 보낸 요청이 없습니다. “보내기” 탭에서 첫 요청을 남겨 보세요.');
      } else {
        ul.innerHTML = '';
        items.forEach(function (it) {
          var m = /^(\d{8}_\d{6})_(.*)\.md$/i.exec(it.name);
          ul.appendChild(itemRow({
            name: it.name,
            displayName: prettyName(it.name.replace(/\.md$/i, '')),
            icon: '📝',
            meta: [(stampToKst(m ? m[1] : '') || fmtDate(it.updated_at)), fmtSize(it.size), 'inbox/' + it.name].filter(Boolean).join(' · '),
            actions: [
              { label: '내용 보기', onClick: function () { previewFile(it.path, it.name); } },
              { label: '삭제', variant: 'btn-danger-ghost', onClick: function () { deleteFile(it.path, it.name, function () { loadInbox(); }); } }
            ]
          }));
        });
      }
      state.loaded.inbox = true;
    } catch (e) {
      emptyState(ul, e.message || '목록을 불러오지 못했습니다.', 'error');
    }
  }

  async function loadInboxFiles() {
    var ul = $('inboxFilesList');
    if (!ul) return;
    if (!(await readyForList(ul, '토큰을 연결하면 첨부 파일 목록이 나타납니다.'))) return;
    emptyState(ul, '불러오는 중…', 'loading');
    try {
      var items = await listDir('inbox/files');
      items = items.filter(function (it) { return it.type === 'file' && it.name !== '.gitkeep'; })
        .sort(function (a, b) { return String(b.name).localeCompare(String(a.name)); });
      if (!items.length) {
        emptyState(ul, '아직 첨부한 파일이 없습니다.');
      } else {
        ul.innerHTML = '';
        items.forEach(function (it) {
          var actions = [];
          if (isPreviewable(it.name)) {
            actions.push({ label: '미리보기', onClick: function () { previewFile(it.path, it.name); } });
          }
          actions.push({ label: '다운로드', variant: 'btn-secondary', onClick: function () { downloadFile(it.path, it.name); } });
          actions.push({ label: '삭제', variant: 'btn-danger-ghost', onClick: function () { deleteFile(it.path, it.name, function () { loadInboxFiles(); }); } });
          ul.appendChild(itemRow({
            name: it.name,
            displayName: stripStamp(it.name),
            icon: fileIcon(it.name),
            meta: [fmtSize(it.size), fmtDate(it.updated_at)].filter(Boolean).join(' · '),
            actions: actions
          }));
        });
      }
      state.loaded.inboxFiles = true;
    } catch (e) {
      emptyState(ul, e.message || '목록을 불러오지 못했습니다.', 'error');
    }
  }

  function stripStamp(name) {
    var m = /^(\d{8}_\d{6})_(.+)$/.exec(name || '');
    return m ? m[2] : name;
  }

  // ---------------------------------------------------------------- 파일 동작
  function friendlyDownloadName(name) {
    return stripStamp(name);
  }

  async function fetchRaw(path) {
    var res = await api(repoBase() + '/contents/' + encPath(path), { raw: true });
    return res;
  }

  async function downloadFile(path, name) {
    try {
      toast('내려받는 중…');
      var res = await fetchRaw(path);
      var blob = await res.blob();
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = friendlyDownloadName(name) || 'download';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 5000);
      toast('다운로드했습니다.', 'ok');
    } catch (e) {
      toast(e.message || '다운로드에 실패했습니다.', 'error');
    }
  }

  async function deleteFile(path, name, after) {
    if (!window.confirm('“' + name + '”을(를) 삭제할까요?\n삭제하면 되돌릴 수 없습니다.')) return;
    try {
      var res = await api(repoBase() + '/contents/' + encPath(path));
      var data = await res.json();
      if (!data || !data.sha) throw new Error('파일 정보를 확인하지 못했습니다.');
      await api(repoBase() + '/contents/' + encPath(path), {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'delete: ' + name + ' (Pickle PC)', sha: data.sha })
      });
      toast('삭제했습니다.', 'ok');
      if (typeof after === 'function') after();
    } catch (e) {
      toast(e.message || '삭제에 실패했습니다.', 'error');
    }
  }

  function closePreview() {
    var m = $('previewModal');
    if (!m) return;
    m.hidden = true;
    $('previewBody').innerHTML = '';
    state.preview = null;
  }

  async function previewFile(path, name) {
    var modal = $('previewModal');
    var bodyEl = $('previewBody');
    if (!modal || !bodyEl) return;
    state.preview = { path: path, name: name };
    $('previewTitle').textContent = name;
    bodyEl.innerHTML = '<p class="muted small" style="margin:0">불러오는 중…</p>';
    modal.hidden = false;
    try {
      var res = await fetchRaw(path);
      var e = ext(name);
      if (IMAGE_EXT.indexOf(e) > -1) {
        var blob = await res.blob();
        var url = URL.createObjectURL(blob);
        var img = document.createElement('img');
        img.src = url;
        img.alt = name;
        img.addEventListener('load', function () { URL.revokeObjectURL(url); });
        bodyEl.innerHTML = '';
        bodyEl.appendChild(img);
      } else if (e === 'pdf') {
        var pblob = await res.blob();
        var ptype = pblob.type && pblob.type !== 'application/octet-stream' ? pblob.type : 'application/pdf';
        var purl = URL.createObjectURL(new Blob([pblob], { type: ptype }));
        var frame = document.createElement('iframe');
        frame.src = purl;
        frame.title = name;
        frame.addEventListener('load', function () { setTimeout(function () { URL.revokeObjectURL(purl); }, 10000); });
        bodyEl.innerHTML = '';
        bodyEl.appendChild(frame);
      } else {
        var text = await res.text();
        var truncated = text.length > TEXT_PREVIEW_LIMIT;
        if (truncated) text = text.slice(0, TEXT_PREVIEW_LIMIT);
        bodyEl.innerHTML = '';
        if (e === 'md' || e === 'markdown') {
          var md = document.createElement('div');
          md.className = 'md';
          md.innerHTML = renderMarkdown(text);
          bodyEl.appendChild(md);
        } else {
          var pre = document.createElement('pre');
          pre.textContent = text;
          bodyEl.appendChild(pre);
        }
        if (truncated) {
          var note = document.createElement('p');
          note.className = 'muted small';
          note.textContent = '내용이 길어 앞부분만 표시했습니다. 전체는 다운로드해 확인해 주세요.';
          bodyEl.appendChild(note);
        }
      }
    } catch (err) {
      bodyEl.innerHTML = '';
      var p = document.createElement('p');
      p.className = 'small';
      p.style.color = 'var(--danger)';
      p.textContent = err.message || '미리보기를 불러오지 못했습니다.';
      bodyEl.appendChild(p);
    }
  }

  /** 아주 작은 마크다운 렌더러 (HTML은 먼저 이스케이프하므로 스크립트가 실행되지 않습니다) */
  function renderMarkdown(src) {
    var lines = String(src || '').replace(/\r\n?/g, '\n').split('\n');
    var html = [];
    var inList = false;
    var inCode = false;
    var codeBuf = [];

    function closeList() {
      if (inList) { html.push('</ul>'); inList = false; }
    }

    lines.forEach(function (raw) {
      var line = raw;
      if (/^```/.test(line)) {
        if (inCode) {
          html.push('<pre class="md-pre"><code>' + esc(codeBuf.join('\n')) + '</code></pre>');
          codeBuf = [];
          inCode = false;
        } else {
          closeList();
          inCode = true;
        }
        return;
      }
      if (inCode) { codeBuf.push(line); return; }

      if (!line.trim()) { closeList(); return; }
      if (/^\s*[-*]\s+/.test(line)) {
        if (!inList) { html.push('<ul>'); inList = true; }
        html.push('<li>' + inline(line.replace(/^\s*[-*]\s+/, '')) + '</li>');
        return;
      }
      closeList();
      var h = /^(#{1,4})\s+(.*)$/.exec(line);
      if (h) {
        var lvl = Math.min(h[1].length, 3);
        html.push('<h' + lvl + '>' + inline(h[2]) + '</h' + lvl + '>');
        return;
      }
      if (/^---+$/.test(line.trim())) { html.push('<hr>'); return; }
      if (/^>\s?/.test(line)) { html.push('<p style="border-left:3px solid var(--line-strong);padding-left:10px;color:var(--muted)">' + inline(line.replace(/^>\s?/, '')) + '</p>'); return; }
      html.push('<p>' + inline(line) + '</p>');
    });
    if (inCode && codeBuf.length) html.push('<pre class="md-pre"><code>' + esc(codeBuf.join('\n')) + '</code></pre>');
    closeList();
    return html.join('');
  }

  function inline(s) {
    var out = esc(s);
    out = out.replace(/`([^`]+)`/g, '<code>$1</code>');
    out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    out = out.replace(/(^|[\s(])\*([^*]+)\*/g, '$1<em>$2</em>');
    out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
    return out;
  }

  // ---------------------------------------------------------------- 이벤트
  function updateCounter() {
    var el = $('charCount');
    var ta = $('promptBody');
    if (!el || !ta) return;
    el.textContent = ta.value.length.toLocaleString('ko-KR') + '자';
  }

  function wire() {
    // 탭
    document.querySelectorAll('.tab').forEach(function (t) {
      t.addEventListener('click', function () { showTab(t.getAttribute('data-tab')); });
    });

    // 설정 이동
    on($('btnGoSettings'), 'click', function () { showTab('settings'); });
    document.querySelectorAll('[data-action="open-settings"]').forEach(function (b) {
      b.addEventListener('click', function () { showTab('settings'); });
    });
    document.querySelectorAll('[data-action="go-outbox"]').forEach(function (b) {
      b.addEventListener('click', function () { state.loaded.outbox = false; showTab('outbox'); });
    });
    document.querySelectorAll('[data-action="go-inbox"]').forEach(function (b) {
      b.addEventListener('click', function () { state.loaded.inbox = false; showTab('inbox'); });
    });
    document.querySelectorAll('[data-action="refresh-outbox"]').forEach(function (b) {
      b.addEventListener('click', function () { loadOutbox(); });
    });
    document.querySelectorAll('[data-action="refresh-inbox"]').forEach(function (b) {
      b.addEventListener('click', function () { loadInbox(); });
    });
    document.querySelectorAll('[data-action="refresh-inbox-files"]').forEach(function (b) {
      b.addEventListener('click', function () { loadInboxFiles(); });
    });
    document.querySelectorAll('[data-action="close-preview"]').forEach(function (b) {
      b.addEventListener('click', closePreview);
    });
    on($('previewDownload'), 'click', function () {
      if (state.preview) downloadFile(state.preview.path, state.preview.name);
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') closePreview();
    });

    // 프롬프트
    var ta = $('promptBody');
    if (ta) {
      ta.addEventListener('input', updateCounter);
      ta.addEventListener('keydown', function (e) {
        if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
          e.preventDefault();
          sendPrompt();
        }
      });
      ta.addEventListener('paste', function (e) {
        var items = e.clipboardData && e.clipboardData.files;
        if (items && items.length) {
          addFiles(items);
        }
      });
    }
    on($('promptTitle'), 'keydown', function (e) {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); sendPrompt(); }
    });
    on($('btnSend'), 'click', sendPrompt);
    on($('btnCopy'), 'click', copyLastSent);
    on($('btnClear'), 'click', function () {
      if (ta) ta.value = '';
      var t = $('promptTitle');
      if (t) t.value = '';
      state.files = [];
      renderFiles();
      updateCounter();
      var s = $('sendStatus');
      if (s) { s.textContent = ''; s.className = 'send-status'; }
      if (ta) ta.focus();
    });

    // 드롭존
    var dz = $('dropzone');
    var fi = $('fileInput');
    if (dz && fi) {
      dz.addEventListener('click', function () { fi.click(); });
      dz.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fi.click(); }
      });
      fi.addEventListener('change', function () {
        addFiles(fi.files);
        fi.value = '';
      });
      ['dragenter', 'dragover'].forEach(function (ev) {
        dz.addEventListener(ev, function (e) { e.preventDefault(); dz.classList.add('is-drag'); });
      });
      ['dragleave', 'drop'].forEach(function (ev) {
        dz.addEventListener(ev, function (e) { e.preventDefault(); dz.classList.remove('is-drag'); });
      });
      dz.addEventListener('drop', function (e) {
        if (e.dataTransfer && e.dataTransfer.files) addFiles(e.dataTransfer.files);
      });
      // 페이지 전체로 파일이 떨어져도 브라우저가 파일을 열지 않도록
      window.addEventListener('dragover', function (e) { e.preventDefault(); });
      window.addEventListener('drop', function (e) { e.preventDefault(); });
    }

    // 설정: 토큰
    on($('btnToggleToken'), 'click', function () {
      var inp = $('tokenInput');
      if (!inp) return;
      var show = inp.type === 'password';
      inp.type = show ? 'text' : 'password';
      $('btnToggleToken').textContent = show ? '가리기' : '보기';
    });
    on($('btnSaveToken'), 'click', async function () {
      var v = ($('tokenInput').value || '').trim();
      if (!v) { toast('토큰을 입력해 주세요.', 'error'); return; }
      if (/\s/.test(v)) { toast('토큰에 공백이 있습니다. 다시 확인해 주세요.', 'error'); return; }
      saveToken(v);
      saveCfg({ owner: ($('cfgOwner').value || '').trim() || DEFAULT_CFG.owner, repo: ($('cfgRepo').value || '').trim() || DEFAULT_CFG.repo });
      state.loaded.outbox = state.loaded.inbox = state.loaded.inboxFiles = false;
      toast('저장했습니다. 연결을 확인합니다…', 'ok');
      await connect(false);
    });
    on($('btnTestConn'), 'click', async function () {
      var v = ($('tokenInput').value || '').trim();
      if (v && v !== state.token) saveToken(v);
      await connect(false);
    });
    on($('btnForgetToken'), 'click', function () {
      if (!window.confirm('저장된 토큰을 이 브라우저에서 삭제할까요?\n(데이터는 지워지지 않습니다. 설정에서 새 토큰으로 다시 연결할 수 있습니다.)')) return;
      saveToken('');
      var inp = $('tokenInput');
      if (inp) inp.value = '';
      state.conn = 'idle';
      state.connMessage = '';
      state.repoInfo = null;
      state.loaded.outbox = state.loaded.inbox = state.loaded.inboxFiles = false;
      var r = $('connResult');
      if (r) { r.className = 'conn-result'; r.textContent = '토큰을 삭제했습니다.'; }
      refreshConnUI();
      toast('토큰을 삭제했습니다.', 'ok');
    });

    // 설정: 저장소
    on($('btnSaveCfg'), 'click', function () {
      var o = ($('cfgOwner').value || '').trim();
      var r = ($('cfgRepo').value || '').trim();
      if (!o || !r) { toast('계정과 저장소 이름을 모두 입력해 주세요.', 'error'); return; }
      saveCfg({ owner: o, repo: r });
      state.conn = 'idle';
      refreshConnUI();
      toast('저장소 설정을 저장했습니다.', 'ok');
      connect(true);
    });
    on($('btnResetCfg'), 'click', function () {
      saveCfg({ owner: DEFAULT_CFG.owner, repo: DEFAULT_CFG.repo });
      $('cfgOwner').value = DEFAULT_CFG.owner;
      $('cfgRepo').value = DEFAULT_CFG.repo;
      state.conn = 'idle';
      refreshConnUI();
      toast('기본값으로 되돌렸습니다.', 'ok');
    });

    // 토큰 입력 후 Enter
    on($('tokenInput'), 'keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); $('btnSaveToken').click(); }
    });
  }

  function init() {
    loadStored();
    wire();
    updateCounter();
    renderFiles();
    refreshConnUI();
    var t = $('promptTitle');
    if (state.token) {
      connect(true);
    }
    if (t && !state.token) {
      // 토큰이 없으면 첫 화면에서 바로 설정으로 유도하지 않고 배너로만 알린다
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
