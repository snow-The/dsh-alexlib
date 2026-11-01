import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 測試用一個臨時書庫，不碰真的 AlexLib。
//
// ⚠️ fixture 的內容是刻意設計的，改動前先讀這裡：
//   A 有「複雜系統」與「認知」，但**沒有**「認知作戰」——「認知」與「作戰」之間隔了別的詞。
//   寫這個檔案時我自己踩過一次：第一版把「認知作戰」四個字直接寫進 A，
//   然後斷言片語查詢不該命中——那是拿測試去證明一件我自己破壞掉的事。
const A_BODY = '複雜系統的湧現性無法由組分的行為推得。睡眠不足會影響認知能力，而作戰計畫需要冷靜。'
const B_BODY = '情報分析與通信偵察：截獲敵方通信信號，分析其技術體制，判明其屬性。'

const root = mkdtempSync(join(tmpdir(), 'alexlib-test-'))
mkdirSync(join(root, 'ocr', 'home'), { recursive: true })
mkdirSync(join(root, 'ocr', 'oc'), { recursive: true })
writeFileSync(join(root, 'ocr', 'home', 'a.pdf_by_PaddleOCR-VL-1.6.md'), '# 第五章 複雜系統\n\n' + A_BODY + '\n')
// 同一本書、不同路徑、同樣內容 -> 應該被合併
writeFileSync(join(root, 'ocr', 'oc', 'a.pdf_by_PaddleOCR-VL-1.6.md'), '# 第五章 複雜系統\n\n' + A_BODY + '\n')
writeFileSync(join(root, 'ocr', 'home', 'b.pdf_by_PaddleOCR-VL-1.6.md'), '# 情報\n\n' + B_BODY + '\n')

process.env.ALEXLIB_ROOT = root
process.env.ALEXLIB_DB = join(root, 'index.db')
const m = await import('../index.js')

test('漢字切成重疊二字組', () => {
  assert.deepEqual(m.tokenize('複雜系統'), ['复杂', '杂系', '系统'])
})

test('繁簡產生相同的詞', () => {
  assert.deepEqual(m.tokenize('認知作戰'), m.tokenize('认知作战'))
  assert.deepEqual(m.tokenize('認知作戰'), ['认知', '知作', '作战'])
})

test('英文與數字照原樣、轉小寫', () => {
  assert.deepEqual(m.tokenize('Game Engine 3'), ['game', 'engine', '3'])
})

test('超長單行會被硬切，不會產生巨型 chunk', () => {
  const chunks = m.chunkMarkdown('# H\n\n' + 'x'.repeat(9000))
  assert.ok(chunks.length > 1)
  assert.ok(Math.max(...chunks.map((c) => c.text.length)) <= 2200)
})

test('OCR 標記會從檔名主幹去掉', () => {
  assert.equal(m.ocrStem('x.pdf_by_PaddleOCR-VL-1.6.md'), 'x.pdf')
  assert.equal(m.ocrStem('x.pdf_by_PaddleOCR-VL-1.5.md.clean.md'), 'x.pdf')
})

test('fixture 自檢：A 裡沒有「認知作戰」這四個字', () => {
  assert.ok(A_BODY.includes('認知'))
  assert.ok(A_BODY.includes('作戰'))
  assert.ok(!A_BODY.includes('認知作戰'), 'fixture 本身不能含被測片語')
})

test('buildIndex 會合併同內容不同路徑', () => {
  const r = m.buildIndex({ log: () => {} })
  assert.equal(r.docs, 2)      // a（兩個路徑，一筆） + b
  assert.equal(r.chunks, 2)
})

test('工具註冊了五個', () => {
  const tools = []
  m.apply({ tools: { register: (t) => tools.push(t) } })
  assert.deepEqual(tools.map((t) => t.name).sort(),
    ['alexlib_doc', 'alexlib_list', 'alexlib_reindex', 'alexlib_search', 'alexlib_stats'])
})

test('搜尋命中，且片段取自原文而不是分詞結果', async () => {
  const tools = []
  m.apply({ tools: { register: (t) => tools.push(t) } })
  const search = tools.find((t) => t.name === 'alexlib_search')
  const r = await search.execute({ query: '复杂系统', k: 5, snippet: 200 })
  assert.equal(r.hits, 1)
  assert.match(r.results[0].snippet, /複雜系統/)
})

test('片語級比對：詞沒有連在一起就不命中', async () => {
  const tools = []
  m.apply({ tools: { register: (t) => tools.push(t) } })
  const search = tools.find((t) => t.name === 'alexlib_search')
  const phrase = await search.execute({ query: '認知作戰', k: 5 })
  assert.equal(phrase.hits, 0, '認知 與 作戰 沒有相鄰，不該命中')
  const single = await search.execute({ query: '認知', k: 5 })
  assert.equal(single.hits, 1, '單獨的二字組仍然查得到')
  const other = await search.execute({ query: '情报分析', k: 5 })
  assert.equal(other.hits, 1)
})

test('alexlib_doc 看得到別名路徑', async () => {
  const tools = []
  m.apply({ tools: { register: (t) => tools.push(t) } })
  const doc = tools.find((t) => t.name === 'alexlib_doc')
  const d = await doc.execute({ rel: 'a.pdf', limit: 1 })
  assert.equal(d.found, true)
  assert.equal(d.aliases, 1)
  assert.equal(d.all_paths.length, 2)
})

test('索引不存在時給的是可行動的錯誤', async () => {
  const saved = process.env.ALEXLIB_DB
  process.env.ALEXLIB_DB = join(root, 'nope.db')
  const mod = await import('../index.js?missing=1')
  const tools = []
  mod.apply({ tools: { register: (t) => tools.push(t) } })
  const search = tools.find((t) => t.name === 'alexlib_search')
  await assert.rejects(() => search.execute({ query: 'x' }), /--build/)
  process.env.ALEXLIB_DB = saved
})
