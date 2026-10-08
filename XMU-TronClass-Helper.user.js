// ==UserScript==
// @name         XMU-TronClass-Helper
// @name:zh-CN   XMU 厦大畅课助手
// @namespace    https://github.com/Lormited/XMU-TronClass-Helper
// @version      0.5.9
// @author       Lormited
// @license      MIT
// @homepageURL  https://github.com/Lormited/XMU-TronClass-Helper
// @supportURL   https://github.com/Lormited/XMU-TronClass-Helper
// @updateURL    https://raw.githubusercontent.com/Lormited/XMU-TronClass-Helper/main/XMU-TronClass-Helper.user.js
// @downloadURL  https://raw.githubusercontent.com/Lormited/XMU-TronClass-Helper/main/XMU-TronClass-Helper.user.js
// @description  XMU 厦大畅课助手：资料下载 / 签到列表 / 界面精简 / 顶栏精简 / 校徽回主页 / 页面自适应 / 课程栏优化 / 待办排序
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
  const FIT_W = 1440;         // 自适应设计基准宽
  const FIT_H = 860;          // 自适应设计基准高
  const FIT_MIN = 0.7;        // 自适应下限
  const FIT_MAX = 1.6;        // 自适应上限（>1 即放大）
  const POLL = 1300;          // 轮询间隔(ms)：等 SPA 渲染 / 抵抗重渲染

  // ─── 基础 ──────────────────────────────────────────────────
  // 默认只开「资料下载」和「界面精简」，其余都要用户自己按需打开：
  //   签到列表   —— 会把首页「常用入口」整块替换掉
  //   顶栏精简   —— 会隐藏顶栏上的入口
  //   校徽回主页 —— 改掉校徽原本的去向
  //   页面自适应 —— 会缩放整个首页并禁止整页滚动
  //   课程栏优化 —— 会接管课程栏的点击与滚轮
  //   显示签到码 —— 每个数字签到都要额外请求一次详情接口
  const DEFAULTS = {
    feat_download: true, feat_signin: false, feat_chrome: true,
    feat_topbar: false, feat_homelogo: false, feat_fit: false, feat_coursebar: false,
    feat_todo: true,
    // 界面精简的四个子项
    chrome_sidebar: true, chrome_footer: true, chrome_ai: true, chrome_scrollbar: true,
    signin_code: false,
  };

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
  // 版本号取自脚本头部的 @version，省得面板里再抄一遍、两边对不上
  const VERSION = (typeof GM_info !== 'undefined' && GM_info.script && GM_info.script.version);

  function style(id, css) {
    if (document.getElementById(id)) return;
    document.documentElement.appendChild(
      Object.assign(document.createElement('style'), { id, textContent: css })
    );
  }

  // 反复执行：等 SPA 渲染出来并抵抗重渲染。定时器统一由 loop 管，模块不用自己记。
  function loop() {
    const ids = [];
    return {
      start(fn) { fn(); ids.push(setInterval(fn, POLL)); },
      stop() { ids.forEach(clearInterval); ids.length = 0; },
    };
  }

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

  const modules = {};
  const featKey = (m) => 'feat_' + m.id;

  // ─── 1. 资料下载（课程页） ────────────────────────────────────────
  const DL_TYPES = ['document', 'file'];

  // 下载地址在 c-media.xmu.edu.cn，与页面不同源。两个坑：
  //   1. GM_download 对跨域地址需要 @connect 授权，否则直接被拦；
  //   2. 它是异步的——失败只走 onerror 回调，不会抛异常。
  // 所以不能「调用完就记成功」（那会得到假的完成进度），要等回调；失败再退回自己取 blob。
  function fallbackDownload(url, name) {
    return fetch(url)
      .then((r) => r.blob())
      .then((blob) => {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = name;
        document.documentElement.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 60000);
        return true;
      })
      .catch(() => false);
  }

  function saveFile(url, name) {
    return new Promise((resolve) => {
      if (typeof GM_download !== 'function') return resolve(fallbackDownload(url, name));
      try {
        GM_download({
          url, name, saveAs: false,
          onload: () => resolve(true),
          onerror: () => resolve(fallbackDownload(url, name)),
        });
      } catch (e) { resolve(fallbackDownload(url, name)); }
    });
  }

  modules.download = {
    id: 'download', name: '资料下载', desc: '课程页右下角一键下载本课资料',

    init() {
      if (!courseId()) return;
      style('xmu-dl', `
        .xmu-fab{position:fixed;right:18px;bottom:18px;z-index:2147483600;height:36px;padding:0 18px;border:none;border-radius:3px;background:#003c88;color:#fff;font-size:14px;line-height:1;cursor:pointer;font-family:inherit;box-shadow:0 2px 10px rgba(0,60,136,.28);}
        /* 站点有通用的 button:focus / button:hover 规则，权重 (0,1,1) 高过 .xmu-fab 的 (0,1,0)，
           而按钮点完焦点不会消失，于是它会一直保持站点那套配色（灰底 + 深灰字）。
           显式声明聚焦/悬停态把 background 和 color 一起钉住——只钉 background 会留下深灰字压在蓝底上。
           注意顺序：:focus 要写在 :hover 之前，否则悬停的深蓝会被聚焦色盖掉。 */
        .xmu-fab:focus{background:#003c88;color:#fff;}
        .xmu-fab:hover{background:#092666;color:#fff;}
        .xmu-fab:focus-visible{outline:2px solid #fff;outline-offset:-4px;}
        .xmu-panel{position:fixed;right:18px;bottom:66px;z-index:2147483600;width:360px;max-width:calc(100vw - 36px);background:#fff;border:1px solid #d8d8d8;border-radius:4px;box-shadow:0 10px 40px rgba(0,0,0,.16);display:none;overflow:hidden;color:#333;font-family:inherit;}
        /* 内部一律用 xmu-dl- 前缀：bar / row / list / nm 这些名字站点自己也在用，
           叫 .bar 会把它的黄色底之类的全局样式引进来（实测踩过） */
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
      this.running = false;              // 下载中关掉模块，重开时按钮不能还卡在「下载中」
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
      try {
        const j = await api(`/api/courses/${courseId()}/activities?sub_course_id=0`);
        const seen = new Set();
        (j.activities || []).forEach((act) => (act.uploads || []).forEach((u) => {
          if (u.deleted || !u.id || seen.has(u.id)) return;      // 已删除 / 重复的跳过
          if (!DL_TYPES.includes(u.type)) return;
          seen.add(u.id);
          this.files.push({ id: u.id, name: u.name || `document-${u.id}`, size: u.size, checked: false });
        }));
      } catch (e) { }

      if (!this.files.length) {
        $('.xmu-dl-list', this.panel).innerHTML = '<div class="xmu-dl-empty">没有可下载的资料</div>';
        $('.xmu-dl-count', this.panel).textContent = '';
        btn.textContent = '无资料';
        return;
      }
      this.render();
    },

    render() {
      if (!this.panel) return;           // 关模块后 pending 的「5 秒恢复」定时器还会调进来
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
        let url = null;
        try { url = (await api(`/api/uploads/${f.id}/download-url-for-ai`)).url || null; } catch (e) { }
        if (url && await saveFile(url, cleanName(f.name))) ok++; else fail++;
        await sleep(400);                       // 别把请求打太密
      }
      this.running = false;
      // 完成信息先占位 5 秒，再由 render 还原成常规文案（按钮文案始终由 render 收尾）
      this.render();
      btn.textContent = `完成：成功 ${ok}${fail ? '，失败 ' + fail : ''}`;
      setTimeout(() => this.render(), 5000);
    },
  };

  // ─── 2. 签到列表（替换首页「常用入口」） ─────────────────────────────────
  const ROLLCALL_TYPE = {
    number: '数字点名', qr: '二维码点名', manual: '手动点名',
    radar: '雷达点名', selfRegistration: '自主签到', roomis: 'ROOMIS',
  };

  const LIST_URL = 'https://c-mobile.xmu.edu.cn/ongoing-rollcall-list';

  // 雷达接口的字段名和页面上看到的不一样：课程名是 course_title，
  // 点名方式也不能直接读 type（数字点名那里 type 是 'another'），要看 is_number / is_radar / source。
  function rollcallType(r) {
    if (r.is_number) return '数字点名';
    if (r.is_radar) return '雷达点名';
    return ROLLCALL_TYPE[String(r.source || r.type || '').replace(/_rollcall$/, '')] || '点名';
  }

  // 点条目直接进答题页。数字点名的路径是 course/{course_id}/number-rollcall/{rollcall_id}/answer，
  // 其它类型暂时回落到通用列表——路径规则没验证过，不猜。
  function rollcallUrl(r) {
    if (r.is_number && r.course_id && r.rollcall_id)
      return `https://c-mobile.xmu.edu.cn/course/${r.course_id}/number-rollcall/${r.rollcall_id}/answer`;
    return LIST_URL;
  }

  // 签到码在 /api/rollcall/{id}/student_rollcalls 的 number_code 里，id 直接取自签到条目
  const RC_CACHE = {};

  async function signinCodeOf(r) {
    const id = r.rollcall_id;
    if (!id) return null;
    if (id in RC_CACHE) return RC_CACHE[id];
    try {
      const j = await api(`/api/rollcall/${id}/student_rollcalls`);
      RC_CACHE[id] = j && j.is_number ? (j.number_code || null) : null;
    } catch (e) { RC_CACHE[id] = null; }
    return RC_CACHE[id];
  }

  modules.signin = {
    id: 'signin', name: '签到列表', desc: '首页「常用入口」替换为「正在签到」',

    init() {
      if (!isHome()) return;
      style('xmu-sc', `
        /* 行间留白：悬停的蓝色块靠这个间距够不着上一行底部的线（与页面待办列表一致） */
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
        /* 圆形箭头 / 完成图标，用页面同款图标字体 */
        .xmu-sc-go{flex-shrink:0;width:24px;height:36px;line-height:36px;text-align:center;font-size:24px;color:var(--primary-brand-color);}
        /* 图标字体的墨迹不在字身框正中（实测偏上 3px），这里把墨迹校正到行中心 */
        .xmu-sc-go i{position:relative;top:3px;}
        .xmu-sc-go.done{color:#1a9c57;}
      `);
      this.poller = loop();
      this.poller.start(() => this.mount());
      this.poller.start(() => this.load());
    },

    destroy() {
      this.poller.stop();
      if (this.card && this.orig !== null) { this.card.innerHTML = this.orig; delete this.card.dataset.xmuSignin; }
      this.card = this.orig = null;
    },

    // 把首页卡片改造成「正在签到」。只接管一次：mount 也在轮询里，
    // 每次重建会换掉鼠标底下的 DOM，悬停就会闪。
    mount() {
      if (!isHome()) return;
      const card = $$('.frequent-entries').find((c) => $('.frequent-entry-header', c) && $('.frequent-entry-list-wrapper', c));
      if (!card) return;
      if (this.card === card && card.dataset.xmuSignin) return;

      if (this.orig === null) this.orig = card.innerHTML;      // 只存一次，供关闭时还原
      this.card = card;
      card.dataset.xmuSignin = '1';
      $('.frequent-entry-header .title', card).textContent = '正在签到';
      $('.frequent-entry-header .options', card)?.remove();
      $('.frequent-entry-list-wrapper', card).innerHTML = '<div class="xmu-sc-body"></div>';
      this.render();
    },

    async load() {
      let next;
      try { next = (await api('/api/radar/rollcalls?api_version=1.1.0')).rollcalls || []; } catch (e) { return; }
      // 数据没变就不重绘，否则轮询会不断换掉鼠标底下的 DOM
      const sig = JSON.stringify(next);
      if (sig === this.sig) return;
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
        const course = r.course_title || r.course_name || r.course?.name || '课程';
        const type = rollcallType(r);
        // 已签到要看 status。student_status 即使已签到也仍是 on_call，不能用
        const signed = /fine|late|present|signed/.test(String(r.status || r.rollcall_status || ''));

        const item = document.createElement('div');
        item.className = 'xmu-sc-item';
        item.innerHTML = `<div class="xmu-sc-main"><div class="xmu-sc-course"></div><div class="xmu-sc-meta"></div></div><span class="xmu-sc-code"></span><span class="xmu-sc-go"></span>`;
        $('.xmu-sc-course', item).textContent = course;
        $('.xmu-sc-meta', item).textContent = type;

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
      if (!store.get('signin_code') || !r.rollcall_id) return;
      const box = $('.xmu-sc-code', item);
      if (!box) return;
      const paint = (c) => { box.textContent = c; box.classList.add('on'); };
      if (r.rollcall_id in RC_CACHE) {
        if (RC_CACHE[r.rollcall_id]) paint(RC_CACHE[r.rollcall_id]);
        return;
      }
      signinCodeOf(r).then((code) => { if (code && box.isConnected) paint(code); });
    },

    apply() { this.render(); },
    tags: () => [['signin_code', '显示签到码']],
  };

  // ─── 3. 界面精简 ─────────────────────────────────────────────
  // [配置键, 标签名, 选择器]
  const CHROME_HIDE = [
    ['chrome_sidebar', '侧栏', 'aside.new-user-index-sidebar, .course-menu-container'],
    ['chrome_footer', '底栏', '.footer'],
    ['chrome_ai', 'AI 助手', 'air-chatbot-app'],
  ];
  // 滚动条靠 CSS 类控制，没有选择器，所以只参与标签列表
  const CHROME_TAGS = [...CHROME_HIDE.map(([k, l]) => [k, l]), ['chrome_scrollbar', '滚动条']];

  modules.chrome = {
    id: 'chrome', name: '界面精简', desc: '隐藏侧栏 / 底栏 / AI 助手 / 滚动条',

    tags: () => CHROME_TAGS,

    init() {
      style('xmu-chrome', `
        html.xmu-no-sb::-webkit-scrollbar,html.xmu-no-sb ::-webkit-scrollbar{width:0!important;height:0!important;display:none!important;}
        html.xmu-no-sb,html.xmu-no-sb *{scrollbar-width:none!important;}
      `);
      this.poller = loop();
      this.poller.start(() => this.apply());
    },

    destroy() {
      this.poller.stop();
      document.documentElement.classList.remove('xmu-no-sb');
      document.getElementById('xmu-chrome')?.remove();
      $$('[data-xmu-hidden]').forEach((el) => { el.style.display = ''; delete el.dataset.xmuHidden; });
    },

    apply() {
      document.documentElement.classList.toggle('xmu-no-sb', !!store.get('chrome_scrollbar'));
      CHROME_HIDE.forEach(([key, , sel]) => {
        const hide = !!store.get(key);
        $$(sel).forEach((el) => {
          if (hide) {
            // 本站本来就藏着的元素不要打标记，否则关掉功能时会被我们弄出来
            if (el.style.display !== 'none') { el.dataset.xmuHidden = '1'; el.style.display = 'none'; }
          } else if (el.dataset.xmuHidden) {
            el.style.display = ''; delete el.dataset.xmuHidden;
          }
        });
      });
    },
  };

  // ─── 4. 顶栏精简（按「入口」聚合，逐项开关） ───────────────────────────────
  const TOPBAR_ROOT = '.header';
  // 这些标签本身就是一个整体，不再往里拆（避免拆成一堆 path）
  const TOPBAR_ATOM = /^(IMG|SVG|USE|PATH|CANVAS|VIDEO|IFRAME|INPUT|TEXTAREA|SELECT)$/;
  // 折叠菜单的入口（「更多」）和它里面的下拉列表，不单独给开关
  const TOPBAR_SKIP = /(^|\s)(autocollapse-more|autocollapse-container|dropdown-list)(\s|$)/;
  // 两条分隔栏自身没有文字，但要能单独关
  const TOPBAR_RULE = 'header-vertical-split-line';
  // 这个入口要拆成「校徽」和「课程中心」两个开关
  const TOPBAR_SPLIT = 'logo-padding';
  // 角标上的数字不算「名字」
  const TOPBAR_BADGE = '.count-wrapper, .count, .badge, .num, .unread';

  // class / 图标名 -> 看得懂的名字
  const TOPBAR_NAMES = {
    'application-center': '应用中心', 'school-name': '课程中心', logo: '校徽',
    'public-course': 'AI课程', 'text-title': '日历', notifications: '通知',
    manual: '帮助', 'profile-item': '账号信息', 'header-vertical-split-line': '分隔栏',
    'font-header-calendar': '日历', 'font-header-help': '帮助', 'font-notification': '通知',
  };

  // 已隐藏的仍算「在场」，否则关掉之后它就再也找不到、没法重新打开
  function topbarVisible(el) {
    if (el.hasAttribute('data-xmu-topbar')) return true;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  // 去掉角标数字后的文字（角标不该成为「名字」）
  function topbarText(el) {
    if (!el.querySelector(TOPBAR_BADGE)) return (el.textContent || '').trim().replace(/\s+/g, ' ');
    const c = el.cloneNode(true);
    c.querySelectorAll(TOPBAR_BADGE).forEach((n) => n.remove());
    return (c.textContent || '').trim().replace(/\s+/g, ' ');
  }

  // 名字优先级：title/aria > 自身 class > 自身图标名 > 文字 > 祖先 class > 兜底。
  // 别调顺序：自身 class 在文字前，「账号信息」才盖得住里面的用户名；
  // 文字在祖先前，否则往上会撞到 .layout-row 里的校徽 <img>，「资源库」会被认成「校徽」。
  function topbarName(el) {
    const aria = (el.getAttribute('title') || el.getAttribute('aria-label') || '').trim();
    if (aria) return aria.slice(0, 12);

    const classesOf = (n) => String(n.getAttribute('class') || '').split(/\s+/);
    const nameOf = (n) => { const c = n && classesOf(n).find((x) => TOPBAR_NAMES[x]); return c && TOPBAR_NAMES[c]; };

    const own = nameOf(el) || nameOf($('i[class], img, svg use', el));   // 自身 class / 图标名
    if (own) return own;

    const txt = topbarText(el);
    if (txt) return txt.slice(0, 12);

    let node = el.parentElement, d = 0;
    while (node && d++ < 4) {                                            // 近几层祖先的 class
      const hit = nameOf(node);
      if (hit) return hit;
      node = node.parentElement;
    }

    const cls = classesOf(el).find((c) => c && !/^(ng-|xmu-)/.test(c));
    return (cls || el.tagName.toLowerCase()).slice(0, 12);
  }

  // 配置键用结构签名而非数组下标，这样角标消失、折叠状态改变时不会张冠李戴。
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

  // 某项关掉后父级缩成 0 宽，但自带的 margin-left 还在，连着关几项就攒出空白。
  // 把这些「空壳」父级一并收掉。
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
    id: 'topbar', name: '顶栏精简', desc: '选择隐藏顶栏上的元素',

    init() {
      this.poller = loop();
      this.poller.start(() => this.apply());
    },

    destroy() {
      this.poller.stop();
      $$('[data-xmu-topbar]').forEach((el) => { el.style.display = ''; el.removeAttribute('data-xmu-topbar'); });
      $$('[data-xmu-shell]').forEach((el) => { el.style.display = ''; el.removeAttribute('data-xmu-shell'); });
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

      // 不能用「可见」剪枝：某项关掉后父容器会缩成 0，剪枝就再也走不进来，
      // 那个开关会从面板上消失、没法重新打开。「可见」只在判断要不要成为开关时看。
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

        // 入口：<a>，或自带 role=button。整体一个开关，不再往里拆
        if (el.tagName === 'A' || el.getAttribute('role') === 'button') {
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

      // 重名的（两条分隔栏）加序号。要先把总数点完再改：边数边改的话，
      // 第一个改名之后第二个就数不出自己还有同名兄弟了。
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
      // 先放开上一轮收掉的空壳再重新判断，避免空壳越收越多
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

  // ─── 5. 校徽回主页 ──────────────────────────────────────────
  // 站点把左上角校徽链到了数字化教学平台（经统一身份认证跳转），点一下要走一遍登录。
  // 这里直接把 href 换掉，而不是拦点击：新标签打开、悬停看地址这些链接语义都还在，
  // 关掉功能时再把原地址还原回去。
  const HOME_URL = 'https://lnt.xmu.edu.cn/user/index#/';

  modules.homelogo = {
    id: 'homelogo', name: '校徽回主页', desc: '点击左上角校徽改为回到首页',

    init() {
      this.poller = loop();
      this.poller.start(() => this.bind());
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

  // ─── 6. 页面自适应（按屏幕比例缩放，仅首页） ───────────────────────────────
  // 放行规则：向上找最近一个「真正」的滚动容器；若某层内部还嵌着别的滚动容器，
  // 说明它只是外层包裹（例如待办卡片包着作业列表），跳过它，滚轮交给里面那层。
  const isScroller = (el) => {
    const cs = getComputedStyle(el);
    return (cs.overflowY === 'auto' || cs.overflowY === 'scroll') && el.scrollHeight > el.clientHeight + 1;
  };

  // 限深限量地看一眼这层里面有没有别的纵向滚动容器
  function hasNestedScroller(el) {
    const q = [...el.children].map((c) => [c, 1]);
    let budget = 80;
    while (q.length && budget-- > 0) {
      const [n, d] = q.shift();
      const cs = getComputedStyle(n);
      if (cs.overflowY === 'auto' || cs.overflowY === 'scroll') return true;
      if (d < 3) [...n.children].forEach((c) => q.push([c, d + 1]));
    }
    return false;
  }

  function wheelScroller(target) {
    if (!(target instanceof Element)) return null;
    let el = target;
    while (el && el !== document.documentElement) {
      if (isScroller(el) && !hasNestedScroller(el)) return el;
      el = el.parentElement;
    }
    return null;
  }

  modules.fit = {
    id: 'fit', name: '页面自适应', desc: '按屏幕比例整体缩放首页，一屏显示更多',

    init() {
      style('xmu-fit', 'html.xmu-fit-on,html.xmu-fit-on body{overflow:hidden!important;}');

      // 拦截整页滚轮，真正能滚的区域放行。开着才挂，不在事件里反复读开关。
      this.onWheel = (e) => {
        if (!isHome() || Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
        if (wheelScroller(e.target)) return;
        e.preventDefault();
      };
      window.addEventListener('wheel', this.onWheel, { passive: false, capture: true });

      this.poller = loop();
      this.poller.start(() => this.apply());
    },

    destroy() {
      this.poller.stop();
      window.removeEventListener('wheel', this.onWheel, { capture: true });
      document.documentElement.classList.remove('xmu-fit-on');
      document.getElementById('xmu-fit')?.remove();
      this.reset();
    },

    reset() {
      const el = $('.main-content');
      if (el) ['zoom', 'width', 'height'].forEach((p) => el.style.removeProperty(p));
    },

    apply() {
      const home = isHome();
      document.documentElement.classList.toggle('xmu-fit-on', home);
      const el = $('.main-content');
      if (!el) return;
      if (!home) return this.reset();                    // 非首页还原，其他页面正常滚动

      const h = window.innerHeight - ($('.header')?.offsetHeight || 0);
      const zoom = clamp(Math.min((window.innerWidth - 1) / FIT_W, (h - 1) / FIT_H), FIT_MIN, FIT_MAX);
      el.style.zoom = zoom;
      el.style.width = window.innerWidth / zoom + 'px';
      el.style.height = h / zoom + 'px';
    },
  };

  // ─── 7. 课程栏优化 ────────────────────────────────────────────
  modules.coursebar = {
    id: 'coursebar', name: '课程栏优化', desc: '课程栏支持滚轮横向滑动，并优化翻页效果',

    init() {
      if (!isHome()) return;
      this.poller = loop();
      this.poller.start(() => this.bind());
    },

    destroy() { this.poller?.stop(); },

    bind() {
      const c = $('.courses-container');
      if (!c) return;
      const max = () => c.scrollWidth - c.clientWidth;

      [['.nav-arrow.right', 1], ['.nav-arrow.left', -1]].forEach(([sel, dir]) => {
        const btn = $(sel);
        if (!btn || btn.dataset.xmuPage) return;
        btn.dataset.xmuPage = '1';
        btn.addEventListener('click', (e) => {
          e.stopImmediatePropagation(); e.preventDefault();
          this.animate(c, clamp(c.scrollLeft + dir * c.clientWidth * COURSE_STEP, 0, max()));
        }, true);
      });

      if (!c.dataset.xmuWheel) {
        c.dataset.xmuWheel = '1';
        c.addEventListener('wheel', (e) => {
          if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
          e.preventDefault();
          const base = this.wheelTo ?? c.scrollLeft;
          this.wheelTo = clamp(base + e.deltaY * WHEEL_STEP, 0, max());
          this.animate(c, this.wheelTo);
        }, { passive: false });
      }
      this.syncArrows(c);
    },

    animate(c, target) {
      smoothScroll(c, target);
      setTimeout(() => this.syncArrows(c), COURSE_DUR + 20);
    },

    // 站点因为点击被拦截不再更新按钮状态，改由自己维护
    syncArrows(c) {
      $('.nav-arrow.left')?.classList.toggle('disabled', c.scrollLeft <= 2);
      $('.nav-arrow.right')?.classList.toggle('disabled', c.scrollLeft >= c.scrollWidth - c.clientWidth - 2);
    },
  };

  // ─── 8. 待办排序 ──────────────────────────────────────────
  // 首页「待办」里的作业按截止时间升序排（最近到期的排最前）。
  // 站点只按发布顺序排，不按截止时间。
  const DUE_RE = /(\d{4})\.(\d{1,2})\.(\d{1,2})\s+(\d{1,2}):(\d{2})/;

  function todoDue(item) {
    const m = ($('.todo-datetime', item)?.textContent || '').match(DUE_RE);
    return m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]).getTime() : Infinity;
  }

  modules.todo = {
    id: 'todo', name: '待办排序', desc: '首页待办按截止时间升序排列',

    init() {
      if (!isHome()) return;
      this.poller = loop();
      this.poller.start(() => this.sort());
    },

    destroy() { this.poller.stop(); },

    sort() {
      const box = $('.todo-list-container');
      if (!box) return;
      const items = $$('.todo-item', box);
      if (items.length < 2) return;

      // 已经按这个顺序排过就跳过：每次轮询都搬 DOM 会把悬停、选中状态搅乱
      const key = (i) => ($('.todo-title', i)?.textContent || '') + '|' + ($('.todo-datetime', i)?.textContent || '');
      const sig = items.map(key).join('##');
      if (sig === this.sig) return;
      this.sig = sig;

      items.slice().sort((a, b) => todoDue(a) - todoDue(b)).forEach((i) => box.appendChild(i));
    },
  };

  // ─── 设置面板 ────────────────────────────────────────────────
  const MODULES = Object.values(modules);

  const settings = {
    init() {
      style('xmu-set', `
        .xmu-set-btn{position:fixed;right:0;top:50%;transform:translateY(-50%);z-index:2147483647;width:26px;height:48px;padding:0;border:none;border-radius:8px 0 0 8px;cursor:pointer;background:#fff;box-shadow:-2px 0 10px rgba(0,0,0,.10);opacity:.35;transition:all .2s ease;display:flex;align-items:center;justify-content:center;}
        .xmu-set-btn:focus{background:#fff;}  /* 同上：站点 button:focus 会把它压成灰色 */
        .xmu-set-btn:hover{opacity:1;width:32px;}
        .xmu-set-btn svg{width:15px;height:15px;color:#6b7280;transition:all .2s ease;}
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

    // 子选项读写：模块可以自己提供（顶栏把整份配置存成一个 JSON），否则用扁平键
    tagOn(m, key) { return m.tagOn ? m.tagOn(key) : !!store.get(key); },
    tagToggle(m, key) { m.tagToggle ? m.tagToggle(key) : store.set(key, !store.get(key)); },

    // 挂在模块下方的小标签，排不下自动换行
    buildTags(m, tags) {
      const wrap = document.createElement('div');
      wrap.className = 'xmu-set-tags';
      tags.forEach(([key, label]) => {
        const tag = document.createElement('span');
        tag.className = 'xmu-tag' + (this.tagOn(m, key) ? ' on' : '');
        tag.textContent = label;
        tag.onclick = () => { this.tagToggle(m, key); m.apply(); this.refresh(); };
        wrap.appendChild(tag);
      });
      return wrap;
    },
  };

  // ─── 启动 ──────────────────────────────────────────────────
  MODULES.forEach((m) => { if (store.get(featKey(m))) m.init(); });
  settings.init();
})();
