/**
 * dsh-daily-memory —— 每日自动复盘 + 记忆沉淀（存储与工具层）
 *
 * 设计要点：
 * - 记忆永不自动进上下文（开场 0 token），只在模型显式调用 memory_search 时按需取用。
 * - 插件负责机械活：采集会话、解压、裁剪、查重、原子写、游标记账。
 * - 判断活（值不值得记）留给模型，通过 memory_commit 提交。
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { listSessionFiles, readSessionEvents, extractDialogue, buildTranscript } from './session-reader.mjs';

export const name = 'dsh-daily-memory';
export const inject = ['tools'];

/** 记忆类型 → 主题文件 */
const TOPICS = {
  preference: 'preferences',
  decision: 'decisions',
  project: 'projects',
  todo: 'todos',
  rejected: 'rejected',
};

/** 全部上限，集中在此处，便于调整 */
export const LIMITS = {
  commitDefault: 8, // 单次默认写入条数
  commitHard: 12, // 单次硬顶
  itemMax: 120, // 单条正文默认字数
  itemHard: 200, // 单条正文硬顶
  searchDefault: 3, // 单次默认返回条数
  searchMax: 5, // 单次返回硬顶
  searchChars: 800, // 单次注入字符硬顶
  sessionBudget: 30000, // 单会话入模字数预算
  backfillBatch: 8, // 回填每晚会话数
  indexMaxLines: 300, // index.md 行数上限
};

const pad = (n) => String(n).padStart(2, '0');
const dateKey = (d = new Date()) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
const isoDate = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

function paths(base) {
  return {
    base,
    index: join(base, 'index.md'),
    state: join(base, 'state.json'),
    runlog: join(base, '_runlog.md'),
    baseline: join(base, '_baseline.md'),
    topics: join(base, 'topics'),
    daily: join(base, 'daily'),
    archive: join(base, 'archive'),
  };
}

function ensureTree(p) {
  for (const d of [p.base, p.topics, p.daily, p.archive]) mkdirSync(d, { recursive: true });
  if (!existsSync(p.index)) writeFileSync(p.index, '# 记忆索引\n\n> 一行一条；只有这个文件需要被检索。\n\n', 'utf8');
  if (!existsSync(p.runlog)) writeFileSync(p.runlog, '# 运行日志\n\n', 'utf8');
  for (const f of Object.values(TOPICS)) {
    const fp = join(p.topics, `${f}.md`);
    if (!existsSync(fp)) writeFileSync(fp, `# ${f}\n\n`, 'utf8');
  }
}

function readState(p) {
  try {
    return JSON.parse(readFileSync(p.state, 'utf8'));
  } catch {
    return { cursor: null, lastRun: null, counts: { commits: 0, searches: 0 }, backfill: null };
  }
}

function writeJsonAtomic(file, value) {
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
  renameSync(tmp, file);
}

function writeAtomic(file, text) {
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, text, 'utf8');
  renameSync(tmp, file);
}

/** 归一化用于查重：去标点空格、英文小写 */
function norm(s) {
  return String(s ?? '')
    .replace(/[\s\p{P}\p{S}]/gu, '')
    .toLowerCase();
}

/** 解析 index.md 的行 → 条目对象 */
function parseIndex(p) {
  if (!existsSync(p.index)) return [];
  const out = [];
  for (const line of readFileSync(p.index, 'utf8').split('\n')) {
    const m = line.match(/^- \[(M-\d{8}-\d{2})\] ([a-z]+) \| (.+?) \| 来源: (.*?) \| 状态: (active|superseded|archived) \| 置信: (.*)$/);
    if (m) out.push({ id: m[1], type: m[2], text: m[3], source: m[4], status: m[5], confidence: m[6] });
  }
  return out;
}

function nextId(entries) {
  const day = dateKey();
  const used = entries.filter((e) => e.id.startsWith(`M-${day}-`)).map((e) => Number(e.id.slice(-2)));
  const n = (used.length ? Math.max(...used) : 0) + 1;
  return `M-${day}-${pad(n)}`;
}

