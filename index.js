/* 正文配图 —— 正文 → 千问27B Q4 写分镜提示词 → Krea2 并发出图
 * 依赖本机 H3 工作台（默认 http://127.0.0.1:8899）：
 *   POST /v1/chat/completions   用你的 RunningHub key 调 Qwen27B
 *   POST /api/krea2/run         提交文生图
 *   GET  /api/krea2/history     查结果
 */
(function () {
  'use strict';

  const LS = 'h3s2i.settings.v2';
  const LS_OLD = 'h3s2i.settings.v1';
  const DEFA = { host: 'http://127.0.0.1:8899', key: '', count: '', style: 'anime', aspect: '16:9 (Widescreen)', mp: 1.5, conc: 3 };
  let S = Object.assign({}, DEFA);
  try {
    // 老版本设置迁移：host/key/画风/画幅/并发继承，张数一律回到「自动」
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(LS) || 'null'); } catch (_) {}
    if (!saved) {
      try {
        const oldCfg = JSON.parse(localStorage.getItem(LS_OLD) || 'null');
        if (oldCfg) saved = { host: oldCfg.host, key: oldCfg.key, style: oldCfg.style, aspect: oldCfg.aspect, mp: oldCfg.mp, conc: oldCfg.conc, count: '' };
      } catch (_) {}
    }
    if (saved) S = Object.assign(S, saved);
  } catch (_) {}
  function saveS() { try { localStorage.setItem(LS, JSON.stringify(S)); } catch (_) {} }

  const STYLES = {
    anime: 'anime style, clean cel shading, soft lighting, detailed background',
    photo: 'photorealistic photograph, natural light, 35mm lens, real materials, fine detail',
    film: 'cinematic film still, anamorphic lens, moody lighting, shallow depth of field',
    illust: 'digital illustration, painterly, warm color grading, atmospheric light',
  };

  const $ = (sel) => document.querySelector(sel);
  const api = (p) => String(S.host || '').replace(/\/+$/, '') + p;
  const abs = (u) => (/^https?:/i.test(u) ? u : api(u));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  let JOBS = [];
  let STOP = false;

  /* ---------- 楼层正文 ---------- */
  function lastMesText() {
    const list = Array.from(document.querySelectorAll('#chat .mes .mes_text'));
    const el = list[list.length - 1];
    return el ? el.innerText || '' : '';
  }
  function stripJunk(s) {
    let t = String(s || '');
    t = t.replace(/<!--[\s\S]*?-->/g, '');
    t = t.replace(/<(logic_check|thinking|meow_FM|status|wlog|parallel_world|branches|UpdateVariable|htm1fenge|StatusPlaceHolderImpl|bbs_start|bbs_end)[^>]*>[\s\S]*?<\/\1>/gi, '');
    t = t.replace(/<[^>]+>/g, '');
    const cut = t.search(/Date\s*Summary|世界运行报告|玩家状态栏|变量更新|^\s*⊹/im);
    if (cut > t.length * 0.3) t = t.slice(0, cut);
    const paras = t.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
    const keep = paras.filter((p) => {
      const cjk = (p.match(/[\u4e00-\u9fa5]/g) || []).length;
      if (cjk >= 15) return true;
      if (cjk >= 6 && /[。！？…”」』】]/.test(p)) return true;
      return false;
    });
    return keep.join('\n\n').trim();
  }
  function storyText() {
    const sel = $('#h3s2i-floor');
    if (sel && sel.value) {
      const el = Array.from(document.querySelectorAll('#chat .mes')).find((m) => (m.getAttribute('mesid') || '') === sel.value);
      if (el) return stripJunk((el.querySelector('.mes_text') || el).innerText || '');
    }
    return stripJunk(lastMesText());
  }

  /* ---------- 千问写提示词 ---------- */
  /* 把要发给千问的东西组装好（「看发给千问的」也用它，保证所见即所发） */
  function buildPromptPack(text, n) {
    const head = n
      ? ('用户指定了 ' + n + ' 张，必须正好输出 ' + n + ' 行。')
      : '张数由你决定：按正文的场景/关键动作切分，判断需要几张图才能把这段故事讲清楚（1–8 张，宁可少而准，不要为了凑数拆碎剧情）。';
    const sys = [
      '你是动画分镜师 + 出图提示词工程师。用户给你一段中文小说正文，你要把它拆成若干「故事插图」的英文出图提示词。',
      head,
      '规则：',
      '1) 每行一条提示词，纯文本，不要编号、不要解释、不要代码块。',
      '2) 画面必须有角色（这是故事插图，不是空场景），按正文时间顺序覆盖关键情节。',
      '3) 角色写法固定：年龄 + 发型发色 + 瞳色 + 衣着（第一次写全，后面保持一致）。',
      '4) 每行必须同时包含这 6 样，缺一不可：',
      '   (a) 镜头：wide shot / medium shot / close-up / over-the-shoulder，加焦距（35mm / 50mm / 85mm）；',
      '   (b) 主体：谁、什么姿态、什么表情、手在做什么；',
      '   (c) 环境：3–6 个具体陈设（家具/道具/墙面/窗外），不要只写 room / scene；',
      '   (d) 光线：光源方向 + 时间（如 afternoon sunlight from the left window）；',
      '   (e) 色调与材质（如 warm beige, worn wood, dusty air）；',
      '   (f) 氛围一句话。',
      '5) 每行 60–90 个英文单词；宁可细节多，也不要写成一句概括。',
      '6) 不要出现文字、字幕、水印、UI、对话框。',
      '7) 参考样式（照这个密度写，不要照抄内容）：',
      '   "Medium shot, 35mm lens. A teenage boy with messy black hair and tired brown eyes sits up on a thin futon in a cramped six-tatami room, one hand rubbing his temple. Yellowed plaster ceiling, stacked cardboard boxes with faded supermarket logos, a cheap folding fan on the floor. Hard afternoon sunlight slices through plastic blinds from the left, striping the tatami in warm amber and deep shadow. Dusty air, worn fabric textures, muted beige and gray palette. Quiet, disoriented mood."',
    ].join('\n');
    const user = '画风要求：' + (STYLES[S.style] || STYLES.anime) + '\n张数：' + (n || '自动（你决定）') + '\n\n正文：\n"""\n' + text + '\n"""';
    return { sys, user };
  }

  async function qwenPrompts(text, n) {
    const key = await pickKey();   // 空串也行：服务端会用账号池
    const pack = buildPromptPack(text, n);
    const sys = pack.sys;
    const user = pack.user;
    const r = await fetch(api('/v1/chat/completions'), {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, key ? { Authorization: 'Bearer ' + key } : {}),
      body: JSON.stringify({ model: 'qwen27b-q4', stream: false, messages: [{ role: 'system', content: sys }, { role: 'user', content: user }] }),
    });
    const j = await r.json().catch(() => ({}));
    if (j.error) throw new Error(j.error.message || JSON.stringify(j.error));
    const out = j.choices && j.choices[0] && j.choices[0].message ? j.choices[0].message.content : '';
    if (!out) throw new Error('模型没返回内容');
    const lines = out.split('\n')
      .map((l) => l.trim().replace(/^[-*•\d.、)\s]+/, '').replace(/^["“]|["”]$/g, '').trim())
      .filter((l) => l.length > 20);
    if (!lines.length) throw new Error('模型没给出可用提示词');
    return lines.slice(0, n || 8);
  }

  /* ---------- Krea2 出图 ---------- */
  async function submitImg(name, prompt, tries) {
    try {
      const r = await fetch(api('/api/krea2/run?panel=krea2'), {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode: 't2i', name: name,
          prompt: prompt + ', ' + (STYLES[S.style] || STYLES.anime),
          aspect: S.aspect, mp: Number(S.mp) || 1.5,
        }),
      });
      const j = await r.json().catch(() => ({}));
      if (j.error) throw new Error(j.error);
      if (!j.taskId) throw new Error('提交没返回 taskId');
      return j.taskId;
    } catch (e) {
      const m = String(e.message || e);
      if (/并发|busy|已满|421|TASK_QUEUE|队列|超时|timeout|fetch/i.test(m) && (tries || 0) < 6) {
        await sleep(4000 + 2000 * (tries || 0));
        return submitImg(name, prompt, (tries || 0) + 1);
      }
      throw e;
    }
  }

  async function waitImg(taskId, maxMs) {
    const t0 = Date.now();
    while (Date.now() - t0 < (maxMs || 300000)) {
      await sleep(3000);
      const j = await (await fetch(api('/api/krea2/history'))).json().catch(() => ({}));
      const job = (j.jobs || []).find((x) => String(x.taskId) === String(taskId));
      if (!job) continue;
      if (job.state === 'done' && job.files && job.files.length) return job.files[job.files.length - 1];
      if (job.state === 'error') throw new Error(job.error || '出图失败');
    }
    throw new Error('出图超时');
  }

  /* ---------- UI ---------- */
  function status(kind, msg) {
    const el = $('#h3s2i-status');
    if (!el) return;
    el.className = 'h3s2i-status ' + (kind || '');
    el.textContent = msg || '';
  }

  function renderGrid() {
    const box = $('#h3s2i-grid');
    if (!box) return;
    if (!JOBS.length) { box.innerHTML = '<div class="hint">还没有图。点「① 生成提示词」再「② 出图」。</div>'; return; }
    box.innerHTML = JOBS.map((j) => {
      if (j.state === 'done') {
        const u = abs(j.file);
        return '<div class="cell"><img src="' + esc(u) + '" alt="">'
          + '<div class="cap">' + esc(j.name) + '<span class="ms">' + (j.secs ? j.secs + 's' : '') + '</span></div>'
          + '<a class="dl" href="' + esc(u) + '" target="_blank" rel="noopener" download>原图</a></div>';
      }
      const cls = j.state === 'error' ? 'bad' : 'run';
      return '<div class="cell ' + cls + '"><div class="ph">' + (j.state === 'error' ? '失败' : '生成中') + '</div>'
        + '<div class="cap">' + esc(j.name) + '</div></div>';
    }).join('');
  }

  function fillFloors() {
    const sel = $('#h3s2i-floor');
    if (!sel) return;
    const mes = Array.from(document.querySelectorAll('#chat .mes'));
    const prev = sel.value;
    sel.innerHTML = '<option value="">最新一条</option>' + mes.map((m) => {
      const id = m.getAttribute('mesid') || '';
      const t = ((m.querySelector('.mes_text') || m).innerText || '').replace(/\s+/g, ' ').slice(0, 26);
      return '<option value="' + esc(id) + '">#' + esc(id) + ' ' + esc(t) + '</option>';
    }).join('');
    if (prev) sel.value = prev;
  }

  async function genPrompts() {
    const text = storyText();
    if (!text) { status('err', '这条楼层没抽到正文'); return; }
    const rawCnt = $('#h3s2i-count').value;
    const n = rawCnt === '' ? 0 : Math.max(1, Math.min(8, Number(rawCnt) || 4));   // 0 = 让模型自己定
    status('run', n ? ('千问27B 正在写 ' + n + ' 条分镜提示词…（20–90 秒）') : '千问27B 正在判断要画几张并写分镜…（20–90 秒）');
    $('#h3s2i-go').disabled = true;
    try {
      const lines = await qwenPrompts(text, n);
      $('#h3s2i-prompts').value = lines.join('\n');
      status('ok', '拿到 ' + lines.length + ' 条提示词（可手改），再点「② 出图」');
    } catch (e) { status('err', '提示词失败：' + (e.message || e)); }
    finally { $('#h3s2i-go').disabled = false; }
  }

  function promptLines() {
    return ($('#h3s2i-prompts') ? $('#h3s2i-prompts').value : '').split('\n').map((l) => l.trim()).filter(Boolean);
  }

  async function genImages() {
    const lines = promptLines();
    if (!lines.length) { status('err', '先点「① 生成提示词」或自己写几行'); return; }
    const conc = Math.max(1, Math.min(6, Number($('#h3s2i-conc').value) || 3));
    STOP = false;
    JOBS = lines.map((p, i) => ({ name: 'S2I_' + String(i + 1).padStart(2, '0'), prompt: p, state: 'run', file: '', secs: 0 }));
    renderGrid();
    $('#h3s2i-imgs').disabled = true;
    let cur = 0, done = 0, ok = 0;
    const t0 = Date.now();
    async function worker() {
      while (!STOP) {
        const i = cur++;
        if (i >= JOBS.length) return;
        const j = JOBS[i];
        const ts = Date.now();
        status('run', '出图 ' + (done + ok >= 0 ? done + 1 : 1) + '/' + JOBS.length + ' · 并发 ' + conc);
        try {
          const id = await submitImg(j.name, j.prompt, 0);
          const f = await waitImg(id);
          j.state = 'done'; j.file = f; j.secs = Math.round((Date.now() - ts) / 1000); ok++;
        } catch (e) {
          j.state = 'error'; j.err = e.message || String(e);
        }
        done++;
        renderGrid();
        status(done === JOBS.length ? 'ok' : 'run',
          '进度 ' + done + '/' + JOBS.length + '（成功 ' + ok + '）· 已用 ' + Math.round((Date.now() - t0) / 1000) + 's');
      }
    }
    const ws = [];
    for (let k = 0; k < conc; k++) ws.push(worker());
    await Promise.all(ws);
    $('#h3s2i-imgs').disabled = false;
    status(ok ? 'ok' : 'err', '完成：' + ok + '/' + JOBS.length + ' 张 · ' + Math.round((Date.now() - t0) / 1000) + ' 秒');
  }

  function copyPrompts() {
    const t = promptLines().join('\n');
    if (!t) { status('err', '没有提示词'); return; }
    (navigator.clipboard ? navigator.clipboard.writeText(t) : Promise.reject()).then(
      () => status('ok', '已复制 ' + promptLines().length + ' 条'),
      () => status('err', '复制失败'));
  }

  async function pickKey() {
    if (S.key) return S.key;
    const sel = $('#h3s2i-acc');
    const nick = sel ? sel.value : '';
    if (!nick) return '';
    try {
      const r = await fetch(api('/api/accounts/export'));
      const j = await r.json();
      const hit = (j.accounts || []).find((a) => String(a.nick || '') === nick);
      return hit ? String(hit.apiKey || '') : '';
    } catch (_) { return ''; }
  }

  /* ---------- 账号：列表 / 导入 / 选择 ---------- */
  async function loadAccList() {
    const sel = $('#h3s2i-acc');
    if (!sel) return;
    const keep = sel.value;
    try {
      const j = await (await fetch(api('/api/accounts'))).json();
      const list = j.accounts || [];
      sel.innerHTML = '<option value="">（用上面的 Key / 服务端账号池）</option>' + list.map((a, i) =>
        '<option value="' + esc(a.nick || ('账号' + (i + 1))) + '">' + esc((a.nick || '账号' + (i + 1)) + ' · …' + (a.keyTail || '') + ' · 并发' + (a.maxConc || 1)) + '</option>'
      ).join('');
      if (keep) sel.value = keep;
      const hint = $('#h3s2i-accHint');
      if (hint) hint.textContent = list.length ? ('服务端已有 ' + list.length + ' 个账号') : '服务端还没有账号，先导入';
    } catch (e) {
      const hint = $('#h3s2i-accHint');
      if (hint) hint.textContent = '读账号失败：' + (e.message || e);
    }
  }

  function toggleAccBox() {
    const box = $('#h3s2i-accBox');
    if (!box) return;
    box.style.display = box.style.display === 'none' ? 'block' : 'none';
  }

  async function importAcc() {
    const ta = $('#h3s2i-accJson');
    const raw = (ta && ta.value || '').trim();
    if (!raw) { status('err', '先把导出的账号 JSON 粘进去'); return; }
    let j = null;
    try { j = JSON.parse(raw); } catch (_) { status('err', 'JSON 格式不对'); return; }
    if (!j.accounts && Array.isArray(j)) j = { accounts: j };
    if (!j.accounts || !j.accounts.length) { status('err', '里面没有 accounts 数组'); return; }
    status('run', '导入 ' + j.accounts.length + ' 个账号…');
    try {
      const r = await fetch(api('/api/accounts/import'), {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(j),
      });
      const res = await r.json();
      if (!res.ok) throw new Error(res.error || '导入失败');
      status('ok', '导入完成：新增 ' + (res.added || 0) + '，更新 ' + (res.updated || 0) + '，共 ' + (res.total || 0));
      if (ta) ta.value = '';
      await loadAccList();
    } catch (e) { status('err', '导入失败：' + (e.message || e)); }
  }

  /* ---------- 预览：正文 / 发给千问的全文 ---------- */
  function showPeek(title, body) {
    let d = document.getElementById('h3s2i-peekdlg');
    if (!d) {
      d = document.createElement('dialog');
      d.id = 'h3s2i-peekdlg';
      d.style.cssText = 'position:fixed;inset:0;margin:auto;width:min(900px,95vw);max-height:86vh;border:1px solid #2b3646;border-radius:12px;background:#0f141b;color:#d7dee9;padding:0;overflow:hidden;z-index:10001';
      d.innerHTML = '<div style="display:flex;align-items:center;gap:10px;padding:10px 14px;background:#141b24;border-bottom:1px solid #232d3b">'
        + '<b id="h3s2i-peekTitle" style="font-size:14px"></b>'
        + '<span id="h3s2i-peekMeta" style="color:#7f8ea3;font-size:12px"></span>'
        + '<button id="h3s2i-peekX" style="margin-left:auto;background:none;border:0;color:#9aa8ba;font-size:16px;cursor:pointer">✕</button></div>'
        + '<textarea id="h3s2i-peekBody" readonly style="width:100%;height:calc(86vh - 92px);background:#0b1017;color:#d7dee9;border:0;padding:12px;font:12px/1.6 ui-monospace,Consolas,monospace;resize:none"></textarea>';
      document.body.appendChild(d);
      d.querySelector('#h3s2i-peekX').onclick = () => d.close();
    }
    d.querySelector('#h3s2i-peekTitle').textContent = title;
    d.querySelector('#h3s2i-peekBody').value = body;
    try { if (!d.open) d.showModal(); } catch (_) { d.setAttribute('open', ''); }
    return d.querySelector('#h3s2i-peekMeta');
  }

  function peekStory() {
    const text = storyText();
    const sel = $('#h3s2i-floor');
    const id = sel && sel.value ? ('#' + sel.value) : '最新一条';
    const meta = showPeek('发给千问的正文', text || '（没抽到正文）');
    meta.textContent = id + ' · ' + text.length + ' 字';
  }

  function peekQwen() {
    const text = storyText();
    if (!text) { status('err', '没抽到正文'); return; }
    const raw = $('#h3s2i-count').value;
    const n = raw === '' ? 0 : Math.max(1, Math.min(8, Number(raw) || 4));
    const pack = buildPromptPack(text, n);
    const meta = showPeek('真正发给千问的请求（system + user）',
      '===== system =====\n' + pack.sys + '\n\n===== user =====\n' + pack.user);
    meta.textContent = '正文 ' + text.length + ' 字 · system ' + pack.sys.length + ' 字 · user ' + pack.user.length + ' 字';
  }

  function openPanel() {
    const d = $('#h3s2i-dlg');
    if (!d) return;
    fillFloors();
    if (typeof d.showModal === 'function') { try { if (!d.open) d.showModal(); } catch (_) { d.setAttribute('open', ''); } }
    else d.setAttribute('open', '');
  }

  function build() {
    if ($('#h3s2i-dlg')) return;
    const fab = document.createElement('div');
    fab.id = 'h3s2i-fab';
    fab.textContent = '🖼';
    fab.title = '正文配图（千问27B 写分镜 → Krea2 出图）';
    document.body.appendChild(fab);

    const d = document.createElement('dialog');
    d.id = 'h3s2i-dlg';
    d.innerHTML = `
      <header><b>正文配图</b><span class="sub">正文 → 千问27B Q4 写分镜 → Krea2 并发出图</span><button id="h3s2i-x" title="关闭">✕</button></header>
      <div class="body">
        <div class="row"><label>H3 地址</label><input id="h3s2i-host" placeholder="http://127.0.0.1:8899">
          <label class="w">Key</label><input id="h3s2i-key" type="password" placeholder="留空 = 用服务端账号池">
        </div>
        <div class="row"><label>账号</label>
          <select id="h3s2i-acc" class="grow"><option value="">（用上面的 Key / 服务端账号池）</option></select>
          <button id="h3s2i-accReload" title="刷新账号列表">↻</button>
          <button id="h3s2i-accOpen">导入账号</button>
        </div>
        <div id="h3s2i-accBox" style="display:none;margin:0 0 9px">
          <textarea id="h3s2i-accJson" placeholder='把 H3工作台「导出账号」得到的 JSON 粘这里，例如：
{"ok":true,"version":1,"accounts":[{"nick":"账号1","apiKey":"...","comfyAuth":"...","accessToken":"...","maxConc":1,"prio":0}]}' style="min-height:96px"></textarea>
          <div class="row" style="margin-top:6px">
            <button id="h3s2i-accImport" class="primary">导入到服务端</button>
            <span class="hint" id="h3s2i-accHint" style="margin:0">导入后账号会存进 8899 的 accounts.json，出图/千问都能直接用</span>
          </div>
        </div>
        <div class="row"><label>楼层</label><select id="h3s2i-floor"></select><button id="h3s2i-refl" title="刷新楼层">↻</button></div>
        <div class="row"><label>张数</label><select id="h3s2i-count" title="自动 = 由模型按正文决定画几张"><option value="">自动（模型判断）</option><option value="1">1 张</option><option value="2">2 张</option><option value="3">3 张</option><option value="4">4 张</option><option value="5">5 张</option><option value="6">6 张</option><option value="7">7 张</option><option value="8">8 张</option></select>
          <label class="w">画风</label><select id="h3s2i-style">
            <option value="anime">动漫</option><option value="photo">写实摄影</option>
            <option value="film">电影感</option><option value="illust">插画</option>
          </select>
          <label class="w">画幅</label><select id="h3s2i-aspect">
            <option>16:9 (Widescreen)</option><option>1:1 (Square)</option><option>9:16 (Portrait Widescreen)</option>
          </select>
          <label class="w">并发</label><input id="h3s2i-conc" type="number" min="1" max="6" value="3">
        </div>
        <div class="row"><button id="h3s2i-peek" title="查看本楼会被当成正文发送的内容">看正文</button>
          <button id="h3s2i-peekq" title="查看真正发给千问的 system + user 全文">看发给千问的</button>
        </div>
        <div class="row"><button id="h3s2i-go" class="primary">① 生成提示词</button>
          <button id="h3s2i-imgs">② 出图</button>
          <button id="h3s2i-stop">停止</button>
          <button id="h3s2i-copy">复制提示词</button></div>
        <textarea id="h3s2i-prompts" placeholder="每行一条英文提示词（可手改）"></textarea>
        <div id="h3s2i-grid"></div>
        <div id="h3s2i-status" class="h3s2i-status"></div>
      </div>`;
    document.body.appendChild(d);

    $('#h3s2i-host').value = S.host; $('#h3s2i-key').value = S.key;
    document.querySelector('#h3s2i-count').value = (S.count === '' || S.count == null) ? '' : String(S.count); document.querySelector('#h3s2i-style').value = S.style;
    $('#h3s2i-aspect').value = S.aspect; $('#h3s2i-conc').value = S.conc;

    fab.onclick = openPanel;
    // 手机：贴右下角，避免被输入栏挡住
    try {
      if (window.innerWidth < 700) {
        fab.style.bottom = '104px';
        fab.style.right = '12px';
        fab.style.width = '42px';
        fab.style.height = '42px';
      }
    } catch (_) {}

    // 顶栏图标入口（最可靠：酒馆顶部图标条里加一个，不受 fixed 定位影响）
    try {
      const bar = document.querySelector('#top-settings-holder');
      if (bar && !document.querySelector('#h3s2i-topbtn')) {
        const tb = document.createElement('div');
        tb.id = 'h3s2i-topbtn';
        tb.className = 'drawer-icon fa-solid fa-image interactable';
        tb.title = '正文配图（正文 → 千问27B → Krea2）';
        tb.tabIndex = 0;
        tb.style.cssText = 'cursor:pointer';
        tb.onclick = openPanel;
        bar.appendChild(tb);
      }
    } catch (e) { console.warn('[h3s2i] top btn fail', e); }

    // 悬浮球如果被页面布局挤到屏幕外，就藏起来，用顶栏图标开
    try {
      const r0 = fab.getBoundingClientRect();
      if (r0.top < 0 || r0.left < 0 || r0.top > window.innerHeight) fab.style.display = 'none';
    } catch (_) {}

    // 同时在「扩展设置」里挂一个抽屉入口（悬浮球被挡时也能开）
    try {
      const host = document.querySelector('#extensions_settings') || document.querySelector('#extensions_settings2');
      if (host && !document.querySelector('#h3s2i-drawer')) {
        const wrap = document.createElement('div');
        wrap.id = 'h3s2i-drawer';
        wrap.innerHTML = '<div class="inline-drawer" style="margin-bottom:6px">'
          + '<div class="inline-drawer-toggle inline-drawer-header" style="cursor:pointer"><b>正文配图</b>'
          + '<span class="hint" style="margin-left:8px;color:#8b98ab;font-size:12px">千问27B 写分镜 → Krea2 出图</span>'
          + '<div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div></div>'
          + '<div class="inline-drawer-content" style="display:none">'
          + '<button id="h3s2i-open" class="menu_button" style="margin:6px 0">打开正文配图</button>'
          + '<div class="hint" style="font-size:12px;color:#8b98ab">H3 地址默认 http://127.0.0.1:8899；Key 填 RunningHub 的</div>'
          + '</div></div>';
        host.appendChild(wrap);
        const head = wrap.querySelector('.inline-drawer-header');
        const content = wrap.querySelector('.inline-drawer-content');
        head.onclick = () => { content.style.display = content.style.display === 'none' ? 'block' : 'none'; };
        wrap.querySelector('#h3s2i-open').onclick = openPanel;
      }
    } catch (e) { console.warn('[h3s2i] settings entry fail', e); }
    $('#h3s2i-x').onclick = () => (d.close ? d.close() : d.removeAttribute('open'));
    $('#h3s2i-host').onchange = (e) => { S.host = e.target.value.trim() || DEFA.host; saveS(); };
    $('#h3s2i-key').onchange = (e) => { S.key = e.target.value.trim(); saveS(); };
    document.querySelector('#h3s2i-count').onchange = (e) => { S.count = e.target.value === '' ? '' : Number(e.target.value); saveS(); };
    $('#h3s2i-style').onchange = (e) => { S.style = e.target.value; saveS(); };
    $('#h3s2i-aspect').onchange = (e) => { S.aspect = e.target.value; saveS(); };
    $('#h3s2i-conc').onchange = (e) => { S.conc = Number(e.target.value) || 3; saveS(); };
    $('#h3s2i-refl').onclick = fillFloors;
    $('#h3s2i-accReload').onclick = loadAccList;
    $('#h3s2i-accOpen').onclick = toggleAccBox;
    $('#h3s2i-accImport').onclick = importAcc;
    try { loadAccList(); } catch (_) {}
    $('#h3s2i-go').onclick = genPrompts;
    $('#h3s2i-peek').onclick = peekStory;
    $('#h3s2i-peekq').onclick = peekQwen;
    $('#h3s2i-imgs').onclick = genImages;
    $('#h3s2i-stop').onclick = () => { STOP = true; status('err', '已停止（已提交的仍会跑完）'); };
    $('#h3s2i-copy').onclick = copyPrompts;
    renderGrid();
  }

  function boot() {
    try { build(); window.__h3s2i = true; console.log('[h3s2i] booted v' + '1.2.0'); }
    catch (e) {
      console.error('[h3s2i] boot fail', e);
      try {
        const d = document.createElement('div');
        d.style.cssText = 'position:fixed;left:8px;right:8px;bottom:8px;z-index:10000;background:#7f1d1d;color:#fff;padding:8px 10px;border-radius:8px;font-size:12px';
        d.textContent = '[正文配图] 加载失败：' + (e && e.message ? e.message : e);
        document.body.appendChild(d);
        setTimeout(() => d.remove(), 15000);
      } catch (_) {}
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => setTimeout(boot, 1200));
  else setTimeout(boot, 1200);
})();