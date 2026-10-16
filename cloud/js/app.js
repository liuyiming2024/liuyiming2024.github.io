/* Cloud Drive · 主流程
 *
 * 一句话说明这个页面在干什么：
 *   文件在你这里加密，密文经过一个公开的暂存区，由 Actions 搬进私有存储库。
 *   页面不知道那个私有库叫什么，也没有权限去碰它。
 *
 * 页面上那枚 token 只需要能写这个公开仓库、能敲一下 Actions；
 * 真正能读写私有库的高权限令牌只存在于仓库的 Secrets 里，页面拿不到。
 */
(function () {
  const $ = (s) => document.querySelector(s);
  const state = { mode: null, token: '', pass: '', files: [] };

  /* ---------- 小工具 ---------- */
  function log(msg, kind) {
    const box = $('#log');
    const line = document.createElement('div');
    line.className = 'log-line' + (kind ? ' ' + kind : '');
    line.textContent = msg;
    box.appendChild(line);
    box.scrollTop = box.scrollHeight;
  }
  function fmt(n) {
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
    if (n < 1073741824) return (n / 1048576).toFixed(1) + ' MB';
    return (n / 1073741824).toFixed(2) + ' GB';
  }
  function randId() {
    const a = new Uint8Array(8);
    crypto.getRandomValues(a);
    return Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('');
  }
  function need(kind) {
    if (!state.token) { log('先填上访问令牌', 'err'); return false; }
    if (!state.pass && kind !== 'list') { log('先填入口令', 'err'); return false; }
    return true;
  }

  /* ---------- 启动 ---------- */
  function boot() {
    state.token = localStorage.getItem(window.CloudCfg.tokenKey) || '';
    $('#token').value = state.token;
    $('#saveToken').addEventListener('click', () => {
      window.CloudApi.setToken($('#token').value);
      state.token = window.CloudApi.token();
      log(state.token ? '令牌已存到本机浏览器' : '已清空本机令牌', 'ok');
    });

    $('#pick').addEventListener('change', () => renderPicked());
    $('#upload').addEventListener('click', doUpload);
    $('#refresh').addEventListener('click', loadList);
    $('#pass').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && state.mode === 'list') loadList();
    });
    log('页面就位。先填令牌和口令，令牌只存在你这台浏览器里。');
  }

  /* ---------- 上传 ---------- */
  function renderPicked() {
    const fs = Array.from($('#pick').files || []);
    $('#picked').innerHTML = fs.length
      ? fs.map((f) => '<span class="chip">' + esc(f.name) + ' · ' + fmt(f.size) + '</span>').join('')
      : '<span class="dim">还没选文件</span>';
  }
  function esc(s) {
    return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  async function doUpload() {
    if (!need()) return;
    const fs = Array.from($('#pick').files || []);
    if (!fs.length) { log('先选文件', 'err'); return; }
    $('#upload').disabled = true;

    for (const f of fs) {
      const id = randId();
      try {
        log('加密中：' + f.name);
        const sealed = await window.CloudCrypto.encryptBlob(f, state.pass);
        log('  密文 ' + fmt(sealed.size) + '（明文 ' + fmt(f.size) + '）');

        const job = randId();
        const b64 = await window.CloudApi.blobToB64(sealed, (done, total) => {
          if (done % (12 * 1024 * 1024) < 3 * 1024 * 1024 || done === total) {
            log('  编码 ' + Math.round((done / total) * 100) + '%');
          }
        });

        log('写入公开暂存区…');
        await window.CloudApi.write(
          window.CloudCfg.inbox + '/' + job + '.bin',
          b64,
          '暂存 ' + job
        );

        log('通知 Actions 搬运…');
        await window.CloudApi.dispatch('put', job, {
          id,
          meta: btoa(unescape(encodeURIComponent(JSON.stringify({
            name: await window.CloudCrypto.encryptText(f.name, state.pass),
            size: f.size
          }))))
        });

        log('等搬运回执…');
        const r = await window.CloudApi.waitJob(job, (waited) => {
          if (waited % 15000 < 3000) log('  已等 ' + Math.round(waited / 1000) + ' 秒');
        });
        log('已存入：' + f.name + '（' + r.store + ' 通道，密文 ' + fmt(r.cipher) + '）', 'ok');
      } catch (e) {
        log('失败：' + f.name + ' —— ' + e.message, 'err');
      }
    }

    $('#upload').disabled = false;
    $('#pick').value = '';
    renderPicked();
    loadList();
  }

  /* ---------- 列目录 ---------- */
  async function loadList() {
    if (!state.token) { log('先填令牌', 'err'); return; }
    $('#refresh').disabled = true;
    try {
      const job = randId();
      await window.CloudApi.dispatch('list', job);
      await window.CloudApi.waitJob(job);
      const raw = await window.CloudApi.readRaw('index.json');
      if (!raw) { state.files = []; renderList(); log('存储是空的'); return; }
      const idx = JSON.parse(new TextDecoder().decode(raw));
      state.files = idx.files || [];
      renderList();
      log('目录已刷新，共 ' + state.files.length + ' 个文件');
    } catch (e) {
      log('列目录失败：' + e.message, 'err');
    } finally {
      $('#refresh').disabled = false;
    }
  }

  function renderList() {
    const box = $('#list');
    if (!state.files.length) {
      box.innerHTML = '<div class="dim">还没有文件</div>';
      return;
    }
    box.innerHTML = state.files
      .map((f) => {
        let shown = '（口令不对或已损坏）';
        try {
          // 列目录时若口令已填就顺手解出文件名，没填就显示为密文条目
          shown = state.pass ? window.CloudCrypto.decryptText(f.name, state.pass) : '🔒 加密文件名';
        } catch (e) {}
        return (
          '<div class="row" data-id="' + f.id + '">' +
          '<span class="nm">' + esc(shown) + '</span>' +
          '<span class="sz">' + fmt(f.size || 0) + '</span>' +
          '<span class="at">' + (f.at || '').slice(0, 10) + '</span>' +
          '<button class="dl">下载</button>' +
          '<button class="rm">删除</button>' +
          '</div>'
        );
      })
      .join('');
    box.querySelectorAll('.dl').forEach((b) =>
      b.addEventListener('click', () => doDownload(b.closest('.row').dataset.id))
    );
    box.querySelectorAll('.rm').forEach((b) =>
      b.addEventListener('click', () => doRemove(b.closest('.row').dataset.id))
    );
  }

  /* ---------- 下载 ---------- */
  async function doDownload(id) {
    if (!need()) return;
    try {
      const job = randId();
      log('请 Actions 取文件…');
      await window.CloudApi.dispatch('get', job, { id });
      const r = await window.CloudApi.waitJob(job, null, 15 * 60 * 1000);

      let sealedBuf;
      if (r.channel === 'release') {
        log('大文件，走直链下载…');
        const resp = await fetch(r.url);
        if (!resp.ok) throw new Error('直链下载失败：HTTP ' + resp.status);
        sealedBuf = await resp.arrayBuffer();
      } else {
        const raw = await window.CloudApi.readRaw(r.path);
        if (!raw) throw new Error('暂存区里读不到回传文件');
        sealedBuf = raw;
      }

      log('解密中…');
      const plain = await window.CloudCrypto.decryptBuffer(sealedBuf, state.pass);

      let name = 'file-' + id;
      const rec = state.files.find((x) => x.id === id);
      if (rec) { try { name = window.CloudCrypto.decryptText(rec.name, state.pass); } catch (e) {} }

      const url = URL.createObjectURL(plain);
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30000);
      log('已下载：' + name + '（' + fmt(plain.size) + '）', 'ok');

      if (r.channel === 'git') {
        await window.CloudApi.remove(r.path, '清理下载暂存').catch(() => {});
      }
    } catch (e) {
      log('下载失败：' + e.message, 'err');
    }
  }

  /* ---------- 删除 ---------- */
  async function doRemove(id) {
    const rec = state.files.find((x) => x.id === id);
    let nm = id;
    if (rec && state.pass) { try { nm = window.CloudCrypto.decryptText(rec.name, state.pass); } catch (e) {} }
    if (!confirm('删除「' + nm + '」？删掉之后没有任何找回的办法。')) return;
    try {
      const job = randId();
      await window.CloudApi.dispatch('del', job, { id });
      await window.CloudApi.waitJob(job);
      log('已删除：' + nm, 'ok');
      loadList();
    } catch (e) {
      log('删除失败：' + e.message, 'err');
    }
  }

  document.addEventListener('DOMContentLoaded', () => {
    boot();
    $('#pass').addEventListener('input', () => {
      state.pass = $('#pass').value;
      if (state.mode === 'list') renderList();
    });
    state.mode = 'list';
  });
})();
