(function (global) {
  'use strict';

  // 敌方经济档位的配色。空字符串（数据不全 / 还在等数据）走灰色。
  //
  // 这几个颜色会一路设到 CSS 变量 --tier-color 上，直接变成大标题的字色。
  // 界面是 Win7 Aero（浅蓝玻璃底），所以这里取的是"深色版"——
  // 深色主题时代那套亮色（#3ecf8e 之类）放到浅玻璃上基本看不见。
  var TIER_COLOR = {
    FULL_BUY: '#0b7a3c',
    HALF_BUY: '#0f5599',
    FORCE_BUY: '#8f5406',
    ECO: '#ad1d1d',
    PISTOL: '#5438b0',
    '': '#55748f'
  };

  // 对手经济推算的置信度。三档含义差别很大，别把 mid 也当成「确定」念出去。
  var EN_CONF = {
    high: '确定',
    mid: '推算',
    low: '数据不全'
  };

  function $(id) { return document.getElementById(id); }

  function money(v) {
    if (typeof v !== 'number' || !isFinite(v)) return '—';
    return '$' + Math.round(v).toLocaleString('en-US');
  }

  function setConn(on, text) {
    var el = $('conn');
    if (!el) return;
    el.className = 'conn' + (on ? ' on' : '');
    $('connText').textContent = text;
  }

  /**
   * 主渲染。
   *
   * 这一版只剩两件事：显示「我的状态」（原始数据，不是建议）和「敌方推演」。
   * 结论、置信度、推理链全部来自 lib/enemy.js —— 前端一个字都不重编，
   * 否则两边口径迟早会漂（这个坑在早期版本里踩过）。
   */
  function render(a) {
    if (!a) return;
    $('idle').classList.add('hidden');
    $('cols').classList.remove('hidden');
    $('adviceBox').classList.remove('hidden');

    var en = a.enemy || {};
    var showEn = !!en.available && !a.inWarmup;

    // ---- 大标题：直接就是对手的结论，整个工具只剩这一件事 ----
    var label, note, color;
    if (a.inWarmup) {
      label = a.notInMatchLabel || '非正式回合';
      note = '热身 / 死斗中，对手数据不参与判断。';
      color = TIER_COLOR[''];
    } else if (showEn) {
      label = '对面：' + (en.tierLabel || '不确定');
      note = en.verdict || '';
      color = TIER_COLOR[en.tier || ''] || '#0f5599';
    } else {
      label = '等待对手数据';
      note = (en.why && en.why[0]) || '还没拿到足够的回合信息。';
      color = TIER_COLOR[''];
    }
    document.documentElement.style.setProperty('--tier-color', color);
    $('tierLabel').textContent = label;
    $('tierNote').textContent = note;

    var sideName = a.side === 'CT' ? 'CT 防守方' : (a.side === 'T' ? 'T 进攻方' : '未定');
    $('roundMeta').textContent = (a.mapName ? a.mapName + ' · ' : '') +
      '第 ' + a.roundNum + ' 回合 · ' + sideName + ' · ' + a.phase;
    $('scoreMeta').innerHTML = 'CT <b>' + a.score.ct + '</b> : <b>' + a.score.t + '</b> T' +
      (a.bombPlanted ? ' · <b>包已下</b>' : '');

    // ---- 我的状态（原始数据）----
    $('myMoney').innerHTML = money(a.me.money) + (a.me.alive ? '' : '<small>已阵亡</small>');
    $('myGun').textContent = a.me.primary ? a.me.primaryName : '无';
    $('myGun').className = 'v ' + (a.me.primary ? 'on' : 'off');
    $('myArmor').textContent = a.me.armor > 0
      ? (a.me.helmet ? '全甲 +' + a.me.armor : '半甲 +' + a.me.armor)
      : '无';
    $('myArmor').className = 'v ' + (a.me.armor > 0 ? 'on' : 'off');
    $('myKit').textContent = a.side === 'CT' ? (a.me.defuseKit ? '有' : '无') : '—';
    $('myKit').className = 'v ' + (a.me.defuseKit ? 'on' : 'off');
    $('myLoss').textContent = a.myTeam.losses + ' 局';
    $('myNextLoss').textContent = money(a.myTeam.nextLossBonus);

    if ($('myNades')) {
      var g = a.me.grenades || {};
      var parts = [];
      if (g.smoke) parts.push('烟 x' + g.smoke);
      if (g.flash) parts.push('闪 x' + g.flash);
      if (g.fire) parts.push('火 x' + g.fire);
      if (g.he) parts.push('雷 x' + g.he);
      $('myNades').textContent = parts.length ? parts.join(' · ') : '无';
      $('myNades').className = 'v ' + (parts.length ? 'on' : 'off');
    }

    // ---- 敌方推演 ----
    $('enConf').textContent = showEn ? (EN_CONF[en.conf] || '—') : '—';
    $('enConf').className = 'pill' + (showEn ? ' conf-' + (en.conf || 'low') : '');

    $('enFoe').textContent = en.foe || '—';
    $('enTier').textContent = showEn ? (en.tierLabel || '—') : (a.inWarmup ? '不计' : '—');

    // 连败数优先用 streak（从比分重建的，不会像 GSI 的计数那样滞后一两帧）
    var enStreak = (typeof en.streak === 'number') ? en.streak : (en.losses || 0);
    $('enLoss').textContent = enStreak + ' 局';
    $('enIfLose').textContent = money(en.ifLoseNow);

    $('enRecord').textContent = (typeof en.halfWins === 'number')
      ? (en.halfWins + ' 胜 ' + en.halfLosses + ' 负')
      : '—';
    $('enIncome').textContent = (showEn && typeof en.income === 'number') ? money(en.income) : '—';
    $('enCeil').textContent = (showEn && typeof en.cashCeil === 'number') ? money(en.cashCeil) : '—';

    var verEl = $('enVerdict');
    if (showEn) {
      verEl.textContent = en.verdict || '—';
      verEl.className = 'enemy-verdict' + (en.conf === 'high' ? ' strong' : '');
    } else {
      verEl.textContent = a.inWarmup
        ? '热身 / 死斗中，对手数据不参与判断。'
        : ((en.why && en.why[0]) || '还没有可推的对手数据。');
      verEl.className = 'enemy-verdict';
    }

    var whyList = $('enWhyList');
    if (whyList) {
      whyList.innerHTML = '';
      (en.why || []).forEach(function (t) {
        var li = document.createElement('li');
        li.textContent = t;
        whyList.appendChild(li);
      });
    }

    // ---- 说明 ----
    var ul = $('adviceList');
    ul.innerHTML = '';
    (a.advice || []).forEach(function (t) {
      var li = document.createElement('li');
      if (t.indexOf('对手已连败') === 0 || t.indexOf('对手经济') === 0 ||
          t.indexOf('注意置信度') === 0) {
        li.className = 'warn';
      }
      li.textContent = t;
      ul.appendChild(li);
    });
  }

  global.BuyHelperUI = {
    render: render,
    setConn: setConn,
    money: money,
    TIER_COLOR: TIER_COLOR
  };
})(window);
