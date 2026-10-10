// ==UserScript==
// @name         XMU-TronClass-Helper
// @name:zh-CN   XMU 厦大畅课助手
// @namespace    https://github.com/Lormited/XMU-TronClass-Helper
// @version      0.6.0
// @author       Lormited
// @license      MIT
// @homepageURL  https://github.com/Lormited/XMU-TronClass-Helper
// @supportURL   https://github.com/Lormited/XMU-TronClass-Helper
// @updateURL    https://raw.githubusercontent.com/Lormited/XMU-TronClass-Helper/main/XMU-TronClass-Helper.user.js
// @downloadURL  https://raw.githubusercontent.com/Lormited/XMU-TronClass-Helper/main/XMU-TronClass-Helper.user.js
// @description  XMU 厦大畅课助手：资料下载 / 首页优化（校徽首页跳转 · 页面自适应 · 课程栏滑动 · 待办排序 · 签到列表替换）/ 界面精简 / 顶栏精简
// @match        https://lnt.xmu.edu.cn/*
// @grant        GM_download
// @grant        GM_getValue
// @grant        GM_setValue
// @connect      c-media.xmu.edu.cn
// @run-at       document-end
// ==/UserScript==

(() => {
  'use strict';

  // ─── 可调参数（想自己试效果，改这里就行） ──────────────────────────────────
  const COURSE_STEP = 0.97;   // 课程栏每次翻页的比例，1 = 正好一屏
  const COURSE_DUR = 280;     // 课程栏翻页动画时长(ms)
  const WHEEL_STEP = 1.6;     // 课程栏滚轮灵敏度
  const FIT_SCALE = 0.85;     // 页面自适应：整页缩放到窗口的 85%
  const POLL = 1300;          // 轮询间隔(ms)

  // ─── 基础 ──────────────────────────────────────────────────
  const DEFAULTS = {
    feat_download: true, feat_home: true, feat_chrome: true,
    feat_topbar: false, feat_signin: false, feat_homelogo: false, feat_fit: false, feat_coursebar: false,
    feat_todo: true,
    chrome_sidebar: true, chrome_footer: true, chrome_ai: true,
  };

  // 配置读写：GM → localStorage → 默认值
  const store = {
    get(k) {
      try { const v = GM_getValue('xmu_' + k, undefined); if (v !== undefined) return v; } catch (e) { }
      try { const v = localStorage.getItem('xmu_' + k); if (v !== null) return JSON.parse(v); } catch (e) { }
      return DEFAULTS[k];
    },
    set(k, v) {
      try { return GM_setValue('xmu_' + k, v); } catch (e) { }
      try { localStorage.setItem('xmu_' + k, JSON.stringify(v)); } catch (e) { }
    },
  };

  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const isHome = () => location.pathname.startsWith('/user/index');
  const courseId = () => (location.pathname.match(/\/course\/(\d+)/) || [])[1] || null;
  const cleanName = (n) => String(n || 'document').replace(/[\\/:*?"<>|\r\n\t]/g, '_').replace(/\s+/g, ' ').slice(0, 180);
  const api = async (path) => (await fetch(path, { credentials: 'include' })).json();

  const REPO = 'https://github.com/Lormited/XMU-TronClass-Helper';
  const VERSION = typeof GM_info === 'undefined' ? '' : GM_info.script.version;   // 取自头部 @version

  function style(id, css) {
    if (document.getElementById(id)) return;
    document.documentElement.appendChild(Object.assign(document.createElement('style'), { id, textContent: css }));
  }

  // 轮询：立即跑一次，随后按 POLL 重复；定时器挂在 m.poller 上
  const poll = (m, ...fns) => {
    const ids = fns.map((f) => { const run = f.bind(m); run(); return setInterval(run, POLL); });
    m.poller = { stop: () => ids.forEach(clearInterval) };
  };

  // 平滑滚动：即时启动，末尾自然收住
  function smoothScroll(c, target, dur = COURSE_DUR) {
    const start = c.scrollLeft, dist = target - start, t0 = performance.now();
    const tick = (now) => {
      const p = Math.min(1, (now - t0) / dur);
      c.scrollLeft = start + dist * (1 - Math.pow(1 - p, 3));
      if (p < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  // 模块登记表：id 取这里的键
  const modules = {};
  const featKey = (m) => 'feat_' + m.id;

  // ─── 资料下载（课程页） ────────────────────────────────────────
  const DL_TYPES = ['document', 'file'];

  function saveFile(url, name) {
    return new Promise((resolve) => {
      try {
        GM_download({
          url, name, saveAs: false,
          onload: () => resolve(true),
          onerror: () => resolve(blobDownload(url, name)),
        });
      } catch (e) { resolve(blobDownload(url, name)); }
    });
  }

  async function blobDownload(url, name) {
    try {
      const blob = await (await fetch(url)).blob();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = name;
      document.documentElement.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 60000);
      return true;
    } catch (e) { return false; }
  }

  modules.download = {
    name: '资料下载', desc: '课程页右下角一键下载本课资料',

    init() {
      if (!courseId()) return;
      style('xmu-dl', `
        .xmu-fab{position:fixed;right:18px;bottom:18px;z-index:2147483600;height:36px;padding:0 18px;border:none;border-radius:3px;background:#003c88;color:#fff;font-size:14px;line-height:1;cursor:pointer;font-family:inherit;box-shadow:0 2px 10px rgba(0,60,136,.28);}
        .xmu-fab:focus{background:#003c88;color:#fff;}
        .xmu-fab:hover{background:#092666;color:#fff;}
        .xmu-fab:focus-visible{outline:2px solid #fff;outline-offset:-4px;}
        .xmu-panel{position:fixed;right:18px;bottom:66px;z-index:2147483600;width:360px;max-width:calc(100vw - 36px);background:#fff;border:1px solid #d8d8d8;border-radius:4px;box-shadow:0 10px 40px rgba(0,0,0,.16);display:none;overflow:hidden;color:#333;font-family:inherit;}
        .xmu-panel .xmu-dl-hd,.xmu-panel .xmu-dl-ft{padding:12px 16px;}
        .xmu-panel .xmu-dl-hd{display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid #eee;font-weight:600;font-size:14px;}
        .xmu-panel .xmu-dl-ft{border-top:1px solid #eee;}
        .xmu-panel .xmu-dl-bar{display:flex;justify-content:space-between;align-items:center;padding:9px 16px;border-bottom:1px solid #f2f2f2;font-size:13px;}
        .xmu-panel .xmu-dl-bar label{display:flex;align-items:center;gap:6px;margin:0;cursor:pointer;}
        .xmu-panel .xmu-dl-count{font-size:12px;color:#737373;}
        .xmu-panel .xmu-dl-list{max-height:320px;overflow:auto;padding:6px 10px;}
        .xmu-panel .xmu-dl-row{display:flex;align-items:center;gap:9px;padding:7px 6px;border-bottom:1px solid #f5f5f5;font-size:13px;}
        .xmu-panel .xmu-dl-row:last-child{border-bottom:none;}
        .xmu-panel .xmu-dl-nm{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
        .xmu-panel .xmu-dl-sz{flex-shrink:0;font-size:12px;color:#737373;}
        .xmu-panel .xmu-dl-empty{padding:22px;text-align:center;color:#737373;font-size:13px;}
        .xmu-panel input[type=checkbox]{accent-color:#003c88;width:15px;height:15px;margin:0;cursor:pointer;}
        .xmu-panel .xmu-dl-x{border:none;background:none;font-size:20px;line-height:1;color:#999;cursor:pointer;padding:0;}
        .xmu-panel .xmu-dl-go{width:100%;height:34px;border:none;border-radius:3px;background:#003c88;color:#fff;font-size:14px;cursor:pointer;}
        .xmu-panel .xmu-dl-go:hover{background:#092666;}
        .xmu-panel .xmu-dl-go:disabled,.xmu-panel .xmu-dl-go:disabled:hover{background:#d0d5d8;cursor:not-allowed;}
      `);

      const fab = document.createElement('button');
      fab.className = 'xmu-fab';
      fab.textContent = '资料下载';
      fab.onclick = async () => {
        if (!this.panel) this.build();
        const open = this.panel.style.display !== 'block';
        this.panel.style.display = open ? 'block' : 'none';
        if (open && !this.files) await this.load();
      };
      this.fab = fab;
      document.documentElement.appendChild(fab);
    },

    destroy() {
      this.fab?.remove(); this.panel?.remove();
      document.getElementById('xmu-dl')?.remove();
      this.fab = this.panel = this.files = null;
      this.running = false;
    },

    build() {
      const p = document.createElement('div');
      p.className = 'xmu-panel';
      p.innerHTML = `
        <div class="xmu-dl-hd"><span>资料下载</span><button class="xmu-dl-x">×</button></div>
        <div class="xmu-dl-bar"><label><input type="checkbox" class="xmu-dl-all"> 全选</label><span class="xmu-dl-count"></span></div>
        <div class="xmu-dl-list"></div>
        <div class="xmu-dl-ft"><button class="xmu-dl-go"></button></div>`;
      document.documentElement.appendChild(p);
      $('.xmu-dl-x', p).onclick = () => { p.style.display = 'none'; };
      $('.xmu-dl-all', p).onchange = (e) => { (this.files || []).forEach((f) => { f.checked = e.target.checked; }); this.render(); };
      $('.xmu-dl-go', p).onclick = () => this.run();
      this.panel = p;
    },

    async load() {
      const btn = $('.xmu-dl-go', this.panel);
      btn.textContent = '加载中…'; btn.disabled = true;
      this.files = [];
      const j = await api(`/api/courses/${courseId()}/activities?sub_course_id=0`).catch(() => ({}));
      const uniq = new Map();                       // 同一个附件可能挂在多个活动下
      (j.activities || []).forEach((a) => (a.uploads || []).forEach((u) => {
        if (u.id && !u.deleted && DL_TYPES.includes(u.type)) uniq.set(u.id, u);
      }));
      this.files = [...uniq.values()].map((u) => ({ id: u.id, name: u.name || `document-${u.id}`, size: u.size, checked: false }));

      if (!this.files.length) {
        $('.xmu-dl-list', this.panel).innerHTML = '<div class="xmu-dl-empty">没有可下载的资料</div>';
        $('.xmu-dl-count', this.panel).textContent = '';
        btn.textContent = '无资料';
        return;
      }
      this.render();
    },

    render() {
      if (!this.panel) return;
      const files = this.files || [];
      const checked = files.filter((f) => f.checked).length;
      const btn = $('.xmu-dl-go', this.panel);
      $('.xmu-dl-count', this.panel).textContent = `共 ${files.length} 个`;
      btn.textContent = this.running ? '下载中…'
        : checked === files.length ? `全部下载（${files.length}）` : `下载选中（${checked}）`;
      btn.disabled = this.running || !checked;

      const list = $('.xmu-dl-list', this.panel);
      list.innerHTML = '';
      files.forEach((f) => {
        const row = document.createElement('div');
        row.className = 'xmu-dl-row';
        row.innerHTML = `<input type="checkbox"${f.checked ? ' checked' : ''}><span class="xmu-dl-nm"></span><span class="xmu-dl-sz"></span>`;
        const nm = $('.xmu-dl-nm', row);
        nm.textContent = f.name;
        nm.title = f.name;
        $('.xmu-dl-sz', row).textContent = f.size ? (f.size / 1048576).toFixed(1) + ' MB' : '';
        $('input', row).onchange = (e) => { f.checked = e.target.checked; this.render(); };
        list.appendChild(row);
      });
    },

    async run() {
      const targets = (this.files || []).filter((f) => f.checked);
      if (!targets.length || this.running) return;
      this.running = true;
      const btn = $('.xmu-dl-go', this.panel);
      let ok = 0, fail = 0;
      for (const [i, f] of targets.entries()) {
        btn.textContent = `下载中 ${i + 1}/${targets.length}`;
        const url = await api(`/api/uploads/${f.id}/download-url-for-ai`).then((r) => r.url).catch(() => null);
        if (url && await saveFile(url, cleanName(f.name))) ok++; else fail++;
        await sleep(400);                       // 别把请求打太密
      }
      this.running = false;
      this.render();
      btn.textContent = `完成：成功 ${ok}${fail ? '，失败 ' + fail : ''}`;
      setTimeout(() => this.render(), 5000);
    },
  };

  // ─── 首页优化（把首页那几个功能收成一组） ──────────────────
  const HOME_FEATS = [
    ['homelogo', '校徽首页跳转'],
    ['fit', '页面自适应'],
    ['coursebar', '课程栏滑动'],
    ['todo', '待办排序'],
    ['signin', '签到列表替换'],
  ];

  // 按配置同步一个子功能；状态没变就不动它
  function syncFeat(sub) {
    const on = !!store.get(featKey(sub));
    if (on === !!sub.on) return;
    sub.on = on;
    if (on) sub.init(); else sub.destroy();
  }

  modules.home = {
    name: '首页优化', desc: '首页的校徽 / 缩放 / 课程栏 / 待办 / 签到，逐项开关',

    tags: () => HOME_FEATS.map(([id, label]) => [featKey(modules[id]), label]),

    init() { this.apply(); },
    apply() { HOME_FEATS.forEach(([id]) => syncFeat(modules[id])); },
    destroy() {
      HOME_FEATS.forEach(([id]) => { modules[id].destroy?.(); modules[id].on = false; });
    },
  };

  // ─── 签到列表替换（首页「常用入口」） ─────────────────────────────────
  const ROLLCALL_TYPE = {
    number: '数字点名', qr: '二维码点名', manual: '手动点名',
    radar: '雷达点名', selfRegistration: '自主签到', roomis: 'ROOMIS',
  };
  const LIST_URL = 'https://c-mobile.xmu.edu.cn/ongoing-rollcall-list';
  const RC_CACHE = {};                          // 签到码缓存：rollcall_id -> 码 / null

  function rollcallType(r) {
    if (r.is_number) return '数字点名';
    if (r.is_radar) return '雷达点名';
    return ROLLCALL_TYPE[String(r.source || r.type || '').replace(/_rollcall$/, '')] || '点名';
  }

  function rollcallUrl(r) {
    if (r.is_number && r.course_id && r.rollcall_id)
      return `https://c-mobile.xmu.edu.cn/course/${r.course_id}/number-rollcall/${r.rollcall_id}/answer`;
    return LIST_URL;
  }

  async function signinCodeOf(r) {
    const id = r.rollcall_id;
    if (!id) return null;
    if (id in RC_CACHE) return RC_CACHE[id];
    const j = await api(`/api/rollcall/${id}/student_rollcalls`).catch(() => null);
    RC_CACHE[id] = j && j.is_number ? j.number_code || null : null;
    return RC_CACHE[id];
  }

  modules.signin = {
    name: '签到列表替换', desc: '把首页「常用入口」换成「正在签到」', sub: true,

    init() {
      if (!isHome()) return;
      style('xmu-sc', `
        .xmu-sc-body{display:flex;flex-direction:column;gap:16px;width:100%;min-width:0;}
        .xmu-sc-empty{padding:26px 0;text-align:center;color:#737373;font-size:13px;}
        .xmu-sc-item{display:flex;align-items:center;justify-content:space-between;gap:9px;padding:11px 6px;border-bottom:1px solid #e8eaec;border-radius:8px;cursor:pointer;transition:background .18s ease;}
        .xmu-sc-item:last-child{border-bottom:none;}
        .xmu-sc-item:hover{background:#f5f8ff;}
        .xmu-sc-item:hover .xmu-sc-go:not(.done){color:var(--primary-brand-color-lightened-2);}
        .xmu-sc-main{min-width:0;flex:1;}
        .xmu-sc-course{font-size:14px;color:#333;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
        .xmu-sc-meta{font-size:12px;color:#8a9099;margin-top:3px;}
        /* 码位宽度固定，有码没码都不改变条目尺寸 */
        .xmu-sc-code{flex-shrink:0;width:48px;text-align:right;font-size:11.5px;font-style:normal;line-height:1.6;color:#003c88;}
        .xmu-sc-code.on{border:1px dashed #9fb6d4;border-radius:8px;background:#f4f8fd;padding:2px 6px;box-sizing:border-box;text-align:center;}
        .xmu-sc-go{flex-shrink:0;width:24px;height:36px;line-height:36px;text-align:center;font-size:24px;color:var(--primary-brand-color);}
        .xmu-sc-go i{position:relative;top:3px;}
        .xmu-sc-go.done{color:#1a9c57;}
      `);
      poll(this, this.mount, this.load);
    },

    destroy() {
      this.poller.stop();
      if (this.card && typeof this.orig === 'string') {   // 留底可能是 undefined，不能直接写回
        this.card.innerHTML = this.orig;
        delete this.card.dataset.xmuSignin;
      }
      this.card = this.orig = null;
    },

    // 把首页卡片改造成「正在签到」（只接管一次）
    mount() {
      if (!isHome()) return;
      const card = $$('.frequent-entries').find((c) => $('.frequent-entry-header', c) && $('.frequent-entry-list-wrapper', c));
      if (!card) return;
      if (this.card === card && card.dataset.xmuSignin) return;

      if (!card.dataset.xmuSignin) this.orig = card.innerHTML;   // 只在没被改造过时留底
      this.card = card;
      card.dataset.xmuSignin = '1';
      $('.frequent-entry-header .title', card).textContent = '正在签到';
      $('.frequent-entry-header .options', card)?.remove();
      $('.frequent-entry-list-wrapper', card).innerHTML = '<div class="xmu-sc-body"></div>';
      this.render();
    },

    async load() {
      const next = await api('/api/radar/rollcalls?api_version=1.1.0').then((j) => j.rollcalls || []).catch(() => null);
      if (!next) return;
      const sig = JSON.stringify(next);
      if (sig === this.sig) return;             // 数据没变就不重绘
      this.sig = sig;
      this.data = next;
      this.render();
    },

    render() {
      const body = this.card && $('.xmu-sc-body', this.card);
      if (!body) return;
      const data = this.data || [];
      if (!data.length) { body.innerHTML = '<div class="xmu-sc-empty">当前没有正在进行的签到</div>'; return; }

      body.innerHTML = '';
      data.forEach((r) => {
        const course = r.course_title || '课程';
        // 已签到看 status；student_status 即使已签也仍是 on_call，不能用
        const signed = /fine|late|present|signed/.test(String(r.status || ''));

        const item = document.createElement('div');
        item.className = 'xmu-sc-item';
        item.innerHTML = `<div class="xmu-sc-main"><div class="xmu-sc-course"></div><div class="xmu-sc-meta"></div></div><span class="xmu-sc-code"></span><span class="xmu-sc-go"></span>`;
        $('.xmu-sc-course', item).textContent = course;
        $('.xmu-sc-meta', item).textContent = rollcallType(r);

        const go = $('.xmu-sc-go', item);
        go.className = 'xmu-sc-go' + (signed ? ' done' : '');
        go.innerHTML = `<i class="font ${signed ? 'font-rollcall-finish' : 'font-goto'}"></i>`;
        if (signed) item.style.cursor = 'default';
        else item.onclick = () => window.open(rollcallUrl(r), '_blank');

        body.appendChild(item);
        this.fillCode(item, r);
      });
    },

    // 命中缓存就同步填，避免列表重绘时闪一下
    fillCode(item, r) {
      if (!r.rollcall_id) return;
      const box = $('.xmu-sc-code', item);
      if (!box) return;
      const paint = (c) => { box.textContent = c; box.classList.add('on'); };
      if (r.rollcall_id in RC_CACHE) {
        if (RC_CACHE[r.rollcall_id]) paint(RC_CACHE[r.rollcall_id]);
        return;
      }
      signinCodeOf(r).then((code) => { if (code && box.isConnected) paint(code); });
    },
  };

  // ─── 界面精简 ─────────────────────────────────────────────
  // [配置键, 标签名, 选择器]
  const CHROME_HIDE = [
    ['chrome_sidebar', '侧栏', 'aside.new-user-index-sidebar, .course-menu-container'],
    ['chrome_footer', '底栏', '.footer'],
    ['chrome_ai', 'AI 助手', 'air-chatbot-app'],
  ];

  modules.chrome = {
    name: '界面精简', desc: '隐藏侧栏 / 底栏 / AI 助手',

    tags: () => CHROME_HIDE.map(([k, l]) => [k, l]),

    init() {
      poll(this, this.apply);
    },

    destroy() {
      this.poller.stop();
      $$('[data-xmu-hidden]').forEach((el) => { el.style.display = ''; delete el.dataset.xmuHidden; });
    },

    apply() {
      CHROME_HIDE.forEach(([key, , sel]) => {
        const hide = !!store.get(key);
        $$(sel).forEach((el) => {
          if (hide) {
            // 站点本来就藏着的元素不打标记，否则关功能时会被我们弄出来
            if (el.style.display !== 'none') { el.dataset.xmuHidden = '1'; el.style.display = 'none'; }
          } else if (el.dataset.xmuHidden) {
            el.style.display = ''; delete el.dataset.xmuHidden;
          }
        });
      });
    },
  };

  // ─── 顶栏精简（按「入口」聚合，逐项开关） ───────────────────────────────
  const TOPBAR_ROOT = '.header';
  const TOPBAR_ATOM = /^(IMG|SVG|USE|PATH|CANVAS|VIDEO|IFRAME|INPUT|TEXTAREA|SELECT)$/;   // 本身即整体，不再拆
  const TOPBAR_SKIP = /(^|\s)(autocollapse-more|autocollapse-container|dropdown-list)(\s|$)/;   // 折叠菜单入口
  const TOPBAR_RULE = 'header-vertical-split-line';   // 分隔栏：自身就是一个开关
  const TOPBAR_SPLIT = 'logo-padding';                // 拆成「校徽 / 课程中心」两个开关
  const TOPBAR_BADGE = '.count-wrapper, .count, .badge, .num, .unread';   // 角标数字不算名字
  const TOPBAR_NAMES = {                              // class / 图标名 → 看得懂的名字
    'application-center': '应用中心', 'school-name': '课程中心', logo: '校徽',
    'public-course': 'AI课程', 'text-title': '日历', notifications: '通知',
    manual: '帮助', 'profile-item': '账号信息', 'header-vertical-split-line': '分隔栏',
    'font-header-calendar': '日历', 'font-header-help': '帮助', 'font-notification': '通知',
  };

  // 已隐藏的仍算「在场」
  function topbarVisible(el) {
    if (el.hasAttribute('data-xmu-topbar')) return true;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  // 取文字，去掉角标数字
  function topbarText(el) {
    if (!el.querySelector(TOPBAR_BADGE)) return (el.textContent || '').trim().replace(/\s+/g, ' ');
    const c = el.cloneNode(true);
    c.querySelectorAll(TOPBAR_BADGE).forEach((n) => n.remove());
    return (c.textContent || '').trim().replace(/\s+/g, ' ');
  }

  // 名字优先级：title/aria > 自身 class > 图标名 > 文字 > 祖先 class
  function topbarName(el) {
    const aria = (el.getAttribute('title') || el.getAttribute('aria-label') || '').trim();
    if (aria) return aria.slice(0, 12);

    const classesOf = (n) => String(n.getAttribute('class') || '').split(/\s+/);
    const nameOf = (n) => { const c = n && classesOf(n).find((x) => TOPBAR_NAMES[x]); return c && TOPBAR_NAMES[c]; };

    const own = nameOf(el) || nameOf($('i[class], img, svg use', el));
    if (own) return own;

    const txt = topbarText(el);
    if (txt) return txt.slice(0, 12);

    let node = el.parentElement, d = 0;
    while (node && d++ < 4) {
      const hit = nameOf(node);
      if (hit) return hit;
      node = node.parentElement;
    }

    const cls = classesOf(el).find((c) => c && !/^(ng-|xmu-)/.test(c));
    return (cls || el.tagName.toLowerCase()).slice(0, 12);
  }

  // 配置键用结构签名，不用数组下标
  function topbarSig(el) {
    const parts = [];
    let node = el, d = 0;
    while (node && d++ < 4) {
      const cls = String(node.getAttribute('class') || '').trim().split(/\s+/)
        .filter((c) => c && !/^ng-/.test(c)).sort().slice(0, 3).join('.');
      parts.push(node.tagName + (cls ? '.' + cls : ''));
      node = node.parentElement;
    }
    return (parts.join('>') + '@' + topbarText(el).replace(/\s+/g, '').slice(0, 10))
      .replace(/[^A-Za-z0-9.@>_-]/g, '');
  }

  // 收掉因隐藏而缩成 0 宽、却还占着 margin 的空壳父级
  function topbarTidy(el) {
    const bar = $(TOPBAR_ROOT);
    let node = el.parentElement, d = 0;
    while (node && node !== bar && d++ < 5) {
      if (node.getBoundingClientRect().width > 0) break;
      node.setAttribute('data-xmu-shell', '1');
      node.style.display = 'none';
      node = node.parentElement;
    }
  }

  modules.topbar = {
    name: '顶栏精简', desc: '选择隐藏顶栏上的元素',

    init() {
      poll(this, this.apply);
    },

    destroy() {
      this.poller.stop();
      $$('[data-xmu-topbar],[data-xmu-shell]').forEach((el) => {
        el.style.display = '';
        el.removeAttribute('data-xmu-topbar');
        el.removeAttribute('data-xmu-shell');
      });
    },

    // 开关整份存成一个 JSON，免得几十个散落的键
    conf() {
      try { return JSON.parse(store.get('topbar_hide') || '{}') || {}; } catch (e) { return {}; }
    },
    tagOn(key) { return !!this.conf()[key]; },
    tagToggle(key) {
      const c = this.conf();
      if (c[key]) delete c[key]; else c[key] = 1;
      store.set('topbar_hide', JSON.stringify(c));
    },

    // 按「入口」聚合：<a> 整体一个开关就不再下钻，纯装饰图标不会单独成项
    units() {
      const bar = $(TOPBAR_ROOT);
      if (!bar) return [];
      const out = [];

      const walk = (el) => {
        const cls = String(el.getAttribute('class') || '');

        if (el.hasAttribute('data-xmu-topbar')) { out.push(el); return; }   // 已关掉的常驻列表
        if (TOPBAR_SKIP.test(cls)) return;
        if (cls.includes(TOPBAR_RULE)) { if (topbarVisible(el)) out.push(el); return; }

        if (cls.includes(TOPBAR_SPLIT)) {                                   // 校徽 / 课程中心 拆成两个
          [...el.children].forEach((k) => {
            if (k.hasAttribute('data-xmu-topbar') || topbarVisible(k)) out.push(k);
          });
          return;
        }

        if (el.tagName === 'A' || el.getAttribute('role') === 'button') {    // 入口整体一个开关
          if (topbarVisible(el)) out.push(el);
          return;
        }

        const kids = [...el.children].filter((k) => !/^(SCRIPT|STYLE|TEMPLATE)$/.test(k.tagName));
        if (!kids.length) {
          if (topbarVisible(el) && (topbarText(el) || TOPBAR_ATOM.test(el.tagName))) out.push(el);
          return;
        }
        kids.forEach(walk);
      };
      [...bar.children].forEach(walk);

      const keySeq = {};
      const list = out.map((el) => {
        const base = topbarSig(el);
        keySeq[base] = (keySeq[base] || 0) + 1;
        return { el, key: base + (keySeq[base] > 1 ? '#' + keySeq[base] : ''), name: topbarName(el) };
      });

      // 重名的（两条分隔栏）加序号
      const total = {};
      list.forEach((u) => { total[u.name] = (total[u.name] || 0) + 1; });
      const seq = {};
      list.forEach((u) => {
        if (total[u.name] > 1) u.name += ' ' + (seq[u.name] = (seq[u.name] || 0) + 1);
      });
      return list;
    },

    tags() { return this.units().map((u) => [u.key, u.name]); },

    apply() {
      // 先放开上一轮收掉的空壳，再重新判断
      $$('[data-xmu-shell]').forEach((n) => { n.style.display = ''; n.removeAttribute('data-xmu-shell'); });
      const hide = this.conf();
      this.units().forEach((u) => {
        if (hide[u.key]) {
          u.el.setAttribute('data-xmu-topbar', '1');
          u.el.style.display = 'none';
          topbarTidy(u.el);
        } else if (u.el.hasAttribute('data-xmu-topbar')) {
          u.el.style.display = '';
          u.el.removeAttribute('data-xmu-topbar');
        }
      });
    },
  };

  // ─── 校徽首页跳转 ──────────────────────────────────────────
  const HOME_URL = 'https://lnt.xmu.edu.cn/user/index#/';

  modules.homelogo = {
    name: '校徽首页跳转', desc: '点左上角校徽回首页，不跳数字化教学平台', sub: true,

    init() {
      poll(this, this.bind);
    },

    destroy() {
      this.poller.stop();
      $$('.header .logo-padding[data-xmu-logo]').forEach((a) => {
        a.setAttribute('href', a.dataset.xmuLogo);
        delete a.dataset.xmuLogo;
      });
    },

    bind() {
      $$('.header .logo-padding').forEach((a) => {
        if (a.getAttribute('href') === HOME_URL) return;
        a.dataset.xmuLogo = a.getAttribute('href') || '';   // 留一份原地址，供关闭时还原
        a.setAttribute('href', HOME_URL);
      });
    },
  };

  // ─── 页面自适应（整页缩放，仅首页） ─────────────────────────────────────
  modules.fit = {
    name: '页面自适应', desc: '按屏幕比例整体缩放首页，一屏显示更多', sub: true,

    init() {
      style('xmu-fit', `
        /* 两块内容区改纵向 flex，多出来的高度全给待办 */
        html.xmu-fit-on main.isStudent{display:flex;flex-direction:column;gap:24px;padding:24px!important;}
        html.xmu-fit-on main.isStudent>.section1{flex:0 0 auto;margin:0!important;gap:24px!important;}
        /* 窗口不够高时别把内容压溢：用内容下限（auto），装不下就让页面滚 */
        html.xmu-fit-on main.isStudent>.section1.wrapper1{flex:1 1 auto;min-height:auto;}
        html.xmu-fit-on main.isStudent .todo-list-container{flex:1 1 auto;min-height:0;}
        /* 右列由首张卡吸收高度 */
        html.xmu-fit-on main.isStudent .section1-right{display:flex;flex-direction:column;}
        html.xmu-fit-on main.isStudent .section1-right>*:first-child{flex:1 1 auto;min-height:auto;}
        /* 间距统一 24px */
        html.xmu-fit-on .main-content{padding-top:0!important;}
      `);
      poll(this, this.apply);
    },

    destroy() {
      this.poller.stop();
      document.documentElement.classList.remove('xmu-fit-on');
      document.getElementById('xmu-fit')?.remove();
      this.reset();
    },

    reset() {
      const clear = (el, props) => props.forEach((p) => el?.style.removeProperty(p));
      clear(document.body, ['zoom']);
      clear($('.main-content'), ['width', 'height']);
    },

    apply() {
      const home = isHome();
      document.documentElement.classList.toggle('xmu-fit-on', home);
      if (!home) return this.reset();                 // 非首页还原
      document.body.style.zoom = FIT_SCALE;

      // 画布尺寸显式给足（视口 ÷ 缩放）；用 clientWidth/Height，不含滚动条，否则会出现滚动条反馈循环
      const mc = $('.main-content');
      if (!mc) return;
      const vp = document.documentElement;
      Object.assign(mc.style, {
        width: vp.clientWidth / FIT_SCALE + 'px',
        height: vp.clientHeight / FIT_SCALE - ($('.header')?.offsetHeight || 0) + 'px',
      });
    },
  };

  // ─── 课程栏滑动 ────────────────────────────────────────────
  modules.coursebar = {
    name: '课程栏滑动', desc: '课程栏支持滚轮横向滑动，并优化翻页效果', sub: true,

    init() {
      if (!isHome()) return;
      poll(this, this.bind);
    },

    destroy() {
      this.poller?.stop();
      document.removeEventListener('click', this.onArrow, true);
      this.c?.removeEventListener('wheel', this.onWheel);
      this.c?.removeEventListener('scroll', this.onScroll);
      this.c = this.wheelTo = this.onArrow = this.onWheel = this.onScroll = null;   // 清干净，否则重开时守卫不成立
    },

    // 用委托在捕获阶段接管左右箭头
    bind() {
      const c = $('.courses-container');
      if (!c) return;
      this.c = c;

      if (!this.onArrow) {
        this.onArrow = (e) => {
          const arrow = e.target instanceof Element && e.target.closest('.nav-arrow');
          if (!arrow || !this.c) return;
          e.stopImmediatePropagation(); e.preventDefault();
          const dir = arrow.classList.contains('right') ? 1 : -1;
          this.animate(this.c.scrollLeft + dir * this.c.clientWidth * COURSE_STEP);
        };
        document.addEventListener('click', this.onArrow, true);

        this.onWheel = (e) => {
          if (!this.c || Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
          e.preventDefault();
          this.wheelTo = clamp((this.wheelTo ?? this.c.scrollLeft) + e.deltaY * WHEEL_STEP, 0, this.max());
          this.animate(this.wheelTo);
        };
        c.addEventListener('wheel', this.onWheel, { passive: false });

        // 滚动时同步箭头状态
        this.onScroll = () => this.syncArrows();
        c.addEventListener('scroll', this.onScroll, { passive: true });
      }
      this.syncArrows();
    },

    max() { return this.c ? this.c.scrollWidth - this.c.clientWidth : 0; },

    animate(target) { smoothScroll(this.c, clamp(target, 0, this.max())); },

    syncArrows() {
      if (!this.c) return;
      $('.nav-arrow.left')?.classList.toggle('disabled', this.c.scrollLeft <= 2);
      $('.nav-arrow.right')?.classList.toggle('disabled', this.c.scrollLeft >= this.max() - 2);
    },
  };

  // ─── 待办排序 ──────────────────────────────────────────
  // 首页待办按截止时间升序排
  const DUE_RE = /(\d{4})\.(\d{1,2})\.(\d{1,2})\s+(\d{1,2}):(\d{2})/;

  function todoDue(item) {
    const m = ($('.todo-datetime', item)?.textContent || '').match(DUE_RE);
    return m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]).getTime() : Infinity;
  }

  modules.todo = {
    name: '待办排序', desc: '首页待办按截止时间升序排列', sub: true,

    init() {
      if (!isHome()) return;
      poll(this, this.sort);
    },

    destroy() { this.poller.stop(); },

    sort() {
      const box = $('.todo-list-container');
      if (!box) return;
      const items = $$('.todo-item', box);
      if (items.length < 2) return;

      // 排过就跳过
      const key = (i) => ($('.todo-title', i)?.textContent || '') + '|' + ($('.todo-datetime', i)?.textContent || '');
      const sig = items.map(key).join('##');
      if (sig === this.sig) return;
      this.sig = sig;

      items.slice().sort((a, b) => todoDue(a) - todoDue(b)).forEach((i) => box.appendChild(i));
    },
  };

  // ─── 设置面板 ────────────────────────────────────────────────
  const MODULES = Object.values(modules).filter((m) => !m.sub);   // 子功能由「首页优化」的标签驱动

  const settings = {
    init() {
      style('xmu-set', `
        .xmu-set-btn{position:fixed;right:0;top:50%;transform:translateY(-50%);z-index:2147483647;width:26px;height:48px;padding:0;border:none;border-radius:8px 0 0 8px;cursor:pointer;background:#fff;box-shadow:-2px 0 10px rgba(0,0,0,.06);opacity:.35;transition:all .2s ease;display:flex;align-items:center;justify-content:center;}
        .xmu-set-btn svg{width:15px;height:15px;color:#6b7280;transition:all .2s ease;}
        .xmu-set-btn:focus{background:#fff;}
        .xmu-set-btn:hover{opacity:1;width:32px;}
        .xmu-set-btn:hover svg{color:#003c88;transform:rotate(45deg);}
        .xmu-set-panel{position:fixed;right:44px;top:50%;transform:translateY(-50%);z-index:2147483647;width:296px;max-height:76vh;overflow:auto;background:#fff;border:1px solid #e8eaed;border-radius:10px;box-shadow:0 12px 48px rgba(0,0,0,.14);display:none;color:#333;font-family:inherit;}
        .xmu-set-panel .xmu-set-hd{display:flex;justify-content:space-between;align-items:center;padding:14px 16px 12px;border-bottom:1px solid #f0f1f3;}
        .xmu-set-panel .xmu-set-hd b{font-size:14px;font-weight:600;}
        .xmu-set-panel .xmu-set-hd button{border:none;background:none;font-size:19px;line-height:1;color:#b8bcc2;cursor:pointer;padding:0 2px;}
        .xmu-set-panel .xmu-set-hd button:hover{color:#555;}
        .xmu-set-panel .xmu-set-item{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:12px 16px;cursor:pointer;}
        .xmu-set-panel .xmu-set-item:hover{background:#fafbfc;}
        .xmu-set-panel .xmu-set-nm{font-size:13px;color:#2b2f36;}
        .xmu-set-panel .xmu-set-ds{font-size:11px;color:#9aa0a6;margin-top:3px;line-height:1.4;}
        .xmu-set-panel .xmu-set-tags{position:relative;display:flex;flex-wrap:wrap;gap:6px;padding:10px 16px 12px 30px;background:#fbfcfd;border-top:1px solid #f4f5f7;}
        .xmu-set-panel .xmu-set-tags::before{content:'';position:absolute;left:17px;top:15px;bottom:16px;width:2px;border-radius:1px;background:#e4e8ee;}
        .xmu-tag{padding:4px 10px;border:1px solid #e2e5e9;border-radius:11px;background:#fff;font-size:11px;color:#6b7280;cursor:pointer;user-select:none;transition:all .15s ease;}
        .xmu-tag:hover{border-color:#b9c2cc;color:#3d4450;}
        .xmu-tag.on{border-color:#003c88;background:#eef3fa;color:#003c88;}
        .xmu-set-panel .xmu-set-ft{padding:9px 16px 12px;text-align:center;font-size:11px;color:#c2c6cb;border-top:1px solid #f4f5f7;}
        .xmu-set-panel .xmu-set-ft a{color:inherit;text-decoration:none;}
        .xmu-set-panel .xmu-set-ft a:hover{color:#003c88;text-decoration:underline;}
        .xmu-sw{position:relative;flex-shrink:0;width:36px;height:20px;border-radius:10px;background:#dfe2e6;transition:background .18s ease;}
        .xmu-sw.on{background:#003c88;}
        .xmu-sw::after{content:'';position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.18);transition:left .18s ease;}
        .xmu-sw.on::after{left:18px;}
      `);

      const btn = document.createElement('button');
      btn.className = 'xmu-set-btn';
      btn.title = 'XMU 厦大畅课助手';
      btn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>`;
      btn.onclick = () => this.toggle();
      this.btn = btn;
      document.documentElement.appendChild(btn);

      // 点击面板外部关闭
      document.addEventListener('click', (e) => {
        if (!this.open) return;
        if (this.panel?.contains(e.target) || this.btn?.contains(e.target)) return;
        this.toggle();
      }, true);
    },

    toggle() {
      if (!this.panel) this.build();
      this.open = !this.open;
      this.panel.style.display = this.open ? 'block' : 'none';
      if (this.open) this.refresh();
    },

    build() {
      const p = document.createElement('div');
      p.className = 'xmu-set-panel';
      p.innerHTML = `
        <div class="xmu-set-hd"><b>XMU 厦大畅课助手</b><button class="xmu-set-x">×</button></div>
        <div class="xmu-set-body"></div>
        <div class="xmu-set-ft"><a href="${REPO}" target="_blank" rel="noopener">v${VERSION}</a></div>`;
      document.documentElement.appendChild(p);
      $('.xmu-set-x', p).onclick = () => this.toggle();
      this.panel = p;
    },

    refresh() {
      const body = $('.xmu-set-body', this.panel);
      body.innerHTML = '';
      MODULES.forEach((m) => {
        const on = !!store.get(featKey(m));
        const row = document.createElement('div');
        row.className = 'xmu-set-item';
        row.innerHTML = `<div><div class="xmu-set-nm">${m.name}</div><div class="xmu-set-ds">${m.desc}</div></div><div class="xmu-sw${on ? ' on' : ''}"></div>`;
        $('.xmu-sw', row).onclick = (e) => {
          e.stopPropagation();
          store.set(featKey(m), !on);
          on ? m.destroy?.() : m.init?.();
          this.refresh();
        };
        body.appendChild(row);

        const tags = on && m.tags?.();
        if (tags?.length) body.appendChild(this.buildTags(m, tags));
      });
    },

    // 子选项读写：模块可自定义，否则用扁平键
    tagOn(m, key) { return m.tagOn ? m.tagOn(key) : !!store.get(key); },
    tagToggle(m, key) { m.tagToggle ? m.tagToggle(key) : store.set(key, !store.get(key)); },

    // 模块下方的小标签，排不下自动换行
    buildTags(m, tags) {
      const wrap = document.createElement('div');
      wrap.className = 'xmu-set-tags';
      tags.forEach(([key, label]) => {
        const tag = document.createElement('span');
        tag.className = 'xmu-tag' + (this.tagOn(m, key) ? ' on' : '');
        tag.textContent = label;
        tag.onclick = () => { this.tagToggle(m, key); m.apply?.(); this.refresh(); };
        wrap.appendChild(tag);
      });
      return wrap;
    },
  };

  // ─── 启动 ──────────────────────────────────────────────────
  // 模块 id 取登记时的键
  // 先把 id 发完再启用：首页优化依赖子模块的 id 拼配置键
  Object.entries(modules).forEach(([id, m]) => { m.id = id; });
  Object.values(modules).forEach((m) => {
    if (!m.sub && store.get(featKey(m))) m.init();
  });
  settings.init();
})();
