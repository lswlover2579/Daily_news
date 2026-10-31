#!/usr/bin/env node
/**
 * 晨间情报 · 数据生成器
 * 用法：node fetch-news.mjs
 * 可选环境变量：LLM_API_KEY / LLM_BASE_URL / LLM_MODEL / LLM_MAX_ITEMS
 * 无任何第三方依赖，Node 20+。
 */
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = dirname(fileURLToPath(import.meta.url));
const CONFIG = JSON.parse(await readFile(join(ROOT, 'feeds.json'), 'utf8'));
const S = Object.assign({ windowHours: 30, perPool: 10, maxPerFeed: 12, providers: ['bing', 'google'] }, CONFIG.settings || {});
const DRY = process.argv.includes('--dry');

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

/* ---------------- 基础工具 ---------------- */

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', hellip: '…', mdash: '—', ndash: '–', ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’', middot: '·', copy: '©' };

function decode(s) {
  return String(s || '').replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const n = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
    }
    return ENT[e.toLowerCase()] ?? m;
  });
}

function stripHtml(s) {
  let out = String(s || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ');
  out = decode(out).replace(/<[^>]+>/g, ' ');
  return out.replace(/\s+/g, ' ').trim();
}

const norm = (s) => String(s || '').toLowerCase().replace(/[\s\u3000\p{P}\p{S}]/gu, '');

function tag(block, name) {
  const m = block.match(new RegExp('<' + name + '(?:\\s[^>]*)?>([\\s\\S]*?)<\\/' + name + '>', 'i'));
  return m ? m[1] : '';
}
function cdata(s) {
  return String(s || '').replace(/^\s*<!\[CDATA\[/, '').replace(/\]\]>\s*$/, '').trim();
}

function hash(s) {
  return createHash('sha1').update(String(s)).digest('hex').slice(0, 12);
}

async function mapLimit(list, limit, fn) {
  const out = new Array(list.length);
  let i = 0;
  async function worker() {
    while (i < list.length) {
      const idx = i++;
      try { out[idx] = await fn(list[idx], idx); }
      catch (e) { out[idx] = { __error: e }; }
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, list.length)) }, worker));
  return out;
}

/* ---------------- 抓取 ---------------- */

