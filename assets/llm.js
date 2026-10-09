/* DataMind · 大模型接入层（OpenAI 兼容接口，浏览器直连，密钥仅存本机）
   职责：1) 把自然语言问题转成结构化分析计划 2) 基于计算结果生成洞察结论 */
(function (global) {
  'use strict';

  var DEFAULT_BASE = 'https://api.openai.com/v1';
  var DEFAULT_MODEL = 'gpt-4o-mini';
  var TIMEOUT = 45000;

  function cfg() {
    var c = global.DAStore.store.getConfig() || {};
    return {
      baseUrl: (c.baseUrl || DEFAULT_BASE).replace(/\/+$/, ''),
      apiKey: c.apiKey || '',
      model: c.model || DEFAULT_MODEL
    };
  }
  function isConfigured() { var c = cfg(); return !!c.apiKey && !!c.model; }

  function extractJSON(text) {
    var s = String(text || '').trim();
    var fence = s.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fence) s = fence[1].trim();
    var start = s.search(/[[{]/);
    if (start > 0) s = s.slice(start);
    var end = Math.max(s.lastIndexOf('}'), s.lastIndexOf(']'));
    if (end >= 0) s = s.slice(0, end + 1);
    return JSON.parse(s);
  }

  function chat(messages, opts) {
    opts = opts || {};
    var c = cfg();
    if (!c.apiKey) return Promise.reject(new Error('未配置 API Key'));
    var ctrl = new AbortController();
    var timer = setTimeout(function () { ctrl.abort(); }, opts.timeout || TIMEOUT);
    return fetch(c.baseUrl + '/chat/completions', {
      method: 'POST',
      signal: ctrl.signal,
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + c.apiKey },
      body: JSON.stringify({
        model: c.model,
        messages: messages,
        temperature: opts.temperature == null ? 0.2 : opts.temperature,
        max_tokens: opts.max_tokens || 1200
      })
    }).then(function (res) {
      clearTimeout(timer);
      if (!res.ok) {
        return res.text().then(function (t) {
          throw new Error('模型返回 ' + res.status + '：' + String(t).slice(0, 180));
        });
      }
      return res.json();
    }).then(function (j) {
      var content = j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
      if (!content) throw new Error('模型返回内容为空');
      return String(content).trim();
    }).catch(function (e) {
      clearTimeout(timer);
      if (e && e.name === 'AbortError') throw new Error('模型请求超时');
      throw e;
    });
  }

  var PLAN_SYSTEM = '你是一名资深数据分析师，负责把用户的自然语言问题转成结构化分析计划。' +
    '只输出一个 JSON 对象，不要输出任何解释、不要使用 markdown 代码块以外的内容。字段约定：\n' +
    '{\n' +
    ' "intent": "query" | "trend" | "anomaly" | "compare",\n' +
    ' "title": "简短中文标题，不超过 18 个字",\n' +
    ' "metrics": ["数值字段名"],\n' +
    ' "dimension": "分组用的文本字段名或 null",\n' +
    ' "timeField": "日期字段名或 null",\n' +
    ' "period": "day" | "week" | "month" | "year",\n' +
    ' "agg": "sum" | "avg" | "count" | "max" | "min",\n' +
    ' "filters": [{"field":"字段名","op":"="|"!="|">"|"<"|">="|"<="|"contains","value":"值"}],\n' +
    ' "topN": 数字或 null,\n' +
    ' "chart": "line" | "bar" | "pie" | "scatter" | "table",\n' +
    ' "anomalyMethod": "iqr" | "zscore"\n' +
    '}\n' +
    '规则：字段名必须严格来自给定的字段列表；涉及时间变化/趋势用 trend 且必须填 timeField 与 period；' +
    '找异常/离群/突变用 anomaly；比较/排名/占比/构成用 compare；其余明细查询用 query；' +
    '无法确定时使用最合理的默认值。';

  function plan(question, summary) {
    var colDesc = summary.columns.map(function (c) {
      var extra = '';
      if (c.type === 'number') extra = '（数值，范围 ' + c.min + ' ~ ' + c.max + '，均值 ' + c.avg + '）';
      else if (c.type === 'date') extra = '（日期，' + (c.min || '?') + ' ~ ' + (c.max || '?') + '）';
      else extra = '（文本，样例：' + (c.samples || []).slice(0, 6).join('、') + '）';
      return '- ' + c.name + '：' + c.type + extra;
    }).join('\n');
    var user = '数据集：' + summary.name + '，共 ' + summary.rowCount + ' 行。\n字段列表：\n' + colDesc +
      '\n\n用户问题：' + question + '\n\n请输出分析计划 JSON。';
    return chat([
      { role: 'system', content: PLAN_SYSTEM },
      { role: 'user', content: user }
    ], { temperature: 0.1, max_tokens: 600 }).then(function (txt) {
      var obj = extractJSON(txt);
      obj.source = 'llm';
      return obj;
    });
  }

  var INSIGHT_SYSTEM = '你是资深数据分析师。基于给定的计算结果，用中文输出 3~5 条业务洞察与建议。' +
    '要求：结论先行、必须引用具体数字、指出原因假设与可执行建议，语言简洁专业。' +
    '只输出一个 JSON 数组，元素为字符串，例如 ["洞察1","洞察2"]，不要输出多余内容。数字可用 <b> 标签强调。';

  function insights(question, result, summary) {
    var payload = {
      问题: question,
      数据集: summary.name + '（' + summary.rowCount + ' 行）',
      分析类型: result.intent,
      标题: result.title,
      关键指标: (result.kpis || []).slice(0, 6).map(function (k) { return k.label + ' = ' + k.value + (k.sub ? '（' + k.sub + '）' : ''); }),
      计算结果: (result.table && result.table.rows ? result.table.rows.slice(0, 15) : [])
    };
    return chat([
      { role: 'system', content: INSIGHT_SYSTEM },
      { role: 'user', content: JSON.stringify(payload, null, 1) }
    ], { temperature: 0.4, max_tokens: 900 }).then(function (txt) {
      var arr = extractJSON(txt);
      if (!Array.isArray(arr)) arr = [String(arr)];
      return arr.filter(function (x) { return typeof x === 'string' && x.trim(); }).slice(0, 6);
    });
  }

  function test() {
    if (!isConfigured()) return Promise.reject(new Error('请先填写 API Key 与模型名称'));
    return chat([{ role: 'user', content: '回复两个字：正常' }], { max_tokens: 20, timeout: 20000 })
      .then(function (t) { return { ok: true, msg: '连接成功，模型回复：' + t.slice(0, 30) }; });
  }

  global.DALLM = {
    cfg: cfg, isConfigured: isConfigured, plan: plan, insights: insights, test: test
  };
})(window);
