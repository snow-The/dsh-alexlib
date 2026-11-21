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
 * 6. **FTS5 用 contentless（`content=''` + `contentless_delete=1`），但不用 `detail=none`。**
 *    我們用二字組 AND 而不是 FTS 的片語查詢，所以不需要位置資訊（省空間）——
 *    但 `detail=none` **會讓 bm25 失去詞頻**，同一個詞在每一篇分數相同，排序等於沒有。
 *    另外 `contentless_delete=1` 與 `columnsize=0` 不相容（SQLite 3.53.4 會直接報錯）。
 *    2026-11-07 實測後移除了這兩個選項；本檔頭的舊敘述曾與程式碼矛盾，已改正。
 */
import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join, relative, extname, basename } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { Worker } from 'node:worker_threads'

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
  const base = s
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]{0,400}>/g, ' ')
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#39;/g, "'")
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
  return denoisePages(base).text
}

/**
 * 清掉獨立成行的頁碼（2026-11-07，從 ocr-book-extract skill 搬進來的）。
 *
 * 為什麼需要：`cleanText` 原本只剝 HTML／URL／多餘空白，OCR 每頁的孤立數字行會原樣
 * 進 chunk 再進 FTS —— 使用者查「2020」會命中一堆頁碼，而頁碼本身沒有任何檢索價值。
 *
 * 為什麼要**先數再決定**：不能見到 `^\d+$` 就刪。表格裡「2020」獨立成行是資料，
 * 不是頁碼。只有在這種行出現 ≥5 次（＝具備分頁的重複性）時才整批移除；
 * 少於 5 次就原樣保留，並把 candidates 回報出去，讓呼叫端看得見我們沒動它。
 */
const PAGE_NO_RE = /^\s*\d{1,4}\s*$/
const PAGE_NO_MIN = 5

