// 会话读取与提炼：DSH 会话文件是「多帧 zstd + JSONL」，逐帧解压后按事件流提取对话。
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { zstdDecompressSync } from 'node:zlib';

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

/** 逐帧解压（单帧 API 只解第一帧，必须按魔数切分） */
export function decodeSessionFile(file) {
  const buf = readFileSync(file);
  const offs = [];
  for (let i = 0; i + 4 <= buf.length; i++) {
    if (buf[i] === 0x28 && buf[i + 1] === 0xb5 && buf[i + 2] === 0x2f && buf[i + 3] === 0xfd) offs.push(i);
  }
  if (!offs.length) throw new Error(`not a zstd session file: ${file}`);
  const parts = [];
  let skipped = 0;
  for (let i = 0; i < offs.length; i++) {
    const start = offs[i];
    const end = i + 1 < offs.length ? offs[i + 1] : buf.length;
    try {
      parts.push(zstdDecompressSync(buf.subarray(start, end)).toString('utf8'));
    } catch {
      // 魔数出现在压缩数据内部时会切错：把本段并入下一段重试
      if (i + 1 < offs.length) {
        const merged = buf.subarray(start, i + 2 < offs.length ? offs[i + 2] : buf.length);
        try {
          parts.push(zstdDecompressSync(merged).toString('utf8'));
          i++;
          continue;
        } catch {
          skipped++;
        }
      } else skipped++;
    }
  }
  return { text: parts.join(''), frames: offs.length, skipped };
}

/** 解析为事件数组 */
export function readSessionEvents(file) {
  const { text, frames, skipped } = decodeSessionFile(file);
  const events = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      /* 尾部半行忽略 */
    }
  }
  return { events, frames, skipped, chars: text.length };
}

function textOf(content) {
  if (!Array.isArray(content)) return '';
  const out = [];
  for (const c of content) {
    if (!c) continue;
    if (c.type === 'text' && typeof c.text === 'string') out.push(c.text);
  }
  return out.join('\n').trim();
}

/** 事件流 → 对话条目（丢弃 reasoning / 工具输出正文，只留工具名） */
export function extractDialogue(events) {
  const items = [];
  let meta = null;
  let title = null;
  for (const ev of events) {
    const d = ev?.data ?? {};
    switch (ev?.type) {
      case 'session':
        meta = { id: ev.id ?? d.id, createdAt: d.createdAt ?? ev.createdAt, cwd: d.cwd ?? ev.cwd };
        break;
      case 'session/title':
        if (!title && d.title) title = d.title;
        break;
      case 'user/message': {
        const text = textOf(d.content);
        if (text) items.push({ role: 'user', time: ev.time, text });
        break;
      }
      case 'assistant/message': {
        const msg = d.message ?? d;
        const text = textOf(msg.content);
        const tools = (msg.content ?? [])
          .filter((c) => c && (c.type === 'toolCall' || c.type === 'tool_call'))
          .map((c) => c.name ?? c.toolName ?? '?');
        if (text || tools.length) items.push({ role: 'assistant', time: ev.time, text, tools });
        break;
      }
      default:
        break;
    }
  }
  return { meta, title, items };
}

function headTail(s, keep) {
  if (!s || s.length <= keep * 2) return s ?? '';
  return `${s.slice(0, keep)}\n…（中间省略 ${s.length - keep * 2} 字）…\n${s.slice(-keep)}`;
}

/**
 * 组装入模文本。
 * 规则：用户消息全留；assistant 只留正文且首尾各 20%、超长等距抽样；工具只留名字。
 */
export function buildTranscript(items, { budget = 30000 } = {}) {
  const lines = [];
  for (const it of items) {
    if (it.role === 'user') {
      lines.push(`【我】${it.text}`);
    } else {
      const keep = Math.max(200, Math.floor((it.text?.length ?? 0) * 0.2));
      const body = headTail(it.text, keep);
      const t = it.tools?.length ? `（调用工具：${[...new Set(it.tools)].join(', ')}）` : '';
      if (body || t) lines.push(`【AI】${body}${t ? ' ' + t : ''}`);
    }
  }
  const raw = lines.join('\n\n');
  let text = raw;
  let truncated = false;
  if (raw.length > budget) {
    // 第一刀：按比例压 assistant，用户消息不压
    const ratio = budget / raw.length;
    text = lines
      .map((l) => (l.startsWith('【我】') ? l : l.slice(0, Math.max(120, Math.floor(l.length * ratio)))))
      .join('\n\n');
    // 第二刀：仍超预算则硬截尾部（尾部多为过程性追问）
    if (text.length > budget) {
      text = text.slice(0, budget);
      truncated = true;
    }
    text += `\n\n（原对话 ${raw.length} 字，已按预算裁剪）`;
  }
  return { text, truncated, chars: text.length, rawChars: raw.length };
}

/** 列出会话文件（用于回填/每日窗口） */
export function listSessionFiles(sessionsRoot) {
  const out = [];
  for (const ws of safeReaddir(sessionsRoot)) {
    const wsDir = join(sessionsRoot, ws);
    if (!isDir(wsDir)) continue;
    for (const sid of safeReaddir(wsDir)) {
      const f = join(wsDir, sid, 'session.v4.jsonl.zstd');
      try {
        const st = statSync(f);
        out.push({ workspace: ws, sessionId: sid, file: f, mtime: st.mtimeMs, size: st.size });
      } catch {
        /* 没有会话文件 */
      }
    }
  }
  return out.sort((a, b) => a.mtime - b.mtime);
}

function safeReaddir(p) {
  try {
    return readdirSync(p);
  } catch {
    return [];
  }
}

function isDir(p) {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}
