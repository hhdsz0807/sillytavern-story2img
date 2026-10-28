/* 正文配图 —— 正文 → 千问27B Q4 写分镜提示词 → Krea2 并发出图
 * 依赖本机 H3 工作台（默认 http://127.0.0.1:8899）：
 *   POST /v1/chat/completions   用你的 RunningHub key 调 Qwen27B
 *   POST /api/krea2/run         提交文生图
 *   GET  /api/krea2/history     查结果
 */
(function () {
  'use strict';

  const LS = 'h3s2i.settings.v1';
  const DEFA = { host: 'http://127.0.0.1:8899', key: '', count: 4, style: 'anime', aspect: '16:9 (Widescreen)', mp: 1.5, conc: 3 };
  let S = Object.assign({}, DEFA);
  try { S = Object.assign(S, JSON.parse(localStorage.getItem(LS) || '{}')); } catch (_) {}
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
  async function qwenPrompts(text, n) {
    if (!S.key) throw new Error('先填 RunningHub API Key');
    const sys = [
      '你是动画分镜师 + 出图提示词工程师。用户给你一段中文小说正文，你要把它拆成 ' + n + ' 张“故事插图”的英文出图提示词。',
      '规则：',
      '1) 每行一条提示词，纯文本，不要编号、不要解释、不要代码块。',
      '2) 画面必须有角色（这是故事插图，不是空场景），按正文时间顺序覆盖关键情节。',
      '3) 角色用固定写法：年龄 + 发型发色 + 瞳色 + 衣着（第一次出现时写全，之后保持一致）。',
      '4) 每条包含：谁在做什么（动作/表情） + 环境陈设 + 光线与时间 + 色调材质 + 镜头（wide shot / medium shot / close-up，35mm 之类）。',
      '5) 不要出现文字、字幕、水印、UI、对话框。',
      '6) 每条 50–80 个英文单词，信息密度高但不要堆砌形容词。',
    ].join('\n');
    const user = '画风要求：' + (STYLES[S.style] || STYLES.anime) + '\n张数：' + n + '\n\n正文：\n"""\n' + text + '\n"""';
    const r = await fetch(api('/v1/chat/completions'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + S.key },
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
    return lines.slice(0, n);
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
    const n = Math.max(1, Math.min(8, Number($('#h3s2i-count').value) || 4));
    status('run', '千问27B 正在写 ' + n + ' 条分镜提示词…（20–90 秒）');
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
          <label class="w">Key</label><input id="h3s2i-key" type="password" placeholder="RunningHub API Key（只存本机）">
        </div>
        <div class="row"><label>楼层</label><select id="h3s2i-floor"></select><button id="h3s2i-refl" title="刷新楼层">↻</button></div>
        <div class="row"><label>张数</label><input id="h3s2i-count" type="number" min="1" max="8" value="4">
          <label class="w">画风</label><select id="h3s2i-style">
            <option value="anime">动漫</option><option value="photo">写实摄影</option>
            <option value="film">电影感</option><option value="illust">插画</option>
          </select>
          <label class="w">画幅</label><select id="h3s2i-aspect">
            <option>16:9 (Widescreen)</option><option>1:1 (Square)</option><option>9:16 (Portrait Widescreen)</option>
          </select>
          <label class="w">并发</label><input id="h3s2i-conc" type="number" min="1" max="6" value="3">
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
    $('#h3s2i-count').value = S.count; $('#h3s2i-style').value = S.style;
    $('#h3s2i-aspect').value = S.aspect; $('#h3s2i-conc').value = S.conc;

    fab.onclick = openPanel;
    $('#h3s2i-x').onclick = () => (d.close ? d.close() : d.removeAttribute('open'));
    $('#h3s2i-host').onchange = (e) => { S.host = e.target.value.trim() || DEFA.host; saveS(); };
    $('#h3s2i-key').onchange = (e) => { S.key = e.target.value.trim(); saveS(); };
    $('#h3s2i-count').onchange = (e) => { S.count = Number(e.target.value) || 4; saveS(); };
    $('#h3s2i-style').onchange = (e) => { S.style = e.target.value; saveS(); };
    $('#h3s2i-aspect').onchange = (e) => { S.aspect = e.target.value; saveS(); };
    $('#h3s2i-conc').onchange = (e) => { S.conc = Number(e.target.value) || 3; saveS(); };
    $('#h3s2i-refl').onclick = fillFloors;
    $('#h3s2i-go').onclick = genPrompts;
    $('#h3s2i-imgs').onclick = genImages;
    $('#h3s2i-stop').onclick = () => { STOP = true; status('err', '已停止（已提交的仍会跑完）'); };
    $('#h3s2i-copy').onclick = copyPrompts;
    renderGrid();
  }

  function boot() {
    try { build(); console.log('[h3s2i] booted'); }
    catch (e) { console.error('[h3s2i] boot fail', e); }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => setTimeout(boot, 1200));
  else setTimeout(boot, 1200);
})();
