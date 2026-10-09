/* DataMind · 应用主逻辑 */
(function (global) {
  'use strict';

  var S = global.DAStore, A = global.DAAnalytics, L = global.DALLM, C = global.DACharts;
  var store = S.store;
  var $ = function (id) { return document.getElementById(id); };

  var state = { dataset: null, busy: false };

  /* ---------- 通用渲染 ---------- */
  function fmtCell(v, pctCol) {
    if (v == null) return '';
    if (v instanceof Date) return v.getFullYear() + '-' + String(v.getMonth() + 1).padStart(2, '0') + '-' + String(v.getDate()).padStart(2, '0');
    if (typeof v === 'number') {
      if (!isFinite(v)) return '-';
      if (pctCol) return (v > 0 ? '+' : '') + (v * 100).toFixed(2) + '%';
      return String(Math.round(v * 100) / 100);
    }
    return String(v);
  }
  function renderTable(wrap, table, opts) {
    opts = opts || {};
    if (!table || !table.rows || !table.rows.length) {
      wrap.innerHTML = '<p class="hint">暂无数据。</p>';
      return;
    }
    var labels = table.labels || {}, pctCols = table.pctCols || [];
    var cols = table.columns.filter(function (c) { return c !== '__value__' && c !== '__rule__'; });
    var html = '<table><thead><tr>';
    cols.forEach(function (c) {
      var isNum = table.rows.some(function (r) { return typeof r[c] === 'number'; });
      html += '<th class="' + (isNum ? 'num' : '') + '">' + esc(labels[c] || c) + '</th>';
    });
    html += '</tr></thead><tbody>';
    table.rows.slice(0, opts.limit || 200).forEach(function (r) {
      html += '<tr>';
      cols.forEach(function (c) {
        var isNum = typeof r[c] === 'number';
        var cls = (isNum ? 'num' : '') + ((c === '__dev__' && Math.abs(r[c]) > 2.5) || (c === '__type__' && r[c]) ? ' flag' : '');
        html += '<td class="' + cls + '">' + esc(fmtCell(r[c], pctCols.indexOf(c) >= 0)) + '</td>';
      });
      html += '</tr>';
    });
    html += '</tbody></table>';
    wrap.innerHTML = html;
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (m) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[m];
    });
  }

  /* ---------- 数据集 ---------- */
  function addDataset(ds, silent) {
    var ok = store.saveDataset(ds);
    if (!ok) alert('本地存储写入失败：数据集过大，已自动清理较旧数据集。建议减少行数后重试。');
    store.setActive(ds.id);
    refreshDatasets();
    selectDataset(ds.id);
    if (!silent) toast('已导入「' + ds.name + '」：' + ds.rows.length + ' 行 × ' + ds.columns.length + ' 列');
  }

  function refreshDatasets() {
    var all = store.listDatasets();
    var active = store.getActiveId();
    $('datasetCount').textContent = all.length;
    var box = $('datasetList');
    if (!all.length) { box.innerHTML = '<p class="hint">还没有数据集，先上传文件或载入示例数据。</p>'; return; }
    box.innerHTML = all.map(function (d) {
      return '<div class="ds-item' + (d.id === active ? ' active' : '') + '" data-id="' + d.id + '">' +
        '<div class="ds-name"><span>' + esc(d.name) + '</span><button class="ds-del" data-del="' + d.id + '" title="删除">✕</button></div>' +
        '<div class="ds-meta">' + d.rows.length + ' 行 · ' + d.columns.length + ' 列 · ' + new Date(d.createdAt).toLocaleDateString('zh-CN') + '</div>' +
        '</div>';
    }).join('');
    Array.prototype.forEach.call(box.querySelectorAll('.ds-item'), function (el) {
      el.addEventListener('click', function (e) {
        if (e.target.dataset.del) {
          if (!confirm('确认删除该数据集？此操作不可恢复。')) return;
          store.deleteDataset(e.target.dataset.del);
          refreshDatasets();
          var rest = store.listDatasets();
          if (rest.length) selectDataset(store.getActiveId() || rest[0].id); else clearDataset();
          return;
        }
        selectDataset(el.dataset.id);
      });
    });
  }

  function clearDataset() {
    state.dataset = null;
    $('chipDataset').textContent = '未选择数据集';
    $('chipDataset').classList.remove('on');
    $('chipRows').textContent = '0 行';
    $('schemaCard').hidden = true;
    $('previewWrap').innerHTML = '<p class="hint">导入数据后在此预览（最多 100 行）。</p>';
  }

  function selectDataset(id) {
    var ds = store.getDataset(id);
    if (!ds) { clearDataset(); return; }
    store.setActive(id);
    state.dataset = ds;
    $('chipDataset').textContent = ds.name;
    $('chipDataset').classList.add('on');
    $('chipRows').textContent = ds.rows.length + ' 行 · ' + ds.columns.length + ' 列';
    $('schemaCard').hidden = false;
    var typeName = { number: '数值', date: '日期', text: '文本' };
    $('schemaList').innerHTML = ds.columns.map(function (c) {
      return '<div class="schema-row"><span>' + esc(c) + '</span><span class="schema-type type-' + ds.types[c] + '">' + typeName[ds.types[c]] + '</span></div>';
    }).join('');
    renderTable($('previewWrap'), { columns: ds.columns, rows: ds.rows.slice(0, 100), labels: {} }, { limit: 100 });
    refreshDatasets();
    renderSuggest();
  }

  /* ---------- 建议问题 ---------- */
  function renderSuggest() {
    var ds = state.dataset;
    var grid = $('suggestGrid'), quick = $('quickRow');
    if (!ds) {
      grid.innerHTML = '<div class="suggest"><b>先导入数据</b><span>上传 CSV/Excel 或载入示例数据集</span></div>';
      quick.innerHTML = '';
      return;
    }
    var num = ds.columns.filter(function (c) { return ds.types[c] === 'number'; });
    var text = ds.columns.filter(function (c) { return ds.types[c] === 'text'; });
    var date = ds.columns.filter(function (c) { return ds.types[c] === 'date'; });
    var m = num[0] || '数量', t = text[0] || '类别';
    var items = [];
    if (date.length) items.push({ b: '趋势分析', s: '按月份看 ' + m + ' 的变化趋势' });
    items.push({ b: '异常识别', s: '找出 ' + m + ' 的异常值' });
    if (text.length) items.push({ b: '指标对比', s: '对比各' + t + '的' + m + '，看占比' });
    items.push({ b: 'Top 排行', s: m + ' 最高的前 10 个' + t });
    grid.innerHTML = items.map(function (i) {
      return '<div class="suggest" data-q="' + esc(i.s) + '"><b>' + esc(i.b) + '</b><span>' + esc(i.s) + '</span></div>';
    }).join('');
    Array.prototype.forEach.call(grid.querySelectorAll('.suggest'), function (el) {
      el.addEventListener('click', function () { $('question').value = el.dataset.q; ask(); });
    });
    quick.innerHTML = items.map(function (i) { return '<button class="quick" data-q="' + esc(i.s) + '">' + esc(i.b) + '</button>'; }).join('');
    Array.prototype.forEach.call(quick.querySelectorAll('.quick'), function (el) {
      el.addEventListener('click', function () { $('question').value = el.dataset.q; ask(); });
    });
  }

  /* ---------- 文件导入 ---------- */
  function handleFile(file) {
    var name = (file.name || '导入数据').replace(/\.(csv|tsv|txt|json|xlsx|xls)$/i, '');
    var ext = (file.name.split('.').pop() || '').toLowerCase();
    if (ext === 'xlsx' || ext === 'xls') {
      if (typeof global.XLSX === 'undefined') {
        toast('Excel 解析库未加载（离线环境），请另存为 CSV 后上传');
        return;
      }
      var fr = new FileReader();
      fr.onload = function (e) {
        try {
          var wb = global.XLSX.read(new Uint8Array(e.target.result), { type: 'array' });
          var sheet = wb.Sheets[wb.SheetNames[0]];
          var csv = global.XLSX.utils.sheet_to_csv(sheet);
          addDataset(S.parseText(csv, name));
        } catch (err) { toast('Excel 解析失败：' + err.message); }
      };
      fr.readAsArrayBuffer(file);
      return;
    }
    var fr2 = new FileReader();
    fr2.onload = function (e) {
      try { addDataset(S.parseText(String(e.target.result), name)); }
      catch (err) { toast('解析失败：' + err.message); }
    };
    fr2.readAsText(file, 'UTF-8');
  }

  /* ---------- 分析主流程 ---------- */
  function ask() {
    var ds = state.dataset;
    var q = ($('question').value || '').trim();
    if (!ds) { toast('请先导入数据集'); return; }
    if (!q) { toast('请输入你想分析的问题'); return; }
    if (state.busy) return;
    state.busy = true;
    $('btnAsk').disabled = true;
    $('emptyState').hidden = true;

    appendQuestion(q);
    $('question').value = '';
    var card = appendAnswer();
    setStatus('解析问题中…', 'busy');

    var summary = A.schemaSummary(ds);
    var useLLM = L.isConfigured();
    $('engineTag').textContent = '引擎：' + (useLLM ? '大模型规划 + 本地计算' : '本地规则');

    var planPromise = useLLM
      ? L.plan(q, summary).catch(function (err) {
          setStatus('模型规划失败（' + err.message + '），已降级为本地规则引擎', '');
          return A.rulePlan(q, ds);
        })
      : Promise.resolve(A.rulePlan(q, ds));

    planPromise.then(function (plan) {
      var result;
      try {
        result = A.executePlan(plan, ds);
      } catch (e) {
        try { result = A.executePlan(A.rulePlan(q, ds), ds); } catch (e2) { throw new Error('分析执行失败：' + e.message); }
      }
      if (!result || !result.insights || !result.insights.length) result = A.executePlan(A.rulePlan(q, ds), ds);
      result.question = q;
      result.engine = plan.source === 'llm' ? '大模型规划' : '本地规则';
      renderAnswer(card, result);

      if (useLLM) {
        setStatus('生成分析结论中…', 'busy');
        return L.insights(q, result, summary).then(function (arr) {
          if (arr && arr.length) {
            result.insights = arr;
            result.engine = '大模型规划 + 大模型结论';
            renderAnswer(card, result, true);
          }
          setStatus('分析完成', 'ok');
        }).catch(function (err) {
          setStatus('结论生成失败，已保留规则结论（' + err.message + '）', '');
        });
      }
      setStatus('分析完成', 'ok');
      return null;
    }).catch(function (err) {
      card.innerHTML = '<div class="ans-title">分析失败</div><p class="err">' + esc(err.message) + '</p>' +
        '<p class="hint">可尝试：换一种说法、检查字段名，或在右上角配置可用的大模型接口。</p>';
      setStatus('出错', '');
    }).then(function () {
      state.busy = false;
      $('btnAsk').disabled = false;
    });
  }

  function appendQuestion(q) {
    var el = document.createElement('div');
    el.className = 'msg msg-q';
    el.innerHTML = '<div class="bubble">' + esc(q) + '</div>';
    $('thread').appendChild(el);
    scrollDown();
  }

  function appendAnswer() {
    var el = document.createElement('div');
    el.className = 'msg msg-a';
    el.innerHTML = '<div class="ans-title">分析中…</div><p class="hint">正在解析意图并执行计算。</p>';
    $('thread').appendChild(el);
    scrollDown();
    return el;
  }

  var INTENT_NAME = { query: '数据查询', trend: '趋势分析', anomaly: '异常识别', compare: '指标对比', summary: '数据概览' };

  function renderAnswer(card, result, keepChart) {
    var kpis = (result.kpis || []).map(function (k) {
      var cls = k.trend == null ? '' : (k.trend > 0 ? 'up' : (k.trend < 0 ? 'down' : ''));
      return '<div class="kpi"><div class="k-label">' + esc(k.label) + '</div>' +
        '<div class="k-value ' + cls + '">' + esc(k.value) + '</div>' +
        (k.sub ? '<div class="k-sub">' + esc(k.sub) + '</div>' : '') + '</div>';
    }).join('');

    var insights = (result.insights || []).map(function (t) { return '<li>' + t + '</li>'; }).join('');

    card.innerHTML =
      '<div class="ans-head"><div><div class="ans-title">' + esc(result.title) + '</div>' +
      '<div class="hint">' + esc(result.subtitle || '') + '</div></div>' +
      '<div class="ans-badges"><span class="badge intent">' + (INTENT_NAME[result.intent] || '分析') + '</span>' +
      '<span class="badge">' + esc(result.engine || '') + '</span></div></div>' +
      (kpis ? '<div class="kpis">' + kpis + '</div>' : '') +
      '<div class="sec-label">分析结论</div><ul class="insights">' + insights + '</ul>' +
      '<div class="chart-box" data-chart="1"></div>' +
      '<div class="sec-label">明细数据</div><div class="table-wrap" data-table="1" style="max-height:280px"></div>' +
      '<div class="ans-foot">' +
      '<button class="btn sm" data-act="copy">复制分析摘要</button>' +
      '<button class="btn sm" data-act="csv">导出结果 CSV</button>' +
      '<button class="btn sm" data-act="detail">在右侧查看明细</button>' +
      '</div>';

    var chartEl = card.querySelector('[data-chart]');
    C.render(chartEl, result.chart);
    renderTable(card.querySelector('[data-table]'), result.table, { limit: 50 });

    card.querySelectorAll('[data-act]').forEach(function (b) {
      b.addEventListener('click', function () {
        var act = b.dataset.act;
        if (act === 'copy') copySummary(result, b);
        else if (act === 'csv') exportCSV(result);
        else if (act === 'detail') showDetail(result);
      });
    });
    scrollDown();
    store.pushHistory({ id: S.uid('h'), q: result.question, title: result.title, intent: result.intent, at: Date.now(), result: result });
    renderHistory();
  }

  function showDetail(result) {
    switchTab('result');
    $('resultDetail').innerHTML =
      '<div class="ans-title" style="font-size:14px">' + esc(result.title) + '</div>' +
      '<p class="hint">' + esc(result.subtitle || '') + '</p>' +
      '<div class="table-wrap" style="max-height:520px;margin-top:8px"></div>';
    renderTable($('resultDetail').querySelector('.table-wrap'), result.table, { limit: 200 });
  }

  function plainText(result) {
    var lines = ['【' + result.title + '】', result.subtitle || '', ''];
    lines.push('关键指标：');
    (result.kpis || []).forEach(function (k) { lines.push('· ' + k.label + '：' + k.value + (k.sub ? '（' + k.sub + '）' : '')); });
    lines.push('');
    lines.push('分析结论：');
    (result.insights || []).forEach(function (t, i) { lines.push((i + 1) + '. ' + String(t).replace(/<\/?b>/g, '')); });
    return lines.join('\n');
  }
  function copySummary(result, btn) {
    var txt = plainText(result);
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(txt).then(function () { btn.textContent = '已复制 ✓'; setTimeout(function () { btn.textContent = '复制分析摘要'; }, 1600); });
    } else {
      var ta = document.createElement('textarea'); ta.value = txt; document.body.appendChild(ta); ta.select();
      document.execCommand('copy'); document.body.removeChild(ta);
      btn.textContent = '已复制 ✓'; setTimeout(function () { btn.textContent = '复制分析摘要'; }, 1600);
    }
  }
  function exportCSV(result) {
    var csv = A.toCSV(result.table);
    var blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = (result.title || '分析结果').replace(/[\\/:*?"<>|]/g, '') + '.csv';
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
  }

  function renderHistory() {
    var all = store.listHistory();
    $('historyList').innerHTML = all.length ? all.map(function (h) {
      return '<div class="hist-item" data-id="' + h.id + '"><div class="hist-q">' + esc(h.q) + '</div>' +
        '<div class="hist-meta">' + (INTENT_NAME[h.intent] || '分析') + ' · ' + new Date(h.at).toLocaleString('zh-CN') + '</div></div>';
    }).join('') : '<p class="hint">还没有分析记录。</p>';
    Array.prototype.forEach.call($('historyList').querySelectorAll('.hist-item'), function (el) {
      el.addEventListener('click', function () {
        var h = store.listHistory().find(function (x) { return x.id === el.dataset.id; });
        if (!h) return;
        $('emptyState').hidden = true;
        appendQuestion(h.q);
        var card = appendAnswer();
        renderAnswer(card, h.result);
      });
    });
  }

  function setStatus(t, cls) {
    var el = $('statusTag');
    el.textContent = t;
    el.className = 'tag ' + (cls || 'muted');
  }
  function toast(msg) { setStatus(msg, ''); }
  function scrollDown() { var c = $('chatScroll'); c.scrollTop = c.scrollHeight; }
  function switchTab(name) {
    Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (t) {
      t.classList.toggle('active', t.dataset.tab === name);
    });
    ['preview', 'result', 'history'].forEach(function (n) {
      $('tab-' + n).classList.toggle('hidden', n !== name);
    });
  }

  /* ---------- 弹窗 ---------- */
  function openModal(id) { $(id).hidden = false; }
  function closeModal(id) { $(id).hidden = true; }

  /* ---------- 事件绑定 ---------- */
  function bind() {
    $('fileInput').addEventListener('change', function (e) {
      var f = e.target.files[0];
      if (f) handleFile(f);
      e.target.value = '';
    });
    $('btnPaste').addEventListener('click', function () { $('pasteErr').textContent = ''; openModal('pasteModal'); });
    $('btnSample').addEventListener('click', function () { addDataset(S.sampleSales()); });
    $('btnPasteSave').addEventListener('click', function () {
      var text = $('pasteText').value;
      var name = ($('pasteName').value || '粘贴数据').trim();
      try {
        var ds = S.parseText(text, name);
        closeModal('pasteModal');
        $('pasteText').value = ''; $('pasteName').value = '';
        addDataset(ds);
      } catch (err) { $('pasteErr').textContent = '导入失败：' + err.message; }
    });

    $('btnAsk').addEventListener('click', ask);
    $('question').addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey || !e.shiftKey)) { e.preventDefault(); ask(); }
    });

    Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (t) {
      t.addEventListener('click', function () { switchTab(t.dataset.tab); });
    });

    $('btnModel').addEventListener('click', function () {
      var c = store.getConfig();
      $('cfgBase').value = c.baseUrl || 'https://api.openai.com/v1';
      $('cfgKey').value = c.apiKey || '';
      $('cfgModel').value = c.model || 'gpt-4o-mini';
      $('cfgMsg').textContent = '';
      openModal('modelModal');
    });
    $('btnHelp').addEventListener('click', function () { openModal('helpModal'); });
    $('btnSaveCfg').addEventListener('click', function () {
      store.setConfig({
        baseUrl: ($('cfgBase').value || '').trim(),
        apiKey: ($('cfgKey').value || '').trim(),
        model: ($('cfgModel').value || '').trim()
      });
      $('cfgMsg').style.color = '#0f9960';
      $('cfgMsg').textContent = '已保存到本机。' + (L.isConfigured() ? '大模型已启用。' : '未填写 Key，继续使用本地规则引擎。');
      refreshModelChip();
      closeModal('modelModal');
    });
    $('btnTestCfg').addEventListener('click', function () {
      store.setConfig({
        baseUrl: ($('cfgBase').value || '').trim(),
        apiKey: ($('cfgKey').value || '').trim(),
        model: ($('cfgModel').value || '').trim()
      });
      $('cfgMsg').style.color = '#5b6675';
      $('cfgMsg').textContent = '测试中…';
      L.test().then(function (r) {
        $('cfgMsg').style.color = '#0f9960';
        $('cfgMsg').textContent = r.msg;
        refreshModelChip();
      }).catch(function (e) {
        $('cfgMsg').style.color = '#d93025';
        $('cfgMsg').textContent = '连接失败：' + e.message;
      });
    });
    $('btnClearCfg').addEventListener('click', function () {
      store.setConfig({ baseUrl: '', apiKey: '', model: '' });
      $('cfgBase').value = ''; $('cfgKey').value = ''; $('cfgModel').value = '';
      $('cfgMsg').style.color = '#5b6675';
      $('cfgMsg').textContent = '已清除模型配置，恢复本地规则引擎。';
      refreshModelChip();
    });

    Array.prototype.forEach.call(document.querySelectorAll('[data-close]'), function (el) {
      el.addEventListener('click', function () {
        Array.prototype.forEach.call(document.querySelectorAll('.modal'), function (m) { m.hidden = true; });
      });
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') Array.prototype.forEach.call(document.querySelectorAll('.modal'), function (m) { m.hidden = true; });
    });
    window.addEventListener('resize', function () {
      Array.prototype.forEach.call(document.querySelectorAll('.chart-box'), function (el) {
        if (global.echarts) { var i = global.echarts.getInstanceByDom(el); if (i) i.resize(); }
      });
    });
  }

  function refreshModelChip() {
    var c = store.getConfig();
    $('btnModel').textContent = '模型：' + (c.apiKey && c.model ? c.model : '未配置（本地规则）');
  }

  /* ---------- 启动 ---------- */
  function init() {
    bind();
    refreshModelChip();
    refreshDatasets();
    renderHistory();
    var all = store.listDatasets();
    if (all.length) selectDataset(store.getActiveId() && store.getDataset(store.getActiveId()) ? store.getActiveId() : all[0].id);
    else renderSuggest();
    $('question').focus();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})(window);