async function get(url) {
  const res = await fetch(url, {
    headers: {
      'user-agent': UA,
      accept: 'application/rss+xml, application/xml, text/xml, */*',
      'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return await res.text();
}

function searchUrl(provider, q) {
  const zh = /[\u4e00-\u9fff]/.test(q);
  if (provider === 'bing') {
    return 'https://www.bing.com/news/search?q=' + encodeURIComponent(q)
      + '&format=rss&setlang=' + (zh ? 'zh-cn' : 'en-us')
      + '&cc=' + (zh ? 'cn' : 'us');
  }
  return 'https://news.google.com/rss/search?q=' + encodeURIComponent(q)
    + '&hl=' + (zh ? 'zh-CN' : 'en-US')
    + '&gl=' + (zh ? 'CN' : 'US')
    + '&ceid=' + (zh ? 'CN:zh-Hans' : 'US:en');
}

function parseFeed(xml) {
  const blocks = xml.match(/<(item|entry)(?:\s[^>]*)?>[\s\S]*?<\/\1>/gi) || [];
  const out = [];
  for (const b of blocks) {
    let title = stripHtml(cdata(tag(b, 'title')));
    if (!title) continue;

    let link = cdata(tag(b, 'link'));
    if (!link || link.includes('<')) {
      const m = b.match(/<link[^>]+href=["']([^"']+)["']/i);
      if (m) link = m[1];
    }
    link = decode(link).trim();

    const dateRaw = stripHtml(cdata(tag(b, 'pubDate') || tag(b, 'published') || tag(b, 'updated') || tag(b, 'dc:date')));
    let date = dateRaw ? new Date(dateRaw) : new Date();
    if (isNaN(date)) date = new Date();

    let desc = stripHtml(cdata(tag(b, 'description') || tag(b, 'summary') || tag(b, 'content:encoded') || tag(b, 'content')));

    let source = stripHtml(cdata(tag(b, 'source')));
    if (!source) {
      // 标题尾部 “ - 媒体名”
      const m = title.match(/\s[-–—]\s([^-–—]{2,18})$/);
      if (m && !/[。！？!?]/.test(m[1])) { source = m[1].trim(); title = title.slice(0, m.index).trim(); }
    }

    if (norm(desc).startsWith(norm(title)) && desc.length < title.length + 40) desc = '';

    out.push({ title, url: link, publishedAt: date.toISOString(), desc, source });
  }
  return out;
}

/* ---------------- 评分与去重 ---------------- */

const HOT = [
  [/战争|开战|空袭|导弹|冲突升级|爆炸/, 14],
  [/加息|降息|降准|利率决议|央行|美联储|通胀数据/, 10],
  [/制裁|关税|出口管制|禁令|实体清单|反倾销/, 10],
  [/军演|演习|航母|战备警巡|军事部署/, 8],
  [/历史新高|暴跌|暴涨|熔断|停牌|违约/, 8],
  [/财报|业绩|指引|发布会|量产/, 4],
];

function scoreItem(it, now) {
  let s = (it.weight || 2) * 8;
  const text = it.title + ' ' + it.desc;
  for (const [re, w] of HOT) if (re.test(text)) s += w;
  const h = Math.max(0, (now - new Date(it.publishedAt)) / 36e5);
  s += Math.max(0, 12 - h / 2);
  return s;
}

const STOP = new Set('the a an and or of to in on for with at by from is are was were be been as its it this that will has have had not but'.split(' '));

function tokens(s) {
  const set = new Set();
  const lower = String(s || '').toLowerCase();
  for (const w of lower.match(/[a-z0-9]{2,}/g) || []) if (!STOP.has(w)) set.add(w);
  for (const seg of lower.match(/[\u4e00-\u9fff]+/g) || []) {
    for (let i = 0; i < seg.length - 1; i++) set.add(seg.slice(i, i + 2));
    if (seg.length === 1) set.add(seg);
  }
  return set;
}

function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

function dedupe(list) {
  const kept = [];
  for (const it of list) {
    const t = tokens(it.title);
    let merged = false;
    for (const k of kept) {
      if (it.url && k.url && it.url === k.url) { k.alsoCount++; merged = true; break; }
      if (jaccard(t, k._tok) >= 0.46) {
        k.alsoCount++;
        if (it.source && k.source !== it.source) k.alsoSources.push(it.source);
        merged = true;
        break;
      }
    }
    if (!merged) { it._tok = t; it.alsoCount = 1; it.alsoSources = []; kept.push(it); }
  }
  return kept;
}

/* ---------------- 市场影响规则 ---------------- */

const RULES = [
  {
    re: /黄金|金价|购金|金矿|bullion|gold price|\bgold\b/i,
    tags: ['黄金', '避险'],
    text: '金价的三条主线：美元与实际利率（反向）、央行购金（结构性买盘）、ETF 与投机持仓（情绪）。短线看美元指数和 10 年期实际收益率，中线看央行净购金能否延续。',
  },
  {
    re: /内存|存储|闪存|DRAM|NAND|HBM|长鑫|长江存储|美光|海力士|三星电子/i,
    tags: ['存储', '半导体'],
    text: '存储是典型的价格周期品：涨价通常来自供给收缩（减产、转产 HBM）叠加 AI 服务器需求。关注合约价、原厂资本开支、模组厂库存天数三个指标。',
  },
  {
    re: /人工智能|大模型|算力|AI 芯片|GPU|英伟达|OpenAI|Anthropic|\bAI\b/i,
    tags: ['AI', '算力'],
    text: 'AI 链条看三层：算力（GPU/HBM/先进封装）→ 模型（训练成本、推理价格战）→ 应用（付费率）。资本开支指引比单季业绩更能决定估值。',
  },
  {
    re: /军演|演习|航母|战备警巡|军事部署|military exercise|carrier/i,
    tags: ['地缘', '军工'],
    text: '军演升级通常先影响风险溢价：航运运费与保险费、原油与天然气、避险资产（黄金、美债、日元）。持续性取决于是否涉及禁航区或实弹科目。',
  },
  {
    re: /台湾|台海|两岸|台北|台积电|Taiwan|TSMC/i,
    tags: ['台海', '半导体'],
    text: '台海风险的传导路径：半导体供应链（先进制程产能）→ 航运（台湾海峡、巴士海峡）→ 外资风险偏好。多数情形是情绪冲击，实质断供才会重定价。',
  },
  {
    re: /加息|降息|美联储|利率|央行|流动性|MLF|LPR|Fed\b/i,
    tags: ['利率', '流动性'],
    text: '利率是估值之锚：降息预期升温利多成长股与黄金、利空美元；但若因衰退而降息，风险资产未必受益。看 2 年期美债与政策指引，而不是单次操作。',
  },
  {
    re: /关税|制裁|出口管制|禁令|实体清单|反倾销|CBAM|碳边境/i,
    tags: ['贸易', '供给'],
    text: '贸易管制直接改变供给曲线：受限环节涨价与国产替代同时发生。关注许可证细则、生效时间与过渡期，这决定冲击是一次性的还是持续的。',
  },
  {
    re: /原油|石油|OPEC|油价|天然气|LNG/i,
    tags: ['能源'],
    text: '油价看供给纪律与需求预期：OPEC+ 减产执行、地缘断供、库存数据。对国内偏成本端影响（化工、航空、物流），对上游是利润端。',
  },
  {
    re: /铜|稀土|锂|镍|铁矿|铝|资源|矿产|critical mineral/i,
    tags: ['资源'],
    text: '资源品看边际成本与库存周期；政策端（出口配额、收储、联合储备）会放大波动。下游需求看电网、新能源与地产三条线。',
  },
  {
    re: /半导体|芯片|晶圆|光刻|封装|制程/i,
    tags: ['半导体'],
    text: '半导体看稼动率与资本开支周期。先进制程与成熟制程已经分化，不要用同一个逻辑定价；设备与材料的订单滞后于资本开支一到两个季度。',
  },
  {
    re: /汇率|人民币|美元指数|日元|离岸/i,
    tags: ['汇率'],
    text: '汇率是相对价格：看利差、贸易顺差与干预意愿。贬值利好出口链，利空外币负债高的航空与地产；关注中间价与离岸价差。',
  },
  {
    re: /房地产|楼市|地产|城中村|保障房/i,
    tags: ['地产'],
    text: '地产看销售与融资两端，政策放松的边际效果取决于居民收入预期。产业链弹性排序：建材/家居 > 银行 > 家电。',
  },
  {
    re: /机器人|人形机器人|robot/i,
    tags: ['机器人'],
    text: '人形机器人仍在 0→1：看订单与量产指引，以及核心零部件（丝杠、减速器、灵巧手、力传感器）的国产化率。警惕发布会量产与真实交付的差距。',
  },
  {
    re: /财政|专项债|国债|赤字|预算/i,
    tags: ['财政'],
    text: '财政扩张看投向：基建、消费补贴还是化债。对债市是供给冲击，对股市是需求预期；实际效果看资金拨付与项目开工。',
  },
  {
    re: /就业|失业|消费|收入/i,
    tags: ['就业', '消费'],
    text: '就业与收入预期是消费复苏的前提。政策落地到消费数据通常有两到三个季度的滞后，先看招聘与工时，再看零售。',
  },
];

const POOL_DEFAULT = {
  cn: '对市场多为情绪与预期层面影响，关注后续政策细则与落地节奏。',
  intl: '国际事件先影响风险偏好与避险资产，再传导至供应链与大宗商品。',
  finance: '关注价格反应是否被后续数据确认，单日波动通常不代表趋势。',
  mil: '地缘事件对市场多为风险溢价冲击，持续性取决于冲突是否扩大。',
  tech: '科技事件看落地节奏与商业化路径：短期情绪，中期看订单与资本开支。',
  industry: '产业事件看供需与库存位置，价格传导通常有一到两个季度滞后。',
  policy: '政策看力度、节奏与执行，市场通常先交易预期、再修正。',
  gold: '金价短线看美元与实际利率，中线看央行购金与 ETF 流向。',
  drill: '军演对市场多为短期风险溢价，观察是否扩大到禁航与实弹。',
  memory: '存储价格看供给收缩与 AI 需求的叠加，跟踪合约价与库存。',
  ai: 'AI 看算力、模型、应用三层的景气传导，资本开支是最硬的指标。',
  taiwan: '台海事件先影响半导体供应链与航运风险溢价，再看外资流向。',
};

function decorate(it, poolId) {
  const text = it.title + ' ' + it.desc;
  const tags = [];
  let impact = '';
  for (const r of RULES) {
    if (r.re.test(text)) {
      r.tags.forEach((t) => { if (!tags.includes(t)) tags.push(t); });
      if (!impact) impact = r.text;
    }
  }
  it.tags = tags.slice(0, 4);
  it.impact = impact || POOL_DEFAULT[poolId] || '';
  return it;
}

function makeSummary(desc, max = 110) {
  const clean = String(desc || '').replace(/\s+/g, ' ').trim();
  if (!clean) return '';
  const parts = clean.split(/(?<=[。！？!?；;])\s*/);
  let out = '';
  for (const p of parts) {
    if (out && out.length + p.length > max) break;
    out += p;
    if (out.length >= max * 0.55) break;
  }
  out = out.trim();
  if (out.length > max + 20) out = out.slice(0, max) + '…';
  return out;
}

/* ---------------- 可选：LLM 摘要 ---------------- */

const LLM_PROMPT = '你是中文财经编辑。根据给定标题与原文摘要，输出严格 JSON：'
  + '{"summary":"60-90字，只陈述事实，2句话以内","context":"50-90字，交代来龙去脉或关键背景","impact":"70-110字，说明对市场/行业的传导逻辑与需要跟踪的指标"}。'
  + '不要编造数字、人名或未给出的事实；信息不足时宁可写得概括。不要输出 JSON 以外的文字。';

async function llmEnrich(items) {
  const key = process.env.LLM_API_KEY;
  if (!key || !items.length) return 0;
  const base = (process.env.LLM_BASE_URL || 'https://api.deepseek.com/v1').replace(/\/+$/, '');
  const model = process.env.LLM_MODEL || 'deepseek-chat';
  const max = Number(process.env.LLM_MAX_ITEMS || 30);
  const targets = items.filter((i) => i.desc && i.desc.length > 60).slice(0, max);
  let ok = 0;

  await mapLimit(targets, 3, async (it) => {
    const payload = {
      model,
      temperature: 0.3,
      messages: [
        { role: 'system', content: LLM_PROMPT },
        { role: 'user', content: `标题：${it.title}\n来源：${it.source}\n时间：${it.publishedAt}\n原文摘要：${it.desc.slice(0, 700)}` },
      ],
    };
    const call = async (withFormat) => {
      const body = Object.assign({}, payload);
      if (withFormat) body.response_format = { type: 'json_object' };
      const res = await fetch(base + '/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(40000),
      });
      if (!res.ok) throw new Error('LLM HTTP ' + res.status);
      return await res.json();
    };
    let json;
    try { json = await call(true); }
    catch { json = await call(false); }
    const content = json?.choices?.[0]?.message?.content || '';
    const obj = JSON.parse(String(content).replace(/^```(?:json)?/i, '').replace(/```$/, '').trim());
    if (obj.summary) it.summary = obj.summary;
    if (obj.context) it.context = obj.context;
    if (obj.impact) it.impact = obj.impact;
    it.ai = true;
    ok++;
  });

  return ok;
}

/* ---------------- 主流程 ---------------- */

async function main() {
  const started = Date.now();
  const now = new Date();
  const cutoff = now.getTime() - S.windowHours * 36e5;

  // 1. 直连 RSS：同一 URL 只抓一次
  const feedMap = new Map();
  const addFeed = (f, poolId) => {
    if (!f || !f.url) return;
    if (!feedMap.has(f.url)) feedMap.set(f.url, { url: f.url, source: f.source, weight: f.weight || 2, pools: [] });
    const t = feedMap.get(f.url);
    if (!t.pools.includes(poolId)) t.pools.push(poolId);
  };
  for (const c of CONFIG.categories) (c.feeds || []).forEach((f) => addFeed(f, c.id));
  for (const k of CONFIG.keywords) (k.feeds || []).forEach((f) => addFeed(f, k.id));

  // 2. 检索任务
  const queries = [];
  for (const c of CONFIG.categories) for (const q of c.queries || []) for (const p of S.providers) queries.push({ pool: c.id, q, provider: p });
  for (const k of CONFIG.keywords) for (const q of k.queries || []) for (const p of S.providers) queries.push({ pool: k.id, q, provider: p });

  console.log(`[1/4] 抓取 ${feedMap.size} 个 RSS、${queries.length} 个检索请求…`);

  let feedsOk = 0, feedsFailed = 0;
  const raw = [];
  const feedErrors = [];

  const feedResults = await mapLimit([...feedMap.values()], 6, async (f) => {
    try {
      const xml = await get(f.url);
      const items = parseFeed(xml).slice(0, S.maxPerFeed);
      return { f, items };
    } catch (e) {
      return { f, error: e.message };
    }
  });

  for (const r of feedResults) {
    if (!r || !r.f) continue;
    if (r.error) { feedsFailed++; feedErrors.push(`${r.f.source}: ${r.error}`); continue; }
    feedsOk++;
    for (const poolId of r.f.pools) {
      for (const it of r.items) {
        raw.push(Object.assign({}, it, { poolId, weight: r.f.weight, provider: 'rss' }));
      }
    }
  }

  const queryResults = await mapLimit(queries, 6, async (q) => {
    try {
      const xml = await get(searchUrl(q.provider, q.q));
      return { q, items: parseFeed(xml).slice(0, 20) };
    } catch (e) {
      return { q, error: e.message };
    }
  });

  let queryOk = 0;
  for (const r of queryResults) {
    if (!r || !r.q) continue;
    if (r.error) continue;
    queryOk++;
    for (const it of r.items) {
      raw.push(Object.assign({}, it, { poolId: r.q.pool, weight: 2, provider: r.q.provider }));
    }
  }

  console.log(`[2/4] RSS 成功 ${feedsOk} / 失败 ${feedsFailed}；检索成功 ${queryOk} / ${queries.length}`);

  // 3. 时间窗过滤 + 关键词跨栏目捞取
  const inWindow = (it) => {
    const t = new Date(it.publishedAt).getTime();
    return Number.isFinite(t) && t >= cutoff && t <= now.getTime() + 6 * 36e5;
  };

  const poolItems = new Map();
  const pushTo = (poolId, it) => {
    if (!poolItems.has(poolId)) poolItems.set(poolId, []);
    poolItems.get(poolId).push(it);
  };

  const catIds = new Set(CONFIG.categories.map((c) => c.id));
  for (const it of raw) {
    if (!inWindow(it)) continue;
    it.publishedAt = new Date(it.publishedAt).toISOString();
    pushTo(it.poolId, it);
  }

  // 关键词池：从综合栏目里二次捞取
  for (const k of CONFIG.keywords) {
    const res = (k.match || []).map((m) => {
      const safe = m.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return /^[a-z0-9 ]+$/i.test(m) ? new RegExp('\\b' + safe + '\\b', 'i') : new RegExp(safe, 'i');
    });
    if (!res.length) continue;
    for (const cid of catIds) {
      for (const it of poolItems.get(cid) || []) {
        if (res.some((re) => re.test(it.title + ' ' + it.desc))) {
          pushTo(k.id, Object.assign({}, it, { poolId: k.id, weight: (it.weight || 2) + 1 }));
        }
      }
    }
  }

  // 4. 每个池：评分 → 去重 → 排序 → 截断
  const buildPool = (pool) => {
    let list = poolItems.get(pool.id) || [];
    for (const it of list) {
      it.score = scoreItem(it, now.getTime());
      it.summary = makeSummary(it.desc);
      const full = String(it.desc || '').replace(/\s+/g, ' ').trim();
      it.excerpt = full && full.length > (it.summary || '').length + 24 ? full.slice(0, 420) : '';
      decorate(it, pool.id);
    }
    list.sort((a, b) => (b.score || 0) - (a.score || 0));
    list = dedupe(list);
    list.sort((a, b) => (b.score || 0) - (a.score || 0));
    list = list.slice(0, S.perPool);
    list.forEach((it, i) => {
      it.importance = i < 2 ? 3 : i < 6 ? 2 : 1;
      it.id = hash(it.url || it.title);
      it.score = Math.round(it.score || 0);
      it.alsoCount = it.alsoCount || 1;
      delete it._tok; delete it.weight; delete it.provider; delete it.poolId; delete it.alsoSources;
      if (!it.source) it.source = '未知来源';
      it.context = it.context || '';
      it.ai = !!it.ai;
    });
    return list;
  };

  const categories = CONFIG.categories.map((c) => ({ id: c.id, name: c.name, desc: c.desc, items: buildPool(c) }));
  const keywords = CONFIG.keywords.map((k) => ({ id: k.id, name: k.name, desc: k.desc, items: buildPool(k) }));

  const all = categories.concat(keywords).flatMap((p) => p.items);
  if (!all.length) {
    console.error('[!] 一条新闻都没抓到，已保留旧数据不覆盖。请检查网络或 feeds.json。');
    console.error(feedErrors.slice(0, 8).join('\n'));
    process.exit(1);
  }

  // 5. 可选 AI 增强（按 URL 去重，优先高分条目）
  const uniq = new Map();
  for (const it of all.slice().sort((a, b) => (b.score || 0) - (a.score || 0))) {
    if (it.url && !uniq.has(it.url)) uniq.set(it.url, it);
  }
  const aiCount = await llmEnrich([...uniq.values()]);
  if (aiCount) console.log(`[3/4] AI 摘要完成 ${aiCount} 条`);
  for (const it of all) delete it.desc;

  // 6. 输出
  const sources = new Set(all.map((i) => i.source));
  const out = {
    version: 1,
    generatedAt: new Date().toISOString(),
    windowHours: S.windowHours,
    sample: false,
    stats: {
      items: all.length,
      sources: sources.size,
      feedsOk,
      feedsFailed,
      queries: queries.length,
      queriesOk: queryOk,
      ai: aiCount,
    },
    categories,
    keywords,
  };

  const json = JSON.stringify(out, null, 2);
  if (DRY) {
    console.log(json.slice(0, 1200));
    return;
  }
  await writeFile(join(ROOT, 'data.json'), json, 'utf8');

  console.log(`[4/4] 已写入 data.json：${all.length} 条 / ${sources.size} 家来源，用时 ${((Date.now() - started) / 1000).toFixed(1)}s`);
  for (const p of categories.concat(keywords)) console.log(`  · ${p.name}  ${p.items.length} 条`);
  if (feedErrors.length) console.log('\n部分源失败：\n' + feedErrors.slice(0, 8).join('\n'));
}

main().catch((e) => { console.error(e); process.exit(1); });
