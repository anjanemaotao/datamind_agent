/* DataMind · 本地数据层：解析、类型推断、持久化（localStorage） */
(function (global) {
  'use strict';

  var KEY_DS = 'datamind.datasets.v1';
  var KEY_ACTIVE = 'datamind.active.v1';
  var KEY_HIST = 'datamind.history.v1';
  var KEY_CFG = 'datamind.config.v1';
  var MAX_ROWS = 20000;

  /* ---------- 基础工具 ---------- */
  function uid(p) { return (p || 'id') + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
  function read(k, d) { try { var v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } }
  function write(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { return false; } }

  /* ---------- CSV / TSV 解析（支持引号、转义、自动分隔符） ---------- */
  function detectDelimiter(text) {
    var head = text.split(/\r?\n/).slice(0, 5).join('\n');
    var cands = [',', '\t', ';', '|'];
    var best = ',', bestScore = -1;
    cands.forEach(function (d) {
      var counts = head.split('\n').map(function (l) { return l.split(d).length; });
      var avg = counts.reduce(function (a, b) { return a + b; }, 0) / counts.length;
      var uniform = counts.every(function (c) { return c === counts[0]; });
      var score = avg + (uniform ? 2 : 0);
      if (score > bestScore) { bestScore = score; best = d; }
    });
    return best;
  }

  function parseDelimited(text, delim) {
    text = String(text).replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    if (!delim) delim = detectDelimiter(text);
    var rows = [], row = [], cur = '', inQuote = false, i = 0;
    while (i < text.length) {
      var ch = text[i];
      if (inQuote) {
        if (ch === '"') {
          if (text[i + 1] === '"') { cur += '"'; i += 2; continue; }
          inQuote = false; i++; continue;
        }
        cur += ch; i++; continue;
      }
      if (ch === '"') { inQuote = true; i++; continue; }
      if (ch === delim) { row.push(cur); cur = ''; i++; continue; }
      if (ch === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; i++; continue; }
      cur += ch; i++;
    }
    if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
    return rows.filter(function (r) { return r.some(function (c) { return String(c).trim() !== ''; }); });
  }

  function toRecords(rows) {
    if (!rows.length) return { columns: [], rows: [] };
    var header = rows[0].map(function (h, i) {
      var s = String(h).trim();
      return s === '' ? ('列' + (i + 1)) : s;
    });
    // 去重表头
    var seen = {};
    header = header.map(function (h) {
      if (!seen[h]) { seen[h] = 1; return h; }
      seen[h]++; return h + '(' + seen[h] + ')';
    });
    var out = [];
    for (var r = 1; r < rows.length && out.length < MAX_ROWS; r++) {
      var obj = {}, any = false;
      for (var c = 0; c < header.length; c++) {
        var v = rows[r][c];
        if (v === undefined) v = '';
        v = String(v).trim();
        if (v !== '') any = true;
        obj[header[c]] = v;
      }
      if (any) out.push(obj);
    }
    return { columns: header, rows: out };
  }

  /* ---------- 类型推断与转换 ---------- */
  var DATE_RE = /^\d{4}[-/年]\d{1,2}([-/月]\d{1,2})?$/;
  function isNum(v) { return typeof v === 'number' ? isFinite(v) : (typeof v === 'string' && v !== '' && !isNaN(Number(v.replace(/[,\s%¥$￥]/g, '')))); }
  function toNum(v) {
    if (typeof v === 'number') return v;
    if (v == null) return null;
    var s = String(v).replace(/[,\s%¥$￥]/g, '');
    if (s === '' || isNaN(Number(s))) return null;
    return Number(s);
  }
  function toDate(v) {
    if (v == null || v === '') return null;
    var s = String(v).trim();
    var m = s.match(/^(\d{4})[-/年.](\d{1,2})(?:[-/月.](\d{1,2}))?/);
    if (m) {
      var y = +m[1], mo = +m[2], d = m[3] ? +m[3] : 1;
      var dt = new Date(y, mo - 1, d);
      if (!isNaN(dt.getTime())) return dt;
    }
    var dt2 = new Date(s);
    return isNaN(dt2.getTime()) ? null : dt2;
  }

  function inferTypes(columns, rows) {
    var sample = rows.slice(0, 300);
    var types = {};
    columns.forEach(function (col) {
      var n = 0, num = 0, date = 0;
      sample.forEach(function (r) {
        var v = r[col];
        if (v === '' || v == null) return;
        n++;
        if (DATE_RE.test(String(v).trim()) || (toDate(v) && /\d{4}/.test(String(v)) && String(v).length >= 6)) date++;
        else if (isNum(v)) num++;
        else if (toDate(v) && /[-/]/.test(String(v))) date++;
      });
      if (!n) { types[col] = 'text'; return; }
      if (date / n >= 0.8) types[col] = 'date';
      else if (num / n >= 0.8) types[col] = 'number';
      else types[col] = 'text';
    });
    return types;
  }

  function normalize(columns, rows) {
    var types = inferTypes(columns, rows);
    var out = rows.map(function (r) {
      var o = {};
      columns.forEach(function (c) {
        var v = r[c];
        if (types[c] === 'number') o[c] = toNum(v);
        else if (types[c] === 'date') o[c] = toDate(v);
        else o[c] = (v == null ? '' : String(v));
      });
      return o;
    });
    return { columns: columns, types: types, rows: out };
  }

  /* ---------- 对外解析入口 ---------- */
  function parseText(text, name) {
    text = String(text || '').trim();
    if (!text) throw new Error('内容为空');
    var columns, rows;
    if (text[0] === '[' || text[0] === '{') {
      var j = JSON.parse(text);
      if (!Array.isArray(j)) j = [j];
      var set = {};
      j.forEach(function (o) { Object.keys(o).forEach(function (k) { set[k] = 1; }); });
      columns = Object.keys(set);
      rows = j.map(function (o) {
        var r = {};
        columns.forEach(function (c) { r[c] = o[c] == null ? '' : (typeof o[c] === 'object' ? JSON.stringify(o[c]) : o[c]); });
        return r;
      });
    } else {
      var parsed = parseDelimited(text);
      if (parsed.length < 2) throw new Error('至少需要表头行和一行数据');
      var rec = toRecords(parsed);
      columns = rec.columns; rows = rec.rows;
    }
    if (!columns.length) throw new Error('未识别到有效列');
    var norm = normalize(columns, rows);
    return buildDataset(name || '数据集', norm);
  }

  function buildDataset(name, norm) {
    return {
      id: uid('ds'),
      name: name,
      columns: norm.columns,
      types: norm.types,
      rows: norm.rows,
      createdAt: Date.now()
    };
  }

  /* ---------- 持久化 ---------- */
  var Store = {
    listDatasets: function () { return read(KEY_DS, []); },
    saveDataset: function (ds) {
      if (!ds) return false;
      var all = this.listDatasets();
      var i = all.findIndex(function (d) { return d.id === ds.id; });
      if (i >= 0) all[i] = ds; else all.push(ds);
      // 容量保护：超出时淘汰最旧数据集
      var ok = write(KEY_DS, all);
      if (!ok) {
        while (all.length > 1 && !ok) { all.shift(); ok = write(KEY_DS, all); }
      }
      return ok;
    },
    getDataset: function (id) { return this.listDatasets().find(function (d) { return d.id === id; }) || null; },
    deleteDataset: function (id) {
      var all = this.listDatasets().filter(function (d) { return d.id !== id; });
      write(KEY_DS, all);
      if (this.getActiveId() === id) write(KEY_ACTIVE, all.length ? all[0].id : null);
    },
    getActiveId: function () { return read(KEY_ACTIVE, null); },
    setActive: function (id) { write(KEY_ACTIVE, id); },

    listHistory: function () { return read(KEY_HIST, []); },
    pushHistory: function (h) {
      var all = this.listHistory();
      all.unshift(h);
      write(KEY_HIST, all.slice(0, 50));
    },
    clearHistory: function () { write(KEY_HIST, []); },

    getConfig: function () { return read(KEY_CFG, { baseUrl: '', apiKey: '', model: '' }); },
    setConfig: function (c) { write(KEY_CFG, c); }
  };

  /* ---------- 示例数据集 ---------- */
  function sampleSales() {
    var channels = ['线上商城', '线下门店', '分销渠道', '直播带货'];
    var regions = ['华东', '华北', '华南', '西南'];
    var rows = [];
    var seed = 20260101;
    function rnd() { seed = (seed * 9301 + 49297) % 233280; return seed / 233280; }
    for (var m = 0; m < 12; m++) {
      for (var d = 0; d < 10; d++) {
        var day = d * 3 + 1;
        channels.forEach(function (ch) {
          regions.forEach(function (rg) {
            var base = 8000 + m * 900 + (ch === '直播带货' ? 4200 : 0) + (rg === '华东' ? 2600 : 0);
            var orders = Math.round(base / (120 + rnd() * 40));
            var sales = Math.round(base * (0.82 + rnd() * 0.36));
            if (m === 6 && d === 5 && ch === '直播带货') sales = Math.round(sales * 3.4); // 人为异常
            if (m === 9 && ch === '线下门店') sales = Math.round(sales * 0.35);           // 人为异常
            rows.push({
              '日期': '2026-' + String(m + 1).padStart(2, '0') + '-' + String(day).padStart(2, '0'),
              '渠道': ch, '地区': rg, '销售额': sales, '订单数': orders
            });
          });
        });
      }
    }
    rows.forEach(function (r) { r['客单价'] = Math.round((r['销售额'] / r['订单数']) * 100) / 100; });
    var columns = ['日期', '渠道', '地区', '销售额', '订单数', '客单价'];
    var norm = normalize(columns, rows);
    return buildDataset('示例·零售销售明细', norm);
  }

  global.DAStore = {
    uid: uid, parseText: parseText, normalize: normalize, buildDataset: buildDataset,
    toNum: toNum, toDate: toDate, isNum: isNum,
    store: Store, sampleSales: sampleSales, MAX_ROWS: MAX_ROWS
  };
})(window);