function indexLine(e) {
  return `- [${e.id}] ${e.type} | ${e.text} | 来源: ${e.source} | 状态: ${e.status} | 置信: ${e.confidence}`;
}

function clipText(t) {
  const s = String(t ?? '').replace(/\s+/g, ' ').trim();
  return s.length > LIMITS.itemHard ? `${s.slice(0, LIMITS.itemHard)}…` : s;
}

/** 参数校验：纯对象定义不会被宿主校验入参 */
function requireString(args, key, { allowEmpty = false } = {}) {
  const v = args?.[key];
  if (typeof v !== 'string' || (!allowEmpty && v.trim() === '')) {
    throw new Error(`invalid ${key}: expected a non-empty string`);
  }
  return v;
}

function rejectUnknown(args, known) {
  if (args == null) return;
  if (typeof args !== 'object' || Array.isArray(args)) throw new Error('invalid arguments: expected an object');
  const unknown = Object.keys(args).filter((k) => !known.includes(k));
  if (unknown.length) throw new Error(`invalid arguments: unknown key(s) ${unknown.join(', ')}`);
}

/* ---------------------------------- 工具 ---------------------------------- */

function reviewTool(base, sessionsRoot) {
  return {
    name: 'memory_review',
    description:
      '读取待复盘的历史会话并返回裁剪后的对话文本，供提炼记忆。mode=daily 用游标窗口（上次成功运行至今），'
      + 'mode=backfill 按队列回填历史会话，mode=probe 只返回会话清单不产生内容。仅读取，不写入记忆。',
    parameters: {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['daily', 'backfill', 'probe'], description: 'daily（默认）|backfill|probe' },
        maxSessions: { type: 'number', description: `本次最多处理多少个会话，默认 8，上限 12` },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          mode: { type: 'string' },
          nextCursor: { type: 'number' },
          sessions: { type: 'array', items: { type: 'object' } },
          note: { type: 'string' },
        },
        additionalProperties: true,
      },
      render: (_args, v) => [{ type: 'text', text: renderReview(v) }],
    },
    async execute(args) {
      rejectUnknown(args, ['mode', 'maxSessions']);
      const mode = args?.mode ?? 'daily';
      if (!['daily', 'backfill', 'probe'].includes(mode)) throw new Error(`invalid mode: ${mode}`);
      const cap = Math.min(Math.max(Number(args?.maxSessions ?? LIMITS.backfillBatch) || LIMITS.backfillBatch, 1), 12);

      const p = paths(base);
      ensureTree(p);
      const state = readState(p);
      const files = listSessionFiles(sessionsRoot);
      const since = state.cursor ?? 0;

      if (mode === 'probe') {
        const sessions = files.slice(-20).map((f) => ({ id: f.sessionId.replace(/^session-/, '').slice(0, 8), size: f.size, mtime: new Date(f.mtime).toISOString().slice(0, 16) }));
        return { ok: true, mode, nextCursor: since, sessions, note: `共 ${files.length} 个会话；游标 ${since ? new Date(since).toISOString() : '未初始化（首次应跑 backfill）'}` };
      }

      // 待处理队列：daily 用时间窗口，backfill 用游标队列（倒序，近的优先）
      let queue;
      if (mode === 'backfill') {
        const queueIds = state.backfill?.queue ?? files.filter((f) => f.mtime <= (state.cursor ?? Date.now())).map((f) => f.sessionId);
        queue = files.filter((f) => queueIds.includes(f.sessionId)).sort((a, b) => b.mtime - a.mtime);
      } else {
        queue = files.filter((f) => f.mtime > since);
      }

      const picked = queue.slice(0, cap);
      const sessions = [];
      let processed = 0;
      for (const f of picked) {
        try {
          const { events } = readSessionEvents(f.file);
          const { meta, title, items } = extractDialogue(events);
          const tr = buildTranscript(items, { budget: LIMITS.sessionBudget });
          if (!items.length) continue;
          sessions.push({
            id: f.sessionId,
            title: title ?? null,
            cwd: meta?.cwd ?? null,
            endedAt: new Date(f.mtime).toISOString().slice(0, 16),
            items: items.length,
            chars: tr.chars,
            truncated: tr.truncated,
            text: tr.text,
          });
          processed++;
        } catch (e) {
          sessions.push({ id: f.sessionId, error: String(e?.message ?? e) });
        }
      }

      const nextCursor = mode === 'daily' ? Date.now() : state.cursor ?? Date.now();
      const note = mode === 'backfill'
        ? `队列剩余 ${Math.max(0, queue.length - processed)} 个会话（共 ${files.length}）`
        : `时间窗口内 ${queue.length} 个会话，已处理 ${processed}`;
      return { ok: true, mode, nextCursor, sessions, note };
    },
  };
}