export function denoisePages(text) {
  const lines = text.split(/\r?\n/)
  let candidates = 0
  for (const l of lines) if (PAGE_NO_RE.test(l)) candidates++
  if (candidates < PAGE_NO_MIN) return { text, stripped: 0, candidates }
  return { text: lines.filter((l) => !PAGE_NO_RE.test(l)).join('\n'), stripped: candidates, candidates }
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

/**
 * 寫入用的連線（重建索引時才開）。**不要拿它來查詢。**
 * 只有 buildIndex 會用到；開一次、寫完就關。
 */
export function openDb(path = DB_PATH) {
  const db = new DatabaseSync(path)
  db.exec('PRAGMA journal_mode=WAL')
  db.exec('PRAGMA synchronous=NORMAL')
  db.exec('PRAGMA busy_timeout=5000')
  return db
}

// ── 唯讀連線（常駐）────────────────────────────────────────────────────
//
// 為什麼要常駐：這個 DB 是 859 MB（`chunks` 374 MB + FTS 465 MB）。
// 每次工具呼叫都 `new DatabaseSync()` 再 close()，等於每次都要重讀 WAL 索引、
// 重新暖頁快取。實測（2026-11-07，本機）：
//   A 每次開關：light 44.0 ms / heavy 158.9 ms
//   B 常駐連線：light 35.0 ms / heavy 140.4 ms
// 省下來的是 9 ms/次 的固定成本，而且每次都付。
//
// 為什麼要 query_only：唯讀連線不會去搶寫鎖，WAL 下多個讀者可以並行；
// 也防止有人手滑在查詢路徑寫入。
//
// 為什麼 close() 是 no-op：呼叫端（5 處）原本都寫 `db.close()`。與其改五個地方
// （每一個都是一次出錯機會），不如讓它無害——真正的關閉走 resetReader()。
let _reader = null
let _readerClose = null

export function openReader() {
  if (_reader) return _reader
  const db = new DatabaseSync(DB_PATH)
  db.exec('PRAGMA journal_mode=WAL')
  db.exec('PRAGMA query_only=1')
  db.exec('PRAGMA busy_timeout=5000')
  db.exec('PRAGMA cache_size=-65536')    // 64 MB 頁快取（FTS 的頁面很值錢）
  db.exec('PRAGMA mmap_size=536870912')  // 512 MB 記憶體映射，省掉 read() 系統呼叫
  db.exec('PRAGMA temp_store=MEMORY')    // bm25 排序的暫存留在記憶體
  _readerClose = db.close.bind(db)
  db.close = () => {}                    // 常駐連線：呼叫端寫的 close() 不會真的關
  _reader = db
  return db
}

/** 真正關掉常駐讀者。重建索引之後呼叫一次，讓下次查詢重新開一條。 */
export function resetReader() {
  if (!_reader) return false
  try { _readerClose() } catch { /* 已經關了 */ }
  _reader = null
  _readerClose = null
  return true
}

// ── 查詢工作執行緒 ────────────────────────────────────────────────────
//
// `node:sqlite` 是同步的：一次 132 ms 的 bm25 排序會卡住整個進程的事件循環。
// 把「搜尋」這種會重排的查詢丟到 worker，主執行緒只等 Promise。
// 啟動失敗時**退回本執行緒**（而不是讓工具壞掉），並印一次警告讓人看得見。
let _worker = null
let _workerBroken = false
let _workerSeq = 0
const _workerPending = new Map()

function getWorker() {
  if (_worker) return _worker
  if (_workerBroken) return null
  try {
    const w = new Worker(new URL('./worker/query-worker.mjs', import.meta.url), {
      type: 'module',
      workerData: { dbPath: DB_PATH },
    })
    w.on('message', (msg) => {
      const p = _workerPending.get(msg.id)
      if (!p) return
      _workerPending.delete(msg.id)
      if (msg.error) p.reject(new Error(msg.error))
      else p.resolve(msg.rows)
    })
    w.on('error', (err) => {
      console.error('[dsh-alexlib] query worker 失敗，退回主執行緒：' + err)
      _workerBroken = true
      for (const p of _workerPending.values()) p.reject(new Error('worker crashed'))
      _workerPending.clear()
      _worker = null
    })
    if (typeof w.unref === 'function') w.unref() // 不要因為它讓進程無法退出
    _worker = w
    return w
  } catch (e) {
    console.error('[dsh-alexlib] query worker 起不來，退回主執行緒：' + e)
    _workerBroken = true
    return null
  }
}

/** 在 worker 裡跑一個查詢。回 null 代表 worker 不可用，呼叫端要自己退回。 */
function queryInWorker(sql, params, timeoutMs = 30000) {
  const w = getWorker()
  if (!w) return null
  const id = ++_workerSeq
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (!_workerPending.has(id)) return
      _workerPending.delete(id)
      reject(new Error('query worker timeout after ' + timeoutMs + 'ms'))
    }, timeoutMs)
    _workerPending.set(id, {
      resolve: (rows) => { clearTimeout(timer); resolve(rows) },
      reject: (e) => { clearTimeout(timer); reject(e) },
    })
    w.postMessage({ id, sql, params })
  })
}

/** 收掉 worker（重建前要呼叫：它 mmap 著同一個檔案）。 */
export function stopWorker() {
  if (!_worker) return false
  try { _worker.terminate() } catch { /* 已經沒了 */ }
  _worker = null
  _workerBroken = false
  for (const p of _workerPending.values()) p.reject(new Error('worker stopped'))
  _workerPending.clear()
  return true
}

/**
 * 引擎現況。存在的理由：worker 起不來時會**靜默退回主執行緒**，
 * 而退回路徑的延遲數字看起來一樣好看——不看這支就分不出「真的用了 worker」與「退回去了」。
 * 2026-11-07 就發生過：忘了 import Worker，benchmark 量到的是退回路徑，我卻以為是 worker 的功勞。
 */
