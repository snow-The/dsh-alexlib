/**
 * dsh-alexlib — AlexLib 書庫的 DSH 工具。
 *
 * 設計決定（每一條都有理由）：
 *
 * 1. **自己一份索引，不共用 GAS 的 kb/gas.db。** AlexLib 是獨立的書庫，
 *    它的索引應該跟著它走，而不是耦合到另一個 repo 的 3.2 GB DB。
 *
 * 2. **連續漢字切成重疊二字組（bigram），拉丁數字照原樣。**
 *    「認知作戰」因此變成必須同時命中 認知 + 知作 + 作戰——
 *    **片語級的比對**，而不是「這兩個詞剛好都出現過」。
 *    這是對 GAS 知識庫那個「認知作戰命中睡眠研究」假陽性的直接修正。
 *
 * 3. **簡繁先統一成簡體**（t2s.json，4,221 個字對，由本機 opencc 產生）。
 *    不做的話「认知作战」查不到「認知作戰」——Python 端的 build_kb.py 就是踩過這個坑。
 *
 * 4. **內容優先，不是路徑優先。** AlexLib/ocr 的 840 個檔案只有 516 份唯一內容，
 *    索引以 sha256 為主鍵，一份內容記住它所有的路徑。同一本書不會被索引兩次。
 *
 * 5. **chunk 有硬上限。** GAS 的 build_kb.py 在「單一段落大於 CHUNK_MAX」時不切，
 *    於是出現過 13 MB 的單一 chunk。這裡一律硬切。
 *
 * 6. **FTS5 用 detail=none, columnsize=0。** 我們用二字組 AND 而不是 FTS 的片語查詢，
 *    不需要位置資訊——省下的空間對 660 MB 的書庫是很大的差別。
 */
import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join, relative, extname, basename } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'

export const name = 'alexlib'
export const inject = ['tools']

const HERE = fileURLToPath(new URL('.', import.meta.url))
// 預設路徑用 homedir() 推導，**不寫死使用者名稱**：寫死了既暴露本機路徑、在別的機器上也一定錯。
const ROOT = process.env.ALEXLIB_ROOT || join(homedir(), 'source', 'repos', 'AlexLib')
const OCR_DIR = join(ROOT, 'ocr')
const DB_PATH = process.env.ALEXLIB_DB || join(ROOT, 'index.db')

const CHUNK_TARGET = 1400
const CHUNK_MAX = 2200
const CHUNK_MIN = 80
const CJK = /[\u3400-\u9FFF\uF900-\uFAFF\u3040-\u30FF\uAC00-\uD7AF]/
const WORDCH = /[A-Za-z0-9_]/

// ---------------------------------------------------------------- 中文處理

let _t2s = null
function t2s() {
  if (_t2s) return _t2s
  const raw = JSON.parse(readFileSync(join(HERE, 't2s.json'), 'utf8'))
  const m = new Map()
  // ⚠️ 必須用 Array.from 逐「碼點」迭代，不能用 [i] 逐「碼元」索引。
  // Python 產生這張表時用的是 len()==1（碼點），但 U+F900-FAFF 的相容漢字會轉成
  // 非 BMP 字元——在 JS 裡那是兩個碼元。逐碼元索引會從第一個這種字之後整個錯位，
  // 症狀是 normalize('認知作戰') 回 '\uFFFD知作\uFFFD'、查詢整組壞掉。
  const trad = Array.from(raw.trad)
  const simp = Array.from(raw.simp)
  for (let i = 0; i < trad.length; i++) m.set(trad[i], simp[i])
  _t2s = m
  return m
}

/** 逐字轉簡體。只做單字對應——片語級轉換需要上下文，對切詞沒有幫助。 */
export function normalize(s) {
  const m = t2s()
  let out = ''
  for (const ch of s) out += m.get(ch) || ch
  return out
}