function renderReview(v) {
  if (!v.ok) return `memory_review 失败：${v.note ?? ''}`;
  if (v.mode === 'probe') {
    const lines = [`# 会话清单（${v.sessions.length}）`, v.note, ''];
    for (const s of v.sessions) lines.push(`- ${s.mtime} | ${(s.size / 1024).toFixed(0)}KB | ${s.id}`);
    return lines.join('\n');
  }
  const head = `# memory_review(${v.mode})　${v.note}`;
  const body = v.sessions.map((s) => `\n===== ${s.title ?? s.id}｜${s.endedAt ?? ''}｜${s.items ?? 0} 条｜${s.chars ?? 0} 字${s.truncated ? '（已裁剪）' : ''} =====\n${s.text ?? s.error ?? ''}`);
  return [head, ...body].join('\n');
}

function commitTool(base) {
  return {
    name: 'memory_commit',
    description:
      '把提炼出的记忆条目写入长期记忆：自动查重、与旧条目冲突时保留旧条并标 superseded、更新 index.md 与主题文件、写当日流水与运行日志。单次默认 8 条、硬顶 12 条，单条正文硬顶 200 字。',
    parameters: {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          description: '记忆条目数组',
          items: {
            type: 'object',
            properties: {
              type: { type: 'string', enum: Object.keys(TOPICS), description: 'preference|decision|project|todo|rejected' },
              text: { type: 'string', description: '一句话结论，尽量 ≤120 字' },
              source: { type: 'string', description: '来源，如：11-17 猎头培训·复盘方案' },
              confidence: { type: 'string', enum: ['高', '中', '低'], description: '置信度，默认中' },
            },
            required: ['type', 'text'],
            additionalProperties: false,
          },
        },
        runMode: { type: 'string', description: '本轮运行模式，写进 _runlog（daily|backfill）' },
        sessions: { type: 'number', description: '本轮覆盖会话数，写进 _runlog' },
        nextCursor: { type: 'number', description: '本轮处理到的游标（毫秒时间戳），由 memory_review 返回' },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          written: { type: 'number' },
          skipped: { type: 'number' },
          ids: { type: 'array', items: { type: 'string' } },
          note: { type: 'string' },
        },
        additionalProperties: true,
      },
      render: (_a, v) => [{ type: 'text', text: v.ok ? `写入 ${v.written} 条，跳过 ${v.skipped} 条${v.ids.length ? `（${v.ids.join(', ')}）` : ''}\n${v.note ?? ''}` : `memory_commit 失败：${v.note}` }],
    },
    async execute(args) {
      rejectUnknown(args, ['items', 'runMode', 'sessions', 'nextCursor']);
      if (!Array.isArray(args?.items)) throw new Error('invalid items: expected an array');
      if (args.items.length > LIMITS.commitHard) throw new Error(`too many items: ${args.items.length} > ${LIMITS.commitHard} (单次硬顶)`);

      const p = paths(base);
      ensureTree(p);
      const entries = parseIndex(p);
      const state = readState(p);
      const written = [];
      let skipped = 0;
      const today = isoDate();
      const dailyLines = [`# ${today} 复盘流水`, ''];

      for (const raw of args.items.slice(0, LIMITS.commitDefault)) {
        const type = String(raw?.type ?? '');
        if (!TOPICS[type]) {
          skipped++;
          continue;
        }
        const text = clipText(raw?.text);
        if (!text) {
          skipped++;
          continue;
        }
        const n = norm(text);
        const pool = [...entries, ...written];
        const dup = pool.find((e) => e.status === 'active' && norm(e.text) === n);
        if (dup) {
          skipped++;
          continue;
        }
        // 冲突：同类型下前 14 字归一相同但内容不同 → 旧条标记 superseded
        const near = pool.find((e) => e.status === 'active' && e.type === type && norm(e.text).slice(0, 14) === n.slice(0, 14));
        const id = nextId(pool);
        const entry = { id, type, text, source: String(raw?.source ?? '未标注'), status: 'active', confidence: String(raw?.confidence ?? '中') };
        if (near) {
          near.status = 'superseded';
          entry.rest = ` | 取代: ${near.id}`;
        }
        written.push(entry);
        dailyLines.push(`- [${entry.id}] ${type} | ${text} | 来源: ${entry.source} | 置信: ${entry.confidence}`);
      }

      if (written.length) {
        // 1) 主题文件：追加块
        for (const e of written) {
          const fp = join(p.topics, `${TOPICS[e.type]}.md`);
          const block = `\n## [${e.id}] ${e.text}\n- 类型: ${e.type}｜置信: ${e.confidence}｜日期: ${today}\n- 来源: ${e.source}\n- 状态: ${e.status}${e.rest ?? ''}\n`;
          writeFileSync(fp, readFileSync(fp, 'utf8') + block, 'utf8');
        }
        // 2) index.md：重写（含 superseded 状态变更）
        const all = [...entries, ...written];
        const lines = all.filter((e) => e.status !== 'archived').map(indexLine);
        writeAtomic(p.index, `# 记忆索引\n\n> 一行一条；只有这个文件需要被检索。\n\n${lines.join('\n')}\n`);
        // 3) 当日流水
        const dailyFile = join(p.daily, `${today}.md`);
        const prev = existsSync(dailyFile) ? `${readFileSync(dailyFile, 'utf8')}\n` : '';
        writeAtomic(dailyFile, `${prev}${dailyLines.join('\n')}\n`);
        // 4) 运行日志
        const mode = String(args?.runMode ?? 'daily');
        const logLine = `- ${new Date().toISOString().slice(0, 16).replace('T', ' ')} | ${mode} | 会话 ${Number(args?.sessions ?? 0)} | 写入 ${written.length} | 跳过 ${skipped}\n`;
        writeFileSync(p.runlog, readFileSync(p.runlog, 'utf8') + logLine, 'utf8');
      }

      // 5) state：游标 + 计数 + backfill 出队
      const nDone = Math.max(0, Number(args?.sessions ?? 0));
      let bf = state.backfill ?? null;
      if (bf && Array.isArray(bf.queue) && nDone > 0) {
        bf = { ...bf, queue: bf.queue.slice(nDone), done: (bf.done ?? 0) + nDone, total: bf.total ?? bf.queue.length };
        if (bf.queue.length === 0) bf.state = 'done';
      }
      const next = {
        ...state,
        cursor: Number(args?.nextCursor ?? state.cursor ?? Date.now()),
        lastRun: new Date().toISOString(),
        counts: { commits: (state.counts?.commits ?? 0) + written.length, searches: state.counts?.searches ?? 0 },
        backfill: bf ?? state.backfill ?? null,
      };
      writeJsonAtomic(p.state, next);

      return { ok: true, written: written.length, skipped, ids: written.map((e) => e.id), note: `游标 → ${new Date(next.cursor).toISOString().slice(0, 16)}` };
    },
  };
}

