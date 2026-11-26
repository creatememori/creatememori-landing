import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const SOURCE_URL = 'https://creatememori.github.io/';
const DEMO_PER_CATEGORY = 8;
const args = process.argv.slice(2);
const fileArgIndex = args.indexOf('--file');
const localFile = fileArgIndex >= 0 ? args[fileArgIndex + 1] : null;

const readSource = async () => {
  if (localFile) {
    return {
      html: fs.readFileSync(path.resolve(localFile), 'utf8'),
      lastModified: await fetchLastModified(),
    };
  }

  const response = await fetch(`${SOURCE_URL}?sync=${Date.now()}`, {
    headers: { 'user-agent': 'MEMORI-demo-data-sync/1.0' },
    cache: 'no-store',
  });
  if (!response.ok) throw new Error(`Source fetch failed: ${response.status}`);
  return {
    html: await response.text(),
    lastModified: await fetchLastModified(),
  };
};

const fetchLastModified = async () => {
  try {
    const response = await fetch('https://api.github.com/repos/creatememori/creatememori.github.io/commits?per_page=1', {
      headers: { 'user-agent': 'MEMORI-demo-data-sync/1.0', accept: 'application/vnd.github+json' },
      cache: 'no-store',
    });
    if (response.ok) {
      const commits = await response.json();
      if (commits[0]?.commit?.author?.date) return commits[0].commit.author.date;
    }
  } catch {}
  try {
    const response = await fetch(SOURCE_URL, { method: 'HEAD', cache: 'no-store' });
    return response.headers.get('last-modified') || new Date().toUTCString();
  } catch {
    return new Date().toUTCString();
  }
};

const parseArray = (html, marker, pattern) => {
  const match = html.match(pattern);
  if (!match) throw new Error(`Unable to parse ${marker}`);
  return vm.runInNewContext(match[1]);
};

const toDate = (value) => {
  const match = String(value || '').match(/(\d{1,2})-(\d{1,2})/);
  if (!match) return null;
  return new Date(2026, Number(match[1]) - 1, Number(match[2]));
};

const parseDeadline = (value) => {
  if (!value) return null;
  let match = String(value).match(/(202\d)-(\d{1,2})-(\d{1,2})/);
  if (match) return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  match = String(value).match(/(\d{1,2}) 月 (\d{1,2}) 日/);
  if (match) return new Date(2026, Number(match[1]) - 1, Number(match[2]));
  return null;
};

const daysLeft = (deadline) => {
  if (!deadline) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.round((deadline - today) / 86400000);
};

const effectiveStatus = (rawStatus, deadline) => {
  const days = daysLeft(deadline);
  if (days === null) return rawStatus;
  if (days < 0 && (rawStatus === '有效' || rawStatus === '即将过期')) return '已过期';
  if (days === 0 && rawStatus === '有效') return '即将过期';
  return rawStatus;
};

const titleKey = (title) => String(title).toLowerCase()
  .replace(/（[^）]*）/g, '')
  .replace(/\([^)]*\)/g, '')
  .replace(/[\s\-—_·:：,，.。\/\\]/g, '');

const { html, lastModified } = await readSource();
const items = parseArray(html, 'ITEMS', /var ITEMS=(\[[\s\S]*?\n\]);/);
const categoryOrder = parseArray(html, 'CAT_ORDER', /var CAT_ORDER=(\[[^\]]*\]);/);
const subcatRaw = html.match(/var SUBCAT=\{([\s\S]*?)\n\};/);
const fallbackRaw = html.match(/var SUB_FALLBACK=(\{.*?\});/);
if (!subcatRaw || !fallbackRaw) throw new Error('Unable to parse subcategory maps');
const subMap = vm.runInNewContext(`({${subcatRaw[1]}})`);
const fallbackMap = vm.runInNewContext(`(${fallbackRaw[1]})`);
const periodRank = { 晚: 3, 中午: 2, 早: 1 };

