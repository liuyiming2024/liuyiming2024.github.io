/*!
 * ==================================================================
 * identity.js —— 全站统一身份服务（Q-Site-S-121）
 * ==================================================================
 *
 * 位置：https://liuyiming2024.github.io/assets/identity.js
 * 所有项目（Chat / Archive / Code / 主页）都引用**这同一份**。
 *
 * ── 为什么它是"服务"而不是"一个页面上的脚本" ──────────────────
 * 之前每个项目各自实现登录，问题不是重复劳动，而是**必然漂移**：
 *   · 失败冻结（15 分钟 8 次）
 *   · 全局爆破闸门
 *   · "记住账号 30 天" 与 "保护密码不记" 两套凭据的区别
 *   · 桌面版桥接票据自动登录
 * 这四条在 A 项目改了，B 项目不会跟着改。于是同一个账号
 * "在聊天室里会被冻结，在主页里不会" —— 安全边界取决于用户从哪进。
 *
 * 现在只有一份实现，登录界面也只有一份（login.html）。
 * 各项目不实现登录，只**调用**它。
 *
 * ── 同源是前提 ──────────────────────────────────────────────────
 * 主页与各项目（/Chat/、/Archive/）同属 liuyiming2024.github.io，
 * localStorage 按 origin 共享，所以令牌一处写入、处处可读。
 * 不需要 iframe、不需要 postMessage、不需要跨域桥接。
 *
 * ── 离线 ────────────────────────────────────────────────────────
 * 本服务**必须联网**（它要访问服务端的 whoami/user_login/logout）。
 * 离线时 whoami 失败，状态显示为"离线"而不是"未登录" ——
 * 这两件事对用户完全不同：
 *   "未登录" → 我知道我没登录
 *   "离线"   → 我登录了，但现在连不上，别让我以为账号出问题了
 * 不区分的话，用户在地铁里打开会以为自己被登出了，于是重新登录、
 * 改密码，制造出一堆本来不存在的问题。
 *
 * ── 用法 ────────────────────────────────────────────────────────
 *   SiteIdentity.whoami()               → Promise<{ok,nick,role,...} | {ok:false,offline}>
 *   SiteIdentity.login(nick, pwd)       → Promise
 *   SiteIdentity.logout()               → Promise
 *   SiteIdentity.goLogin(next)          → 跳到统一登录页
 *   SiteIdentity.mount(hostEl, opts)    → 在页面里渲染账号区
 *   SiteIdentity.onChange(fn)           → 状态变化时回调（含跨标签）
 *   SiteIdentity.ready                  → Promise，首次探测完成
 * ==================================================================
 */
