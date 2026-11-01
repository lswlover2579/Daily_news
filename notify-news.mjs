#!/usr/bin/env node
/**
 * 晨间情报通知器
 * 默认关闭。仅当 NOTIFY_ENABLED=true 且配置了通知渠道时才会发送。
 * 支持飞书自定义机器人、Telegram Bot、Resend 邮件 API；Node 20+，无第三方依赖。
 */
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const MAX_MESSAGE_CHARS = 3500;
const MAX_ITEMS = 12;

function flatten(data) {
  return [...(data.categories || []), ...(data.keywords || [])]
    .flatMap((pool) => (pool.items || []).map((item) => ({ ...item, poolName: pool.name || pool.id || '' })));
}

function uniqueItems(items) {
  const seen = new Set();
  return items
    .slice()
    .sort((a, b) => (b.importance || 0) - (a.importance || 0) || (b.score || 0) - (a.score || 0))
    .filter((item) => {
      const key = item.url ? `url:${item.url}` : `id:${item.id || item.title}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function truncate(text, max) {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  return value.length > max ? value.slice(0, max - 1) + '…' : value;
}

export function formatNotification(items) {
  const unique = uniqueItems(items);
  const selected = unique.slice(0, MAX_ITEMS);
  const parts = [`晨间情报｜新增 ${unique.length} 条`];
  let body = '';
  let included = 0;
  for (const [index, item] of selected.entries()) {
    const title = truncate(item.title || '（无标题）', 140);
    const summary = truncate(item.summary || item.excerpt || '', 220);
    const published = item.publishedAt
      ? new Date(item.publishedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })
      : '';
    const lines = [
      `\n\n${index + 1}. ${title}`,
      item.source ? `来源：${truncate(item.source, 60)}` : '',
      published ? `时间：${published}` : '',
      summary,
      item.url ? `链接：${item.url}` : '',
    ].filter(Boolean).join('\n');
    if (parts.join('').length + body.length + lines.length > MAX_MESSAGE_CHARS) break;
    body += lines;
    included++;
  }
  const omitted = Math.max(0, unique.length - included);
  if (omitted) body += `\n\n另有 ${omitted} 条未展开。`;
  return parts[0] + body;
}

function enabledChannels() {
  const channels = (process.env.NOTIFY_CHANNELS || '')
    .split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
  const allowed = new Set(['feishu', 'telegram', 'email']);
  const invalid = channels.filter((x) => !allowed.has(x));
  if (invalid.length) throw new Error(`未知通知渠道：${invalid.join(', ')}；可选 feishu, telegram, email`);
  return [...new Set(channels)];
}

async function postJson(url, payload, headers = {}) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(15000),
  });
  const text = await response.text();
  let result = {};
  try { result = text ? JSON.parse(text) : {}; } catch { /* response may be plain text */ }
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${truncate(text, 300)}`);
  return result;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[char]);
}

async function sendFeishu(message) {
  const webhook = process.env.FEISHU_WEBHOOK_URL;
  if (!webhook) throw new Error('缺少 FEISHU_WEBHOOK_URL');
  const result = await postJson(webhook, { msg_type: 'text', content: { text: message } });
  if (result.code !== undefined && result.code !== 0) {
    throw new Error(`飞书返回错误 ${result.code}: ${result.msg || 'unknown error'}`);
  }
}

async function sendTelegram(message) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) throw new Error('缺少 TELEGRAM_BOT_TOKEN 或 TELEGRAM_CHAT_ID');
  const result = await postJson(`https://api.telegram.org/bot${token}/sendMessage`, {
    chat_id: chatId,
    text: message,
    disable_web_page_preview: true,
  });
  if (result.ok !== true) throw new Error(`Telegram 返回错误：${truncate(JSON.stringify(result), 300)}`);
}

async function sendEmail(message) {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.EMAIL_FROM;
  const to = (process.env.EMAIL_TO || '').split(',').map((x) => x.trim()).filter(Boolean);
  if (!apiKey || !from || !to.length) {
    throw new Error('邮件渠道需要配置 RESEND_API_KEY、EMAIL_FROM、EMAIL_TO');
  }
  const result = await postJson('https://api.resend.com/emails', {
    from,
    to,
    subject: `晨间情报｜新增新闻`,
    text: message,
    html: `<pre style="white-space:pre-wrap;font-family:system-ui,sans-serif">${escapeHtml(message)}</pre>`,
  }, { authorization: `Bearer ${apiKey}` });
  if (!result.id) throw new Error(`邮件服务未返回发送 ID：${truncate(JSON.stringify(result), 300)}`);
}

export async function notifyNewItems(items) {
  if (String(process.env.NOTIFY_ENABLED || '').toLowerCase() !== 'true') {
    console.log('[通知] NOTIFY_ENABLED 未设为 true，已跳过。');
    return;
  }
  const unique = uniqueItems(items);
  if (!unique.length) {
    console.log('[通知] 没有新新闻，不发送。');
    return;
  }
  const channels = enabledChannels();
  if (!channels.length) throw new Error('通知已开启，但 NOTIFY_CHANNELS 未配置。');
  const message = formatNotification(unique);
  const senders = { feishu: sendFeishu, telegram: sendTelegram, email: sendEmail };
  const results = await Promise.allSettled(channels.map((channel) => senders[channel](message)));
  const failures = [];
  results.forEach((result, index) => {
    if (result.status === 'fulfilled') console.log(`[通知] ${channels[index]} 发送成功。`);
    else {
      const reason = result.reason instanceof Error ? result.reason.message : String(result.reason);
      failures.push(`${channels[index]}：${reason}`);
      console.error(`[通知] ${channels[index]} 发送失败：${reason}`);
    }
  });
  if (failures.length) throw new Error(failures.join('；'));
}

// 单独运行时仅在显式加 --all 后发送当前 data.json，防止误发历史新闻。
const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isDirectRun) {
  try {
    const data = JSON.parse(await readFile(join(ROOT, 'data.json'), 'utf8'));
    const items = uniqueItems(flatten(data));
    if (process.argv.includes('--dry-run')) {
      console.log(formatNotification(items));
    } else if (process.argv.includes('--all')) {
      await notifyNewItems(items);
    } else {
      console.log('未发送：独立运行请添加 --all；默认仅由 fetch-news.mjs 推送新增新闻。');
      console.log(`当前数据有 ${items.length} 条去重新闻。预览可运行：node notify-news.mjs --dry-run`);
    }
  } catch (error) {
    console.error(`[通知] ${error.message}`);
    process.exitCode = 1;
  }
}
