const { app, BrowserWindow, Menu, ipcMain, dialog } = require('electron')
const path = require('path')
const fs = require('fs')
const initSqlJs = require('sql.js')

const isDev = !app.isPackaged
let SQL_PROMISE = null
async function getSQL() {
  if (!SQL_PROMISE) SQL_PROMISE = initSqlJs()
  return SQL_PROMISE
}

const dbCache = new Map() // dbPath -> { mtimeMs, db }
const offsetLookup = [0x1092,0x254F,0x348,0x14B40,0x241A,0x2676,0x7F,0x9,0x250B,0x18A,0x7B,0x12E2,0x7EBC,0x5F23,0x981,0x11,0x85BA,0x0A566,0x1093,0x0E,0x2D266,0x7C3,0x0C16,0x76D,0x15D41,0x12CD,0x25,0x8F,0x0DA2,0x4C1B,0x53F,0x1B0,0x14AFC,0x23E0,0x258C,0x4D1,0x0D6A,0x72F,0x0BA8,0x7C9,0x0BA8,0x131F,0x0C75C7,0x0D]
function descramble(u8) {
  for (let currOff = u8.length - 1; currOff >= 0; currOff--) {
    const offset = (currOff + offsetLookup[currOff % 44]) % u8.length
    const tmp = u8[currOff]; u8[currOff] = u8[offset]; u8[offset] = tmp
  }
  for (let i = 0; i < u8.length; i++) u8[i] = (255 - u8[i]) & 255
}
function scramble(u8) {
  // inverse of descramble()
  for (let i = 0; i < u8.length; i++) u8[i] = (255 - u8[i]) & 255
  for (let currOff = 0; currOff < u8.length; currOff++) {
    const offset = (currOff + offsetLookup[currOff % 44]) % u8.length
    const tmp = u8[currOff]; u8[currOff] = u8[offset]; u8[offset] = tmp
  }
}
async function openDb(dbPath) {
  const st = fs.statSync(dbPath)
  const cached = dbCache.get(dbPath)
  if (cached && cached.mtimeMs === st.mtimeMs) return cached.db
  if (cached) { try { cached.db.close() } catch {} }
  const SQL = await getSQL()
  const bytes = fs.readFileSync(dbPath)
  const db = new SQL.Database(bytes)
  dbCache.set(dbPath, { mtimeMs: st.mtimeMs, db })
  return db
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1500,
    height: 950,
    title: 'Nova - Voxel Studio',
    icon: path.join(__dirname, 'public', 'branding', 'app_icon.png'),
    backgroundColor: '#12151c',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.cjs')
    }
  })
  Menu.setApplicationMenu(null)
  win.setMenuBarVisibility(false)
  win.once('ready-to-show', () => win.show())
  const distIndex = path.join(__dirname, 'dist', 'index.html')
  if (fs.existsSync(distIndex)) win.loadFile(distIndex)
  else win.loadURL('http://127.0.0.1:4173')
}

ipcMain.handle('nova:pickDirectory', async () => {
  const res = await dialog.showOpenDialog({
    properties: ['openDirectory'],
    title: 'Select Cube World root directory'
  })
  if (res.canceled) return null
  return res.filePaths?.[0] ?? null
})

ipcMain.handle('nova:listCubFiles', async (_evt, { rootDir, query } = {}) => {
  if (!rootDir || typeof rootDir !== 'string') return []
  const q = (query || '').toLowerCase().trim()
  const results = []
  const walk = (dir) => {
    let items
    try { items = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const it of items) {
      const full = path.join(dir, it.name)
      if (it.isDirectory()) walk(full)
      else if (it.isFile() && it.name.toLowerCase().endsWith('.cub')) {
        const rel = path.relative(rootDir, full).replace(/\\/g, '/')
        if (!q || rel.toLowerCase().includes(q)) results.push({ rel, full, name: it.name })
      }
    }
  }
  walk(rootDir)
  // cap to keep UI snappy (search narrows it anyway)
  results.sort((a, b) => a.rel.localeCompare(b.rel))
  return results.slice(0, 5000)
})

ipcMain.handle('nova:listDbFiles', async (_evt, { rootDir } = {}) => {
  if (!rootDir || typeof rootDir !== 'string') return []
  const results = []
  const walk = (dir) => {
    let items
    try { items = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const it of items) {
      const full = path.join(dir, it.name)
      if (it.isDirectory()) walk(full)
      else if (it.isFile() && it.name.toLowerCase().endsWith('.db')) {
        const rel = path.relative(rootDir, full).replace(/\\/g, '/')
        results.push({ rel, full, name: it.name })
      }
    }
  }
  walk(rootDir)
  results.sort((a, b) => a.rel.localeCompare(b.rel))
  return results
})

ipcMain.handle('nova:readFile', async (_evt, { path: filePath } = {}) => {
  if (!filePath || typeof filePath !== 'string') return null
  try {
    const b = fs.readFileSync(filePath)
    return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)
  } catch {
    return null
  }
})