(function (g) {
  'use strict';

  /* 与 Chat 的 sb.js 一致的键名 —— 它们必须共用同一份令牌。 */
  var CFG_KEY = 'wxlg_sb_cfg';
  var TOK_KEY = 'wxlg_sb_token';
  var UID_KEY = 'wxlg_sb_uid';
  var DEF_URL = 'https://pimryrsxkwyafmponegp.supabase.co';
  var DEF_KEY = 'sb_publishable_jPrK6j5l9NGbnLKcytTegg_di1njO8t';

  /* ⚠ 登录页与后端地址都写死在这里，但**回跳地址绝不来自 URL 参数** ——
     见 goLogin() 里的白名单说明。 */
  var LOGIN_PAGE = 'https://liuyiming2024.github.io/login.html';

  var ROLE = { owner: '站长', admin: '管理员', member: '成员' };

  var state = { ok: false, offline: false, nick: null, role: null, status: null, id: null, site: null };
  var subs = [];
  var inflight = null;

  /* ---------------- 存储 ---------------- */

  function ls(k, v) {
    try {
      if (v === undefined) return localStorage.getItem(k);
      if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v);
    } catch (e) { }
    return null;
  }
  function ss(k, v) {
    try {
      if (v === undefined) return sessionStorage.getItem(k);
      if (v === null) sessionStorage.removeItem(k); else sessionStorage.setItem(k, v);
    } catch (e) { }
    return null;
  }

  function cfg() {
    var url = DEF_URL, key = DEF_KEY;
    var raw = ls(CFG_KEY);
    if (raw) {
      try {
        var o = JSON.parse(raw);
        if (o && o.url) url = o.url;
        if (o && o.key) key = o.key;
      } catch (e) { /* 配置坏了就用内置的 */ }
    }
    return { url: url, key: key };
  }

  function token() { return ss(TOK_KEY) || ls(TOK_KEY) || null; }

  /* ---------------- 网络 ---------------- */

  function rpc(name, body) {
    var c = cfg();
    var t = token();
    var h = {
      'apikey': c.key,
      'Authorization': 'Bearer ' + c.key,
      'Content-Type': 'application/json'
    };
    /* ⚠ 会话走 x-session 头，不是 Authorization。
       放进 Bearer 会被网关当成 JWT 去解析，报 Invalid JWT。 */
    if (t) h['x-session'] = t;

    return fetch(c.url + '/rest/v1/rpc/' + name, {
      method: 'POST', headers: h, body: JSON.stringify(body || {})
    }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    });
  }

  /* ---------------- 状态 ---------------- */

  function emit() { subs.forEach(function (f) { try { f(state); } catch (e) { } }); }

  function set(next) {
    state = next;
    emit();
  }

  /**
   * 向服务端问"我是谁"。
   * 幂等：并发调用共享同一个 Promise，避免打开页面时连发好几次。
   */
  function whoami(force) {
    if (!force && inflight) return inflight;
    if (!token()) {
      inflight = Promise.resolve(set({ ok: false, offline: false, nick: null, role: null, status: null, id: null, site: null }) || state);
      return inflight;
    }
    state.offline = false;
    inflight = rpc('whoami', {}).then(function (r) {
      if (r && r.ok) {
        set({ ok: true, offline: false, id: r.id, nick: r.nick, role: r.role, status: r.status, site: r.site || null });
      } else {
        /* user gone：会话还在但用户没了（被物理删除）。
           ⚠ 必须清掉本地令牌 —— 否则界面一直显示"已登录"
           而什么都做不了，用户只会以为站点坏了。 */
        if (r && r.err === 'user gone') { dropSession(); }
        set({ ok: false, offline: false, nick: null, role: null, status: null, id: null, site: null });
      }
      return state;
    }).catch(function () {
      /* 网络失败 ≠ 未登录。见文件头"离线"一节。 */
      set({ ok: false, offline: true, nick: null, role: null, status: null, id: null, site: null });
      return state;
    }).then(function (s) { inflight = null; return s; });
    return inflight;
  }

  /* ---------------- 动作 ---------------- */

  function setSession(tok, uid) {
    ss(TOK_KEY, tok || null); ss(UID_KEY, uid || null);
    ls(TOK_KEY, tok || null); ls(UID_KEY, uid || null);
  }
  function dropSession() {
    ss(TOK_KEY, null); ss(UID_KEY, null);
    ls(TOK_KEY, null); ls(UID_KEY, null);
  }

  function login(nick, pwd) {
    return rpc('user_login', { p_nick: nick, p_pwd: pwd }).then(function (r) {
      if (!r || !r.ok) throw new Error((r && r.err) || '昵称或密码错误');
      setSession(r.token, r.uid);
      return whoami(true);
    });
  }

  function register(nick, real, pwd) {
    return rpc('user_register', { p_nick: nick, p_real: real, p_pwd: pwd });
  }

  /* ---------------- 账号设置（Q-Chat-S-123） ----------------
     这些原本是聊天室内部的页面，现在提到集群层：
     账号不归任何单个项目，所以设置页也不该长在项目里 ——
     否则在主页改了昵称，聊天室那边要等下次同步才看得到，
     用户会以为"改了没生效"。 */

  /**
   * 改资料。传 null = 不改；p_avatar 传 '' = 明确清空头像。
   * ⚠ 这个区分是服务端定的（profile_update 的 case when），
   *   前端必须照做，否则头像永远删不掉。
   */
  function profileUpdate(patch) {
    var b = {};
    if (patch.nick != null) b.p_nick = patch.nick;
    if (patch.real != null) b.p_real = patch.real;
    if (patch.bio != null) b.p_bio = patch.bio;
    if (patch.avatar != null) b.p_avatar = patch.avatar;
    return rpc('profile_update', b).then(function () { return whoami(true); });
  }

  function changePassword(oldPwd, newPwd) {
    return rpc('user_password', { p_old: oldPwd, p_new: newPwd });
  }

  /** 用户列表。成员只能拿到自己；管理员拿全部。 */
  function listUsers(status) {
    return rpc('user_list', status ? { p_status: status } : {});
  }

  /** 审核：p_status ∈ active / pending / banned */
  function review(userId, status) {
    return rpc('user_review', { p_user: userId, p_status: status });
  }

  /* ---------------- 跨项目权限（Q-Chat-S-124） ----------------
     权限升到集群层：能不能用某个项目，不该取决于你在哪个项目里问。
     对外就是这一个函数，两个参数，返回状态值。 */

  /**
   * 判定某个用户有没有某项跨项目权限。
   *
   * @param perm  权限条目，如 'drive.use'、'archive.read'、'code.run'
   * @param user  用户 id（uuid）。不传=判定自己
   * @returns Promise<'ok'|'denied'|'banned'|'unknown'|'no_user'>
   *
   * ⚠ 返回值是**状态**不是布尔：
   *   ok      有
   *   denied  被单独禁止（找站长）
   *   banned  被封禁
   *   unknown 权限点没注册 —— 多半是调用方把名字拼错了
   *   no_user 用户不存在
   * 若服务端只回 true/false，这三种"不能"在界面上长得一样，
   * 用户只会以为功能坏了。这里保留区分。
   *
   * ⚠ 但**安全判定必须以服务端的返回为准**：
   *   本函数是"要不要显示这个按钮"的参考，不是闸门。
   *   真正的闸门在各项目自己服务端的 if 判断里。
   */
  function can(perm, user) {
    return rpc('site_can', { p_perm: perm, p_user: user || state.id })
      .then(function (r) { return r; });
  }

  /** 手上只有昵称时用这个 */
  function canNick(perm, nick) {
    return rpc('site_can_nick', { p_perm: perm, p_nick: nick });
  }

  /** 按名字取判定函数，读起来更顺：SI.perm('drive.use') */
  function perm(permName, user) { return can(permName, user); }

  /** 权限点清单（按项目分组）。仅管理员/站长可用。 */
  function listPerms() { return rpc('site_perms_list', {}); }

  /**
   * 上传头像到公共 storage。
   * ⚠ 走 media bucket，和聊天室共用 —— 不另开一个，
   *   否则头像和消息图片两套配额、两套清理规则。
   * @returns Promise<头像 URL>
   */
  function uploadAvatar(blob, mime) {
    var c = cfg();
    var t = token();
    if (!t) return Promise.reject(new Error('请先登录'));
    var ext = (mime || 'image/png').split('/')[1] || 'png';
    var path = 'avatar_' + (state.id || 'x') + '_' + Date.now() + '.' + (ext === 'jpeg' ? 'jpg' : ext);
    var h = { 'apikey': c.key, 'Content-Type': mime || 'image/png', 'x-upsert': 'true' };
    h['x-session'] = t;
    return fetch(c.url + '/storage/v1/object/media/' + path, {
      method: 'POST', headers: h, body: blob
    }).then(function (r) {
      if (!r.ok) throw new Error('上传失败 ' + r.status);
      return c.url + '/storage/v1/object/public/media/' + path;
    });
  }

  function logout() {
    var t = token();
    dropSession();
    if (!t) return Promise.resolve(set({
      ok: false, offline: false, nick: null, role: null, status: null, id: null, site: null
    }) || true);
    /* ⚠ 必须通知服务端（E-079 的教训）：只清本地的话那条令牌
       在服务端还有效 14 天，公用电脑上点了"退出"仍能被继续使用。 */
    return rpc('logout', {}).catch(function () { }).then(function () {
      set({ ok: false, offline: false, nick: null, role: null, status: null, id: null, site: null });
      return true;
    });
  }

  /**
   * 去统一登录页。
   * @param next 登录成功后要回哪（必须是同源相对路径或本站绝对地址）
   */
  function goLogin(next) {
    var u = LOGIN_PAGE;
    var n = safeNext(next);
    if (n) u += '?next=' + encodeURIComponent(n);
    location.href = u;
  }

  /**
   * ⚠⚠ 回跳白名单 —— 这是本文件最要紧的安全约束。
   *
   * next 直接来自 URL，如果原样拼进跳转，就是一个**开放重定向**：
   * 攻击者可以构造 https://你的站/login.html?next=https://钓鱼站，
   * 登录页上一切正常（域名确实是你的），登录完"嗖"地送到假站去。
   *
   * 所以只接受同源的绝对地址，其余一律丢弃（宁可不回跳，回到主页）。
   */
  function safeNext(next) {
    if (!next) return null;

    /* ⚠⚠ 先显式堵掉 javascript: / data: 这类伪协议。
       只靠 new URL 的 origin 判断是不够的：
       javascript: 的 origin 是 "null"，虽然实际也不等于本站 origin，
       但那是**依赖浏览器的实现细节** —— 换个解析方式、或哪天有人
       改成字符串匹配，就会放行。而一旦放行，
       ?next=javascript:... 就是存储型 XSS：链接看着是你的域名，
       点开在你自己的页面上执行攻击者写的代码。
       安全约束不能靠"恰好等价"，必须显式写出来。 */
    if (/^\s*[a-z][a-z0-9+.-]*\s*:/i.test(next)) {
      /* 带冒号的只看 http/https，其余（javascript、data、vbscript…）一律拒绝 */
      if (!/^https?:\/\//i.test(next)) return null;
    }
    /* 协议相对地址 //evil.com —— 会继承当前协议跳到别的域 */
    if (/^\/\//.test(next)) return null;

    try {
      var u = new URL(next, location.href);
      if (u.origin !== location.origin) return null;
      return u.pathname + u.search + u.hash;
    } catch (e) {
      /* 解析失败（比如不是合法 URL）时也要拒绝，不能原样放行 */
      return null;
    }
  }

  /* ---------------- 跨标签同步 ---------------- */

  /**
   * ⚠ storage 事件只在**其他标签页**触发，当前页自己改的不触发。
   * 所以"我在这个标签登录了"必须自己 emit 一次，
   * 而"别的标签登录了"靠 storage 事件 —— 两条路都要有，
   * 只写一条就会出现"有时界面更新有时不更新"的怪现象。
   */
  window.addEventListener('storage', function (e) {
    if (e.key === TOK_KEY || e.key === UID_KEY) whoami(true);
  });

  /* ---------------- 渲染 ---------------- */

  /**
   * 头像算法**必须与 Chat 的 ui.js avatar() 一致**：
   * 昵称首字 + 昵称哈希色相。
   * 否则同一个人在不同项目里是两个颜色的头像，
   * 看着像两个账号 —— 那是"统一身份"最直观的破绽。
   */
  function avatarEl(nick, role) {
    var name = nick || '?';
    var ch = String(name).trim().slice(0, 1).toUpperCase();
    var hue = 0;
    for (var i = 0; i < name.length; i++) hue = (hue * 31 + name.charCodeAt(i)) % 360;
    var d = document.createElement('span');
    d.className = 'acct-av';
    d.style.background = 'hsl(' + hue + ',52%,52%)';
    d.textContent = ch;
    if (role === 'owner') d.classList.add('acct-owner');
    if (role === 'admin') d.classList.add('acct-admin');
    return d;
  }

  /**
   * 把账号区渲染进 host。opts:
   *   loginHref  未登录时点"登录"去哪（缺省用 next=当前页）
   *   compact    只显示头像
   */
  function mount(host, opts) {
    if (!host) return function () { };
    opts = opts || {};

    function draw() {
      host.innerHTML = '';
      if (!state.ok) {
        var a = document.createElement('a');
        a.className = 'acct-btn' + (state.offline ? ' acct-off' : '');
        a.textContent = state.offline ? '离线' : '登录';
        a.title = state.offline ? '连不上服务器，登录后才能同步' : '登录（全站通用）';
        if (!state.offline) {
          a.href = 'javascript:void 0';
          a.onclick = function (e) {
            e.preventDefault();
            goLogin(opts.loginHref || location.href);
          };
        } else {
          a.href = 'javascript:void 0';
        }
        host.appendChild(a);
        return;
      }

      var box = document.createElement('div');
      box.className = 'acct-box';
      box.appendChild(avatarEl(state.nick, state.role));

      if (!opts.compact) {
        var nm = document.createElement('span');
        nm.className = 'acct-name';
        nm.textContent = state.nick;
        box.appendChild(nm);

        var tg = document.createElement('span');
        tg.className = 'acct-role';
        tg.textContent = ROLE[state.role] || state.role;
        box.appendChild(tg);

        /* 待审核 / 已封禁必须显示：他登了录却什么都用不了，
           不说原因的话只会以为站点坏了。 */
        if (state.status && state.status !== 'active') {
          var st = document.createElement('span');
          st.className = 'acct-role acct-pending';
          st.textContent = state.status === 'pending' ? '待审核'
            : (state.status === 'banned' ? '已封禁' : state.status);
          box.appendChild(st);
        }
      }

      var out = document.createElement('button');
      out.className = 'acct-btn acct-out';
      out.type = 'button';
      out.textContent = '退出';
      out.title = '退出登录（全站生效）';
      out.onclick = function () {
        out.disabled = true; out.textContent = '…';
        logout().then(function () { out.disabled = false; out.textContent = '退出'; });
      };
      box.appendChild(out);
      host.appendChild(box);
    }

    draw();
    var off = onChange(draw);
    return off;
  }

  function onChange(fn) {
    subs.push(fn);
    return function () {
      var i = subs.indexOf(fn);
      if (i >= 0) subs.splice(i, 1);
    };
  }

  /* ---------------- 启动 ---------------- */

  var ready = whoami();

  g.SiteIdentity = {
    /* 状态 */
    get state() { return state; },
    ready: ready,
    whoami: whoami,
    onChange: onChange,
    /* 动作 */
    login: login,
    register: register,
    logout: logout,
    can: can,
    canNick: canNick,
    perm: perm,
    listPerms: listPerms,
    profileUpdate: profileUpdate,
    changePassword: changePassword,
    listUsers: listUsers,
    review: review,
    uploadAvatar: uploadAvatar,
    goLogin: goLogin,
    /* 渲染 */
    mount: mount,
    avatarEl: avatarEl,
    /* 给需要自己发请求的项目用 */
    rpc: rpc,
    token: token,
    /* 调试/自检 */
    _safeNext: safeNext
  };
})(window);
