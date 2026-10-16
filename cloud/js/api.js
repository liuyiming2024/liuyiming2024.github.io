/* Cloud Drive · 传输层
 *
 * 页面只认识一个仓库：自己所在的这个公开仓库。
 * 上传 = 把密文写进 inbox，再敲一下 Actions 让它搬走；
 * 下载 = 敲一下 Actions 让它搬来，再从 outbox 读密文。
 * 页面从头到尾不知道文件最终落在哪，也没有权限去碰那个地方。
 */
(function () {
  const API = 'https://api.github.com';

  function token() {
    return localStorage.getItem(window.CloudCfg.tokenKey) || '';
  }
  function setToken(t) {
    localStorage.setItem(window.CloudCfg.tokenKey, (t || '').trim());
  }

  function req(path, opts) {
    const headers = Object.assign(
      {
        Authorization: 'token ' + token(),
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28'
      },
      (opts && opts.headers) || {}
    );
    return fetch(API + path, Object.assign({}, opts, { headers })).then(async (r) => {
      const text = await r.text();
      let data;
      try { data = text ? JSON.parse(text) : {}; } catch (e) { data = { raw: text }; }
      if (!r.ok) {
        const msg = data.message || r.statusText;
        const err = new Error(msg);
        err.status = r.status;
        err.body = data;
        throw err;
      }
      return data;
    });
  }

  const repo = () => '/repos/' + window.CloudCfg.owner + '/' + window.CloudCfg.repo;

  /* 读文件原文（走 raw，不读 base64） */
  async function readRaw(path) {
    const r = await fetch(API + repo() + '/contents/' + encodeURI(path) + '?ref=main', {
      headers: { Authorization: 'token ' + token(), Accept: 'application/vnd.github.raw' }
    });
    if (r.status === 404) return null;
    if (!r.ok) throw new Error((await r.json()).message || r.statusText);
    return r.arrayBuffer();
  }

  /* 读文件元信息（拿 sha，删文件要用） */
  function stat(path) {
    return req(repo() + '/contents/' + encodeURI(path) + '?ref=main').catch((e) =>
      e.status === 404 ? null : Promise.reject(e)
    );
  }

  /* 写文件。content 已是 base64（不带换行） */
  function write(path, b64, message, sha) {
    const body = { message, content: b64 };
    if (sha) body.sha = sha;
    return req(repo() + '/contents/' + encodeURI(path), {
      method: 'PUT',
      body: JSON.stringify(body)
    });
  }

  async function remove(path, message) {
    const s = await stat(path);
    if (!s) return null;
    return req(repo() + '/contents/' + encodeURI(path), {
      method: 'DELETE',
      body: JSON.stringify({ message, sha: s.sha })
    });
  }

  /* 触发搬运工作流。只传很小的指令，文件内容不经过这里 */
  function dispatch(op, jobId, extra) {
    return req(repo() + '/actions/workflows/' + window.CloudCfg.workflow + '/dispatches', {
      method: 'POST',
      body: JSON.stringify({
        ref: 'main',
        inputs: Object.assign({ op, job_id: jobId }, extra || {})
      })
    });
  }

  /* 等回执。Actions 干完会把 status/<jobId>.json 写进公开仓库 */
  async function waitJob(jobId, onTick, timeoutMs) {
    const path = window.CloudCfg.status + '/' + jobId + '.json';
    const deadline = Date.now() + (timeoutMs || 10 * 60 * 1000);
    let waited = 0;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 3000));
      waited += 3000;
      let raw;
      try {
        raw = await readRaw(path);
      } catch (e) {
        continue; // 瞬时 403：放慢重试，别判成失败
      }
      if (raw) {
        let j;
        try {
          j = JSON.parse(new TextDecoder().decode(raw));
        } catch (e) {
          throw new Error('回执文件解析失败，原始内容：' + new TextDecoder().decode(raw).slice(0, 200));
        }
        await remove(path, '清理回执 ' + jobId).catch(() => {});
        if (j.ok === false) throw new Error(j.error || '搬运失败，未给出原因');
        return j;
      }
      if (onTick) onTick(waited);
    }
    throw new Error('等回执超时：Actions 可能没跑起来，或没权限触发工作流');
  }

  /* 大文件转 base64：分块，避免一次构造超大字符串爆栈 */
  function blobToB64(blob, onProgress) {
    return new Promise((resolve, reject) => {
      const CH = 3 * 1024 * 1024; // 3MB 的倍数，保证 base64 无填充错位
      const parts = [];
      let off = 0;
      const reader = new FileReader();
      reader.onerror = () => reject(reader.error);
      reader.onload = () => {
        const u8 = new Uint8Array(reader.result);
        let s = '';
        for (let i = 0; i < u8.length; i += 8192) {
          s += String.fromCharCode.apply(null, u8.subarray(i, i + 8192));
        }
        parts.push(btoa(s));
        off += CH;
        if (onProgress) onProgress(Math.min(off, blob.size), blob.size);
        if (off < blob.size) next();
        else resolve(parts.join(''));
      };
      function next() {
        reader.readAsArrayBuffer(blob.slice(off, Math.min(off + CH, blob.size)));
      }
      next();
    });
  }

  function b64ToBlob(b64, type) {
    const bin = atob(b64);
    const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    return new Blob([u8], { type: type || 'application/octet-stream' });
  }

  window.CloudApi = {
    token, setToken, readRaw, stat, write, remove,
    dispatch, waitJob, blobToB64, b64ToBlob, req, repo
  };
})();
