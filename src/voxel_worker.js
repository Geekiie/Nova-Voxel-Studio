const faceDefs = [
  { n: [1, 0, 0], verts: [[0.5, -0.5, -0.5], [0.5, -0.5, 0.5], [0.5, 0.5, 0.5], [0.5, 0.5, -0.5]] },
  { n: [-1, 0, 0], verts: [[-0.5, -0.5, 0.5], [-0.5, -0.5, -0.5], [-0.5, 0.5, -0.5], [-0.5, 0.5, 0.5]] },
  { n: [0, 1, 0], verts: [[-0.5, 0.5, 0.5], [0.5, 0.5, 0.5], [0.5, 0.5, -0.5], [-0.5, 0.5, -0.5]] },
  { n: [0, -1, 0], verts: [[-0.5, -0.5, 0.5], [0.5, -0.5, 0.5], [0.5, -0.5, -0.5], [-0.5, -0.5, -0.5]] },
  { n: [0, 0, 1], verts: [[0.5, -0.5, 0.5], [-0.5, -0.5, 0.5], [-0.5, 0.5, 0.5], [0.5, 0.5, 0.5]] },
  { n: [0, 0, -1], verts: [[-0.5, -0.5, -0.5], [0.5, -0.5, -0.5], [0.5, 0.5, -0.5], [-0.5, 0.5, -0.5]] }
]

function parseKey(k) {
  const p = k.split(',')
  return [p[0] | 0, p[1] | 0, p[2] | 0]
}
function keyOf(x, y, z) { return `${x},${y},${z}` }

self.onmessage = (e) => {
  const msg = e.data
  if (!msg || msg.type !== 'buildChunk') return
  const id = msg.id
  try {
    const occ = new Set(msg.occKeys || [])
    const voxKeys = msg.voxKeys || []
    const colors = msg.colors || []
    const pos = []
    const nrm = []
    const col = []
    const idx = []
    let v = 0
    for (let i = 0; i < voxKeys.length; i++) {
      const k = voxKeys[i]
      const [x, y, z] = parseKey(k)
      const cc = colors[i] || { r: 255, g: 255, b: 255 }
      const cr = Math.max(0, Math.min(255, cc.r)) / 255
      const cg = Math.max(0, Math.min(255, cc.g)) / 255
      const cb = Math.max(0, Math.min(255, cc.b)) / 255
      for (const f of faceDefs) {
        const nk = keyOf(x + f.n[0], y + f.n[1], z + f.n[2])
        if (occ.has(nk)) continue
        const base = v
        for (const vv of f.verts) {
          pos.push(x + vv[0], y + vv[1], z + vv[2])
          nrm.push(f.n[0], f.n[1], f.n[2])
          col.push(cr, cg, cb)
          v++
        }
        idx.push(base, base + 1, base + 2, base, base + 2, base + 3)
      }
    }

    const posA = new Float32Array(pos)
    const nrmA = new Float32Array(nrm)
    const colA = new Float32Array(col)
    const idxA = new Uint32Array(idx)
    self.postMessage({ ok: true, id, pos: posA, nrm: nrmA, col: colA, idx: idxA }, [posA.buffer, nrmA.buffer, colA.buffer, idxA.buffer])
  } catch (err) {
    self.postMessage({ ok: false, id, error: String(err?.message || err) })
  }
}

