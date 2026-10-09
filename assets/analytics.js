/* DataMind · 分析引擎：意图规划 + 本地精确计算 + 结论生成 */
(function (global) {
  'use strict';

  var S = global.DAStore;
  var AGGS = ['sum', 'avg', 'count', 'max', 'min'];

  /* ---------- 数值工具 ---------- */
  function fmt(n, digits) {
    if (n == null || (typeof n === 'number' && !isFinite(n))) return '-';
    var d = digits == null ? 2 : digits;
    if (Math.abs(n) >= 1e8) return (n / 1e8).toFixed(d) + '亿';
    if (Math.abs(n) >= 1e4) return (n / 1e4).toFixed(d) + '万';
    return Number(n.toFixed(d)).toLocaleString('zh-CN');
  }
  function pct(a, b) { if (!isFinite(a) || !isFinite(b) || b === 0) return null; return (a - b) / Math.abs(b); }
  function mean(a) { return a.length ? a.reduce(function (x, y) { return x + y; }, 0) / a.length : 0; }
  function std(a) {
    if (a.length < 2) return 0;
    var m = mean(a);
    return Math.sqrt(a.reduce(function (s, v) { return s + (v - m) * (v - m); }, 0) / (a.length - 1));
  }
  function quantile(sorted, q) {
    if (!sorted.length) return 0;
    var p = (sorted.length - 1) * q, lo = Math.floor(p), hi = Math.ceil(p);
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (p - lo);
  }

  /* ---------- 数据操作 ---------- */
  function applyFilters(rows, filters) {
    if (!filters || !filters.length) return rows;
    return rows.filter(function (r) {
      return filters.every(function (f) {
        var v = r[f.field];
        var t = String(f.value);
        if (v == null) return false;
        if (typeof v === 'number' || typeof f.value === 'number') {
          var nv = Number(v), nt = Number(t);
          switch (f.op) {
            case '>': return nv > nt;
            case '<': return nv < nt;
            case '>=': return nv >= nt;
            case '<=': return nv <= nt;
            case '=': return nv === nt;
            case '!=': return nv !== nt;
          }
        }
        var sv = String(v);
        switch (f.op) {
          case '=': return sv === t || sv.toLowerCase() === t.toLowerCase();
          case '!=': return sv !== t;
          case 'contains': return sv.indexOf(t) >= 0;
          case '>': return sv > t;
          case '<': return sv < t;
          default: return true;
        }
      });
    });
  }

  function aggregate(values, agg) {
    var nums = values.filter(function (v) { return typeof v === 'number' && isFinite(v); });
    if (agg === 'count') return values.length;
    if (!nums.length) return 0;
    switch (agg) {
      case 'sum': return nums.reduce(function (a, b) { return a + b; }, 0);
      case 'avg': return mean(nums);
      case 'max': return Math.max.apply(null, nums);
      case 'min': return Math.min.apply(null, nums);
      default: return mean(nums);
    }
  }

  function periodKey(d, period) {
    if (!(d instanceof Date)) d = new Date(d);
    var y = d.getFullYear(), m = d.getMonth() + 1, day = d.getDate();
    if (period === 'year') return y + '年';
    if (period === 'month') return y + '-' + String(m).padStart(2, '0');
    if (period === 'week') {
      var t = new Date(d.getTime()); var dow = (t.getDay() + 6) % 7; t.setDate(t.getDate() - dow);
      return t.getFullYear() + '-' + String(t.getMonth() + 1).padStart(2, '0') + '-' + String(t.getDate()).padStart(2, '0') + ' 周';
    }
    return y + '-' + String(m).padStart(2, '0') + '-' + String(day).padStart(2, '0');
  }

  function groupRows(rows, keyFn) {
    var map = {}, order = [];
    rows.forEach(function (r) {
      var k = keyFn(r);
      if (k == null || k === '') k = '(空)';
      k = String(k);
      if (!map[k]) { map[k] = []; order.push(k); }
      map[k].push(r);
    });
    return { map: map, order: order };
  }

  /* ---------- 数据集摘要（给大模型看） ---------- */
  function schemaSummary(ds) {
    var cols = ds.columns.map(function (c) {
      var t = ds.types[c];
      var info = { name: c, type: t };
      if (t === 'number') {
        var vals = ds.rows.map(function (r) { return r[c]; }).filter(function (v) { return typeof v === 'number' && isFinite(v); });
        info.min = vals.length ? Math.min.apply(null, vals) : 0;
        info.max = vals.length ? Math.max.apply(null, vals) : 0;
        info.avg = vals.length ? Math.round(mean(vals) * 100) / 100 : 0;
      } else if (t === 'date') {
        var ds2 = ds.rows.map(function (r) { return r[c]; }).filter(function (v) { return v instanceof Date || (v && !isNaN(new Date(v).getTime())); });
        if (ds2.length) {
          var times = ds2.map(function (v) { return (v instanceof Date ? v : new Date(v)).getTime(); });
          info.min = new Date(Math.min.apply(null, times)).toISOString().slice(0, 10);
          info.max = new Date(Math.max.apply(null, times)).toISOString().slice(0, 10);
        }
      } else {
        var uniq = {};
        ds.rows.slice(0, 500).forEach(function (r) { uniq[r[c]] = 1; });
        info.samples = Object.keys(uniq).slice(0, 12);
      }
      return info;
    });
    return {
      name: ds.name,
      rowCount: ds.rows.length,
      columns: cols,
      sample: ds.rows.slice(0, 3)
    };
  }

  /* ---------- 本地规则规划（无模型时的降级方案） ---------- */
  var TREND_WORDS = ['趋势', '走势', '变化', '增长', '下降', '随时间', '按月', '按周', '按天', '按年', '月度', '每日', '每周', '年度', '环比', '同比'];
  var ANOMALY_WORDS = ['异常', '离群', '突变', '波动异常', '可疑', ' outlier', 'outlier', '不正常', '突增', '突降', '极值'];
  var COMPARE_WORDS = ['对比', '比较', '相比', '哪个', '各自', '排名', '差异', '占比', '构成', '分布'];
  var TOP_RE = /(?:前|top|TOP)\s*(\d+)|(\d+)\s*个/;
  var AGG_MAP = { '总和': 'sum', '总': 'sum', '合计': 'sum', '平均': 'avg', '均值': 'avg', '客单价': 'avg', '最多': 'max', '最高': 'max', '最大': 'max', '最少': 'min', '最低': 'min', '最小': 'min', '数量': 'count', '多少个': 'count' };
  var METRIC_HINT = ['销售额', '销量', '收入', '金额', '订单', '订单数', '用户数', '人数', '客单价', '利润', '成本', '转化率', '点击', '访问', 'gmv', 'GMV', '数量'];
  var PERIOD_MAP = { '按年': 'year', '年度': 'year', '每年': 'year', '按月': 'month', '月度': 'month', '每月': 'month', '按周': 'week', '每周': 'week', '按天': 'day', '每日': 'day', '每天': 'day' };

  function pickByWords(q, words) { return words.some(function (w) { return q.indexOf(w) >= 0; }); }

  function matchField(ds, candidates, typeFilter) {
    var cols = ds.columns.filter(function (c) { return !typeFilter || ds.types[c] === typeFilter; });
    for (var i = 0; i < candidates.length; i++) {
      for (var j = 0; j < cols.length; j++) {
        if (cols[j] === candidates[i] || cols[j].toLowerCase() === String(candidates[i]).toLowerCase()) return cols[j];
      }
    }
    for (var a = 0; a < candidates.length; a++) {
      for (var b = 0; b < cols.length; b++) {
        if (cols[b].indexOf(candidates[a]) >= 0 || String(candidates[a]).indexOf(cols[b]) >= 0) return cols[b];
      }
    }
    return null;
  }

  // 优先匹配问题中直接写出的字段名，其次匹配字段值所属字段，最后回退第一个文本列
  function extractDimension(q, ds) {
    var textCols = ds.columns.filter(function (c) { return ds.types[c] === 'text'; });
    if (!textCols.length) return null;
    for (var i = 0; i < textCols.length; i++) if (q.indexOf(textCols[i]) >= 0) return textCols[i];
    var qn = q.toLowerCase();
    for (var j = 0; j < textCols.length; j++) {
      var hit = ds.rows.some(function (r) {
        var v = String(r[textCols[j]] || '');
        return v && v.length > 1 && qn.indexOf(v.toLowerCase()) >= 0;
      });
      if (hit) return textCols[j];
    }
    return textCols[0];
  }

  function extractMetric(q, ds) {
    var numCols = ds.columns.filter(function (c) { return ds.types[c] === 'number'; });
    for (var i = 0; i < METRIC_HINT.length; i++) {
      var hit = numCols.find(function (c) { return q.indexOf(c) >= 0; });
      if (hit) return hit;
      if (q.indexOf(METRIC_HINT[i]) >= 0) {
        var fuzzy = numCols.find(function (c) { return c.indexOf(METRIC_HINT[i]) >= 0; });
        if (fuzzy) return fuzzy;
      }
    }
    return numCols[0] || null;
  }

  function extractFilters(q, ds) {
    var filters = [];
    ds.columns.forEach(function (c) {
      if (ds.types[c] !== 'text') return;
      var vals = {};
      ds.rows.forEach(function (r) { if (r[c]) vals[r[c]] = 1; });
      Object.keys(vals).forEach(function (v) {
        if (v && q.indexOf(String(v)) >= 0) filters.push({ field: c, op: '=', value: String(v) });
      });
    });
    return filters.slice(0, 3);
  }

  function rulePlan(q, ds) {
    q = (q || '').trim();
    var plan = {
      intent: 'query', title: q.slice(0, 24), metrics: [], dimension: null, timeField: null,
      period: 'month', agg: 'sum', filters: [], topN: null, sort: null, chart: 'table',
      anomalyMethod: 'iqr', source: 'rule'
    };
    var metric = extractMetric(q, ds);
    if (metric) plan.metrics = [metric];

    // 聚合方式
    Object.keys(AGG_MAP).forEach(function (k) { if (q.indexOf(k) >= 0) plan.agg = AGG_MAP[k]; });
    // 时间粒度
    var periodHit = false;
    Object.keys(PERIOD_MAP).forEach(function (k) { if (q.indexOf(k) >= 0) { plan.period = PERIOD_MAP[k]; periodHit = true; } });
    // TOP N
    var m = q.match(TOP_RE);
    if (m) plan.topN = Number(m[1] || m[2]);

    var dateCols = ds.columns.filter(function (c) { return ds.types[c] === 'date'; });
    var textCols = ds.columns.filter(function (c) { return ds.types[c] === 'text'; });
    plan.timeField = dateCols[0] || null;
    plan.filters = extractFilters(q, ds);

    if (pickByWords(q, ANOMALY_WORDS)) {
      plan.intent = 'anomaly';
      plan.chart = 'scatter';
      if (!metric) metric = ds.columns.filter(function (c) { return ds.types[c] === 'number'; })[0];
      plan.metrics = metric ? [metric] : [];
      return plan;
    }
    if (pickByWords(q, TREND_WORDS) && plan.timeField) {
      plan.intent = 'trend';
      plan.chart = 'line';
      return plan;
    }
    if (pickByWords(q, COMPARE_WORDS)) {
      plan.intent = 'compare';
      plan.chart = (q.indexOf('占比') >= 0 || q.indexOf('构成') >= 0) ? 'pie' : 'bar';
      plan.dimension = extractDimension(q, ds);
      return plan;
    }
    // 默认查询：仅在问题体现分组意图时才按维度聚合
    var groupHint = /各|每|按|前|top|TOP|排名|分布/.test(q) || ds.columns.some(function (c) { return ds.types[c] === 'text' && q.indexOf(c) >= 0; });
    if (groupHint && textCols.length) {
      plan.dimension = extractDimension(q, ds);
      plan.chart = 'bar';
      if (!plan.topN) plan.topN = 10;
      // 「前 N 个 X」通常是排名合计而非极值
      if (plan.topN && (plan.agg === 'max' || plan.agg === 'min')) plan.agg = 'sum';
    } else {
      plan.dimension = null;
      plan.chart = 'table';
      // 未显式要求时间粒度时，不按时间分组，直接给整体结果
      if (!periodHit) plan.timeField = null;
    }
    plan.sort = metric ? { field: '__metric__', order: 'desc' } : null;
    return plan;
  }

  /* ---------- 计划校验 ---------- */
  function validatePlan(plan, ds) {
    var cols = ds.columns;
    function okField(f) { return f && cols.indexOf(f) >= 0 ? f : null; }
    plan.intent = ['query', 'trend', 'anomaly', 'compare', 'summary'].indexOf(plan.intent) >= 0 ? plan.intent : 'query';
    plan.metrics = (plan.metrics || []).map(okField).filter(Boolean)
      .filter(function (c) { return ds.types[c] === 'number'; });
    if (!plan.metrics.length) {
      var first = cols.filter(function (c) { return ds.types[c] === 'number'; })[0];
      if (first) plan.metrics = [first];
    }
    plan.dimension = okField(plan.dimension);
    plan.timeField = okField(plan.timeField);
    if (plan.timeField && ds.types[plan.timeField] !== 'date') plan.timeField = cols.filter(function (c) { return ds.types[c] === 'date'; })[0] || null;
    if (AGGS.indexOf(plan.agg) < 0) plan.agg = 'sum';
    if (['day', 'week', 'month', 'year'].indexOf(plan.period) < 0) plan.period = 'month';
    plan.filters = (plan.filters || []).filter(function (f) { return f && cols.indexOf(f.field) >= 0 && f.value != null && f.value !== ''; });
    plan.topN = (plan.topN && plan.topN > 0) ? Math.min(plan.topN, 200) : null;
    if (!plan.chart) plan.chart = 'table';
    return plan;
  }

  /* ---------- 执行计划 ---------- */
  function executePlan(plan, ds) {
    plan = validatePlan(plan, ds);
    var metric = plan.metrics[0];
    var rows = applyFilters(ds.rows, plan.filters);

    if (plan.intent === 'trend' && plan.timeField) return runTrend(plan, ds, rows, metric);
    if (plan.intent === 'anomaly') return runAnomaly(plan, ds, rows, metric);
    if (plan.intent === 'compare') return runCompare(plan, ds, rows, metric);
    return runQuery(plan, ds, rows, metric);
  }

  function filterDesc(plan) {
    if (!plan.filters.length) return '';
    return '（筛选：' + plan.filters.map(function (f) { return f.field + f.op + f.value; }).join('、') + '）';
  }
  function aggLabel(agg) { return { sum: '合计', avg: '平均', count: '计数', max: '最大', min: '最小' }[agg] || agg; }

  /* --- 查询 / 分组聚合 --- */
  function runQuery(plan, ds, rows, metric) {
    var dim = plan.dimension || plan.timeField;
    var period = plan.period;
    var items;
    if (dim) {
      var keyFn = ds.types[dim] === 'date'
        ? function (r) { return periodKey(r[dim], period); }
        : function (r) { return r[dim]; };
      var g = groupRows(rows, keyFn);
      items = g.order.map(function (k) {
        var o = { label: k };
        plan.metrics.forEach(function (m) { o[m] = aggregate(g.map[k].map(function (r) { return r[m]; }), plan.agg); });
        o['__metric__'] = metric ? o[metric] : g.map[k].length;
        o['__count__'] = g.map[k].length;
        return o;
      });
    } else {
      var o1 = { label: plan.filters.length ? plan.filters.map(function (f) { return String(f.value); }).join(' / ') : '全部数据' };
      plan.metrics.forEach(function (m) { o1[m] = aggregate(rows.map(function (r) { return r[m]; }), plan.agg); });
      o1['__metric__'] = metric ? o1[metric] : rows.length;
      o1['__count__'] = rows.length;
      items = [o1];
    }
    items.sort(function (a, b) { return (b.__metric__ || 0) - (a.__metric__ || 0); });
    var shown = plan.topN ? items.slice(0, plan.topN) : items.slice(0, 30);

    var total = items.reduce(function (s, i) { return s + (typeof i.__metric__ === 'number' ? i.__metric__ : 0); }, 0);
    var summable = plan.agg === 'sum' || plan.agg === 'count';
    var kpis = [];
    if (metric && summable) {
      kpis.push({ label: aggLabel(plan.agg) + metric, value: fmt(total), sub: ds.name + filterDesc(plan) });
    }
    if (items.length) {
      var top = items[0], bottom = items[items.length - 1];
      if (items.length > 1) kpis.push({ label: '最高：' + top.label, value: fmt(top.__metric__), sub: '共 ' + items.length + ' 个分组' });
      else kpis.push({ label: aggLabel(plan.agg) + (metric || '记录数') + '（' + top.label + '）', value: fmt(top.__metric__), sub: ds.name + filterDesc(plan) });
      if (items.length > 1) kpis.push({ label: '最低：' + bottom.label, value: fmt(bottom.__metric__), sub: '' });
      if (metric && summable && total) {
        kpis.push({ label: '头部占比', value: (top.__metric__ / total * 100).toFixed(1) + '%', sub: top.label + ' 占合计' });
      }
    }

    var insights = [];
    if (items.length && metric) {
      var t = items[0];
      if (items.length === 1) {
        insights.push('<b>' + t.label + '</b> 的' + aggLabel(plan.agg) + (metric) + '为 <b>' + fmt(t.__metric__) + '</b>（参与计算 ' + rows.length + ' 行）' + filterDesc(plan) + '。');
      } else {
        insights.push('按 <b>' + (dim || '整体') + '</b> 聚合' + aggLabel(plan.agg) + '，<b>' + t.label + '</b> 排名第一，' + metric + ' 为 <b>' + fmt(t.__metric__) + '</b>。');
        var last = items[items.length - 1];
        var gap = pct(t.__metric__, last.__metric__);
        if (gap != null) insights.push('首位与末位（' + last.label + '）相差 <b>' + (gap * 100).toFixed(1) + '%</b>' + (gap > 0 ? '，头部集中度高。' : '，分布较为均衡。'));
        var avgAll = mean(items.map(function (i) { return i.__metric__ || 0; }));
        var above = items.filter(function (i) { return (i.__metric__ || 0) > avgAll; }).length;
        insights.push('共 <b>' + items.length + '</b> 个分组，均值 <b>' + fmt(avgAll) + '</b>，其中 <b>' + above + '</b> 个高于均值。');
      }
    }
    if (!insights.length) insights.push('已按要求完成聚合查询，共 ' + rows.length + ' 行数据参与计算。');

    var cols = ['label'].concat(plan.metrics).concat(['__count__']);
    return {
      intent: 'query',
      title: plan.title || (dim ? (dim + ' 维度 ' + aggLabel(plan.agg) + (metric || '')) : '数据查询'),
      subtitle: ds.name + ' · ' + rows.length + ' 行参与计算' + filterDesc(plan),
      kpis: kpis, insights: insights,
      table: { columns: cols, rows: shown, labels: { label: dim || '分组', __count__: '记录数' } },
      chart: { type: (plan.chart === 'table' ? (items.length > 1 ? 'bar' : 'table') : plan.chart), labels: shown.map(function (i) { return i.label; }), series: [{ name: aggLabel(plan.agg) + (metric || '记录数'), data: shown.map(function (i) { return i.__metric__; }) }] },
      plan: plan
    };
  }

  /* --- 趋势分析 --- */
  function runTrend(plan, ds, rows, metric) {
    var dim = plan.timeField;
    var g = groupRows(rows, function (r) { return periodKey(r[dim], plan.period); });
    var order = g.order.slice().sort();
    var points = order.map(function (k) {
      return { label: k, value: aggregate(g.map[k].map(function (r) { return r[metric]; }), plan.agg), n: g.map[k].length };
    });
    var vals = points.map(function (p) { return p.value; });
    var first = vals[0], last = vals[vals.length - 1];
    var change = pct(last, first);
    var maxP = points.reduce(function (a, b) { return b.value > a.value ? b : a; }, points[0]);
    var minP = points.reduce(function (a, b) { return b.value < a.value ? b : a; }, points[0]);
    // 线性回归斜率与判定方向
    var n = points.length, xs = points.map(function (_, i) { return i; });
    var mx = mean(xs), my = mean(vals);
    var slope = n > 1 ? (xs.reduce(function (s, x, i) { return s + (x - mx) * (vals[i] - my); }, 0)) / (xs.reduce(function (s, x) { return s + (x - mx) * (x - mx); }, 0)) : 0;
    // 环比
    var mom = [];
    for (var i = 1; i < vals.length; i++) { var c = pct(vals[i], vals[i - 1]); if (c != null) mom.push(c); }
    var momAvg = mom.length ? mean(mom) : 0;
    var momStd = std(mom);
    var jumps = [];
    for (var j = 1; j < points.length; j++) {
      var cc = pct(vals[j], vals[j - 1]);
      if (cc != null && momStd > 0 && Math.abs(cc - momAvg) > 2 * momStd) {
        jumps.push({ label: points[j].label, change: cc, value: vals[j] });
      }
    }
    var dirTxt = change == null ? '基本持平' : (change > 0.05 ? '整体上升' : (change < -0.05 ? '整体下滑' : '整体平稳'));
    var kpis = [
      { label: '起点 ' + points[0].label, value: fmt(first), sub: '' },
      { label: '终点 ' + points[points.length - 1].label, value: fmt(last), sub: '' },
      { label: '整体变化', value: change == null ? '-' : (change > 0 ? '+' : '') + (change * 100).toFixed(1) + '%', sub: dirTxt, trend: change == null ? 0 : change },
      { label: '平均环比', value: (momAvg > 0 ? '+' : '') + (momAvg * 100).toFixed(2) + '%', sub: '每' + ({ day: '日', week: '周', month: '月', year: '年' }[plan.period]) + '平均' },
      { label: '峰值 ' + maxP.label, value: fmt(maxP.value), sub: '' },
      { label: '谷值 ' + minP.label, value: fmt(minP.value), sub: '' }
    ];
    var insights = [];
    insights.push(metric + ' 在 <b>' + points[0].label + ' → ' + points[points.length - 1].label + '</b> 期间<b>' + dirTxt + '</b>，累计变化 <b>' + (change == null ? '-' : (change > 0 ? '+' : '') + (change * 100).toFixed(1) + '%') + '</b>（' + fmt(first) + ' → ' + fmt(last) + '）。');
    insights.push('线性趋势斜率约 <b>' + fmt(slope) + '</b>/期，最高点出现在 <b>' + maxP.label + '</b>（' + fmt(maxP.value) + '），最低点 <b>' + minP.label + '</b>（' + fmt(minP.value) + '）。');
    if (jumps.length) {
      insights.push('检测到 <b>' + jumps.length + '</b> 个显著波动点：' + jumps.slice(0, 4).map(function (x) {
        return x.label + '（' + (x.change > 0 ? '+' : '') + (x.change * 100).toFixed(0) + '%）';
      }).join('、') + '，建议重点核查。');
    } else {
      insights.push('未检测到超过 2 倍标准差环比波动的异常点，走势相对平稳。');
    }
    insights.push('峰谷差 <b>' + fmt(maxP.value - minP.value) + '</b>，波动幅度约为均值的 <b>' + (my ? ((maxP.value - minP.value) / my * 100).toFixed(1) : '0') + '%</b>。');

    return {
      intent: 'trend',
      title: plan.title || (metric + ' 时间趋势（按' + ({ day: '日', week: '周', month: '月', year: '年' }[plan.period]) + '）'),
      subtitle: ds.name + ' · ' + rows.length + ' 行 · ' + aggLabel(plan.agg) + metric + filterDesc(plan),
      kpis: kpis, insights: insights,
      table: { columns: ['label', 'value', 'mom', 'n'], rows: points.map(function (p, i) {
        return { label: p.label, value: p.value, mom: i ? pct(p.value, points[i - 1].value) : null, n: p.n };
      }), labels: { label: ({ day: '日期', week: '周', month: '月份', year: '年份' })[plan.period], value: aggLabel(plan.agg) + metric, mom: '环比', n: '样本数' }, pctCols: ['mom'] },
      chart: { type: 'line', labels: points.map(function (p) { return p.label; }), series: [{ name: aggLabel(plan.agg) + metric, data: vals }], marks: jumps.map(function (x) { return x.label; }) },
      plan: plan
    };
  }

  /* --- 异常识别 --- */
  function runAnomaly(plan, ds, rows, metric) {
    var vals = rows.map(function (r) { return r[metric]; }).filter(function (v) { return typeof v === 'number' && isFinite(v); });
    if (!vals.length) return { intent: 'anomaly', title: '异常识别', insights: ['未找到可用于异常检测的数值指标。'], kpis: [], table: { columns: [], rows: [] }, chart: null, plan: plan };
    var sorted = vals.slice().sort(function (a, b) { return a - b; });
    var q1 = quantile(sorted, 0.25), q3 = quantile(sorted, 0.75), iqr = q3 - q1;
    var lo = q1 - 1.5 * iqr, hi = q3 + 1.5 * iqr;
    var m = mean(vals), sd = std(vals);
    var method = plan.anomalyMethod === 'zscore' ? 'zscore' : 'iqr';
    var flagged = [];
    rows.forEach(function (r, idx) {
      var v = r[metric];
      if (typeof v !== 'number' || !isFinite(v)) return;
      var isOut = method === 'zscore' ? (sd > 0 && Math.abs((v - m) / sd) >= 2.5) : (v < lo || v > hi);
      if (!isOut) return;
      var row = { __idx__: idx + 1 };
      ds.columns.forEach(function (c) { row[c] = r[c]; });
      row['__value__'] = v;
      row['__dev__'] = sd > 0 ? (v - m) / sd : 0;
      row['__type__'] = v > m ? '偏高' : '偏低';
      row['__rule__'] = method === 'zscore' ? ('|z|=' + Math.abs((v - m) / sd).toFixed(2)) : ('超出 [' + fmt(lo) + ',' + fmt(hi) + ']');
      flagged.push(row);
    });
    flagged.sort(function (a, b) { return Math.abs(b.__dev__) - Math.abs(a.__dev__); });
    var top = flagged.slice(0, 20);

    var kpis = [
      { label: '异常记录数', value: String(flagged.length), sub: '占比 ' + (flagged.length / rows.length * 100).toFixed(2) + '%' },
      { label: '均值 / 标准差', value: fmt(m) + ' / ' + fmt(sd), sub: metric },
      { label: '正常区间', value: fmt(lo) + ' ~ ' + fmt(hi), sub: 'IQR 1.5 倍法' },
      { label: '最高偏离', value: top.length ? fmt(top[0].__value__) : '-', sub: top.length ? ('z=' + top[0].__dev__.toFixed(2)) : '' }
    ];
    var insights = [];
    insights.push('对 <b>' + metric + '</b> 采用 <b>' + (method === 'zscore' ? 'Z-Score（|z|≥2.5）' : 'IQR 四分位（1.5×IQR）') + '</b> 检测，共识别 <b>' + flagged.length + '</b> 条异常记录，占总量 <b>' + (flagged.length / rows.length * 100).toFixed(2) + '%</b>。');
    if (top.length) {
      var hi1 = top[0];
      insights.push('偏离最严重的是第 <b>' + hi1.__idx__ + '</b> 行：' + metric + ' = <b>' + fmt(hi1.__value__) + '</b>（' + hi1.__type__ + '，' + hi1.__rule__ + '），约为均值的 <b>' + (m ? (hi1.__value__ / m).toFixed(2) : '-') + ' 倍</b>。');
      var high = flagged.filter(function (f) { return f.__type__ === '偏高'; }).length;
      insights.push('异常构成：偏高 <b>' + high + '</b> 条，偏低 <b>' + (flagged.length - high) + '</b> 条' + (high > flagged.length - high ? '，以突增为主，需核查是否存在活动或刷量。' : '，以突降为主，需核查是否漏采或业务中断。'));
      // 维度归因
      var textCols = ds.columns.filter(function (c) { return ds.types[c] === 'text'; });
      if (textCols.length) {
        var c0 = textCols[0], cnt = {};
        flagged.forEach(function (f) { var k = String(f[c0]); cnt[k] = (cnt[k] || 0) + 1; });
        var arr = Object.keys(cnt).sort(function (a, b) { return cnt[b] - cnt[a]; });
        if (arr.length) insights.push('异常集中在 <b>' + c0 + '</b> 维度：' + arr.slice(0, 3).map(function (k) { return k + '（' + cnt[k] + ' 条）'; }).join('、') + '。');
      }
    } else {
      insights.push('未检测到明显异常值，数据分布较为均匀。');
    }

    var cols = ['__idx__'].concat(ds.columns).concat(['__type__', '__dev__']);
    return {
      intent: 'anomaly',
      title: plan.title || (metric + ' 异常识别'),
      subtitle: ds.name + ' · ' + rows.length + ' 行 · ' + (method === 'zscore' ? 'Z-Score 法' : 'IQR 法') + filterDesc(plan),
      kpis: kpis, insights: insights,
      table: { columns: cols, rows: top, labels: { __idx__: '行号', __type__: '类型', __dev__: '偏离(σ)' } },
      chart: { type: 'scatter', labels: rows.map(function (_, i) { return i + 1; }), series: [{ name: metric, data: rows.map(function (r) { return r[metric]; }) }], thresholds: { lo: lo, hi: hi, mean: m }, anomalyIdx: top.map(function (t) { return t.__idx__; }) },
      plan: plan
    };
  }

  /* --- 指标对比 --- */
  function runCompare(plan, ds, rows, metric) {
    var dim = plan.dimension || ds.columns.filter(function (c) { return ds.types[c] === 'text'; })[0];
    if (!dim) return runQuery(plan, ds, rows, metric);
    var g = groupRows(rows, function (r) { return r[dim]; });
    var items = g.order.map(function (k) {
      var o = { label: k };
      plan.metrics.forEach(function (m) { o[m] = aggregate(g.map[k].map(function (r) { return r[m]; }), plan.agg); });
      o['__metric__'] = metric ? o[metric] : g.map[k].length;
      o['__count__'] = g.map[k].length;
      return o;
    }).sort(function (a, b) { return (b.__metric__ || 0) - (a.__metric__ || 0); });
    var total = items.reduce(function (s, i) { return s + (i.__metric__ || 0); }, 0);
    items.forEach(function (i) { i['__share__'] = total ? i.__metric__ / total : 0; });
    var first = items[0], second = items[1], last = items[items.length - 1];
    var kpis = [];
    if (metric) kpis.push({ label: '领先：' + first.label, value: fmt(first.__metric__), sub: '占比 ' + (first.__share__ * 100).toFixed(1) + '%' });
    if (second) {
      var gapv = pct(first.__metric__, second.__metric__);
      kpis.push({ label: '对比 ' + second.label, value: fmt(second.__metric__), sub: '领先 ' + (gapv != null ? (gapv * 100).toFixed(1) + '%' : '-'), trend: gapv });
    }
    kpis.push({ label: '末位：' + last.label, value: fmt(last.__metric__), sub: '占比 ' + (last.__share__ * 100).toFixed(1) + '%' });
    var cv = std(items.map(function (i) { return i.__metric__ || 0; })) / (mean(items.map(function (i) { return i.__metric__ || 0; })) || 1);
    kpis.push({ label: '离散度 CV', value: cv.toFixed(2), sub: cv > 0.5 ? '差异显著' : '相对均衡' });

    var insights = [];
    insights.push('按 <b>' + dim + '</b> 对比' + aggLabel(plan.agg) + (metric || '记录数') + '，<b>' + first.label + '</b> 最高（' + fmt(first.__metric__) + '，占 <b>' + (first.__share__ * 100).toFixed(1) + '%</b>）。');
    if (second) {
      var d = first.__metric__ - second.__metric__;
      insights.push('第一名比第二名（' + second.label + '）高 <b>' + fmt(d) + '</b>，领先幅度 <b>' + (pct(first.__metric__, second.__metric__) * 100).toFixed(1) + '%</b>。');
    }
    var top3 = items.slice(0, 3).reduce(function (s, i) { return s + i.__share__; }, 0);
    insights.push('前 3 位合计占比 <b>' + (top3 * 100).toFixed(1) + '%</b>，' + (top3 > 0.6 ? '头部集中度较高。' : '分布相对分散。'));
    insights.push('末位 ' + last.label + ' 与第一名的差距为 <b>' + fmt(first.__metric__ - last.__metric__) + '</b>，' + (cv > 0.5 ? '各' + dim + '之间差异显著，建议关注资源倾斜。' : '整体差异可控。'));

    var cols = ['label'].concat(plan.metrics).concat(['__share__', '__count__']);
    return {
      intent: 'compare',
      title: plan.title || (dim + ' 维度对比 · ' + aggLabel(plan.agg) + (metric || '')),
      subtitle: ds.name + ' · ' + rows.length + ' 行' + filterDesc(plan),
      kpis: kpis, insights: insights,
      table: { columns: cols, rows: items.slice(0, 30), labels: { label: dim, __share__: '占比', __count__: '记录数' }, pctCols: ['__share__'] },
      chart: { type: plan.chart === 'pie' ? 'pie' : 'bar', labels: items.map(function (i) { return i.label; }), series: [{ name: aggLabel(plan.agg) + (metric || '记录数'), data: items.map(function (i) { return i.__metric__; }) }] },
      plan: plan
    };
  }

  /* ---------- 导出 CSV ---------- */
  function toCSV(table) {
    if (!table || !table.columns) return '';
    var labels = table.labels || {};
    var head = table.columns.map(function (c) { return labels[c] || c; });
    var lines = [head.join(',')];
    table.rows.forEach(function (r) {
      lines.push(table.columns.map(function (c) {
        var v = r[c];
        if (v == null) return '';
        var s = v instanceof Date
          ? (v.getFullYear() + '-' + String(v.getMonth() + 1).padStart(2, '0') + '-' + String(v.getDate()).padStart(2, '0'))
          : String(v);
        return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
      }).join(','));
    });
    return lines.join('\n');
  }

  global.DAAnalytics = {
    schemaSummary: schemaSummary,
    rulePlan: rulePlan,
    validatePlan: validatePlan,
    executePlan: executePlan,
    fmt: fmt, pct: pct, mean: mean, std: std,
    toCSV: toCSV
  };
})(window);