export function engineStatus() {
  return {
    reader: _reader !== null,
    worker: _worker !== null,
    worker_broken: _workerBroken,
    path: _worker ? 'worker' : (_workerBroken ? 'main(fallback)' : 'main(not-started)'),
  }
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
      tok, heading_tok, tokenize='unicode61 remove_diacritics 2',
      content='', contentless_delete=1
    );
    CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, val TEXT);
  `)

  // 遷移：`CREATE VIRTUAL TABLE IF NOT EXISTS` 不會改既有表的定義，所以舊庫的
  // chunks_fts 仍是「會把正文再存一份」的版本。實測那份 `chunks_fts_content` 佔 358.9 MB
  // （859 MB 的 41.8%），而我們從來不從 FTS 讀回欄位，只取 bm25() 與 rowid。
  // 偵測到舊定義就砍掉重建——資料不必救，它會由下一次 buildIndex 重新灌入。
  //
  // ⚠️ 兩個踩過的坑，改這裡之前先讀：
  //   1. `contentless_delete=1` 與 `columnsize=0` **不相容**。SQLite 3.53.4 的原文：
  //      "contentless_delete=1 is incompatible with columnsize=0"。所以新版放棄 columnsize=0。
  //   2. **不能先 DROP 再 CREATE**：一旦 CREATE 因參數錯誤失敗，舊表已經沒了，
  //      手上就是一個沒有 FTS 的索引（2026-11-07 真的發生過一次，chunks_fts 整個消失）。
  //      → 先用暫存表驗證新定義建得起來，成功之後才動舊表。
  //   3. **`detail=none` 會讓 bm25 變成常數**。它不存詞頻，於是同一個詞在每一篇的分數一樣，
  //      `ORDER BY bm25()` 等於任意排序。這個坑從第一版就在（2026-11-07 實測 raw bm25 全為 0）。
  //      拿掉 detail=none 之後才真的有排序。
  const FTS_SQL = `CREATE VIRTUAL TABLE chunks_fts USING fts5(
      tok, heading_tok, tokenize='unicode61 remove_diacritics 2',
      content='', contentless_delete=1
    )`
  const fts = db.prepare("SELECT sql FROM sqlite_master WHERE name='chunks_fts'").get()
  const stale = fts && (!String(fts.sql).includes("content=''") || /detail\s*=\s*none/.test(String(fts.sql)))
  if (stale) {
    db.exec("CREATE VIRTUAL TABLE chunks_fts_probe_definition USING fts5(tok, content='', contentless_delete=1)")
    db.exec('DROP TABLE chunks_fts_probe_definition')
    db.exec('DROP TABLE chunks_fts')
    db.exec(FTS_SQL)
  }
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
  // 重建前先把常駐讀者關掉：Windows 上 mmap 著的讀者會拖住檔案的截斷／搬移，
  // 而且重建會 DROP/重建表，舊連線的 schema 快取不該繼續存在。
  resetReader()
  stopWorker()
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
  const db = openReader()
  const d = db.prepare('SELECT count(*) AS n, COALESCE(sum(n_chunks),0) AS c, COALESCE(sum(n_paths),0) AS p FROM docs').get()
  const last = db.prepare("SELECT val FROM meta WHERE key='last_index'").get()
  db.close()
  return { indexed: true, db: DB_PATH, root: ROOT, unique_docs: d.n, chunks: d.c, paths: d.p, last_index: last ? last.val : null }
}

// ---------------------------------------------------------------- 工具

const textOutput = () => ({
  schema: { type: 'object', additionalProperties: true },
  render: (_a, v) => [{ type: 'text', text: typeof v === 'string' ? v : JSON.stringify(v) }],
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
    '在 AlexLib 書庫（約 346 份唯一文件 / 841 條路徑的 OCR markdown，繁體簡體都有）裡搜尋。中文用重疊二字組做片語級比對' +
    '（「認知作戰」必須三個二字組都命中）。**片語 AND 0 命中時會自動放寬成 OR**，此時 mode 會寫明 relaxed-OR、' +
    'relaxed_from 給出實際使用的表達式 —— 那幾筆不是精確片語命中，只是較鬆的相關結果。回傳來源、路徑、標題、片段與 BM25 分數。',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: '查詢字串（中文或英文）' },
      k: { type: 'number', description: '回傳幾筆，預設 5' },
      source: { type: 'string', description: '限定來源：oc / w8 / gas / home' },
      snippet: { type: 'number', description: '每筆片段長度，預設 160' },
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
    const k = num(args, 'k', 5), width = num(args, 'snippet', 160), src = str(args, 'source')
    const db = openReader()
    const sql = 'SELECT c.sha256, c.ord, c.heading, c.text, d.rel, d.title, d.n_paths, bm25(chunks_fts) AS score ' +
      'FROM chunks_fts JOIN chunks c ON c.id = chunks_fts.rowid JOIN docs d ON d.sha256 = c.sha256 ' +
      'WHERE chunks_fts MATCH ?' + (src ? ' AND d.source = ?' : '') + ' ORDER BY score LIMIT ?'
    // 主查詢走 worker：`node:sqlite` 是同步的，一次 132 ms 的 bm25 排序會卡住整個進程。
    // worker 不可用／掛掉 → 退回本執行緒（寧可慢，不要壞）。
    let rows = null
    const mainParams = src ? [expr, src, k] : [expr, k]
    const viaWorker = queryInWorker(sql, mainParams)
    if (viaWorker) {
      try { rows = await viaWorker } catch { rows = null }
    }
    if (rows === null) rows = src ? db.prepare(sql).all(expr, src, k) : db.prepare(sql).all(expr, k)

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
    // ── 真的有 0 命中時，把上面算好的 relax_expr 跑掉（2026-11-07）────────────
    //
    // 實測 235 個 session、23 次 alexlib_search：**43.5% 回 0**，而那 10 次裡有 9 次
    // 用 OR 就有結果（例：`团队 分工 角色` 0 → OR 1,034 個 chunk，+30 ms）。
    // 舊版把 relax_expr 算出來放在 diagnose 裡**從來沒有執行**——於是使用者拿到的是一個
    // 需要自己再去打一次的建議，而 `alexlib_doc` 在 235 個 session 裡**一次都沒被呼叫**。
    //
    // 這不是把判準改鬆：`mode` 會明說這是 relaxed，且 `diagnose` 保留「片語 AND 為何是 0」。
    // 放寬的結果**不可以長得像精確命中**。
    let relaxedFrom = null
    if (rows.length === 0 && diagnose && diagnose.relax_expr) {
      try {
        const relaxParams = src ? [diagnose.relax_expr, src, k] : [diagnose.relax_expr, k]
        let r = null
        const viaWorker2 = queryInWorker(sql, relaxParams)
        if (viaWorker2) {
          try { r = await viaWorker2 } catch { r = null }
        }
        if (r === null) r = db.prepare(sql).all(...relaxParams)
        if (r.length) { rows = r; relaxedFrom = diagnose.relax_expr }
      } catch {
        /* 放寬也失敗就維持 0 命中，不要吃掉上面那份診斷 */
      }
    }
    db.close()
    return {
      query: q,
      tokens: toks,
      mode: relaxedFrom
        ? 'relaxed-OR（片語 AND 0 命中 → 已自動放寬為任一詞命中；**這些不是精確片語命中**）'
        : 'bigram-AND（片語級）',
      hits: rows.length,
      relaxed_from: relaxedFrom,
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
    const db = openReader()
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
    const db = openReader()
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

// 偵察：取代「先整檔 read 再看」與「教模型怎麼數行數」。
// 這支工具的存在理由就是 2026-11-07 那條討論：OCR 書的機械前處理（數大小、找章節、
// 決定分頁預算）是程式的工作，不該寫在 skill 裡要模型照做。
const PROBE_LINES = 7000       // >7000 行就別整檔讀（實測 OCR 檔的空白+雜訊約 47%）
const PROBE_BYTES = 256 * 1024 // 1 MB 的 OCR 檔有效內容約 256 KB

const probeTool = {
  name: 'alexlib_probe',
  description:
    '偵察一份 OCR markdown：大小、行數、空白比率、獨立數字行（頁碼候選）、標題數、預估 chunk 數，' +
    '並直接給出「該不該整檔讀」的結論。**要讀一本書之前先跑這個，不要直接 read 整檔。**' +
    '不傳 rel 就列出最大的幾份（只 stat，不讀內容）。',
  parameters: {
    type: 'object',
    properties: {
      rel: { type: 'string', description: '路徑或標題片段（省略則列出最大的幾份）' },
      limit: { type: 'number', description: '沒給 rel 時列幾份，預設 10' },
    },
  },
  output: textOutput(),
  timeoutMs: 60000,
  isConcurrencySafe: () => true,
  async execute(args) {
    if (!existsSync(OCR_DIR)) throw new Error('AlexLib/ocr not found: ' + OCR_DIR)
    const rel = str(args, 'rel')
    const lim = num(args, 'limit', 10)
    const files = walk(OCR_DIR)

    if (!rel) {
      const rows = files
        .map((p) => ({ rel: relative(OCR_DIR, p).split('\\').join('/'), bytes: statSync(p).size }))
        .sort((a, b) => b.bytes - a.bytes)
        .slice(0, lim)
        .map((r) => ({ ...r, over_budget: r.bytes > PROBE_BYTES }))
      return { scanned_files: files.length, budget_bytes: PROBE_BYTES, biggest: rows }
    }

    const low = rel.toLowerCase()
    const hits = files.filter((p) => {
      const r = relative(OCR_DIR, p).split('\\').join('/')
      return r.toLowerCase().includes(low) || basename(p).toLowerCase().includes(low)
    })
    if (hits.length === 0) throw new Error('找不到符合的檔案：' + rel)
    if (hits.length > 1) {
      return {
        matched: hits.slice(0, 20).map((p) => relative(OCR_DIR, p).split('\\').join('/')),
        note: '符合多份，請給更精確的 rel（以上只列前 20 筆）',
      }
    }

    const p = hits[0]
    const raw = readFileSync(p, 'utf8')
    const rawLines = raw.split(/\r?\n/)
    const bytes = Buffer.byteLength(raw, 'utf8')
    const blank = rawLines.filter((l) => l.trim() === '').length
    const pages = denoisePages(raw)
    const cleaned = cleanText(raw)
    const headings = (raw.match(/^#{1,6}\s+\S/gm) || []).length
    const estChunks = Math.max(0, Math.ceil(cleaned.length / CHUNK_TARGET))
    const overBudget = rawLines.length > PROBE_LINES || bytes > PROBE_BYTES
    return {
      rel: relative(OCR_DIR, p).split('\\').join('/'),
      bytes,
      lines: rawLines.length,
      blank_lines: blank,
      blank_ratio: Number((blank / Math.max(1, rawLines.length)).toFixed(3)),
      page_number_lines: pages.candidates,
      page_numbers_stripped: pages.stripped,
      headings,
      cleaned_chars: cleaned.length,
      est_chunks: estChunks,
      chunk_target: CHUNK_TARGET,
      over_budget: overBudget,
      budget: { lines: PROBE_LINES, bytes: PROBE_BYTES },
      advice: overBudget
        ? '不要整檔讀：用 alexlib_doc(rel, offset, limit) 分頁，共約 ' + estChunks + ' 個 chunk；先用 alexlib_search 縮小到相關段落。'
        : '檔案在預算內，可以整檔讀；但仍建議先用 alexlib_search 定位。',
    }
  },
}

const statsTool = {  name: 'alexlib_stats',
  description: 'AlexLib 索引狀態：唯一文件數、chunk 數、別名路徑數、最後索引時間。',
  parameters: { type: 'object', properties: {} },
  output: textOutput(),
  timeoutMs: 30000,
  isConcurrencySafe: () => true,
  async execute() { return indexStats() },
}

// 不再對 agent 掛 alexlib_reindex（2026-11-07）。
//
// 它是 timeoutMs 600000 的阻塞式全量重建，description 自己都寫「建議在終端機跑、
// 不要佔住 agent 迴圈」—— 那就不該同時把它擺在 agent 伸手可及的地方。
// 重建走 CLI：node index.js --build / --force（本檔尾端已經接好），buildIndex 仍照舊 export。
export function apply(ctx) {
  for (const tool of [searchTool, docTool, listTool, probeTool, statsTool]) {
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
