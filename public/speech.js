(function (global) {
  'use strict';

  /**
   * 语音播报（浏览器内置 TTS，零依赖）
   *
   * 两个必须知道的浏览器限制：
   *   1. 必须先有一次用户点击才允许发声 -> 所以用「开关按钮」来解锁，不做自动开启
   *   2. 中文语音包要系统里装了才有 -> 没装会退回默认嗓音（英文口音），界面会提示
   *
   * 播报时机：只在回合的购买倒计时（freezetime）里播一次，
   * 且同一回合 + 同一结论只念一遍，不会每 100ms 刷屏。
   *
   * 念什么：只念对手经济。买枪建议和战术规划都已移除，
   * 所以这里不再提「买哪把枪」「打哪个点」——
   * 结论文本一律取自 lib/enemy.js 给出的短句，前端不自己下判断。
   */

  var STORE_KEY = 'cs2bh.speech.v1';
  var MIN_GAP_MS = 3500;
  var TEST_TEXT = '语音播报已就绪。第 9 回合，进攻方。对面连败攒够钱了，这回合可能满买反扑。本回合再输，每人进账 2400 块。';

  var cfg = { enabled: false, rate: 1.05, volume: 1, voiceURI: '' };
  var lastAnnounceKey = '';
  var lastSpokenText = '';
  var lastSpokenAt = 0;
  var els = {};

  // ---------- 配置持久化 ----------
  function load() {
    try {
      var raw = global.localStorage.getItem(STORE_KEY);
      if (!raw) return;
      var s = JSON.parse(raw);
      if (!s || typeof s !== 'object') return;
      if (typeof s.enabled === 'boolean') cfg.enabled = s.enabled;
      if (typeof s.rate === 'number' && s.rate >= 0.5 && s.rate <= 2) cfg.rate = s.rate;
      if (typeof s.volume === 'number') cfg.volume = s.volume;
      if (typeof s.voiceURI === 'string') cfg.voiceURI = s.voiceURI;
    } catch (e) { /* 隐私模式下 localStorage 会抛错，忽略 */ }
  }

  function save() {
    try { global.localStorage.setItem(STORE_KEY, JSON.stringify(cfg)); } catch (e) {}
  }

  // ---------- 语音能力 ----------
  function supported() {
    return typeof global.speechSynthesis !== 'undefined' &&
      typeof global.SpeechSynthesisUtterance !== 'undefined';
  }

  function allVoices() {
    if (!supported()) return [];
    try { return global.speechSynthesis.getVoices() || []; } catch (e) { return []; }
  }

  function zhVoices() {
    return allVoices().filter(function (v) {
      var t = String(v.lang || '').toLowerCase().replace('_', '-');
      return t.indexOf('zh') === 0 || t.indexOf('cmn') === 0;
    });
  }

  function currentVoice() {
    var list = zhVoices();
    if (!list.length) return null;
    if (cfg.voiceURI) {
      for (var i = 0; i < list.length; i++) {
        if (list[i].voiceURI === cfg.voiceURI) return list[i];
      }
    }
    var PREFER = ['xiaoxiao', 'xiaoyi', 'huihui', 'yunxi', 'kangkang', 'yaoyao'];
    for (var p = 0; p < PREFER.length; p++) {
      for (var j = 0; j < list.length; j++) {
        if (String(list[j].name || '').toLowerCase().indexOf(PREFER[p]) !== -1) return list[j];
      }
    }
    return list[0];
  }

  // 用一条静音 utterance 把语音队列唤醒（首次点击时调）
  function unlock() {
    if (!supported()) return;
    try {
      var u = new global.SpeechSynthesisUtterance(' ');
      u.volume = 0;
      u.rate = 2;
      global.speechSynthesis.speak(u);
    } catch (e) {}
  }

  // ---------- 朗读 ----------
  function speak(text, opts) {
    opts = opts || {};
    if (!supported() || !text) return false;
    if (!cfg.enabled && !opts.force) return false;

    var now = Date.now();
    if (!opts.force) {
      if (text === lastSpokenText) return false;
      if (now - lastSpokenAt < MIN_GAP_MS) return false;
    }

    try {
      if (opts.cancel !== false) global.speechSynthesis.cancel();
      var u = new global.SpeechSynthesisUtterance(text);
      var v = currentVoice();
      if (v) {
        u.voice = v;
        u.lang = v.lang || 'zh-CN';
      } else {
        u.lang = 'zh-CN';
      }
      u.rate = cfg.rate;
      u.volume = cfg.volume;
      u.pitch = 1;
      global.speechSynthesis.speak(u);
      lastSpokenText = text;
      lastSpokenAt = now;
      return true;
    } catch (e) {
      return false;
    }
  }

  // ---------- 把分析结果编成一句人话 ----------
  /**
   * 现在只念对手经济。两个刻意的设计：
   *
   *   1. 结论不在这里编 —— 用 lib/enemy.js 给的短句（en.say）。
   *      那边同时算了置信度，前端各拼一套的话口径迟早会漂。
   *   2. 短句为空时**不猜**。en.say 为空只有一种情况：
   *      本半场胜负记录不全（conf = low，服务是中途启动的）。
   *      这时只敢说连败数，因为那个数直接来自 GSI，推不推得出来都精确。
   *
   * 早先的兜底只看「连败数是不是 0」，于是数据不全时会说出
   * 「对面经济正常，大概率完整购买」这种**毫无依据**的话 —— 比不说还糟。
   */
  function compose(a) {
    if (!a || !a.side || a.inWarmup) return '';
    var en = a.enemy;
    if (!en) return '';

    var streak = (typeof en.streak === 'number') ? en.streak : en.losses;

    var body = '';
    if (en.say) {
      body = String(en.say);
    } else if (typeof streak === 'number' && streak >= 2) {
      body = '对面连败 ' + streak + ' 局，提防强起和快攻。';
    }
    // 没把握就闭嘴 —— 播一句错的比不播更糟
    if (!body) return '';

    // 败方补偿是固定阶梯，所以「本回合再输他们能拿多少」是精确值，值得念出来
    var tail = '';
    if (typeof streak === 'number' && streak > 0 && typeof en.ifLoseNow === 'number') {
      tail = '本回合再输，每人进账 ' + en.ifLoseNow + ' 块。';
    }

    return '第 ' + a.roundNum + ' 回合，' +
      (a.side === 'CT' ? '防守方' : '进攻方') + '。' + body + tail;
  }

  /** 让调用方（overlay / preview）在每次收到数据时调它即可 */
  function maybeAnnounce(a) {
    if (!a || !a.side || !cfg.enabled) return false;
    // 热身 / 死斗 / 对局已结束：一个字都别念
    if (a.inWarmup) return false;

    // 只在购买倒计时里播。以前「包已经下了」时还会在 live 阶段喊回防，
    // 那是战术模块的功能，现在没有要喊的东西了。
    if (a.phase !== 'freezetime') return false;

    var en = a.enemy || {};
    // 同一回合 + 同一结论只念一遍。
    // 对手推算结果进 key 是有意的：购买时间里如果比分快照晚到、结论变了，
    // 就应该重念一次 —— 反正 speak() 里还有 3.5 秒最小间隔挡着，不会刷屏。
    var key = a.roundNum + '|' + a.side + '|' + (en.conf || '-') + '|' +
      (en.tier || '-') + '|' + ((typeof en.streak === 'number') ? en.streak : '-');
    if (key === lastAnnounceKey) return false;

    if (speak(compose(a))) {
      lastAnnounceKey = key;
      return true;
    }
    return false;
  }

  // ---------- 界面挂载 ----------
  function renderUI() {
    if (!els.toggle) return;

    if (!supported()) {
      els.toggle.disabled = true;
      els.toggle.textContent = '语音播报：不支持';
      if (els.note) els.note.textContent = '当前浏览器没有语音合成接口，换 Chrome 或 Edge 即可。';
      return;
    }

    els.toggle.textContent = '语音播报：' + (cfg.enabled ? '开' : '关');
    els.toggle.className = 'sp-btn' + (cfg.enabled ? ' on' : '');

    var list = zhVoices();

    if (els.voice) {
      var sig = list.map(function (v) { return v.voiceURI; }).join(',');
      if (els.voice.getAttribute('data-sig') !== sig) {
        els.voice.setAttribute('data-sig', sig);
        els.voice.innerHTML = '';
        if (!list.length) {
          var o = document.createElement('option');
          o.value = '';
          o.textContent = '未检测到中文语音';
          els.voice.appendChild(o);
        } else {
          list.forEach(function (v) {
            var op = document.createElement('option');
            op.value = v.voiceURI;
            op.textContent = v.name;
            els.voice.appendChild(op);
          });
          var cur = currentVoice();
          if (cur) els.voice.value = cur.voiceURI;
        }
      }
    }

    if (els.rateVal) els.rateVal.textContent = cfg.rate.toFixed(2).replace(/\.?0+$/, '') + 'x';

    if (els.note) {
      if (!list.length) {
        els.note.textContent = '没检测到中文语音包，读出来会是英文口音。' +
          'Windows：设置 → 时间和语言 → 语音 → 添加“中文(简体)”语音。';
      } else if (cfg.enabled) {
        els.note.textContent = '每回合购买时间自动播报一次。';
      } else {
        els.note.textContent = '浏览器要求先有一次点击才允许发声，点左边开关即可。';
      }
    }
  }

  function mount() {
    els.toggle = document.getElementById('spToggle');
    if (!els.toggle) return;
    els.voice = document.getElementById('spVoice');
    els.rate = document.getElementById('spRate');
    els.rateVal = document.getElementById('spRateVal');
    els.test = document.getElementById('spTest');
    els.note = document.getElementById('spNote');

    els.toggle.onclick = function () {
      if (!supported()) return;
      cfg.enabled = !cfg.enabled;
      save();
      if (cfg.enabled) unlock();
      else { try { global.speechSynthesis.cancel(); } catch (e) {} }
      renderUI();
    };

    if (els.rate) {
      els.rate.value = String(cfg.rate);
      els.rate.oninput = function () {
        cfg.rate = Number(els.rate.value) || 1;
        save();
        renderUI();
      };
    }

    if (els.voice) {
      els.voice.onchange = function () {
        cfg.voiceURI = els.voice.value;
        save();
      };
    }

    if (els.test) {
      els.test.onclick = function () { speak(TEST_TEXT, { force: true }); };
    }

    if (supported() && typeof global.speechSynthesis.addEventListener === 'function') {
      global.speechSynthesis.addEventListener('voiceschanged', renderUI);
    }
    // 部分浏览器要等一会儿才吐语音列表
    setTimeout(renderUI, 400);
    renderUI();
  }

  load();

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount);
  } else {
    mount();
  }

  global.BuyHelperSpeech = {
    maybeAnnounce: maybeAnnounce,
    compose: compose,
    speak: speak,
    renderUI: renderUI,
    cfg: cfg,
    supported: supported,
    zhVoiceCount: function () { return zhVoices().length; }
  };
})(window);