/** 漢字 → 重疊二字組；拉丁/數字 → 原字（小寫）。 */
export function tokenize(s) {
  const text = normalize(s)
  const out = []
  let han = ''
  let word = ''
  const flushHan = () => {
    if (!han) return
    if (han.length === 1) out.push(han)
    else for (let i = 0; i + 1 < han.length; i++) out.push(han.slice(i, i + 2))
    han = ''
  }
  const flushWord = () => { if (word) { out.push(word); word = '' } }
  for (const ch of text) {
    if (CJK.test(ch)) { flushWord(); han += ch; continue }
    flushHan()
    if (WORDCH.test(ch)) word += ch.toLowerCase()
    else flushWord()
  }
  flushHan(); flushWord()
  return out
}

function matchExpr(tokens) {
  const uniq = [...new Set(tokens)].filter((t) => t.length > 0)
  if (!uniq.length) return null
  return uniq.map((t) => '"' + t.replaceAll('"', '""') + '"').join(' AND ')
}

/** 從「原文」取片段。查的是正規化後的位置，再對回原文（逐字 1:1，索引可直接用）。 */
function snippetOf(text, tokens, width) {
  const norm = normalize(text)
  let pos = -1
  for (const t of tokens) {
    const i = norm.indexOf(t)
    if (i >= 0 && (pos < 0 || i < pos)) pos = i
  }
  if (pos < 0) pos = 0
  const start = Math.max(0, pos - Math.floor(width / 3))
  const body = text.slice(start, start + width).replace(/\s+/g, ' ').trim()
  return (start > 0 ? '…' : '') + body + '…'
}

/**
 * OCR 輸出裡混著大量 HTML（PaddleOCR 會把版面標記一起吐出來）。
 * 不清掉的話：索引被樣板字塞滿、BM25 被稀釋、snippet 顯示的是 `div style text align`。
 * 這一關同時改善索引大小與檢索品質。
 */
export function cleanText(s) {
  return s
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]{0,400}>/g, ' ')
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#39;/g, "'")
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
}

/** 去掉 OCR 標記的檔名主幹——同一個主幹就是同一本書。 */
export function ocrStem(name) {
  // ⚠️ 不能用 /_by_PaddleOCR[^.]*\.md$/ —— [^.]* 吃不下 '-VL-1.6' 裡的點，
  // 結果只去掉了 .md，'_by_PaddleOCR-VL-1.6' 留在主幹裡，跨 OCR 版本的去重等於沒做。
  // 先剝 .clean.md，再剝 .md，最後從 _by_PaddleOCR 一路砍到底。
  return name
    .replace(/\.clean\.md$/i, '')
    .replace(/\.md$/i, '')
    .replace(/_by_PaddleOCR.*$/i, '')
    .trim()
}

// ---------------------------------------------------------------- 切塊

export function chunkMarkdown(text) {
  const chunks = []
  let heading = ''
  let cur = []
  let curLen = 0
  const push = () => {
    const body = cur.join('\n').trim()
    if (body) chunks.push({ heading, text: body })
    cur = []; curLen = 0
  }
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/\s+$/, '')
    const h = line.match(/^(#{1,6})\s+(.*)$/)
    if (h) { push(); heading = h[2].trim().slice(0, 200); continue }
    if (!line.trim()) {
      if (curLen >= CHUNK_TARGET) push()
      else { cur.push(line); curLen += 1 }
      continue
    }
    // 單行本身就超長 -> 硬切（build_kb.py 就是在這裡漏掉的，做出 13 MB 的 chunk）
    if (line.length > CHUNK_MAX) {
      push()
      for (let i = 0; i < line.length; i += CHUNK_TARGET) {
        chunks.push({ heading, text: line.slice(i, i + CHUNK_TARGET) })
      }
      continue
    }
    if (curLen + line.length > CHUNK_MAX && curLen >= CHUNK_MIN) push()
    cur.push(line); curLen += line.length + 1
  }
  push()
  return chunks.filter((c) => c.text.length >= 20)
}

// ---------------------------------------------------------------- 索引

export function openDb(path = DB_PATH) {
  const db = new DatabaseSync(path)
  db.exec('PRAGMA journal_mode=WAL')
  db.exec('PRAGMA synchronous=NORMAL')
  return db
}

