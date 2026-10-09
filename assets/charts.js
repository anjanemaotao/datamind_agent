/* DataMind · 图表渲染层（ECharts） */
(function (global) {
  'use strict';

  var PALETTE = ['#2563eb', '#0f9960', '#f59e0b', '#7c3aed', '#0891b2', '#e11d48', '#65a30d', '#9333ea'];

  function available() { return typeof global.echarts !== 'undefined'; }

  function base(title) {
    return {
      color: PALETTE,
      grid: { left: 56, right: 24, top: 34, bottom: 52 },
      tooltip: { trigger: 'axis', backgroundColor: 'rgba(255,255,255,.96)', borderColor: '#e6eaf0', textStyle: { color: '#1c2430', fontSize: 12 } },
      legend: { top: 4, textStyle: { color: '#5b6675', fontSize: 12 }, itemHeight: 8, itemWidth: 14 },
      title: { text: title || '', left: 10, top: 4, textStyle: { fontSize: 12, color: '#8b95a5', fontWeight: 'normal' } },
      textStyle: { fontFamily: '-apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif' }
    };
  }

  function buildOption(chart) {
    if (!chart) return null;
    var labels = chart.labels || [];
    var s0 = (chart.series && chart.series[0]) || { name: '值', data: [] };
    var opt;

    if (chart.type === 'line') {
      opt = base();
      opt.grid.top = 30;
      opt.xAxis = {
        type: 'category', data: labels, boundaryGap: false,
        axisLine: { lineStyle: { color: '#dfe5ee' } },
        axisLabel: { color: '#8b95a5', fontSize: 11, hideOverlap: true, rotate: labels.length > 14 ? 35 : 0 }
      };
      opt.yAxis = {
        type: 'value', splitLine: { lineStyle: { color: '#f0f3f7' } },
        axisLabel: { color: '#8b95a5', fontSize: 11, formatter: function (v) { return shortNum(v); } }
      };
      opt.series = [{
        name: s0.name, type: 'line', smooth: true, symbolSize: 6,
        data: s0.data,
        lineStyle: { width: 2.4 },
        areaStyle: { color: 'rgba(37,99,235,.10)' },
        markLine: (chart.marks && chart.marks.length) ? {
          symbol: 'none', silent: true,
          label: { formatter: '波动点', color: '#b7791f', fontSize: 10 },
          lineStyle: { color: '#f59e0b', type: 'dashed', width: 1 },
          data: chart.marks.map(function (m) { return { xAxis: m }; })
        } : undefined
      }];
      return opt;
    }

    if (chart.type === 'pie') {
      var data = labels.map(function (l, i) { return { name: l, value: s0.data[i] }; });
      opt = base();
      opt.grid = undefined;
      opt.tooltip = { trigger: 'item', formatter: '{b}: {c} ({d}%)' };
      opt.series = [{
        name: s0.name, type: 'pie', radius: ['38%', '66%'], center: ['50%', '56%'],
        itemStyle: { borderColor: '#fff', borderWidth: 2 },
        label: { fontSize: 11, color: '#5b6675', formatter: '{b}\n{d}%' },
        data: data
      }];
      return opt;
    }

    if (chart.type === 'scatter') {
      var idx = chart.anomalyIdx || [];
      var pts = (s0.data || []).map(function (v, i) { return [i + 1, v]; });
      opt = base();
      opt.tooltip = { trigger: 'item', formatter: function (p) { return '第 ' + p.data[0] + ' 行<br/>' + s0.name + '：' + p.data[1]; } };
      opt.xAxis = { type: 'value', name: '行号', nameTextStyle: { color: '#8b95a5' }, splitLine: { lineStyle: { color: '#f0f3f7' } }, axisLabel: { color: '#8b95a5', fontSize: 11 } };
      opt.yAxis = { type: 'value', splitLine: { lineStyle: { color: '#f0f3f7' } }, axisLabel: { color: '#8b95a5', fontSize: 11, formatter: function (v) { return shortNum(v); } } };
      opt.series = [{
        name: s0.name, type: 'scatter', symbolSize: 5, data: pts,
        itemStyle: {
          color: function (p) { return idx.indexOf(p.data[0]) >= 0 ? '#d93025' : 'rgba(37,99,235,.55)'; }
        },
        markLine: chart.thresholds ? {
          symbol: 'none', silent: true,
          lineStyle: { color: '#d93025', type: 'dashed', width: 1 },
          label: { fontSize: 10, color: '#d93025' },
          data: [
            { yAxis: chart.thresholds.hi, name: '上界' },
            { yAxis: chart.thresholds.lo, name: '下界' },
            { yAxis: chart.thresholds.mean, name: '均值', lineStyle: { color: '#8b95a5', type: 'dotted' }, label: { color: '#8b95a5' } }
          ]
        } : undefined
      }];
      return opt;
    }

    // bar（默认）
    opt = base();
    opt.xAxis = {
      type: 'category', data: labels,
      axisLine: { lineStyle: { color: '#dfe5ee' } },
      axisLabel: { color: '#8b95a5', fontSize: 11, interval: 0, rotate: labels.length > 10 ? 35 : 0, hideOverlap: true }
    };
    opt.yAxis = { type: 'value', splitLine: { lineStyle: { color: '#f0f3f7' } }, axisLabel: { color: '#8b95a5', fontSize: 11, formatter: function (v) { return shortNum(v); } } };
    opt.series = [{
      name: s0.name, type: 'bar', data: s0.data, barMaxWidth: 34,
      itemStyle: { borderRadius: [4, 4, 0, 0] }
    }];
    return opt;
  }

  function shortNum(v) {
    if (typeof v !== 'number') return v;
    var a = Math.abs(v);
    if (a >= 1e8) return (v / 1e8).toFixed(1) + '亿';
    if (a >= 1e4) return (v / 1e4).toFixed(1) + '万';
    return String(Math.round(v * 100) / 100);
  }

  function render(el, chart) {
    if (!el) return null;
    if (!available()) {
      el.innerHTML = '<div class="chart-fallback">图表库未加载（离线环境），已自动改用明细表格展示。结果数值不受影响。</div>';
      return null;
    }
    var opt = buildOption(chart);
    if (!opt) { el.innerHTML = ''; return null; }
    var inst = global.echarts.getInstanceByDom(el) || global.echarts.init(el);
    inst.setOption(opt, true);
    inst.resize();
    return inst;
  }

  global.DACharts = { render: render, buildOption: buildOption, available: available };
})(window);
