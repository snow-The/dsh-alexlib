// 查詢工作執行緒：自己的連線、自己的執行緒。
//
// 為什麼需要它：`node:sqlite` 是**同步** API。一次 132 ms 的 bm25 排序會把整個進程的
// 事件循環卡住——同一時間的 UI 請求、心跳、其他工具全部排隊。把查詢丟到 worker，
// 主執行緒只等 Promise，不再被 CPU 佔住。
//
// 通訊協定：{ id, sql, params } → { id, rows } 或 { id, error }
import { DatabaseSync } from 'node:sqlite'
import { parentPort, workerData } from 'node:worker_threads'

const db = new DatabaseSync(workerData.dbPath)
db.exec('PRAGMA journal_mode=WAL')
db.exec('PRAGMA query_only=1')          // 這個執行緒永遠不寫
db.exec('PRAGMA busy_timeout=5000')
db.exec('PRAGMA cache_size=-65536')     // 64 MB
db.exec('PRAGMA mmap_size=536870912')   // 512 MB
db.exec('PRAGMA temp_store=MEMORY')

parentPort.on('message', ({ id, sql, params }) => {
  try {
    const stmt = db.prepare(sql)
    const rows = stmt.all(...(params || []))
    parentPort.postMessage({ id, rows })
  } catch (e) {
    parentPort.postMessage({ id, error: String(e && e.message ? e.message : e).slice(0, 500) })
  }
})

// 主執行緒叫我們收工
parentPort.on('close', () => { try { db.close() } catch { /* ignore */ } })