function schema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS docs(
      sha256 TEXT PRIMARY KEY, source TEXT, rel TEXT, title TEXT,
      bytes INTEGER, mtime REAL, n_chunks INTEGER, n_paths INTEGER, all_paths TEXT
    );
    CREATE TABLE IF NOT EXISTS chunks(
      id INTEGER PRIMARY KEY, sha256 TEXT, ord INTEGER, heading TEXT, text TEXT
    );
    CREATE INDEX IF NOT EXISTS chunks_doc ON chunks(sha256, ord);
    CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
      tok, heading_tok, tokenize='unicode61 remove_diacritics 2', detail=none, columnsize=0
    );
    CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, val TEXT);
  `)
}

function walk(dir, acc = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) walk(p, acc)
    else if (extname(e.name).toLowerCase() === '.md') acc.push(p)
  }
  return acc
}

export function buildIndex({ log = () => {}, force = false, limit = 0 } = {}) {
  if (!existsSync(OCR_DIR)) throw new Error('AlexLib/ocr not found: ' + OCR_DIR)
  const files = walk(OCR_DIR)
  log('scan: ' + files.length + ' files under ' + OCR_DIR)

  const byHash = new Map()
  for (const p of files) {
    // 去重鍵 = 清洗後文字的 sha256，不是檔案的 sha256。
    // 理由：同一本書常有兩三次 OCR 執行，位元組差幾個字元就會變成兩份文件，
    // 檢索時同一本書出現兩三次（實測：指挥控制系统仿真 兩次、Game Engine Architecture 三次）。
    // 用文字當鍵，同一本書只會有一筆，其他路徑記在 all_paths。
    const h = createHash('sha256').update(cleanText(readFileSync(p, 'utf8'))).digest('hex')
    const rel = relative(OCR_DIR, p).split('\\').join('/')
    const st = statSync(p)
    if (!byHash.has(h)) {
      byHash.set(h, { sha256: h, source: rel.split('/')[0], rel, title: basename(p),
                      bytes: st.size, mtime: st.mtimeMs, paths: [] })
    }
    byHash.get(h).paths.push(rel)
  }
  log('unique contents: ' + byHash.size + ' (from ' + files.length + ' files)')

  // 第二層去重：同一個檔名主幹就是同一本書。同一本書常被 OCR 兩次（VL-1.5 與 VL-1.6），
  // 文字差幾個字元、內容雜湊就不同，於是檢索時同一本書出現兩三次
  // （實測：指挥控制系统仿真 兩份、系统科学概论 兩份）。
  // 以主幹分組，留檔案最大的那一份當代表（OCR 最完整），其餘路徑全部併入 all_paths。
  const byStem = new Map()
  for (const d of byHash.values()) {
    const stem = ocrStem(d.title)
    const prev = byStem.get(stem)
    if (!prev) { byStem.set(stem, d); continue }
    if (d.bytes > prev.bytes) { d.paths = d.paths.concat(prev.paths); byStem.set(stem, d) }
    else prev.paths = prev.paths.concat(d.paths)
  }
  const docs = [...byStem.values()]
  log('unique books (by stem): ' + docs.length)

  const db = openDb()
  schema(db)
  if (force) {
    // 重建時必須整批清掉。INSERT OR REPLACE 只認「同一個鍵」，而一旦更換去重鍵
    // （檔案 sha256 → 文字 sha256），每一筆都變成新鍵，舊的原地留下來——
    // 索引會變成兩份。實測：docs 516 → 1027、chunks 396k → 790k。
    db.exec('DELETE FROM chunks_fts')
    db.exec('DELETE FROM chunks')
    db.exec('DELETE FROM docs')
  }
  const have = new Set(db.prepare('SELECT sha256 FROM docs').all().map((r) => r.sha256))

  const insDoc = db.prepare('INSERT OR REPLACE INTO docs(sha256,source,rel,title,bytes,mtime,n_chunks,n_paths,all_paths) VALUES(?,?,?,?,?,?,?,?,?)')
  const insChunk = db.prepare('INSERT INTO chunks(id,sha256,ord,heading,text) VALUES(?,?,?,?,?)')
  const insFts = db.prepare('INSERT INTO chunks_fts(rowid,tok,heading_tok) VALUES(?,?,?)')
  const delChunk = db.prepare('DELETE FROM chunks WHERE sha256=?')
  const delFts = db.prepare('DELETE FROM chunks_fts WHERE rowid IN (SELECT id FROM chunks WHERE sha256=?)')

  let done = 0, skipped = 0
  const t0 = Date.now()
  let nextId = db.prepare('SELECT COALESCE(MAX(id),0) AS m FROM chunks').get().m + 1
  db.exec('BEGIN')
  for (const d of docs) {
    if (limit && done >= limit) break
    if (!force && have.has(d.sha256)) { skipped++; continue }
    delFts.run(d.sha256); delChunk.run(d.sha256)
    const text = cleanText(readFileSync(join(OCR_DIR, d.paths[0]), 'utf8'))
    const chunks = chunkMarkdown(text)
    for (let i = 0; i < chunks.length; i++) {
      const c = chunks[i]
      const id = nextId++
      insChunk.run(id, d.sha256, i, c.heading, c.text)
      insFts.run(id, tokenize(c.text).join(' '), tokenize(c.heading).join(' '))
    }
    insDoc.run(d.sha256, d.source, d.paths[0], d.title, d.bytes, d.mtime, chunks.length, d.paths.length, d.paths.join('\n'))
    done++
    if (done % 20 === 0) {
      db.exec('COMMIT'); db.exec('BEGIN')
      log('  indexed ' + done + ' docs, ' + ((Date.now() - t0) / 1000).toFixed(0) + 's')
    }
  }
  db.exec('COMMIT')
  db.prepare('INSERT OR REPLACE INTO meta(key,val) VALUES(?,?)').run('last_index', new Date().toISOString())
  const n = db.prepare('SELECT count(*) AS n FROM docs').get().n
  const c = db.prepare('SELECT count(*) AS n FROM chunks').get().n
  db.close()
  log('done: docs=' + n + ' chunks=' + c + ' indexed_now=' + done + ' skipped=' + skipped)
  return { docs: n, chunks: c, indexed: done, skipped }
}

export function indexStats() {
  if (!existsSync(DB_PATH)) return { indexed: false, db: DB_PATH, root: ROOT }
  const db = openDb(DB_PATH)
  const d = db.prepare('SELECT count(*) AS n, COALESCE(sum(n_chunks),0) AS c, COALESCE(sum(n_paths),0) AS p FROM docs').get()
  const last = db.prepare("SELECT val FROM meta WHERE key='last_index'").get()
  db.close()
  return { indexed: true, db: DB_PATH, root: ROOT, unique_docs: d.n, chunks: d.c, paths: d.p, last_index: last ? last.val : null }
}

// ---------------------------------------------------------------- 工具

const textOutput = () => ({
  schema: { type: 'object', additionalProperties: true },
  render: (_a, v) => [{ type: 'text', text: typeof v === 'string' ? v : JSON.stringify(v, null, 2) }],
})
const str = (a, k) => (a && typeof a[k] === 'string' ? a[k] : undefined)
const num = (a, k, d) => (a && Number.isFinite(a[k]) ? a[k] : d)

function requireIndex() {
  if (!existsSync(DB_PATH)) {
    throw new Error('AlexLib 索引不存在：' + DB_PATH + '  —  先跑 node index.js --build')
  }
}

const searchTool = {
  name: 'alexlib_search',
  description:
    '在 AlexLib 書庫（840 個 OCR markdown、516 份唯一內容）裡搜尋。中文用重疊二字組做片語級比對' +
    '（「認知作戰」必須三個二字組都命中），簡繁自動統一。回傳來源、路徑、標題、片段與 BM25 分數。',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: '查詢字串（中文或英文）' },
      k: { type: 'number', description: '回傳幾筆，預設 8' },
      source: { type: 'string', description: '限定來源：oc / w8 / gas / home' },
      snippet: { type: 'number', description: '每筆片段長度，預設 220' },
    },
    required: ['query'],
  },
  output: textOutput(),
  timeoutMs: 60000,
  isConcurrencySafe: () => true,
  async execute(args) {
    requireIndex()
    const q = str(args, 'query')
    if (!q) throw new Error('query is required')
    const toks = tokenize(q)
    const expr = matchExpr(toks)
    if (!expr) throw new Error('查詢裡沒有可用的詞')
    const k = num(args, 'k', 8), width = num(args, 'snippet', 220), src = str(args, 'source')
    const db = openDb(DB_PATH)
    const sql = 'SELECT c.sha256, c.ord, c.heading, c.text, d.rel, d.title, d.n_paths, bm25(chunks_fts) AS score ' +
      'FROM chunks_fts JOIN chunks c ON c.id = chunks_fts.rowid JOIN docs d ON d.sha256 = c.sha256 ' +
      'WHERE chunks_fts MATCH ?' + (src ? ' AND d.source = ?' : '') + ' ORDER BY score LIMIT ?'
    const rows = src ? db.prepare(sql).all(expr, src, k) : db.prepare(sql).all(expr, k)

    // ── 0 命中時說清楚「為什麼」（2026-10-04）──────────────────────────────
    //
    // 實測踩到：查 `認知作戰` 回 0 筆，而查 `认知` 有 160 筆。
    // 片語級 AND 是**刻意的設計**（分詞成 认知/知作/作战，必須全中），所以 0 是誠實答案
    // —— 但使用者拿到 0，**無從判斷是「語料沒有」還是「檢索壞了」**。
    //
    // 這件事值得修的理由：**「安靜地回 0」與「安靜地壞掉」在輸出上長得一模一樣。**
    let diagnose = null
    if (rows.length === 0) {
      const one = db.prepare('SELECT COUNT(*) c FROM chunks_fts WHERE chunks_fts MATCH ?')
      const per = toks.map((t) => {
        let c = 0
        try { c = one.get('"' + t.replaceAll('"', '""') + '"').c } catch { c = -1 }
        return { token: t, chunks: c }
      })
      const zero = per.filter((x) => x.chunks === 0).map((x) => x.token)
      const hit = per.filter((x) => x.chunks > 0)
      diagnose = {
        why: zero.length
          ? ('有 ' + zero.length + ' 個二字組在整個語料裡一次都沒出現（' + zero.join('、') +
             '）—— 片語級 AND 要求全部命中，所以結果必然是 0。')
          : '每個二字組都出現過，但沒有任何片段同時包含全部 —— 這幾個字沒有連在一起過。',
        per_token: per,
        suggestion: hit.length
          ? ('放寬：只查 ' + hit.map((x) => x.token).join('、') + '（' + hit.length + ' 個詞，可用 OR）')
          : '這組詞在語料裡完全沒有基礎，換個說法或改用英文詞。',
        relax_expr: hit.length ? hit.map((x) => '"' + x.token.replaceAll('"', '""') + '"').join(' OR ') : null,
      }
    }
    db.close()
    return {
      query: q,
      tokens: toks,
      mode: 'bigram-AND（片語級）',
      hits: rows.length,
      diagnose,
      results: rows.map((r) => ({
        source: r.rel.split('/')[0],
        rel: r.rel,
        title: r.title,
        heading: r.heading || null,
        chunk: r.ord,
        aliases: r.n_paths > 1 ? r.n_paths - 1 : 0,
        score: Number(r.score.toFixed(3)),
        snippet: snippetOf(r.text, toks, width),
      })),
    }
  },
}

const docTool = {
  name: 'alexlib_doc',
  description: '讀取 AlexLib 裡某一份文件的內容（用路徑或標題片段比對），可分頁看它的 chunk。',
  parameters: {
    type: 'object',
    properties: {
      rel: { type: 'string', description: '路徑或標題片段' },
      offset: { type: 'number', description: '從第幾個 chunk 開始，預設 0' },
      limit: { type: 'number', description: '看幾個 chunk，預設 6' },
    },
    required: ['rel'],
  },
  output: textOutput(),
  timeoutMs: 60000,
  isConcurrencySafe: () => true,
  async execute(args) {
    requireIndex()
    const key = str(args, 'rel')
    if (!key) throw new Error('rel is required')
    const off = num(args, 'offset', 0), lim = num(args, 'limit', 6)
    const db = openDb(DB_PATH)
    const doc = db.prepare('SELECT * FROM docs WHERE rel LIKE ? OR title LIKE ? LIMIT 1').all('%' + key + '%', '%' + key + '%')[0]
    if (!doc) { db.close(); return { found: false, key, hint: '用 alexlib_list 看有哪些書' } }
    const chunks = db.prepare('SELECT ord, heading, text FROM chunks WHERE sha256=? ORDER BY ord LIMIT ? OFFSET ?').all(doc.sha256, lim, off)
    db.close()
    return {
      found: true, title: doc.title, source: doc.source, rel: doc.rel,
      bytes: doc.bytes, n_chunks: doc.n_chunks, aliases: doc.n_paths - 1,
      all_paths: doc.n_paths > 1 ? doc.all_paths.split('\n') : undefined,
      offset: off, returned: chunks.length,
      chunks: chunks.map((c) => ({ ord: c.ord, heading: c.heading || null, text: c.text })),
    }
  },
}

const listTool = {
  name: 'alexlib_list',
  description: '列出 AlexLib 書庫裡的文件（可依來源或標題片段篩選）。',
  parameters: {
    type: 'object',
    properties: {
      source: { type: 'string', description: 'oc / w8 / gas / home' },
      pattern: { type: 'string', description: '標題或路徑片段' },
      limit: { type: 'number', description: '預設 40' },
    },
  },
  output: textOutput(),
  timeoutMs: 30000,
  isConcurrencySafe: () => true,
  async execute(args) {
    requireIndex()
    const src = str(args, 'source'), pat = str(args, 'pattern'), lim = num(args, 'limit', 40)
    const db = openDb(DB_PATH)
    const where = [], params = []
    if (src) { where.push('source = ?'); params.push(src) }
    if (pat) { where.push('(title LIKE ? OR rel LIKE ?)'); params.push('%' + pat + '%', '%' + pat + '%') }
    const sql = 'SELECT source, rel, title, n_chunks, n_paths, bytes FROM docs' +
      (where.length ? ' WHERE ' + where.join(' AND ') : '') + ' ORDER BY n_chunks DESC LIMIT ?'
    const rows = db.prepare(sql).all(...params, lim)
    const total = db.prepare('SELECT count(*) AS n FROM docs').get().n
    db.close()
    return {
      total_docs: total, returned: rows.length,
      docs: rows.map((r) => ({ source: r.source, title: r.title, rel: r.rel, chunks: r.n_chunks,
                               aliases: r.n_paths - 1, mb: Number((r.bytes / 1048576).toFixed(2)) })),
    }
  },
}

const statsTool = {
  name: 'alexlib_stats',
  description: 'AlexLib 索引狀態：唯一文件數、chunk 數、別名路徑數、最後索引時間。',
  parameters: { type: 'object', properties: {} },
  output: textOutput(),
  timeoutMs: 30000,
  isConcurrencySafe: () => true,
  async execute() { return indexStats() },
}

const reindexTool = {
  name: 'alexlib_reindex',
  description: '重建／更新 AlexLib 索引。預設只補新內容（已索引的 sha256 會跳過）。' +
    '大型重建建議在終端機跑 node index.js --build，不要佔住 agent 迴圈。',
  parameters: {
    type: 'object',
    properties: {
      force: { type: 'boolean', description: '連已索引的也重做' },
      limit: { type: 'number', description: '這次最多處理幾份（0 = 不限）' },
    },
  },
  output: textOutput(),
  timeoutMs: 600000,
  isConcurrencySafe: () => false,
  async execute(args) {
    const out = []
    const r = buildIndex({ log: (m) => out.push(m), force: args && args.force === true, limit: num(args, 'limit', 0) })
    return { ...r, log: out }
  },
}

export function apply(ctx) {
  for (const tool of [searchTool, docTool, listTool, statsTool, reindexTool]) {
    try {
      ctx.tools.register(tool)
    } catch (err) {
      console.error('[dsh-alexlib] ' + tool.name + ' registration skipped: ' + err)
    }
  }
}

// ---------------------------------------------------------------- CLI

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]
if (isMain) {
  const args = process.argv.slice(2)
  if (args.includes('--build')) {
    buildIndex({ log: (m) => console.log('[dsh-alexlib] ' + m), force: args.includes('--force') })
  } else if (args.includes('--stats')) {
    console.log(JSON.stringify(indexStats(), null, 2))
  } else {
    console.log('usage: node index.js --build [--force] | --stats')
  }
}