const normalized = items.map((item, index) => {
  const deadline = parseDeadline(item[8]);
  const rawStatus = item[5];
  return {
    index,
    title: item[0],
    cat: item[1],
    sub: subMap[item[0]] || fallbackMap[item[1]] || '其他',
    date: item[2],
    period: item[3],
    heat: item[4],
    status: effectiveStatus(rawStatus, deadline),
    rawStatus,
    desc: item[6],
    url: item[7],
    deadline: item[8],
    deadlineDays: daysLeft(deadline),
    day: toDate(item[2]),
    key: titleKey(item[0]),
  };
});

const statusCounts = normalized.reduce((result, item) => {
  result[item.status] = (result[item.status] || 0) + 1;
  return result;
}, {});

const total = normalized.length;
const active = statusCounts['有效'] || 0;
const subCount = new Set(normalized.map((item) => `${item.cat}/${item.sub}`)).size;
const categoryCounts = categoryOrder.map((name) => ({
  name,
  count: normalized.filter((item) => item.cat === name).length,
}));
const dates = [...new Set(normalized.map((item) => item.date))]
  .sort((a, b) => toDate(a) - toDate(b))
  .map((date) => {
    const dayItems = normalized.filter((item) => item.date === date);
    return {
      date,
      count: dayItems.length,
      morning: dayItems.filter((item) => item.period === '早').length,
      noon: dayItems.filter((item) => item.period === '中午').length,
      evening: dayItems.filter((item) => item.period === '晚').length,
    };
  });

const demoItems = [];
const usedTitles = new Set();
const pickedByCategory = new Map();
for (const name of categoryOrder) {
  const candidates = normalized
    .filter((item) => item.cat === name)
    .sort((a, b) => (b.day - a.day) || (periodRank[b.period] - periodRank[a.period]) || (a.index - b.index));
  const picked = [];
  for (const item of candidates) {
    if (usedTitles.has(item.key)) continue;
    usedTitles.add(item.key);
    picked.push({
      title: item.title,
      cat: item.cat,
      sub: item.sub,
      date: item.date,
      period: item.period,
      heat: item.heat,
      status: item.status,
      desc: item.desc,
      url: item.url,
      deadline: item.deadline,
      deadlineDays: item.deadlineDays,
    });
    if (picked.length === DEMO_PER_CATEGORY) break;
  }
  pickedByCategory.set(name, picked);
}
// Interleave the categories so the first page shows the full breadth, while every
// category still contributes its latest eight items.
const maxPicked = Math.max(...[...pickedByCategory.values()].map((picked) => picked.length));
for (let round = 0; round < maxPicked; round += 1) {
  for (const name of categoryOrder) {
    const item = pickedByCategory.get(name)?.[round];
    if (item) demoItems.push(item);
  }
}

const payload = {
  meta: {
    sourceUrl: SOURCE_URL,
    sourceUpdated: lastModified,
    total,
    active,
    activePct: total ? Math.round((active / total) * 100) : 0,
    subCount,
    categoryCount: categoryCounts.length,
    categories: categoryCounts,
    dates,
    statusCounts,
    demoCount: demoItems.length,
    demoPerCategory: DEMO_PER_CATEGORY,
    rangeStart: dates[0]?.date || '',
    rangeEnd: dates[dates.length - 1]?.date || '',
  },
  items: demoItems,
};

const outputPath = path.join(process.cwd(), 'demo-data.js');
const output = `window.MEMORI_DEMO = ${JSON.stringify(payload, null, 2)};\n`;
fs.writeFileSync(outputPath, output, 'utf8');

const categoriesWithFewer = categoryOrder.filter((name) => demoItems.filter((item) => item.cat === name).length < DEMO_PER_CATEGORY);
console.log(`Synced ${total} items; ${active} active; ${subCount} category/sub pairs; ${demoItems.length} demo items.`);
if (categoriesWithFewer.length) console.warn(`Fewer demo items for: ${categoriesWithFewer.join(', ')}`);
console.log(`Source updated: ${lastModified}`);
console.log(`Wrote ${outputPath}`);