ipcMain.handle('nova:saveProject', async (_evt, { suggestedName, arrayBuffer } = {}) => {
  try {
    const projectsDir = path.join(__dirname, 'projects')
    try { if (!fs.existsSync(projectsDir)) fs.mkdirSync(projectsDir, { recursive: true }) } catch {}
    const res = await dialog.showSaveDialog({
      title: 'Save Project',
      defaultPath: path.join(projectsDir, (suggestedName && String(suggestedName)) ? String(suggestedName) : 'project.nvsproj'),
      filters: [{ name: 'Nova Voxel Studio Project', extensions: ['nvsproj'] }]
    })
    if (res.canceled || !res.filePath) return { ok: false, canceled: true }
    const u8 = new Uint8Array(arrayBuffer || new ArrayBuffer(0))
    fs.writeFileSync(res.filePath, Buffer.from(u8))
    return { ok: true, path: res.filePath }
  } catch (e) {
    return { ok: false, error: String(e?.message || e) }
  }
})

ipcMain.handle('nova:openProject', async () => {
  try {
    const projectsDir = path.join(__dirname, 'projects')
    try { if (!fs.existsSync(projectsDir)) fs.mkdirSync(projectsDir, { recursive: true }) } catch {}
    const res = await dialog.showOpenDialog({
      title: 'Open Project',
      defaultPath: projectsDir,
      properties: ['openFile'],
      filters: [{ name: 'Nova Voxel Studio Project', extensions: ['nvsproj'] }]
    })
    if (res.canceled || !res.filePaths?.[0]) return { ok: false, canceled: true }
    const p = res.filePaths[0]
    const b = fs.readFileSync(p)
    return { ok: true, path: p, arrayBuffer: b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) }
  } catch (e) {
    return { ok: false, error: String(e?.message || e) }
  }
})


ipcMain.handle('nova:listDbAssets', async (_evt, { dbPath, query } = {}) => {
  if (!dbPath || typeof dbPath !== 'string') return []
  const q = (query || '').toLowerCase().trim()
  try {
    const db = await openDb(dbPath)
    const keys = []
    const stmt = db.prepare('SELECT `key` FROM `blobs`')
    while (stmt.step()) {
      const k = String(stmt.get()[0])
      if (!k.toLowerCase().endsWith('.cub')) continue
      if (q && !k.toLowerCase().includes(q)) continue
      keys.push(k)
      if (keys.length >= 8000) break
    }
    stmt.free()
    keys.sort((a, b) => a.localeCompare(b))
    return keys
  } catch {
    return []
  }
})

ipcMain.handle('nova:readDbAsset', async (_evt, { dbPath, key } = {}) => {
  if (!dbPath || typeof dbPath !== 'string' || !key || typeof key !== 'string') return null
  try {
    const db = await openDb(dbPath)
    const stmt = db.prepare('SELECT `value` FROM `blobs` WHERE `key` = ?')
    stmt.bind([key])
    let out = null
    if (stmt.step()) {
      const v = stmt.get()[0]
      const u8 = v instanceof Uint8Array ? new Uint8Array(v) : new Uint8Array(v)
      descramble(u8)
      out = u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength)
    }
    stmt.free()
    return out
  } catch {
    return null
  }
})

ipcMain.handle('nova:replaceDbAsset', async (_evt, { dbPath, key, valueBuffer } = {}) => {
  if (!dbPath || typeof dbPath !== 'string' || !key || typeof key !== 'string' || !valueBuffer) return { ok: false, error: 'Invalid args' }
  try {
    const SQL = await getSQL()
    const originalBytes = fs.readFileSync(dbPath)
    const db = new SQL.Database(originalBytes)

    // make sure row exists
    const check = db.prepare('SELECT COUNT(1) FROM `blobs` WHERE `key` = ?')
    check.bind([key])
    let exists = 0
    if (check.step()) exists = Number(check.get()[0] || 0)
    check.free()
    if (!exists) { try { db.close() } catch {} ; return { ok: false, error: 'Key not found in blobs table' } }

    // scramble bytes the same way Cube World stores them
    const u8 = new Uint8Array(valueBuffer)
    const scrambled = new Uint8Array(u8) // copy
    scramble(scrambled)

    const stmt = db.prepare('UPDATE `blobs` SET `value` = ? WHERE `key` = ?')
    stmt.bind([scrambled, key])
    stmt.step()
    stmt.free()

    const outBytes = db.export()
    try { db.close() } catch {}

    fs.writeFileSync(dbPath, Buffer.from(outBytes))
    // invalidate cache
    const cached = dbCache.get(dbPath)
    if (cached) { try { cached.db.close() } catch {} ; dbCache.delete(dbPath) }
    return { ok: true }
  } catch (e) {
    return { ok: false, error: String(e?.message || e) }
  }
})

ipcMain.handle('nova:createDbBackup', async (_evt, { dbPath, outDir } = {}) => {
  if (!dbPath || typeof dbPath !== 'string' || !outDir || typeof outDir !== 'string') return { ok: false, error: 'Invalid args' }
  try {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const dbName = path.basename(dbPath).replace(/[^a-zA-Z0-9._-]+/g, '_')
    const baseOut = path.join(outDir, `NovaVoxelStudio_Backup_${dbName}_${stamp}`)
    fs.mkdirSync(baseOut, { recursive: true })

    const dest = path.join(baseOut, dbName)
    fs.copyFileSync(dbPath, dest)

    // write a tiny manifest so it's easy to see what got backed up
    fs.writeFileSync(path.join(baseOut, 'manifest.json'), JSON.stringify({
      createdAt: new Date().toISOString(),
      dbPath,
      copied: 1,
      file: dbName
    }, null, 2))

    return { ok: true, outDir: baseOut, copied: 1 }
  } catch (e) {
    return { ok: false, error: String(e?.message || e) }
  }
})

app.whenReady().then(createWindow)
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