function searchTool(base) {
  return {
    name: 'memory_search',
    description:
      '按关键词检索长期记忆，只返回最相关的少量条目（默认 3 条、硬顶 5 条、总注入 ≤800 字）。先过 index.md，命中再取主题文件里的原文块。检索不是自动的：需要历史偏好/决策/待办时才调用。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '关键词，可用空格分隔多个词' },
        type: { type: 'string', enum: Object.keys(TOPICS), description: '只看某一类型' },
        limit: { type: 'number', description: `返回条数，默认 ${LIMITS.searchDefault}，上限 ${LIMITS.searchMax}` },
      },
      required: ['query'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: { ok: { type: 'boolean' }, hits: { type: 'array', items: { type: 'object' } }, note: { type: 'string' } },
        additionalProperties: true,
      },
      render: (_a, v) => [{ type: 'text', text: v.ok ? renderHits(v) : `memory_search 失败：${v.note}` }],
    },
    async execute(args) {
      rejectUnknown(args, ['query', 'type', 'limit']);
      const query = requireString(args, 'query');
      const limit = Math.min(Math.max(Number(args?.limit ?? LIMITS.searchDefault) || LIMITS.searchDefault, 1), LIMITS.searchMax);
      const p = paths(base);
      ensureTree(p);
      const terms = query.toLowerCase().split(/\s+/).map((t) => t.trim()).filter(Boolean).map(norm).filter(Boolean);
      const entries = parseIndex(p).filter((e) => e.status === 'active' && (!args?.type || e.type === args.type));
      const scored = entries
        .map((e) => {
          const hay = norm(`${e.text} ${e.source}`);
          const score = terms.reduce((acc, t) => acc + (hay.includes(t) ? 1 : 0), 0);
          return { ...e, score };
        })
        .filter((e) => e.score > 0)
        .sort((a, b) => b.score - a.score || (a.id < b.id ? 1 : -1))
        .slice(0, limit);

      const hits = [];
      let budget = LIMITS.searchChars;
      for (const e of scored) {
        const body = `${e.id} ${e.type}｜${e.text}｜来源: ${e.source}｜置信: ${e.confidence}`;
        if (body.length > budget) break;
        budget -= body.length;
        hits.push({ id: e.id, type: e.type, text: e.text, source: e.source, confidence: e.confidence });
      }
      const state = readState(p);
      writeJsonAtomic(p.state, { ...state, counts: { ...(state.counts ?? {}), searches: (state.counts?.searches ?? 0) + 1 } });
      return { ok: true, hits, note: hits.length ? '' : `无命中（索引 ${entries.length} 条）` };
    },
  };
}

function renderHits(v) {
  if (!v.hits.length) return `无匹配记忆（${v.note}）`;
  return ['# 相关记忆', ...v.hits.map((h) => `- [${h.id}] ${h.type}｜${h.text}｜来源: ${h.source}｜置信: ${h.confidence}`)].join('\n');
}

/* --------------------------------- 生命周期 -------------------------------- */

export function apply(ctx, config) {
  const base = config?.memoryDir ?? join(homedir(), '.dsh', 'memory');
  const sessionsRoot = config?.sessionsRoot ?? join(homedir(), '.dsh', 'sessions');
  const p = paths(base);
  ensureTree(p);

  for (const def of [reviewTool(base, sessionsRoot), commitTool(base), searchTool(base)]) {
    ctx.tools.register(def);
  }

  // 首次运行：无游标 → 记录 backfill 队列，由模型在当晚分批回填
  const state = readState(p);
  if (!state.cursor) {
    const files = listSessionFiles(sessionsRoot);
    const queue = files.sort((a, b) => b.mtime - a.mtime).map((f) => f.sessionId);
    writeJsonAtomic(p.state, { ...state, cursor: null, backfill: { state: 'pending', queue, done: 0, total: queue.length } });
  }
}
