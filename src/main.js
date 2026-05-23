import './style.css'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js'
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js'
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js'
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { STLExporter } from 'three/examples/jsm/exporters/STLExporter.js'
import { OBJExporter } from 'three/examples/jsm/exporters/OBJExporter.js'
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js'

// Chunk meshing worker (keeps big edits from freezing the UI).
let voxelWorker = null
let voxelWorkerReq = 1
const voxelWorkerPending = new Map() // id -> { resolve, reject }

const DEFAULT_SHORTCUTS = {
  voxelBrush: 'b', paintBrush: 'p', airBrush: 'a', eraser: 'e',
  bucket: 'f', scale: 's', select: 'm', rotate: 'r', eyedropHoldAlt: 'alt+click'
}

const state = {
  theme: 'dark', activeColor: '#7aa2ff', brushSize: 1, tool: 'voxelBrush',
  voxelMap: new Map(), selected: new Set(), undo: [], redo: [],
  shortcuts: JSON.parse(localStorage.getItem('nova.shortcuts') || 'null') || { ...DEFAULT_SHORTCUTS },
  pointer: { painting: false, resizeBrush: false, resizeStartX: 0, resizeStartSize: 1, lastKey: null, prevTool: null, lastForwardPlaceAt: 0, altEyedropActive: false, lockAreaKeys: new Set(), scaleStart: null, lastClientX: null, lastClientY: null },
  scaleMode: false, shiftDown: false,
  uiTyping: false,
  layerClipboard: null,
  strokeDirty: false,
  strokeRebuildScheduled: false,
  strokeLastRebuildAt: 0,
  strokeOverlay: { active: false, addInst: null, delInst: null, max: 18000, addCount: 0, delCount: 0, addKeyToIndex: new Map(), delKeyToIndex: new Map() },
  strokeOps: null, // Map<voxelKey, { op: 'set'|'del', color?:{r,g,b} }>
  chunkRebuild: { queue: [], queued: new Set(), maxPerFrame: 3 },
  brushCache: new Map() // Map<brushSize, Array<[dx,dy,dz]>>
}
state.shortcuts.select = 'm'
state.shortcuts.scale = 's'
// Clean up old shortcut keys we don't use anymore.
for (const k of Object.keys(state.shortcuts)) {
  if (!(k in DEFAULT_SHORTCUTS)) delete state.shortcuts[k]
}

document.querySelector('#app').innerHTML = `
<div class="app">
  <div id="topMenuBar" class="topMenuBar">
    <div class="menuItem">
      <button id="fileMenuBtn" class="menuTab">File</button>
      <div id="fileMenu" class="menuPanel hidden">
        <button id="menuOpenProjectBtn">Open Project</button>
        <button id="menuNewProjectBtn">New Project</button>
        <button id="menuSaveProjectBtn">Save Project</button>
        <button id="menuImportBtn">Import Model</button>
        <div class="menuSubWrap">
          <button id="menuExportLayerBtn">Export Layer ▸</button>
          <div id="exportLayerSubMenu" class="menuPanel menuSub hidden">
            <button data-export-scope="layer" data-export-fmt="cub">Export .cub</button>
            <button data-export-scope="layer" data-export-fmt="json">Export .json</button>
            <button data-export-scope="layer" data-export-fmt="vox">Export .vox</button>
            <button data-export-scope="layer" data-export-fmt="stl">Export .stl</button>
            <button data-export-scope="layer" data-export-fmt="obj">Export .obj</button>
            <button data-export-scope="layer" data-export-fmt="fbx">Export .fbx</button>
            <button data-export-scope="layer" data-export-fmt="gltf">Export .gltf</button>
            <button data-export-scope="layer" data-export-fmt="glb">Export .glb</button>
          </div>
        </div>
        <div class="menuSubWrap">
          <button id="menuExportWorkspaceBtn">Export Workspace ▸</button>
          <div id="exportWorkspaceSubMenu" class="menuPanel menuSub hidden">
            <button data-export-scope="workspace" data-export-fmt="cub">Export .cub</button>
            <button data-export-scope="workspace" data-export-fmt="json">Export .json</button>
            <button data-export-scope="workspace" data-export-fmt="vox">Export .vox</button>
            <button data-export-scope="workspace" data-export-fmt="stl">Export .stl</button>
            <button data-export-scope="workspace" data-export-fmt="obj">Export .obj</button>
            <button data-export-scope="workspace" data-export-fmt="fbx">Export .fbx</button>
            <button data-export-scope="workspace" data-export-fmt="gltf">Export .gltf</button>
            <button data-export-scope="workspace" data-export-fmt="glb">Export .glb</button>
          </div>
        </div>
      </div>
    </div>
    <div class="menuItem">
      <button id="settingsMenuBtn" class="menuTab">Settings</button>
      <div id="settingsMenu" class="menuPanel hidden">
        <button id="settingsThemeBtn">Dark Mode</button>
        <button id="settingsShortcutsBtn">Keyboard Shortcuts</button>
        <button id="settingsHslBtn">Edit Hue / Saturation / Luminosity</button>
      </div>
    </div>
    <div class="menuItem">
      <button id="helpMenuBtn" class="menuTab">Help</button>
      <div id="helpMenu" class="menuPanel hidden">
        <div class="helpText">F1: Toggle menu bar</div>
      </div>
    </div>
    <div class="menuItem" style="display:flex;gap:6px;align-items:center;">
      <button id="topUndoBtn" class="menuTab bigIconBtn" title="Undo (Ctrl+Z)">↶</button>
      <button id="topRedoBtn" class="menuTab bigIconBtn" title="Redo (Ctrl+Shift+Z)">↷</button>
    </div>
    <input id="fileInput" class="hiddenFileInput" type="file" accept=".obj,.stl,.fbx,.gltf,.glb,.cub,.vox" />
  </div>
  <aside class="sidebar">
    <h2><img src="./branding/logo_main.png" alt="Nova Voxel Studio" id="brandLogo"></h2>
    <div id="statusLine" style="font-size:12px;opacity:.8;min-height:16px;"></div>
    <div class="toolCols">
      <div style="grid-column:1 / -1;">
        <h3>Tools</h3>
        <div class="toolGrid">
          <button class="iconBtn" data-tool="voxelBrush" title="Voxel Brush (B)"><img class="toolIcon" src="./branding/icons/voxel_brush_icon.png" alt="Voxel Brush"></button>
          <button class="iconBtn" data-tool="eraser" title="Voxel Eraser (E)"><img class="toolIcon" src="./branding/icons/eraser_icon.png" alt="Eraser"></button>
          <button class="iconBtn" data-tool="paintBrush" title="Paint Brush (P)"><img class="toolIcon" src="./branding/icons/color_brush_icon.png" alt="Paint Brush"></button>
          <button class="iconBtn" data-tool="airBrush" title="Airbrush (A)"><img class="toolIcon" src="./branding/icons/air_brush_icon.png" alt="Air Brush"></button>
          <button class="iconBtn" data-tool="bucket" title="Bucket Fill (F)"><img class="toolIcon" src="./branding/icons/paint_bucket_icon.png" alt="Bucket"></button>
          <button class="iconBtn" data-tool="picker" title="Eyedropper (Alt+Click)"><img class="toolIcon" src="./branding/icons/eye_dropper_icon.png" alt="Eyedropper"></button>
        </div>
      </div>
    </div>
    <div class="row colorRow">
      <label>Brush Size
        <select id="brushSize">
          ${Array.from({ length: 16 }, (_, i) => `<option value="${i + 1}" ${i + 1 === state.brushSize ? 'selected' : ''}>${i + 1}</option>`).join('')}
        </select>
      </label>
      <label class="colorLabelRow"><span>Color</span><input id="colorPicker" type="color" value="#7aa2ff"></label>
      <button id="savePalette">＋</button>
    </div>
    <div id="palette" class="palette"></div>
    <div class="layersPanel">
      <div class="layersHeader">
        <h3>Layers</h3>
        <div class="layersBtns">
          <button id="addLayerBtn" title="Add layer">＋</button>
          <button id="removeLayerBtn" title="Remove selected layer">－</button>
          <button id="mergeLayerBtn" title="Merge selected down (same type)">Merge</button>
        </div>
      </div>
      <div id="layersList" class="layersList"></div>
      <div class="assetHint">Active layer is where new voxels draw.</div>
    </div>
  </aside>
  <main class="canvasWrap">
    <canvas id="c3d"></canvas><div id="brushCursor"></div><div id="toolCursor"></div>
    <div id="modelToggles">
      <button class="viewBtn modelBtn" data-tool="select" title="Move (M)"><img class="toolIcon" src="./branding/icons/move_icon.png" alt="Move"></button>
      <button class="viewBtn modelBtn" data-tool="rotate" title="Rotate (R)"><img class="toolIcon" src="./branding/icons/rotate_icon.png" alt="Rotate"></button>
      <button class="viewBtn modelBtn" data-tool="scale" title="Scale (S)"><img class="toolIcon" src="./branding/icons/scale_icon.png" alt="Scale"></button>
      <button id="snapFloorBtn" class="viewBtn modelBtn" title="Snap to Floor"><img class="toolIcon" src="./branding/icons/snap_to_surface_icon.png" alt="Snap to Floor"></button>
    </div>
    <div id="viewToggles">
      <button id="toggleShadowsBtn" class="viewBtn active">Shadows</button>
      <button id="toggleOutlineBtn" class="viewBtn">Outlines</button>
      <button id="toggleShaderBtn" class="viewBtn active">Shader</button>
    </div>
  </main>
  <aside class="assetPanel" id="assetPanel">
    <div class="assetHeader">
      <input id="assetSearch" placeholder="Search assets..." />
      <button id="assetPickRoot">Set Root</button>
      <button id="assetBackupBtn">Create Backup</button>
    </div>
    <div class="assetPreviewWrap">
      <canvas id="assetPreview"></canvas>
      <div id="assetPreviewLabel" class="assetPreviewLabel">No selection</div>
    </div>
    <div class="assetNav">
      <button id="assetBackBtn" class="assetBackBtn hidden">← Back</button>
      <div id="assetRootLabel" class="assetRootLabel">Root: (not set)</div>
    </div>
    <div id="assetList" class="assetList"></div>
  </aside>
</div>
<div id="shortcutModal" class="modal hidden"></div>
<div id="hslWindow" class="hslWindow hidden"></div>`

const palette = ['#7aa2ff', '#f7768e', '#9ece6a', '#e0af68', '#bb9af7']
const canvas = document.getElementById('c3d')
const brushCursor = document.getElementById('brushCursor')
const toolCursor = document.getElementById('toolCursor')
// Cursor overlays are visuals only (don't let them be draggable/selectable).
brushCursor?.setAttribute('draggable', 'false')
toolCursor?.setAttribute('draggable', 'false')
brushCursor?.addEventListener('dragstart', (e) => e.preventDefault())
toolCursor?.addEventListener('dragstart', (e) => e.preventDefault())
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true })
renderer.setPixelRatio(devicePixelRatio)
renderer.shadowMap.enabled = true
renderer.shadowMap.type = THREE.PCFSoftShadowMap
const scene = new THREE.Scene()
const camera = new THREE.PerspectiveCamera(65, 1, 0.1, 2000)
camera.position.set(36, 26, 36)
const controls = new OrbitControls(camera, canvas)
controls.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.ROTATE, RIGHT: THREE.MOUSE.PAN }
scene.add(new THREE.HemisphereLight(0xffffff, 0x1b1f2a, 0.65))
const d = new THREE.DirectionalLight(0xffffff, 0.95)
d.position.set(24, 42, 18)
d.castShadow = true
d.shadow.mapSize.set(2048, 2048)
d.shadow.camera.near = 1
d.shadow.camera.far = 250
d.shadow.camera.left = -120
d.shadow.camera.right = 120
d.shadow.camera.top = 120
d.shadow.camera.bottom = -120
scene.add(d)
const GRID_SIZE = 120
const GRID_DIVS = 120
const gridHelper = new THREE.GridHelper(GRID_SIZE, GRID_DIVS, 0x667088, 0x333844)
scene.add(gridHelper)
const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(260, 260),
  new THREE.ShadowMaterial({ opacity: 0.22 })
)
ground.rotation.x = -Math.PI / 2
ground.position.y = -0.51
ground.receiveShadow = true
ground.userData.isFloor = true
scene.add(ground)

// Axis marker lives in world space (corner of the floor grid).
function makeAxisLabelSprite(text, colorHex) {
  const canvas = document.createElement('canvas')
  canvas.width = 128
  canvas.height = 128
  const ctx = canvas.getContext('2d')
  ctx.clearRect(0, 0, canvas.width, canvas.height)
  ctx.font = 'bold 72px system-ui, Segoe UI, Arial'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.lineWidth = 10
  ctx.strokeStyle = 'rgba(0,0,0,0.65)'
  ctx.fillStyle = colorHex
  ctx.strokeText(text, 64, 68)
  ctx.fillText(text, 64, 68)
  const tex = new THREE.CanvasTexture(canvas)
  tex.minFilter = THREE.LinearFilter
  tex.magFilter = THREE.LinearFilter
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false })
  const sp = new THREE.Sprite(mat)
  sp.scale.set(2.6, 2.6, 1)
  sp.renderOrder = 999
  return sp
}

const axisCorner3D = new THREE.Group()
axisCorner3D.renderOrder = 998

const gridHalf = GRID_SIZE / 2
axisCorner3D.position.set(-gridHalf, 0.02, -gridHalf)

const axLen = 7
const axX = new THREE.ArrowHelper(new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 0, 0), axLen, 0xff4b4b, 1.4, 0.9)
const axY = new THREE.ArrowHelper(new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 0), axLen, 0x31d17c, 1.4, 0.9)
const axZ = new THREE.ArrowHelper(new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 0, 0), axLen, 0x4a8cff, 1.4, 0.9)
axisCorner3D.add(axX, axY, axZ)

const spX = makeAxisLabelSprite('X', '#ff4b4b'); spX.position.set(axLen + 1.2, 0.6, 0)
const spY = makeAxisLabelSprite('Y', '#31d17c'); spY.position.set(0, axLen + 1.2, 0)
const spZ = makeAxisLabelSprite('Z', '#4a8cff'); spZ.position.set(0, 0.6, axLen + 1.2)
axisCorner3D.add(spX, spY, spZ)
scene.add(axisCorner3D)

const raycaster = new THREE.Raycaster()
const mouse = new THREE.Vector2()
const root = new THREE.Group(); scene.add(root)
const selection = new THREE.Group(); scene.add(selection)
let sourceModel = null, voxelMesh = null, voxelGroup = null
let models = [] // model layers: [{ id, name, group }]
let voxelLayers = [] // voxel layers: [{ id, name, voxelMap: Map, group: THREE.Group, chunkIndex: Map<chunkKey, Set<voxelKey>>, render: { pivot, inner, chunks: Map<chunkKey, THREE.Mesh> } }]
let activeModelId = null
let activeVoxelLayerId = null
let selectedLayer = { type: null, id: null } // {type:'model'|'voxel', id}
let layerOrder = [] // [{type:'model'|'voxel', id}] controls UI order
let voxelOutlineGroup = null
let strokeVisited = new Set()
let shadowsEnabled = true
let shaderEnabled = true
let perfModeActive = false
const VOXEL_CHUNK_SIZE = 12
const frustum = new THREE.Frustum()
const camProjMatrix = new THREE.Matrix4()
let chunkCullFrame = 0

// Proxy used for voxel-layer transforms (keeps gizmo stable while chunks rebuild).
const voxelGizmoProxy = new THREE.Object3D()
voxelGizmoProxy.visible = false
voxelGizmoProxy.userData.isVoxelGizmoProxy = true
scene.add(voxelGizmoProxy)
let voxelProxySession = null // { layerId, baseMap, startPos:Vector3, startRot:Euler }
let voxelGhost = null // Object used for live preview while dragging

const transform = new TransformControls(camera, canvas)
transform.setMode('scale')
transform.setSize(1.35)
transform.showX = true
transform.showY = true
transform.showZ = true
transform.setScaleSnap(0.05)
transform.space = 'world'
transform.visible = false
transform.addEventListener('dragging-changed', (e) => controls.enabled = !e.value)
let voxelTransformSession = null // { layerId, baseMap, mode, startPos:Vector3, startRot:Euler }
transform.addEventListener('mouseDown', () => {
  pushUndo()
  const mg = getActiveModelGroup()
  if (transform.mode === 'scale' && mg) state.pointer.scaleStart = mg.scale.clone()
  // Start voxel-proxy transform session (we transform a proxy at the layer's center, then bake into voxel keys).
  const obj = transform.object
  if (obj?.userData?.isVoxelGizmoProxy && voxelProxySession?.layerId) {
    const layer = voxelLayers.find((l) => l.id === voxelProxySession.layerId)
    if (layer) {
      voxelTransformSession = {
        layerId: layer.id,
        baseMap: layer.voxelMap,
        mode: transform.mode,
        startPos: obj.position.clone(),
        startRot: obj.rotation.clone(),
        startQuat: obj.quaternion.clone()
      }
      const frac1 = (v) => {
        const f = v - Math.floor(v)
        if (Math.abs(f - 0.5) < 1e-8) return 0.5
        if (f > 0.5) return f - 1
        return f
      }
      voxelTransformSession.startPosFrac = new THREE.Vector3(frac1(voxelTransformSession.startPos.x), frac1(voxelTransformSession.startPos.y), frac1(voxelTransformSession.startPos.z))
      // Live ghost preview while dragging voxel layers.
      createVoxelGhostForLayer(layer.id)
    }
  } else voxelTransformSession = null
})
transform.addEventListener('objectChange', () => {
  const modelGroup = getActiveModelGroup()
  if (modelGroup) {
    const minScale = 0.05
    modelGroup.scale.x = Math.max(minScale, Math.abs(modelGroup.scale.x))
    modelGroup.scale.y = Math.max(minScale, Math.abs(modelGroup.scale.y))
    modelGroup.scale.z = Math.max(minScale, Math.abs(modelGroup.scale.z))
    if (state.shiftDown && transform.mode === 'scale' && state.pointer.scaleStart) {
      const s0 = state.pointer.scaleStart
      const rx = modelGroup.scale.x / s0.x
      const ry = modelGroup.scale.y / s0.y
      const rz = modelGroup.scale.z / s0.z
      const ratios = [rx, ry, rz]
      const idx = ratios
        .map((r, i) => ({ i, d: Math.abs(r - 1) }))
        .sort((a, b) => b.d - a.d)[0].i
      const r = Math.max(minScale / Math.max(s0.x, s0.y, s0.z), ratios[idx])
      modelGroup.scale.set(
        Math.max(minScale, s0.x * r),
        Math.max(minScale, s0.y * r),
        Math.max(minScale, s0.z * r)
      )
    }
    if (transform.mode === 'rotate') {
      const snap = Math.PI / 4 // 45 deg
      const threshold = THREE.MathUtils.degToRad(3) // "Radial Snap Degrees Value"
      const snapAxis = (v) => {
        const t = Math.round(v / snap) * snap
        return Math.abs(v - t) <= threshold ? t : v
      }
      modelGroup.rotation.x = snapAxis(modelGroup.rotation.x)
      modelGroup.rotation.y = snapAxis(modelGroup.rotation.y)
      modelGroup.rotation.z = snapAxis(modelGroup.rotation.z)
    }
  }
})
transform.addEventListener('change', () => {
  const modelGroup = getActiveModelGroup()
  if (state.scaleMode && modelGroup) {
    // damp sensitivity a bit by easing toward snapped value
    modelGroup.scale.x = Math.round(modelGroup.scale.x * 20) / 20
    modelGroup.scale.y = Math.round(modelGroup.scale.y * 20) / 20
    modelGroup.scale.z = Math.round(modelGroup.scale.z * 20) / 20
  }
  // Snap voxel-layer transforms while dragging (preview only).
  const obj = transform.object
  if (obj?.userData?.isVoxelGizmoProxy) {
    if (!transform.dragging) return
    const sess = voxelTransformSession?.layerId === obj.userData.layerId ? voxelTransformSession : null
    const frac = sess?.startPosFrac || new THREE.Vector3(0, 0, 0)
    if (transform.mode === 'translate') {
      // Snap relative to the start fractional offset so different voxel layers stay on the same grid.
      obj.position.set(
        frac.x + Math.round(obj.position.x - frac.x),
        frac.y + Math.round(obj.position.y - frac.y),
        frac.z + Math.round(obj.position.z - frac.z)
      )
    }
    if (transform.mode === 'rotate') {
      const snap = Math.PI / 2
      obj.rotation.set(
        Math.round(obj.rotation.x / snap) * snap,
        Math.round(obj.rotation.y / snap) * snap,
        Math.round(obj.rotation.z / snap) * snap
      )
    }
    // Update ghost transform in real time (cheap preview).
    if (voxelGhost && voxelTransformSession) {
      const startPos = voxelTransformSession.startPos
      const bx = voxelGhost.userData.basePos?.x ?? 0
      const by = voxelGhost.userData.basePos?.y ?? 0
      const bz = voxelGhost.userData.basePos?.z ?? 0
      voxelGhost.position.set(
        bx + (obj.position.x - startPos.x),
        by + (obj.position.y - startPos.y),
        bz + (obj.position.z - startPos.z)
      )
      // Ghost rotation preview (snapped to 90 deg via proxy snapping).
      const baseQuat = voxelGhost.userData.baseQuat
      const startQuat = voxelTransformSession.startQuat
      if (baseQuat && startQuat) {
        const dq = obj.quaternion.clone().multiply(startQuat.clone().invert())
        voxelGhost.quaternion.copy(baseQuat.clone().multiply(dq))
      } else {
        const sr = voxelTransformSession.startRot
        const br = voxelGhost.userData.baseRot?.y ?? 0
        voxelGhost.rotation.set(0, br + (obj.rotation.y - (sr?.y ?? 0)), 0)
      }
    }
  }
})
transform.addEventListener('mouseUp', () => {
  // Commit voxel-layer transforms by baking into voxelMap once on mouseUp.
  const obj = transform.object
  if (!obj?.userData?.isVoxelGizmoProxy) return
  const layerId = voxelTransformSession?.layerId
  const layer = voxelLayers.find((l) => l.id === layerId)
  if (!layer) return

  const sess = voxelTransformSession?.layerId === layerId ? voxelTransformSession : null
  const baseMap = sess ? sess.baseMap : layer.voxelMap
  if (!baseMap || !baseMap.size) return

  // Translation deltas are measured relative to drag start.
  const startPos = sess?.startPos ?? obj.position
  const rawTx = Math.round(obj.position.x - startPos.x)
  const rawTy = Math.round(obj.position.y - startPos.y)
  const rawTz = Math.round(obj.position.z - startPos.z)
  const isRotate = (sess?.mode === 'rotate')
  const tx = isRotate ? 0 : rawTx
  const ty = isRotate ? 0 : rawTy
  const tz = isRotate ? 0 : rawTz
  const snap = Math.PI / 2
  const srx = Math.round((sess?.startRot?.x ?? 0) / snap) * snap
  const sry = Math.round((sess?.startRot?.y ?? 0) / snap) * snap
  const srz = Math.round((sess?.startRot?.z ?? 0) / snap) * snap
  const rx = Math.round(obj.rotation.x / snap) * snap - srx
  const ry = Math.round(obj.rotation.y / snap) * snap - sry
  const rz = Math.round(obj.rotation.z / snap) * snap - srz

  if (tx === 0 && ty === 0 && tz === 0 && rx === 0 && ry === 0 && rz === 0) return

  // Rotate around voxel-layer bounds center (exact in doubled-coordinate space).
  const keysB = [...baseMap.keys()]
  const xsB = keysB.map((k) => parseKey(k)[0])
  const ysB = keysB.map((k) => parseKey(k)[1])
  const zsB = keysB.map((k) => parseKey(k)[2])
  const minXB = Math.min(...xsB), maxXB = Math.max(...xsB)
  const minYB = Math.min(...ysB), maxYB = Math.max(...ysB)
  const minZB = Math.min(...zsB), maxZB = Math.max(...zsB)
  const CX2 = (minXB + maxXB)
  const CY2 = (minYB + maxYB)
  const CZ2 = (minZB + maxZB)

  // Discrete 90-degree rotation to avoid "random holes" from float rounding at 90 degrees.
  // avoiding sign/axis ambiguity from Euler extraction.
  const startQuat = sess?.startQuat
  const dq = startQuat ? obj.quaternion.clone().multiply(startQuat.clone().invert()) : null
  let stepsX = (((Math.round(rx / (Math.PI / 2)) % 4) + 4) % 4)
  let stepsY = (((Math.round(ry / (Math.PI / 2)) % 4) + 4) % 4)
  let stepsZ = (((Math.round(rz / (Math.PI / 2)) % 4) + 4) % 4)
  if (dq) {
    const qx = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2)
    const qy = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2)
    const qz = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 2)
    const inv = (q) => q.clone().invert()
    const score = (a, b) => 1 - Math.min(1, a.angleTo(b) / Math.PI) 
    const bestStep = (axisQ) => {
      // Compare dq to axisQ^k for k=0..3
      let bestK = 0
      let best = -1
      let cur = new THREE.Quaternion() // identity
      for (let k = 0; k < 4; k++) {
        const s = score(dq, cur)
        if (s > best) { best = s; bestK = k }
        cur = cur.clone().multiply(axisQ)
      }
      let bestKn = 0
      let bestn = -1
      cur = new THREE.Quaternion()
      const axisQN = inv(axisQ)
      for (let k = 0; k < 4; k++) {
        const s = score(dq, cur)
        if (s > bestn) { bestn = s; bestKn = k }
        cur = cur.clone().multiply(axisQN)
      }
      // Choose direction with better match.
      if (bestn > best) return (4 - bestKn) % 4
      return bestK % 4
    }

    stepsX = bestStep(qx)
    stepsY = bestStep(qy)
    stepsZ = bestStep(qz)
  }
  // Apply inverse 90° mappings below so the baked voxel rotation matches gizmo/ghost direction.

  const rot90X = (x2, y2, z2) => {
    const dy = y2 - CY2
    const dz = z2 - CZ2
    return [x2, CY2 - dz, CZ2 + dy]
  }
  const rot90Y = (x2, y2, z2) => {
    const dx = x2 - CX2
    const dz = z2 - CZ2
    return [CX2 - dz, y2, CZ2 + dx]
  }
  const rot90Z = (x2, y2, z2) => {
    const dx = x2 - CX2
    const dy = y2 - CY2
    return [CX2 - dy, CY2 + dx, z2]
  }

  const out = new Map()
  for (const [k, c] of baseMap.entries()) {
    let [x, y, z] = parseKey(k)
    let x2 = x * 2, y2 = y * 2, z2 = z * 2
    for (let i = 0; i < stepsX; i++) [x2, y2, z2] = rot90X(x2, y2, z2)
    for (let i = 0; i < stepsY; i++) [x2, y2, z2] = rot90Y(x2, y2, z2)
    for (let i = 0; i < stepsZ; i++) [x2, y2, z2] = rot90Z(x2, y2, z2)
    const nx0 = x2 / 2
    const ny0 = y2 / 2
    const nz0 = z2 / 2
    const nx = (Number.isInteger(nx0) ? nx0 : Math.round(nx0)) + tx
    const ny = (Number.isInteger(ny0) ? ny0 : Math.round(ny0)) + ty
    const nz = (Number.isInteger(nz0) ? nz0 : Math.round(nz0)) + tz
    out.set(keyOf(nx, ny, nz), c)
  }

  // Drift fix for 90° rotations:
  let finalOut = out

  layer.voxelMap = finalOut
  if (layerId === activeVoxelLayerId) syncStateVoxelMapToActiveLayer()
  voxelTransformSession = null
  disposeVoxelGhost()

  rebuildVoxelMesh()
  // Recenter proxy to new voxel bounds center after bake.
  const keys2 = [...layer.voxelMap.keys()]
  if (keys2.length) {
    const xs2 = keys2.map((k) => parseKey(k)[0])
    const ys2 = keys2.map((k) => parseKey(k)[1])
    const zs2 = keys2.map((k) => parseKey(k)[2])
    const ncx = (Math.min(...xs2) + Math.max(...xs2)) / 2
    const ncy = (Math.min(...ys2) + Math.max(...ys2)) / 2
    const ncz = (Math.min(...zs2) + Math.max(...zs2)) / 2
    obj.position.set(ncx, ncy, ncz)
    obj.rotation.set(0, 0, 0)
  }
  rebuildLayersUI()
})
scene.add(transform)
scene.add(transform.getHelper())

const keyOf = (x, y, z) => `${x},${y},${z}`
const parseKey = (k) => k.split(',').map(Number)
const toHex = (c) => `#${((1 << 24) + (c.r << 16) + (c.g << 8) + c.b).toString(16).slice(1)}`
function setStatus(msg = '') {
  const el = document.getElementById('statusLine')
  if (el) el.textContent = msg
}
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]))
}

function voxelMapBoundsCenter(voxelMap) {
  if (!voxelMap?.size) return new THREE.Vector3(0, 0, 0)
  let minX = Infinity, minY = Infinity, minZ = Infinity
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity
  for (const k of voxelMap.keys()) {
    const [x, y, z] = parseKey(k)
    if (x < minX) minX = x; if (y < minY) minY = y; if (z < minZ) minZ = z
    if (x > maxX) maxX = x; if (y > maxY) maxY = y; if (z > maxZ) maxZ = z
  }
  return new THREE.Vector3((minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2)
}
function attachVoxelLayerProxy(layerId, mode) {
  const layer = voxelLayers.find((l) => l.id === layerId)
  if (!layer) return
  const c = voxelMapBoundsCenter(layer.voxelMap)
  voxelGizmoProxy.position.copy(c)
  voxelGizmoProxy.rotation.set(0, 0, 0)
  voxelGizmoProxy.visible = true
  voxelGizmoProxy.userData.layerId = layerId
  voxelProxySession = { layerId }
  transform.detach()
  transform.setMode(mode)
  transform.attach(voxelGizmoProxy)
  transform.visible = true
}
function disposeVoxelGhost() {
  if (!voxelGhost) return
  try { root.remove(voxelGhost) } catch {}
  voxelGhost.traverse((o) => {
    if (o.isMesh) {
      if (o.material && o.material.userData?.__ghost) {
        try { o.material.dispose() } catch {}
      }
    }
  })
  voxelGhost = null
}
function createVoxelGhostForLayer(layerId) {
  disposeVoxelGhost()
  const layer = voxelLayers.find((l) => l.id === layerId)
  if (!layer?.group) return null
  // Clone hierarchy, reusing geometry, with translucent material.
  const ghost = layer.group.clone(true)
  ghost.userData.isVoxelGhost = true
  ghost.userData.basePos = ghost.position.clone()
  ghost.userData.baseRot = ghost.rotation.clone()
  ghost.userData.baseQuat = ghost.quaternion.clone()
  ghost.traverse((o) => {
    if (!o.isMesh) return
    const m = new THREE.MeshBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.35,
      depthWrite: false,
      depthTest: false
    })
    m.userData.__ghost = true
    m.polygonOffset = true
    m.polygonOffsetFactor = -1
    m.polygonOffsetUnits = -1
    o.material = m
    o.renderOrder = 999
  })
  root.add(ghost)
  voxelGhost = ghost
  return ghost
}

// Layers
function ensureActiveVoxelLayer() {
  if (activeVoxelLayerId && voxelLayers.find((l) => l.id === activeVoxelLayerId)) return
  if (!voxelLayers.length) {
    const id = `v_${Math.random().toString(36).slice(2, 10)}`
    voxelLayers.push({ id, name: 'Voxel Layer 1', voxelMap: new Map(), group: new THREE.Group(), chunkIndex: new Map(), render: { pivot: null, inner: null, chunks: new Map() } })
    activeVoxelLayerId = id
    layerOrder.push({ type: 'voxel', id })
  } else {
    activeVoxelLayerId = voxelLayers[0].id
  }
}
function safeTransformDetach() {
  const obj = transform.object
  if (obj?.userData?.isVoxelLayerGroup) {
    // "Commit" current state as baseline by reattaching before detaching.
    transform.detach()
    // Reattach and detach immediately so the baseline updates to current.
    transform.attach(obj)
    transform.detach()
    return
  }
  transform.detach()
}
function getActiveVoxelLayer() {
  ensureActiveVoxelLayer()
  return voxelLayers.find((l) => l.id === activeVoxelLayerId) || voxelLayers[0]
}
function syncStateVoxelMapToActiveLayer() {
  const vl = getActiveVoxelLayer()
  state.voxelMap = vl.voxelMap
}
function chunkKeyForXYZ(x, y, z) {
  const cx = Math.floor(x / VOXEL_CHUNK_SIZE)
  const cy = Math.floor(y / VOXEL_CHUNK_SIZE)
  const cz = Math.floor(z / VOXEL_CHUNK_SIZE)
  return `${cx},${cy},${cz}`
}
function ensureLayerIndex(layer) {
  if (!layer.chunkIndex) layer.chunkIndex = new Map()
  if (!layer.render) layer.render = { pivot: null, inner: null, chunks: new Map() }
}
function indexVoxelKey(layer, key) {
  ensureLayerIndex(layer)
  const [x, y, z] = parseKey(key)
  const ck = chunkKeyForXYZ(x, y, z)
  let set = layer.chunkIndex.get(ck)
  if (!set) { set = new Set(); layer.chunkIndex.set(ck, set) }
  set.add(key)
}
function deindexVoxelKey(layer, key) {
  if (!layer?.chunkIndex) return
  const [x, y, z] = parseKey(key)
  const ck = chunkKeyForXYZ(x, y, z)
  const set = layer.chunkIndex.get(ck)
  if (!set) return
  set.delete(key)
  if (!set.size) layer.chunkIndex.delete(ck)
}
function rebuildLayerChunkIndex(layer) {
  ensureLayerIndex(layer)
  layer.chunkIndex.clear()
  for (const k of layer.voxelMap.keys()) indexVoxelKey(layer, k)
}
function ensureVoxelWorker() {
  if (voxelWorker) return voxelWorker
  try {
    // Vite worker URLs can hit EPERM on some Windows/OneDrive setups, so this is a Blob worker.
    const src = `
      const faceDefs = [
        { n:[1,0,0], verts:[[0.5,-0.5,-0.5],[0.5,-0.5,0.5],[0.5,0.5,0.5],[0.5,0.5,-0.5]] },
        { n:[-1,0,0], verts:[[-0.5,-0.5,0.5],[-0.5,-0.5,-0.5],[-0.5,0.5,-0.5],[-0.5,0.5,0.5]] },
        { n:[0,1,0], verts:[[-0.5,0.5,0.5],[0.5,0.5,0.5],[0.5,0.5,-0.5],[-0.5,0.5,-0.5]] },
        { n:[0,-1,0], verts:[[-0.5,-0.5,0.5],[0.5,-0.5,0.5],[0.5,-0.5,-0.5],[-0.5,-0.5,-0.5]] },
        { n:[0,0,1], verts:[[0.5,-0.5,0.5],[-0.5,-0.5,0.5],[-0.5,0.5,0.5],[0.5,0.5,0.5]] },
        { n:[0,0,-1], verts:[[-0.5,-0.5,-0.5],[0.5,-0.5,-0.5],[0.5,0.5,-0.5],[-0.5,0.5,-0.5]] }
      ];
      const parseKey = (k)=>{ const p=k.split(','); return [p[0]|0,p[1]|0,p[2]|0] };
      const keyOf = (x,y,z)=>''+x+','+y+','+z;
      self.onmessage=(e)=>{
        const msg=e.data;
        if(!msg||msg.type!=='buildChunk') return;
        const id=msg.id;
        try{
          const occ=new Set(msg.occKeys||[]);
          const voxKeys=msg.voxKeys||[];
          const colors=msg.colors||[];
          const pos=[], nrm=[], col=[], idx=[];
          let v=0;
          for(let i=0;i<voxKeys.length;i++){
            const k=voxKeys[i];
            const [x,y,z]=parseKey(k);
            const cc=colors[i]||{r:255,g:255,b:255};
            const cr=Math.max(0,Math.min(255,cc.r))/255;
            const cg=Math.max(0,Math.min(255,cc.g))/255;
            const cb=Math.max(0,Math.min(255,cc.b))/255;
            for(const f of faceDefs){
              const nk=keyOf(x+f.n[0],y+f.n[1],z+f.n[2]);
              if(occ.has(nk)) continue;
              const base=v;
              for(const vv of f.verts){
                pos.push(x+vv[0],y+vv[1],z+vv[2]);
                nrm.push(f.n[0],f.n[1],f.n[2]);
                col.push(cr,cg,cb);
                v++;
              }
              idx.push(base,base+1,base+2, base,base+2,base+3);
            }
          }
          const posA=new Float32Array(pos);
          const nrmA=new Float32Array(nrm);
          const colA=new Float32Array(col);
          const idxA=new Uint32Array(idx);
          self.postMessage({ok:true,id,pos:posA,nrm:nrmA,col:colA,idx:idxA}, [posA.buffer,nrmA.buffer,colA.buffer,idxA.buffer]);
        }catch(err){
          self.postMessage({ok:false,id,error:String(err&&err.message||err)});
        }
      };
    `
    const url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }))
    voxelWorker = new Worker(url)
    voxelWorker.onmessage = (e) => {
      const msg = e.data
      const p = voxelWorkerPending.get(msg?.id)
      if (!p) return
      voxelWorkerPending.delete(msg.id)
      if (msg?.ok) p.resolve(msg)
      else p.reject(new Error(msg?.error || 'worker failed'))
    }
    voxelWorker.onerror = (err) => {
      // Fail all pending requests.
      for (const [id, p] of voxelWorkerPending.entries()) p.reject(err)
      voxelWorkerPending.clear()
    }
    return voxelWorker
  } catch {
    voxelWorker = null
    return null
  }
}
function allLayersList() {
  const known = new Set(layerOrder.map((l) => `${l.type}:${l.id}`))
  for (const m of models) {
    if (m.archived) continue
    const k = `model:${m.id}`
    if (!known.has(k)) layerOrder.push({ type: 'model', id: m.id })
  }
  for (const v of voxelLayers) {
    const k = `voxel:${v.id}`
    if (!known.has(k)) layerOrder.push({ type: 'voxel', id: v.id })
  }
  // Filter out any stale entries.
  layerOrder = layerOrder.filter((l) => (l.type === 'model' ? models.some((m) => m.id === l.id) : voxelLayers.some((v) => v.id === l.id)))

  const out = []
  for (const l of layerOrder) {
    if (l.type === 'model') {
      const m = models.find((mm) => mm.id === l.id)
      if (m) out.push({ id: m.id, name: m.name, type: 'model' })
    } else {
      const v = voxelLayers.find((vv) => vv.id === l.id)
      if (v) out.push({ id: v.id, name: v.name, type: 'voxel' })
    }
  }
  return out
}
function rebuildLayersUI() {
  const list = document.getElementById('layersList')
  if (!list) return
  const layers = allLayersList()
  list.innerHTML = ''

  // Small layer preview renderer (one shared offscreen WebGL canvas).
  // We render each layer once on UI rebuild and blit into its <canvas> thumbnail.
  if (!rebuildLayersUI._thumb) {
    const c = document.createElement('canvas')
    const r = new THREE.WebGLRenderer({ canvas: c, antialias: true, alpha: true, preserveDrawingBuffer: true })
    r.setPixelRatio(1)
    const scene = new THREE.Scene()
    const cam = new THREE.PerspectiveCamera(45, 1, 0.1, 2000)
    cam.position.set(18, 14, 18)
    cam.lookAt(0, 0, 0)
    scene.add(new THREE.AmbientLight(0xffffff, 0.7))
    const dl = new THREE.DirectionalLight(0xffffff, 0.8)
    dl.position.set(20, 30, 10)
    scene.add(dl)
    rebuildLayersUI._thumb = { r, scene, cam, obj: null, w: 64, h: 48 }
  }
  const thumb = rebuildLayersUI._thumb
  const renderThumbInto = (layerMeta, canvasEl) => {
    if (!canvasEl) return
    try {
      const ctx = canvasEl.getContext('2d')
      if (!ctx) return
      ctx.clearRect(0, 0, canvasEl.width, canvasEl.height)

      let obj = null
      if (layerMeta.type === 'voxel') {
        const vl = voxelLayers.find((x) => x.id === layerMeta.id)
        if (!vl?.voxelMap?.size) return
        obj = buildPreviewMesh(vl.voxelMap, 2500)
      } else {
        const ml = models.find((x) => x.id === layerMeta.id)
        if (!ml?.group) return
        obj = ml.group.clone(true)
        obj.traverse((o) => {
          if (o.isMesh) {
            o.castShadow = false
            o.receiveShadow = false
            o.material = new THREE.MeshStandardMaterial({ color: 0x9aa6bf, roughness: 0.9, metalness: 0.02 })
          }
        })
      }
      if (!obj) return

      if (thumb.obj) {
        try { thumb.scene.remove(thumb.obj) } catch {}
        thumb.obj.traverse((o) => {
          if (o.isMesh) {
            try { o.geometry?.dispose?.() } catch {}
            try { o.material?.dispose?.() } catch {}
          }
        })
      }
      thumb.obj = obj
      thumb.scene.add(obj)

      const box = new THREE.Box3().setFromObject(obj)
      const size = new THREE.Vector3()
      const center = new THREE.Vector3()
      box.getSize(size)
      box.getCenter(center)
      const maxDim = Math.max(size.x, size.y, size.z, 1e-3)
      const dist = maxDim * 1.6 + 6
      thumb.cam.position.set(center.x + dist, center.y + dist * 0.85, center.z + dist)
      thumb.cam.lookAt(center)
      thumb.cam.updateProjectionMatrix()

      thumb.r.setSize(thumb.w, thumb.h, false)
      thumb.cam.aspect = thumb.w / thumb.h
      thumb.cam.updateProjectionMatrix()
      thumb.r.setClearColor(0x000000, 0)
      thumb.r.clear(true, true, true)
      thumb.r.render(thumb.scene, thumb.cam)
      ctx.drawImage(thumb.r.domElement, 0, 0, canvasEl.width, canvasEl.height)
    } catch {}
  }

  const isNameTaken = (name, type, id) => {
    const n = String(name || '').trim().toLowerCase()
    if (!n) return false
    for (const m of models) if (!(type === 'model' && m.id === id) && String(m.name || '').trim().toLowerCase() === n) return true
    for (const v of voxelLayers) if (!(type === 'voxel' && v.id === id) && String(v.name || '').trim().toLowerCase() === n) return true
    return false
  }
  const makeUniqueName = (base, type, id) => {
    const raw = String(base || '').trim() || (type === 'voxel' ? 'Voxel Layer' : 'Model Layer')
    if (!isNameTaken(raw, type, id)) return raw
    for (let i = 2; i < 5000; i++) {
      const candidate = `${raw} (${i})`
      if (!isNameTaken(candidate, type, id)) return candidate
    }
    return raw
  }
  const startInlineRename = (layerMeta, rowEl) => {
    const left = rowEl.querySelector('.layerLeft')
    const nameEl = rowEl.querySelector('.layerName')
    if (!left || !nameEl) return
    const current = String(layerMeta.name || '')
    const input = document.createElement('input')
    input.className = 'layerRenameInput'
    input.value = current
    input.spellcheck = false
    input.autocomplete = 'off'
    input.autocapitalize = 'off'
    input.autocorrect = 'off'
    state.uiTyping = true
    // swap
    nameEl.replaceWith(input)
    input.focus()
    input.select()

    const commit = () => {
      const typed = String(input.value || '').trim()
      const next = makeUniqueName(typed, layerMeta.type, layerMeta.id)
      if (layerMeta.type === 'voxel') {
        const vl = voxelLayers.find((x) => x.id === layerMeta.id)
        if (vl) vl.name = next
      } else {
        const ml = models.find((x) => x.id === layerMeta.id)
        if (ml) ml.name = next
      }
      state.uiTyping = false
      rebuildLayersUI()
    }
    const cancel = () => {
      state.uiTyping = false
      rebuildLayersUI()
    }
    input.addEventListener('keydown', (e) => {
      e.stopPropagation()
      if (e.key === 'Enter') { e.preventDefault(); commit() }
      else if (e.key === 'Escape') { e.preventDefault(); cancel() }
    })
    input.addEventListener('pointerdown', (e) => e.stopPropagation())
    input.addEventListener('click', (e) => e.stopPropagation())
    input.addEventListener('blur', () => commit(), { once: true })
  }

  for (const l of layers) {
    const div = document.createElement('div')
    div.className = 'layerItem'
    if (l.type === 'voxel' && l.id === activeVoxelLayerId) div.classList.add('active')
    if (selectedLayer.type === l.type && selectedLayer.id === l.id) div.classList.add('selected')
    div.draggable = true
    div.dataset.layerType = l.type
    div.dataset.layerId = l.id
    div.innerHTML = `
      <canvas class="layerThumb" width="64" height="48"></canvas>
      <div class="layerLeft">
        <div class="layerName">${l.name}</div>
        <div class="layerType">${l.type}</div>
      </div>
      <button class="layerRenameBtn" title="Rename" draggable="false">✎</button>
    `
    // Render thumbnail.
    try { renderThumbInto(l, div.querySelector('.layerThumb')) } catch {}

    // Add per-model voxelize button (to the left of the pencil).
    if (l.type === 'model') {
      const renameBtn = div.querySelector('.layerRenameBtn')
      if (renameBtn) {
        const vb = document.createElement('button')
        vb.className = 'layerVoxelizeBtn'
        vb.title = 'Voxelize this layer'
        vb.setAttribute('draggable', 'false')
        vb.innerHTML = `<img class="toolIcon" src="./branding/icons/voxelize_icon.png" alt="Voxelize">`
        renameBtn.insertAdjacentElement('beforebegin', vb)
        vb.addEventListener('click', (e) => {
          e.preventDefault()
          e.stopPropagation()
          selectedLayer = { type: 'model', id: l.id }
          activeModelId = l.id
          voxelizeModel()
        })
      }
    }
    div.addEventListener('click', () => {
      // Clicking a layer in UI:
      // - voxel: sets active drawing layer
      // - model: selects active model for voxelize/transform target
      selectedLayer = { type: l.type, id: l.id }
      if (l.type === 'voxel') {
        activeVoxelLayerId = l.id
        syncStateVoxelMapToActiveLayer()
        // Do NOT rebuild voxel meshes just to change active layer; it causes subtle shifting/reattach issues.
      } else {
        activeModelId = l.id
        rebuildToolState()
      }
      rebuildLayersUI()
    })
    div.querySelector('.layerRenameBtn')?.addEventListener('click', (e) => {
      e.preventDefault()
      e.stopPropagation()
      startInlineRename(l, div)
    })
    // Drag reordering
    div.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('application/x-nova-layer', JSON.stringify({ type: l.type, id: l.id }))
      e.dataTransfer.effectAllowed = 'move'
    })
    div.addEventListener('dragover', (e) => {
      e.preventDefault()
      e.dataTransfer.dropEffect = 'move'
      div.classList.add('dragOver')
    })
    div.addEventListener('dragleave', () => div.classList.remove('dragOver'))
    div.addEventListener('drop', (e) => {
      e.preventDefault()
      div.classList.remove('dragOver')
      const raw = e.dataTransfer.getData('application/x-nova-layer')
      if (!raw) return
      let data
      try { data = JSON.parse(raw) } catch { return }
      const fromKey = `${data.type}:${data.id}`
      const toKey = `${l.type}:${l.id}`
      if (fromKey === toKey) return
      const fromIdx = layerOrder.findIndex((x) => `${x.type}:${x.id}` === fromKey)
      const toIdx = layerOrder.findIndex((x) => `${x.type}:${x.id}` === toKey)
      if (fromIdx < 0 || toIdx < 0) return
      const [moved] = layerOrder.splice(fromIdx, 1)
      layerOrder.splice(toIdx, 0, moved)
      rebuildLayersUI()
    })
    list.appendChild(div)
  }
}
function applyPerformanceModeByVoxelCount() {
  const count = state.voxelMap.size
  const shouldPerf = count > 90000
  if (shouldPerf === perfModeActive) return
  perfModeActive = shouldPerf
  if (shouldPerf) {
    // Big win on huge scenes.
    shadowsEnabled = false
    renderer.shadowMap.enabled = false
    d.castShadow = false
    ground.receiveShadow = false
    document.getElementById('toggleShadowsBtn')?.classList.remove('active')
    if (document.getElementById('toggleOutlineBtn')?.classList.contains('active')) {
      document.getElementById('toggleOutlineBtn').classList.remove('active')
    }
    renderer.setPixelRatio(1)
    setStatus(`Performance mode enabled (${count.toLocaleString()} voxels)`)
  } else {
    // Restore quality defaults.
    shadowsEnabled = true
    renderer.shadowMap.enabled = true
    d.castShadow = true
    ground.receiveShadow = true
    document.getElementById('toggleShadowsBtn')?.classList.add('active')
    renderer.setPixelRatio(devicePixelRatio)
    setStatus(`Performance mode disabled (${count.toLocaleString()} voxels)`)
  }
}

function setTheme(mode) {
  state.theme = mode
  document.documentElement.dataset.theme = mode
  scene.background = new THREE.Color(mode === 'dark' ? 0x12151c : 0xf3f5f9)
  const t = document.getElementById('settingsThemeBtn')
  if (t) t.textContent = mode === 'dark' ? 'Dark Mode' : 'Light Mode'
}
setTheme('dark')

function fitRenderer() {
  const w = canvas.clientWidth, h = canvas.clientHeight
  renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix()
}
new ResizeObserver(fitRenderer).observe(canvas); fitRenderer()

function drawPalette() {
  const box = document.getElementById('palette')
  box.innerHTML = palette.map((c) => `<button class="swatch" data-color="${c}" style="background:${c}"></button>`).join('')
  box.querySelectorAll('.swatch').forEach((b) => b.onclick = () => {
    state.activeColor = b.dataset.color
    document.getElementById('colorPicker').value = state.activeColor
  })
}
drawPalette()
ensureActiveVoxelLayer()
syncStateVoxelMapToActiveLayer()
rebuildLayersUI()

function rebuildToolState() {
  document.querySelectorAll('.iconBtn, .modelBtn').forEach((b) => b.classList.toggle('active', b.dataset.tool === state.tool))
  const modelGroup = getActiveModelGroup()
  const voxelLayerGroup = (selectedLayer.type === 'voxel')
    ? (voxelLayers.find((l) => l.id === selectedLayer.id)?.group ?? null)
    : null

  // Voxel-layer transforms (translate/rotate only) are allowed even when voxels exist.
  if ((state.tool === 'select' || state.tool === 'rotate') && voxelLayerGroup) {
    attachVoxelLayerProxy(selectedLayer.id, state.tool === 'rotate' ? 'rotate' : 'translate')
    return
  }

  // Model-layer transforms.
  if (state.scaleMode && modelGroup) {
    transform.setMode('scale')
    transform.detach()
    transform.attach(modelGroup)
    transform.visible = true
    transform.setScaleSnap(0.05)
    transform.translationSnap = null
    transform.rotationSnap = null
  } else if (state.tool === 'select' && modelGroup) {
    transform.setMode('translate')
    transform.detach()
    transform.attach(modelGroup)
    transform.visible = true
    transform.translationSnap = null
    transform.rotationSnap = null
  } else if (state.tool === 'rotate' && modelGroup) {
    transform.setMode('rotate')
    transform.detach()
    transform.attach(modelGroup)
    transform.visible = true
    transform.translationSnap = null
    transform.rotationSnap = null
  } else {
    transform.detach()
    transform.visible = false
  }
}
rebuildToolState()

function pushUndo() {
  state.undo.push(makeSnapshot())
  if (state.undo.length > 50) state.undo.shift()
  state.redo = []
}
function makeSnapshot() {
  return {
    layerOrder: layerOrder.map((l) => ({ type: l.type, id: l.id })),
    voxelLayers: voxelLayers.map((l) => ({
      id: l.id,
      name: l.name,
      voxels: [...l.voxelMap.entries()].map(([k, c]) => [k, { r: c.r, g: c.g, b: c.b }])
    })),
    activeVoxelLayerId,
    selectedLayer: { type: selectedLayer.type, id: selectedLayer.id },
    selected: [...state.selected],
    models: models.map((m) => ({
      id: m.id,
      name: m.name,
      position: m.group.position.clone(),
      rotation: m.group.rotation.clone(),
      scale: m.group.scale.clone(),
      visible: m.group.visible,
      archived: !!m.archived
    })),
    activeModelId
  }
}
function applySnap(s) {
  // Restore voxel layers
  voxelLayers = (s.voxelLayers || []).map((l) => ({
    id: l.id,
    name: l.name,
    voxelMap: new Map((l.voxels || []).map(([k, c]) => [k, c])),
    group: new THREE.Group()
  }))
  layerOrder = Array.isArray(s.layerOrder) ? s.layerOrder.map((l) => ({ type: l.type, id: l.id })) : layerOrder
  activeVoxelLayerId = s.activeVoxelLayerId ?? (voxelLayers[0]?.id ?? null)
  ensureActiveVoxelLayer()
  syncStateVoxelMapToActiveLayer()
  state.selected = new Set(s.selected || [])
  selectedLayer = s.selectedLayer ? { type: s.selectedLayer.type, id: s.selectedLayer.id } : { type: null, id: null }

  // Restore model list:
  // Keep imported models in memory so Redo can restore them.
  if (Array.isArray(s.models)) {
    const keep = new Set(s.models.map((mm) => mm.id))
    for (const m of models) {
      if (!keep.has(m.id)) {
        m.archived = true
        m.group.visible = false
      }
    }
    // Restore transforms/flags for those present in snapshot.
    for (const sm of s.models) {
      const m = models.find((mm) => mm.id === sm.id)
      if (!m) continue
      m.name = sm.name
      m.archived = !!sm.archived
      m.group.position.copy(sm.position)
      m.group.rotation.copy(sm.rotation)
      m.group.scale.copy(sm.scale)
      m.group.visible = sm.visible
    }
  }
  activeModelId = s.activeModelId ?? activeModelId

  rebuildVoxelMesh()
  rebuildSelection()
  rebuildLayersUI()
  rebuildToolState()
}
function undo() {
  const s = state.undo.pop(); if (!s) return
  state.redo.push(makeSnapshot())
  applySnap(s)
}
function redo() {
  const s = state.redo.pop(); if (!s) return
  state.undo.push(makeSnapshot())
  applySnap(s)
}

function getActiveModelGroup() {
  const m = models.find((mm) => mm.id === activeModelId)
  return m?.group || null
}
function setActiveModelByGroup(group) {
  const id = group?.userData?.modelId
  if (!id) return
  activeModelId = id
  rebuildToolState()
}
function addModelGroup(sceneObj, name = 'model') {
  // Importing a model always creates a new model layer; do not destroy existing voxel layers.
  const id = `m_${Math.random().toString(36).slice(2, 10)}`
  const modelGroup = new THREE.Group()
  modelGroup.add(sceneObj)
  modelGroup.userData.isModelRoot = true
  modelGroup.userData.modelId = id
  root.add(modelGroup)
  modelGroup.traverse((o) => {
    if (o.isMesh && !o.material) o.material = new THREE.MeshStandardMaterial({ color: 0x9098aa, roughness: 0.85, metalness: 0.05 })
    if (o.isMesh) { o.castShadow = true; o.receiveShadow = true }
  })
  // Auto-scale imports to working size.
  modelGroup.updateMatrixWorld(true)
  const importBox = new THREE.Box3().setFromObject(modelGroup)
  const size = new THREE.Vector3(); importBox.getSize(size)
  const maxDim = Math.max(size.x, size.y, size.z)
  const targetWorkingSize = 40
  if (Number.isFinite(maxDim) && maxDim > 0) {
    const s = targetWorkingSize / maxDim
    modelGroup.scale.multiplyScalar(s)
    modelGroup.updateMatrixWorld(true)
  }
  // Auto-snap to floor
  const floorBox = new THREE.Box3().setFromObject(modelGroup)
  if (Number.isFinite(floorBox.min.y)) {
    modelGroup.position.y += (0 - floorBox.min.y)
    modelGroup.updateMatrixWorld(true)
  }
  models.push({ id, name, group: modelGroup, archived: false })
  layerOrder.push({ type: 'model', id })
  activeModelId = id
  controls.target.set(0, 0, 0); controls.update()
  transform.detach(); transform.visible = false; state.scaleMode = false
  for (const m of models) m.group.visible = true
  setStatus(`Imported ${models.length} model(s)`)
  rebuildToolState()
  rebuildLayersUI()
}

async function loadFile(file) {
  const ext = file.name.split('.').pop()?.toLowerCase()
  let sceneObj = null
  // Allow Ctrl+Z to undo imports.
  pushUndo()
  if (ext === 'cub') {
    const ab = await file.arrayBuffer()
    const dv = new DataView(ab)
    if (ab.byteLength < 12) throw new Error('Invalid .cub file')
    const sx = dv.getInt32(0, true), sy = dv.getInt32(4, true), sz = dv.getInt32(8, true)
    if (sx <= 0 || sy <= 0 || sz <= 0) throw new Error('Invalid .cub dimensions')
    const expected = 12 + sx * sy * sz * 3
    if (ab.byteLength < expected) throw new Error('Truncated .cub file')
    const voxMap = new Map()
    state.selected.clear()
    let o = 12
    const ox = Math.floor(sx / 2), oy = 0, oz = Math.floor(sz / 2)
    for (let z = 0; z < sz; z++) for (let y = 0; y < sy; y++) for (let x = 0; x < sx; x++) {
      const r = dv.getUint8(o++), g = dv.getUint8(o++), b = dv.getUint8(o++)
      if (r === 0 && g === 0 && b === 0) continue
      voxMap.set(keyOf(x - ox, y - oy, z - oz), { r, g, b })
    }
    const id = `v_${Math.random().toString(36).slice(2, 10)}`
    voxelLayers.push({ id, name: file.name, voxelMap: voxMap, group: new THREE.Group() })
    activeVoxelLayerId = id
    syncStateVoxelMapToActiveLayer()
    layerOrder.push({ type: 'voxel', id })
    rebuildVoxelMesh()
    rebuildSelection()
    setStatus(`Imported .cub (${sx}x${sy}x${sz})`)
    transform.detach(); transform.visible = false; state.scaleMode = false
    rebuildLayersUI()
    return
  }
  if (ext === 'vox') {
    const ab = await file.arrayBuffer()
    const { sx, sy, sz, vox } = parseVoxToVoxelMap(ab)
    const id = `v_${Math.random().toString(36).slice(2, 10)}`
    voxelLayers.push({ id, name: file.name, voxelMap: vox, group: new THREE.Group() })
    activeVoxelLayerId = id
    syncStateVoxelMapToActiveLayer()
    layerOrder.push({ type: 'voxel', id })
    rebuildVoxelMesh()
    rebuildSelection()
    setStatus(`Imported .vox (${sx}x${sy}x${sz})`)
    transform.detach(); transform.visible = false; state.scaleMode = false
    rebuildLayersUI()
    return
  }
  if (ext === 'obj') sceneObj = new OBJLoader().parse(await file.text())
  else if (ext === 'stl') {
    const g = new STLLoader().parse(await file.arrayBuffer())
    sceneObj = new THREE.Group(); sceneObj.add(new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color: 0x9098aa })))
  } else if (ext === 'fbx') sceneObj = new FBXLoader().parse(await file.arrayBuffer(), '')
  else if (ext === 'glb' || ext === 'gltf') {
    const loader = new GLTFLoader()
    sceneObj = await new Promise((res, rej) => {
      const parseDone = (g) => res(g.scene)
      if (ext === 'glb') file.arrayBuffer().then((ab) => loader.parse(ab, '', parseDone, rej))
      else file.text().then((txt) => loader.parse(txt, '', parseDone, rej))
    })
  } else throw new Error('Unsupported file type')
  sourceModel = sceneObj
  addModelGroup(sceneObj, file.name)
}

function parseVoxToVoxelMap(arrayBuffer) {
  const u8 = new Uint8Array(arrayBuffer)
  const dv = new DataView(arrayBuffer)
  const tag = (o) => String.fromCharCode(u8[o], u8[o + 1], u8[o + 2], u8[o + 3])
  if (u8.length < 8 || tag(0) !== 'VOX ') throw new Error('Invalid .vox')
  const version = dv.getInt32(4, true)
  if (version !== 150 && version !== 200) {
    // still try; format is usually compatible
  }
  let offset = 8
  if (tag(offset) !== 'MAIN') throw new Error('Invalid .vox (missing MAIN)')
  // MAIN: [contentBytes][childrenBytes]
  const mainContent = dv.getInt32(offset + 4, true)
  const mainChildren = dv.getInt32(offset + 8, true)
  offset += 12 + mainContent
  const end = offset + mainChildren

  let sx = 0, sy = 0, sz = 0
  let palette = null // Uint8Array length 1024
  let xyzi = null // Uint8Array for XYZI content

  while (offset + 12 <= end) {
    const id = tag(offset)
    const contentSize = dv.getInt32(offset + 4, true)
    const childrenSize = dv.getInt32(offset + 8, true)
    const contentOff = offset + 12
    const childOff = contentOff + contentSize

    if (id === 'SIZE' && contentSize >= 12) {
      sx = dv.getInt32(contentOff + 0, true)
      sy = dv.getInt32(contentOff + 4, true)
      sz = dv.getInt32(contentOff + 8, true)
    } else if (id === 'XYZI' && contentSize >= 4) {
      xyzi = u8.slice(contentOff, contentOff + contentSize)
    } else if (id === 'RGBA' && contentSize >= 1024) {
      palette = u8.slice(contentOff, contentOff + 1024)
    }
    offset = childOff + childrenSize
  }

  if (!sx || !sy || !sz || !xyzi) throw new Error('Invalid .vox (missing SIZE/XYZI)')
  if (!palette) {
    // Fallback palette: simple grayscale
    palette = new Uint8Array(1024)
    for (let i = 0; i < 256; i++) {
      palette[i * 4 + 0] = i
      palette[i * 4 + 1] = i
      palette[i * 4 + 2] = i
      palette[i * 4 + 3] = 255
    }
  }

  const count = new DataView(xyzi.buffer, xyzi.byteOffset, xyzi.byteLength).getInt32(0, true)
  const vox = new Map()
  const ox = Math.floor(sx / 2), oy = 0, oz = Math.floor(sz / 2)
  let p = 4
  for (let i = 0; i < count; i++) {
    const x = xyzi[p++], y = xyzi[p++], z = xyzi[p++], ci = xyzi[p++]
    if (!ci) continue
    const pi = ci * 4
    const r = palette[pi + 0], g = palette[pi + 1], b = palette[pi + 2], a = palette[pi + 3]
    if (a === 0) continue
    vox.set(keyOf(x - ox, y - oy, z - oz), { r, g, b })
  }
  return { sx, sy, sz, vox }
}

function createSampler(material) {
  const m = Array.isArray(material) ? material[0] : material
  const tex = m?.map
  const img = tex?.image
  if (!img?.width) return null
  const c = document.createElement('canvas'); c.width = img.width; c.height = img.height
  const ctx = c.getContext('2d', { willReadFrequently: true }); if (!ctx) return null
  try {
    ctx.drawImage(img, 0, 0)
    return {
      w: img.width, h: img.height, d: ctx.getImageData(0, 0, img.width, img.height).data,
      wrapS: tex?.wrapS, wrapT: tex?.wrapT, tex
    }
  } catch { return null }
}
const materialSamplerCache = new WeakMap()
function getSamplerForMaterial(material) {
  const m = Array.isArray(material) ? material[0] : material
  if (!m) return null
  if (materialSamplerCache.has(m)) return materialSamplerCache.get(m)
  const smp = createSampler(m)
  materialSamplerCache.set(m, smp)
  return smp
}
function srgbChannelToLinear(v) {
  const x = Math.max(0, Math.min(1, v))
  return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4
}
function linearChannelToSrgbByte(v) {
  const x = Math.max(0, Math.min(1, v))
  const s = x <= 0.0031308 ? (x * 12.92) : (1.055 * (x ** (1 / 2.4)) - 0.055)
  return Math.max(0, Math.min(255, Math.round(s * 255)))
}
function enhanceVoxelColorBytes(r, g, b) {
  const inLum = (r + g + b) / (3 * 255)
  let rf = Math.max(0, Math.min(1, r / 255))
  let gf = Math.max(0, Math.min(1, g / 255))
  let bf = Math.max(0, Math.min(1, b / 255))
  // Gentle shadow/depth recovery + vibrance/contrast boost.
  rf = Math.pow(rf, 1.08)
  gf = Math.pow(gf, 1.08)
  bf = Math.pow(bf, 1.08)
  const l = rf * 0.2126 + gf * 0.7152 + bf * 0.0722
  const sat = 1.16
  rf = l + (rf - l) * sat
  gf = l + (gf - l) * sat
  bf = l + (bf - l) * sat
  const contrast = inLum < 0.1 ? 1.0 : 1.08
  rf = (rf - 0.5) * contrast + 0.5
  gf = (gf - 0.5) * contrast + 0.5
  bf = (bf - 0.5) * contrast + 0.5
  if (inLum > 0.02 && (rf + gf + bf) < 0.03) {
    rf = Math.max(rf, 0.05); gf = Math.max(gf, 0.05); bf = Math.max(bf, 0.05)
  }
  return {
    r: Math.max(0, Math.min(255, Math.round(rf * 255))),
    g: Math.max(0, Math.min(255, Math.round(gf * 255))),
    b: Math.max(0, Math.min(255, Math.round(bf * 255)))
  }
}
const _tmpUv = new THREE.Vector2()
function resolveUvWrap(value, wrapMode) {
  if (wrapMode === THREE.RepeatWrapping) return THREE.MathUtils.euclideanModulo(value, 1)
  if (wrapMode === THREE.MirroredRepeatWrapping) {
    const a = Math.abs(value)
    const i = Math.floor(a)
    const f = a - i
    return i % 2 === 0 ? f : 1 - f
  }
  return Math.max(0, Math.min(1, value))
}
function sampleColorLinear(smp, matColor, uvA, uvB, uvC, u, v, w) {
  if (smp && uvA && uvB && uvC) {
    _tmpUv.set(
      uvA.x * u + uvB.x * v + uvC.x * w,
      uvA.y * u + uvB.y * v + uvC.y * w
    )
    if (smp.tex?.transformUv) smp.tex.transformUv(_tmpUv)
    else {
      _tmpUv.x = resolveUvWrap(_tmpUv.x, smp.wrapS)
      _tmpUv.y = resolveUvWrap(_tmpUv.y, smp.wrapT)
    }
    const tx = _tmpUv.x
    const ty = _tmpUv.y
    const fx = Math.max(0, Math.min(smp.w - 1, tx * (smp.w - 1)))
    const fy = Math.max(0, Math.min(smp.h - 1, ty * (smp.h - 1)))
    const x0 = Math.floor(fx), y0 = Math.floor(fy)
    const x1 = Math.min(smp.w - 1, x0 + 1), y1 = Math.min(smp.h - 1, y0 + 1)
    const dx = fx - x0, dy = fy - y0
    const o00 = (y0 * smp.w + x0) * 4
    const o10 = (y0 * smp.w + x1) * 4
    const o01 = (y1 * smp.w + x0) * 4
    const o11 = (y1 * smp.w + x1) * 4
    const a00 = (smp.d[o00 + 3] ?? 255) / 255
    const a10 = (smp.d[o10 + 3] ?? 255) / 255
    const a01 = (smp.d[o01 + 3] ?? 255) / 255
    const a11 = (smp.d[o11 + 3] ?? 255) / 255
    const a0 = a00 * (1 - dx) + a10 * dx
    const a1 = a01 * (1 - dx) + a11 * dx
    const alpha = a0 * (1 - dy) + a1 * dy
    if (alpha < 0.35) return null
    const r00 = srgbChannelToLinear((smp.d[o00] ?? 0) / 255)
    const g00 = srgbChannelToLinear((smp.d[o00 + 1] ?? 0) / 255)
    const b00 = srgbChannelToLinear((smp.d[o00 + 2] ?? 0) / 255)
    const r10 = srgbChannelToLinear((smp.d[o10] ?? 0) / 255)
    const g10 = srgbChannelToLinear((smp.d[o10 + 1] ?? 0) / 255)
    const b10 = srgbChannelToLinear((smp.d[o10 + 2] ?? 0) / 255)
    const r01 = srgbChannelToLinear((smp.d[o01] ?? 0) / 255)
    const g01 = srgbChannelToLinear((smp.d[o01 + 1] ?? 0) / 255)
    const b01 = srgbChannelToLinear((smp.d[o01 + 2] ?? 0) / 255)
    const r11 = srgbChannelToLinear((smp.d[o11] ?? 0) / 255)
    const g11 = srgbChannelToLinear((smp.d[o11 + 1] ?? 0) / 255)
    const b11 = srgbChannelToLinear((smp.d[o11 + 2] ?? 0) / 255)
    const r0 = r00 * (1 - dx) + r10 * dx
    const g0 = g00 * (1 - dx) + g10 * dx
    const b0 = b00 * (1 - dx) + b10 * dx
    const r1 = r01 * (1 - dx) + r11 * dx
    const g1 = g01 * (1 - dx) + g11 * dx
    const b1 = b01 * (1 - dx) + b11 * dx
    const rr = r0 * (1 - dy) + r1 * dy
    const gg = g0 * (1 - dy) + g1 * dy
    const bb = b0 * (1 - dy) + b1 * dy
    const ml = (matColor.r + matColor.g + matColor.b) / 3
    const useTint = ml > 0.08
    if (useTint) {
      const tint = 0.45
      return {
        r: rr * (1 - tint + tint * matColor.r),
        g: gg * (1 - tint + tint * matColor.g),
        b: bb * (1 - tint + tint * matColor.b)
      }
    }
    return { r: rr, g: gg, b: bb }
  }
  return {
    r: Number.isFinite(matColor?.r) ? matColor.r : srgbChannelToLinear(122 / 255),
    g: Number.isFinite(matColor?.g) ? matColor.g : srgbChannelToLinear(162 / 255),
    b: Number.isFinite(matColor?.b) ? matColor.b : srgbChannelToLinear(255 / 255)
  }
}
function sampleColorFromHitLinear(hit) {
  const mat = Array.isArray(hit.object.material) ? hit.object.material[0] : hit.object.material
  const matColor = new THREE.Color(1, 1, 1)
  if (mat?.color) matColor.copy(mat.color)
  const smp = getSamplerForMaterial(mat)
  const uv = hit.uv
  if (smp && uv) {
    const tx = resolveUvWrap(uv.x, smp.wrapS)
    const ty = 1 - resolveUvWrap(uv.y, smp.wrapT)
    const px = Math.min(smp.w - 1, Math.max(0, Math.floor(tx * smp.w)))
    const py = Math.min(smp.h - 1, Math.max(0, Math.floor(ty * smp.h)))
    const o = (py * smp.w + px) * 4
    return {
      r: srgbChannelToLinear((smp.d[o] ?? 0) / 255) * matColor.r,
      g: srgbChannelToLinear((smp.d[o + 1] ?? 0) / 255) * matColor.g,
      b: srgbChannelToLinear((smp.d[o + 2] ?? 0) / 255) * matColor.b
    }
  }
  return { r: matColor.r, g: matColor.g, b: matColor.b }
}
function rebakeVoxelColorsFromIntersections() {
  if (!modelGroup || !state.voxelMap.size) return
  const meshTargets = []
  modelGroup.traverse((o) => { if (o.isMesh) meshTargets.push(o) })
  if (!meshTargets.length) return
  const dirs = [
    new THREE.Vector3(1, 0, 0), new THREE.Vector3(-1, 0, 0),
    new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, -1, 0),
    new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 0, -1)
  ]
  const maxDist = 1.8
  const origin = new THREE.Vector3()
  const center = new THREE.Vector3()
  for (const [k, existing] of state.voxelMap.entries()) {
    const [x, y, z] = parseKey(k)
    center.set(x, y, z)
    let lr = 0, lg = 0, lb = 0, n = 0
    for (const d of dirs) {
      origin.copy(center).addScaledVector(d, 0.95)
      raycaster.set(origin, d.clone().multiplyScalar(-1))
      raycaster.near = 0
      raycaster.far = maxDist
      const hits = raycaster.intersectObjects(meshTargets, false)
      if (!hits.length) continue
      const c = sampleColorFromHitLinear(hits[0])
      lr += c.r; lg += c.g; lb += c.b; n += 1
    }
    if (n > 0) {
      state.voxelMap.set(k, {
        r: linearChannelToSrgbByte(lr / n),
        g: linearChannelToSrgbByte(lg / n),
        b: linearChannelToSrgbByte(lb / n)
      })
    } else if (!existing) {
      state.voxelMap.set(k, { r: 122, g: 162, b: 255 })
    }
  }
}

function voxelizeModel() {
  if (!models.length) return
  setStatus('Voxelizing...')
  // Only voxelize the selected model layer (if selected), otherwise voxelize all models.
  const targetModels = (selectedLayer.type === 'model' && selectedLayer.id)
    ? models.filter((m) => m.id === selectedLayer.id)
    : models
  if (!targetModels.length) return

  // Align model(s) to the voxel grid so voxel layers from different sources line up.
  // We snap only by tiny sub-voxel offsets (<= 0.5) to avoid visibly changing placement.
  const snapModelToGrid = (mg) => {
    mg.updateMatrixWorld(true)
    // Use world position as the anchor; snap to nearest integer voxel center.
    const px = mg.position.x
    const py = mg.position.y
    const pz = mg.position.z
    const fx = px - Math.round(px)
    const fy = py - Math.round(py)
    const fz = pz - Math.round(pz)
    // If we're noticeably off-grid, nudge onto the grid.
    const eps = 1e-6
    if (Math.abs(fx) > eps) mg.position.x = px - fx
    if (Math.abs(fy) > eps) mg.position.y = py - fy
    if (Math.abs(fz) > eps) mg.position.z = pz - fz
    mg.updateMatrixWorld(true)
  }
  for (const m of targetModels) snapModelToGrid(m.group)
  for (const m of targetModels) m.group.updateMatrixWorld(true)
  pushUndo()
  const voxelSize = 1 // world-space voxel size: model scale directly controls voxel density/count
  const accum = new Map()
  const addSample = (key, lc) => {
    const cur = accum.get(key)
    if (cur) {
      cur.lr += lc.r
      cur.lg += lc.g
      cur.lb += lc.b
      cur.count += 1
      const qr = Math.round(Math.max(0, Math.min(1, lc.r)) * 15)
      const qg = Math.round(Math.max(0, Math.min(1, lc.g)) * 15)
      const qb = Math.round(Math.max(0, Math.min(1, lc.b)) * 15)
      const qk = `${qr},${qg},${qb}`
      const bin = cur.bins.get(qk)
      if (bin) { bin.c += 1; bin.lr += lc.r; bin.lg += lc.g; bin.lb += lc.b } else cur.bins.set(qk, { c: 1, lr: lc.r, lg: lc.g, lb: lc.b })
    } else {
      const qr = Math.round(Math.max(0, Math.min(1, lc.r)) * 15)
      const qg = Math.round(Math.max(0, Math.min(1, lc.g)) * 15)
      const qb = Math.round(Math.max(0, Math.min(1, lc.b)) * 15)
      const qk = `${qr},${qg},${qb}`
      const bins = new Map()
      bins.set(qk, { c: 1, lr: lc.r, lg: lc.g, lb: lc.b })
      accum.set(key, { lr: lc.r, lg: lc.g, lb: lc.b, count: 1, bins })
    }
  }

  for (const mg of targetModels.map((m) => m.group)) mg.traverse((o) => {
    if (!o.isMesh || !o.geometry?.attributes?.position) return
    const pos = o.geometry.attributes.position
    const uv = o.geometry.attributes.uv
    const idx = o.geometry.index
    const mats = Array.isArray(o.material) ? o.material : [o.material]
    const triCount = idx ? idx.count / 3 : pos.count / 3
    const triMat = new Int16Array(triCount)
    if (idx && o.geometry.groups?.length && mats.length > 1) {
      for (const g of o.geometry.groups) {
        const matIndex = Math.max(0, Math.min(mats.length - 1, g.materialIndex ?? 0))
        const triStart = Math.floor((g.start ?? 0) / 3)
        const triEnd = Math.min(triCount, Math.ceil(((g.start ?? 0) + (g.count ?? 0)) / 3))
        for (let ti = triStart; ti < triEnd; ti++) triMat[ti] = matIndex
      }
    }
    for (let t = 0; t < triCount; t++) {
      const i0 = idx ? idx.getX(t * 3) : t * 3, i1 = idx ? idx.getX(t * 3 + 1) : t * 3 + 1, i2 = idx ? idx.getX(t * 3 + 2) : t * 3 + 2
      const mat = mats[Math.max(0, Math.min(mats.length - 1, triMat[t]))]
      const smp = getSamplerForMaterial(mat)
      const mc = new THREE.Color(1, 1, 1); if (mat?.color) mc.copy(mat.color)
      const a = new THREE.Vector3().fromBufferAttribute(pos, i0).applyMatrix4(o.matrixWorld)
      const b = new THREE.Vector3().fromBufferAttribute(pos, i1).applyMatrix4(o.matrixWorld)
      const c = new THREE.Vector3().fromBufferAttribute(pos, i2).applyMatrix4(o.matrixWorld)
      const edge = Math.max(a.distanceTo(b), b.distanceTo(c), c.distanceTo(a))
      // Higher adaptive sampling for very large scaled models to avoid shell holes.
      const steps = Math.max(1, Math.min(120, Math.ceil(edge / (voxelSize * 0.6))))
      const uvA = uv ? new THREE.Vector2().fromBufferAttribute(uv, i0) : null
      const uvB = uv ? new THREE.Vector2().fromBufferAttribute(uv, i1) : null
      const uvC = uv ? new THREE.Vector2().fromBufferAttribute(uv, i2) : null
      for (let u = 0; u <= steps; u++) for (let v = 0; v <= steps - u; v++) {
        const uu = u / steps, vv = v / steps, ww = 1 - uu - vv
        const p = new THREE.Vector3().copy(a).multiplyScalar(uu).addScaledVector(b, vv).addScaledVector(c, ww)
        // Preserve world-space placement (translation/rotation/scale) instead of rebasing to box.min.
        const x = Math.round(p.x / voxelSize), y = Math.round(p.y / voxelSize), z = Math.round(p.z / voxelSize)
        const sampled = sampleColorLinear(smp, mc, uvA, uvB, uvC, uu, vv, ww)
        if (!sampled) continue
        addSample(keyOf(x, y, z), sampled)
      }
    }
  })
  const outMap = new Map()
  for (const [k, a] of accum.entries()) {
    let lr = a.lr, lg = a.lg, lb = a.lb, count = a.count
    if (a.bins && a.bins.size) {
      let best = null
      for (const v of a.bins.values()) if (!best || v.c > best.c) best = v
      if (best && best.c > 0) { lr = best.lr; lg = best.lg; lb = best.lb; count = best.c }
    }
    const inv = count > 0 ? 1 / count : 1
    const out = enhanceVoxelColorBytes(
      linearChannelToSrgbByte(lr * inv),
      linearChannelToSrgbByte(lg * inv),
      linearChannelToSrgbByte(lb * inv)
    )
    outMap.set(k, out)
  }
  // Put result into a new voxel layer (so voxels can be moved/merged later).
  const newId = `v_${Math.random().toString(36).slice(2, 10)}`
  const voxelName = (targetModels.length === 1)
    ? targetModels[0].name
    : `Voxelized (${targetModels.length} models)`
  voxelLayers.push({ id: newId, name: voxelName, voxelMap: outMap, group: new THREE.Group() })
  activeVoxelLayerId = newId
  syncStateVoxelMapToActiveLayer()
  layerOrder.push({ type: 'voxel', id: newId })
  closeSmallVoxelGaps()
  const beforeReduce = state.voxelMap.size
  reduceLargeVoxelMapIfNeeded()
  const afterReduce = state.voxelMap.size
  applyPerformanceModeByVoxelCount()
  if (afterReduce < beforeReduce) setStatus(`Large model optimized: ${beforeReduce.toLocaleString()} -> ${afterReduce.toLocaleString()} voxels`)
  else setStatus(`Voxelized ${afterReduce.toLocaleString()} voxels`)
  // Keep voxelization interactive: skip heavy post ray-bake pass.
  rebuildVoxelMesh()

  // Hide/archive the original model layer(s) that were voxelized so Undo can bring them back.
  const removedIds = new Set(targetModels.map((m) => m.id))
  for (const m of targetModels) {
    m.group.visible = false
    m.archived = true
  }
  layerOrder = layerOrder.filter((l) => !(l.type === 'model' && removedIds.has(l.id)))
  if (selectedLayer.type === 'model' && removedIds.has(selectedLayer.id)) selectedLayer = { type: 'voxel', id: newId }
  if (activeModelId && removedIds.has(activeModelId)) activeModelId = models.find((mm) => !mm.archived)?.id ?? null

  transform.detach(); transform.visible = false; state.scaleMode = false
  rebuildLayersUI()
}

function closeSmallVoxelGaps() {
  if (!state.voxelMap.size) return
  const candidates = new Set()
  for (const k of state.voxelMap.keys()) {
    const [x, y, z] = parseKey(k)
    candidates.add(keyOf(x + 1, y, z)); candidates.add(keyOf(x - 1, y, z))
    candidates.add(keyOf(x, y + 1, z)); candidates.add(keyOf(x, y - 1, z))
    candidates.add(keyOf(x, y, z + 1)); candidates.add(keyOf(x, y, z - 1))
  }
  const toFill = []
  for (const k of candidates) {
    if (state.voxelMap.has(k)) continue
    const [x, y, z] = parseKey(k)
    let n = 0
    if (state.voxelMap.has(keyOf(x + 1, y, z))) n++
    if (state.voxelMap.has(keyOf(x - 1, y, z))) n++
    if (state.voxelMap.has(keyOf(x, y + 1, z))) n++
    if (state.voxelMap.has(keyOf(x, y - 1, z))) n++
    if (state.voxelMap.has(keyOf(x, y, z + 1))) n++
    if (state.voxelMap.has(keyOf(x, y, z - 1))) n++
    if (n >= 5) toFill.push(k)
  }
  for (const k of toFill) {
    const [x, y, z] = parseKey(k)
    let sr = 0, sg = 0, sb = 0, c = 0
    const ns = [[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]]
    for (const d of ns) {
      const cc = state.voxelMap.get(keyOf(x + d[0], y + d[1], z + d[2]))
      if (!cc) continue
      sr += cc.r; sg += cc.g; sb += cc.b; c++
    }
    if (c > 0) state.voxelMap.set(k, { r: Math.round(sr / c), g: Math.round(sg / c), b: Math.round(sb / c) })
  }
}

function reduceLargeVoxelMapIfNeeded() {
  const count = state.voxelMap.size
  const SOFT_CAP = 120000
  if (count <= SOFT_CAP) return
  const entries = [...state.voxelMap.entries()]
  const surface = new Set()
  for (const [k] of entries) {
    const [x, y, z] = parseKey(k)
    if (
      !state.voxelMap.has(keyOf(x + 1, y, z)) || !state.voxelMap.has(keyOf(x - 1, y, z)) ||
      !state.voxelMap.has(keyOf(x, y + 1, z)) || !state.voxelMap.has(keyOf(x, y - 1, z)) ||
      !state.voxelMap.has(keyOf(x, y, z + 1)) || !state.voxelMap.has(keyOf(x, y, z - 1))
    ) surface.add(k)
  }
  const target = Math.max(SOFT_CAP, Math.floor(count * 0.65))
  const out = new Map()
  // Always keep silhouette/surface voxels first.
  for (const k of surface) out.set(k, state.voxelMap.get(k))
  if (out.size >= target) {
    state.voxelMap = out
    return
  }
  const interior = entries.filter(([k]) => !surface.has(k))
  const remain = target - out.size
  const step = Math.max(1, Math.ceil(interior.length / Math.max(1, remain)))
  for (let i = 0; i < interior.length; i += step) {
    const [k, c] = interior[i]
    out.set(k, c)
    if (out.size >= target) break
  }
  state.voxelMap = out
}

function buildVoxelChunkGroup(voxelMap, layerId) {
  // Pivot group so TransformControls gizmos sit at the voxel-layer bounds center.
  const pivot = new THREE.Group()
  pivot.userData.isVoxelLayerGroup = true
  pivot.userData.layerId = layerId
  pivot.userData.isVoxelLayerPivot = true

  const group = new THREE.Group()
  group.userData.isVoxelLayerInner = true
  pivot.add(group)

  // Compute bounds center in voxel/world units (same space as voxel keys).
  let cx = 0, cy = 0, cz = 0
  if (voxelMap?.size) {
    let minX = Infinity, minY = Infinity, minZ = Infinity
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity
    for (const k of voxelMap.keys()) {
      const [x, y, z] = parseKey(k)
      if (x < minX) minX = x; if (y < minY) minY = y; if (z < minZ) minZ = z
      if (x > maxX) maxX = x; if (y > maxY) maxY = y; if (z > maxZ) maxZ = z
    }
    cx = (minX + maxX) / 2
    cy = (minY + maxY) / 2
    cz = (minZ + maxZ) / 2
  }
  pivot.position.set(cx, cy, cz)
  group.position.set(-cx, -cy, -cz)
  pivot.userData.pivotCenter = new THREE.Vector3(cx, cy, cz)
  const chunkData = new Map()
  const faceDefs = [
    { n: [1, 0, 0], verts: [[0.5, -0.5, -0.5], [0.5, -0.5, 0.5], [0.5, 0.5, 0.5], [0.5, 0.5, -0.5]] },
    { n: [-1, 0, 0], verts: [[-0.5, -0.5, 0.5], [-0.5, -0.5, -0.5], [-0.5, 0.5, -0.5], [-0.5, 0.5, 0.5]] },
    { n: [0, 1, 0], verts: [[-0.5, 0.5, 0.5], [0.5, 0.5, 0.5], [0.5, 0.5, -0.5], [-0.5, 0.5, -0.5]] },
    { n: [0, -1, 0], verts: [[-0.5, -0.5, 0.5], [0.5, -0.5, 0.5], [0.5, -0.5, -0.5], [-0.5, -0.5, -0.5]] },
    { n: [0, 0, 1], verts: [[0.5, -0.5, 0.5], [-0.5, -0.5, 0.5], [-0.5, 0.5, 0.5], [0.5, 0.5, 0.5]] },
    { n: [0, 0, -1], verts: [[-0.5, -0.5, -0.5], [0.5, -0.5, -0.5], [0.5, 0.5, -0.5], [-0.5, 0.5, -0.5]] }
  ]
  const getChunk = (x, y, z) => {
    const cx = Math.floor(x / VOXEL_CHUNK_SIZE)
    const cy = Math.floor(y / VOXEL_CHUNK_SIZE)
    const cz = Math.floor(z / VOXEL_CHUNK_SIZE)
    const ck = `${cx},${cy},${cz}`
    let cd = chunkData.get(ck)
    if (cd) return cd
    cd = { cx, cy, cz, pos: [], nrm: [], col: [], idx: [], v: 0 }
    chunkData.set(ck, cd)
    return cd
  }
  for (const [k, c] of voxelMap.entries()) {
    const [x, y, z] = parseKey(k)
    const cc = c || { r: 255, g: 255, b: 255 }
    const cr = Math.max(0, Math.min(255, Number.isFinite(cc.r) ? cc.r : 255)) / 255
    const cg = Math.max(0, Math.min(255, Number.isFinite(cc.g) ? cc.g : 255)) / 255
    const cb = Math.max(0, Math.min(255, Number.isFinite(cc.b) ? cc.b : 255)) / 255
    const cd = getChunk(x, y, z)
    for (const f of faceDefs) {
      const nx = x + f.n[0], ny = y + f.n[1], nz = z + f.n[2]
      if (voxelMap.has(keyOf(nx, ny, nz))) continue
      const base = cd.v
      for (const vv of f.verts) {
        cd.pos.push(x + vv[0], y + vv[1], z + vv[2])
        cd.nrm.push(f.n[0], f.n[1], f.n[2])
        cd.col.push(cr, cg, cb)
        cd.v++
      }
      cd.idx.push(base, base + 1, base + 2, base, base + 2, base + 3)
    }
  }
  for (const cd of chunkData.values()) {
    if (!cd.idx.length) continue
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.Float32BufferAttribute(cd.pos, 3))
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(cd.nrm, 3))
    geo.setAttribute('color', new THREE.Float32BufferAttribute(cd.col, 3))
    geo.setIndex(cd.idx)
    geo.computeBoundingSphere()
    const mat = shaderEnabled
      ? new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, metalness: 0.02, side: THREE.DoubleSide })
      : new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide })
    const mesh = new THREE.Mesh(geo, mat)
    mesh.castShadow = shadowsEnabled
    mesh.receiveShadow = shadowsEnabled
    mesh.userData.isVoxelChunkMesh = true
    mesh.userData.layerType = 'voxel'
    mesh.userData.layerId = layerId
    mesh.userData.chunkKey = `${cd.cx},${cd.cy},${cd.cz}`
    mesh.userData.chunkCoords = { cx: cd.cx, cy: cd.cy, cz: cd.cz }
    const minX = cd.cx * VOXEL_CHUNK_SIZE - 0.5
    const minY = cd.cy * VOXEL_CHUNK_SIZE - 0.5
    const minZ = cd.cz * VOXEL_CHUNK_SIZE - 0.5
    const size = VOXEL_CHUNK_SIZE + 1
    mesh.userData.chunkBounds = new THREE.Box3(
      new THREE.Vector3(minX, minY, minZ),
      new THREE.Vector3(minX + size, minY + size, minZ + size)
    )
    mesh.userData.isChunk = true
    group.add(mesh)
  }
  return pivot
}

function rebuildVoxelMesh() {
  const proxyActiveLayerId = transform.object?.userData?.isVoxelGizmoProxy ? transform.object.userData.layerId : null
  const attachedMode = transform.mode
  const attachedVisible = transform.visible

  if (voxelMesh) root.remove(voxelMesh)
  if (voxelGroup) root.remove(voxelGroup)
  if (voxelOutlineGroup) root.remove(voxelOutlineGroup)
  voxelMesh = null
  voxelGroup = null
  voxelOutlineGroup = null
  voxelGroup = new THREE.Group()
  // Build all voxel layers (including active drawing layer).
  for (const l of voxelLayers) {
    ensureLayerIndex(l)
    if (!l.chunkIndex || l.chunkIndex.size === 0) rebuildLayerChunkIndex(l)
    l.group = buildVoxelChunkGroup(l.voxelMap, l.id)
    // Cache render state for dirty-chunk rebuilds.
    l.render.pivot = l.group
    l.render.inner = l.group.children?.find((c) => c.userData?.isVoxelLayerInner) || l.group.children?.[0] || l.group
    l.render.chunks = new Map()
    for (const child of (l.render.inner?.children || [])) {
      if (child?.userData?.isChunk && child.userData.chunkKey) l.render.chunks.set(child.userData.chunkKey, child)
    }
    voxelGroup.add(l.group)
  }
  root.add(voxelGroup)
  updateChunkVisibility(true)

  // Optional outlines (per-voxel edges for surface voxels; still cheap-ish because it's one merged LineSegments).
  const outlineOn = document.getElementById('toggleOutlineBtn')?.classList.contains('active')
  if (outlineOn) {
    voxelOutlineGroup = new THREE.Group()
    const lineMat = new THREE.LineBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.42 })
    const edgePairs = [
      // bottom square
      [-0.5, -0.5, -0.5,  0.5, -0.5, -0.5],
      [ 0.5, -0.5, -0.5,  0.5, -0.5,  0.5],
      [ 0.5, -0.5,  0.5, -0.5, -0.5,  0.5],
      [-0.5, -0.5,  0.5, -0.5, -0.5, -0.5],
      // top square
      [-0.5,  0.5, -0.5,  0.5,  0.5, -0.5],
      [ 0.5,  0.5, -0.5,  0.5,  0.5,  0.5],
      [ 0.5,  0.5,  0.5, -0.5,  0.5,  0.5],
      [-0.5,  0.5,  0.5, -0.5,  0.5, -0.5],
      // verticals
      [-0.5, -0.5, -0.5, -0.5,  0.5, -0.5],
      [ 0.5, -0.5, -0.5,  0.5,  0.5, -0.5],
      [ 0.5, -0.5,  0.5,  0.5,  0.5,  0.5],
      [-0.5, -0.5,  0.5, -0.5,  0.5,  0.5]
    ]
    // Build per-layer so "same position in different layer" can still be outlined cleanly.
    for (const layer of voxelLayers) {
      const vm = layer.voxelMap
      if (!vm?.size) continue
      // Surface voxels only.
      const pos = []
      for (const k of vm.keys()) {
        const [x, y, z] = parseKey(k)
        // If fully surrounded, skip.
        if (
          vm.has(keyOf(x + 1, y, z)) &&
          vm.has(keyOf(x - 1, y, z)) &&
          vm.has(keyOf(x, y + 1, z)) &&
          vm.has(keyOf(x, y - 1, z)) &&
          vm.has(keyOf(x, y, z + 1)) &&
          vm.has(keyOf(x, y, z - 1))
        ) continue
        for (const e of edgePairs) {
          pos.push(
            x + e[0], y + e[1], z + e[2],
            x + e[3], y + e[4], z + e[5]
          )
        }
      }
      if (!pos.length) continue
      const g = new THREE.BufferGeometry()
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
      g.computeBoundingSphere()
      const ls = new THREE.LineSegments(g, lineMat)
      ls.frustumCulled = true
      voxelOutlineGroup.add(ls)
    }
    root.add(voxelOutlineGroup)
  }

  if (proxyActiveLayerId) {
    // Keep proxy centered on the same layer after rebuild.
    const layer = voxelLayers.find((l) => l.id === proxyActiveLayerId)
    if (layer) {
      const c = voxelMapBoundsCenter(layer.voxelMap)
      voxelGizmoProxy.position.copy(c)
      voxelGizmoProxy.userData.layerId = proxyActiveLayerId
      transform.detach()
      transform.setMode(attachedMode)
      transform.attach(voxelGizmoProxy)
      transform.visible = attachedVisible
    }
  }
  rebuildLayersUI()
}

function updateChunkVisibility(force = false) {
  if (!voxelGroup) return
  chunkCullFrame++
  if (!force && (chunkCullFrame % 3 !== 0)) return
  camera.updateMatrixWorld()
  camProjMatrix.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse)
  frustum.setFromProjectionMatrix(camProjMatrix)
  for (const layerGroup of voxelGroup.children) {
    const kids = layerGroup?.children || []
    for (const child of kids) {
      if (!child.userData?.isChunk) continue
      const bb = child.userData.chunkBounds
      child.visible = bb ? frustum.intersectsBox(bb) : true
    }
  }
}

// Dirty-chunk rebuild pipeline (fast strokes on huge voxel layers).
const _faceDefs = [
  { n: [1, 0, 0], verts: [[0.5, -0.5, -0.5], [0.5, -0.5, 0.5], [0.5, 0.5, 0.5], [0.5, 0.5, -0.5]] },
  { n: [-1, 0, 0], verts: [[-0.5, -0.5, 0.5], [-0.5, -0.5, -0.5], [-0.5, 0.5, -0.5], [-0.5, 0.5, 0.5]] },
  { n: [0, 1, 0], verts: [[-0.5, 0.5, 0.5], [0.5, 0.5, 0.5], [0.5, 0.5, -0.5], [-0.5, 0.5, -0.5]] },
  { n: [0, -1, 0], verts: [[-0.5, -0.5, 0.5], [0.5, -0.5, 0.5], [0.5, -0.5, -0.5], [-0.5, -0.5, -0.5]] },
  { n: [0, 0, 1], verts: [[0.5, -0.5, 0.5], [-0.5, -0.5, 0.5], [-0.5, 0.5, 0.5], [0.5, 0.5, 0.5]] },
  { n: [0, 0, -1], verts: [[-0.5, -0.5, -0.5], [0.5, -0.5, -0.5], [0.5, 0.5, -0.5], [-0.5, 0.5, -0.5]] }
]
function enqueueDirtyChunk(layerId, chunkKey) {
  const k = `${layerId}|${chunkKey}`
  if (state.chunkRebuild.queued.has(k)) return
  state.chunkRebuild.queued.add(k)
  state.chunkRebuild.queue.push({ layerId, chunkKey })
}
function markDirtyChunksForVoxelKey(layer, voxelKey) {
  const [x, y, z] = parseKey(voxelKey)
  const cx = Math.floor(x / VOXEL_CHUNK_SIZE)
  const cy = Math.floor(y / VOXEL_CHUNK_SIZE)
  const cz = Math.floor(z / VOXEL_CHUNK_SIZE)
  for (const d of [[0,0,0],[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]]) {
    enqueueDirtyChunk(layer.id, `${cx + d[0]},${cy + d[1]},${cz + d[2]}`)
  }
}
function gatherChunkAndNeighborOccupancy(layer, cx, cy, cz) {
  // Occupancy used only for face-culling checks while building this chunk.
  const occ = new Set()
  const addFromChunk = (ck) => {
    const set = layer.chunkIndex.get(ck)
    if (!set) return
    for (const k of set) occ.add(k)
  }
  const base = `${cx},${cy},${cz}`
  addFromChunk(base)
  addFromChunk(`${cx+1},${cy},${cz}`)
  addFromChunk(`${cx-1},${cy},${cz}`)
  addFromChunk(`${cx},${cy+1},${cz}`)
  addFromChunk(`${cx},${cy-1},${cz}`)
  addFromChunk(`${cx},${cy},${cz+1}`)
  addFromChunk(`${cx},${cy},${cz-1}`)
  return occ
}
async function rebuildChunkMesh(layer, chunkKey) {
  ensureLayerIndex(layer)
  if (!layer.render?.inner) return false
  const parts = chunkKey.split(',').map((n) => Number.parseInt(n, 10))
  const cx = parts[0] | 0, cy = parts[1] | 0, cz = parts[2] | 0
  const set = layer.chunkIndex.get(chunkKey)
  const voxKeys = set ? [...set] : []
  const occ = gatherChunkAndNeighborOccupancy(layer, cx, cy, cz)

  // If no voxels in this chunk, remove mesh if it exists.
  const existing = layer.render.chunks.get(chunkKey)
  if (!voxKeys.length) {
    if (existing) {
      layer.render.inner.remove(existing)
      existing.geometry?.dispose?.()
      existing.material?.dispose?.()
      layer.render.chunks.delete(chunkKey)
    }
    return true
  }

  const payload = {
    id: voxelWorkerReq++,
    type: 'buildChunk',
    chunkKey,
    voxKeys,
    colors: voxKeys.map((k) => layer.voxelMap.get(k) || { r: 255, g: 255, b: 255 }),
    occKeys: [...occ]
  }

  const w = ensureVoxelWorker()
  let msg = null
  if (w) {
    msg = await new Promise((resolve, reject) => {
      voxelWorkerPending.set(payload.id, { resolve, reject })
      w.postMessage(payload)
    })
  } else {
    // Fallback: build on main thread if worker isn't available.
    msg = buildChunkOnMain(payload)
  }

  if (!msg?.ok) return false
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(msg.pos, 3))
  geo.setAttribute('normal', new THREE.BufferAttribute(msg.nrm, 3))
  geo.setAttribute('color', new THREE.BufferAttribute(msg.col, 3))
  geo.setIndex(new THREE.BufferAttribute(msg.idx, 1))
  geo.computeBoundingSphere()

  const mat = shaderEnabled
    ? new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, metalness: 0.02, side: THREE.DoubleSide })
    : new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide })

  const mesh = existing || new THREE.Mesh(geo, mat)
  if (existing) {
    existing.geometry?.dispose?.()
    existing.material?.dispose?.()
    mesh.geometry = geo
    mesh.material = mat
  } else {
    mesh.userData.isVoxelChunkMesh = true
    mesh.userData.layerType = 'voxel'
    mesh.userData.layerId = layer.id
    mesh.userData.chunkKey = chunkKey
    mesh.userData.isChunk = true
    layer.render.inner.add(mesh)
    layer.render.chunks.set(chunkKey, mesh)
  }
  mesh.castShadow = shadowsEnabled
  mesh.receiveShadow = shadowsEnabled
  const minX = cx * VOXEL_CHUNK_SIZE - 0.5
  const minY = cy * VOXEL_CHUNK_SIZE - 0.5
  const minZ = cz * VOXEL_CHUNK_SIZE - 0.5
  const size = VOXEL_CHUNK_SIZE + 1
  mesh.userData.chunkBounds = new THREE.Box3(
    new THREE.Vector3(minX, minY, minZ),
    new THREE.Vector3(minX + size, minY + size, minZ + size)
  )
  return true
}
function buildChunkOnMain(payload) {
  const occ = new Set(payload.occKeys || [])
  const pos = []
  const nrm = []
  const col = []
  const idx = []
  let v = 0
  for (let i = 0; i < payload.voxKeys.length; i++) {
    const k = payload.voxKeys[i]
    const [x, y, z] = parseKey(k)
    const cc = payload.colors[i] || { r: 255, g: 255, b: 255 }
    const cr = Math.max(0, Math.min(255, cc.r)) / 255
    const cg = Math.max(0, Math.min(255, cc.g)) / 255
    const cb = Math.max(0, Math.min(255, cc.b)) / 255
    for (const f of _faceDefs) {
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
  return { ok: true, id: payload.id, pos: new Float32Array(pos), nrm: new Float32Array(nrm), col: new Float32Array(col), idx: new Uint32Array(idx) }
}
async function processChunkRebuildQueue() {
  if (processChunkRebuildQueue._busy) return
  processChunkRebuildQueue._busy = true
  try {
    const budget = state.chunkRebuild.maxPerFrame
    let did = 0
    while (did < budget && state.chunkRebuild.queue.length) {
      const { layerId, chunkKey } = state.chunkRebuild.queue.shift()
      state.chunkRebuild.queued.delete(`${layerId}|${chunkKey}`)
      const layer = voxelLayers.find((l) => l.id === layerId)
      if (!layer) continue
      // If layer has not been fully built yet, fall back to full rebuild once.
      if (!layer.render?.inner) { rebuildVoxelMesh(); break }
      await rebuildChunkMesh(layer, chunkKey)
      did++
    }
    if (did) updateChunkVisibility(true)
  } finally {
    processChunkRebuildQueue._busy = false
  }
}

function rebuildVoxelMesh_OldInstanced_DISABLED() {
  if (voxelMesh) root.remove(voxelMesh)
  if (!state.voxelMap.size) { voxelMesh = null; return }
  const count = Math.max(1, state.voxelMap.size)
  const g = new THREE.BoxGeometry(1, 1, 1)
  const m = new THREE.MeshBasicMaterial({ vertexColors: true, color: 0xffffff })
  voxelMesh = new THREE.InstancedMesh(g, m, count)
  voxelMesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(count * 3), 3)
  const keys = [...state.voxelMap.keys()]
  keys.forEach((k, i) => {
    const [x, y, z] = parseKey(k)
    const c = state.voxelMap.get(k) || { r: 255, g: 255, b: 255 }
    const r = Number.isFinite(c.r) ? c.r : 255
    const gg = Number.isFinite(c.g) ? c.g : 255
    const b = Number.isFinite(c.b) ? c.b : 255
    voxelMesh.setMatrixAt(i, new THREE.Matrix4().makeTranslation(x, y, z))
    voxelMesh.instanceColor.setXYZ(
      i,
      Math.max(0, Math.min(255, r)) / 255,
      Math.max(0, Math.min(255, gg)) / 255,
      Math.max(0, Math.min(255, b)) / 255
    )
  })
  voxelMesh.count = keys.length
  voxelMesh.instanceMatrix.needsUpdate = true
  voxelMesh.instanceColor.needsUpdate = true
  voxelMesh.material.needsUpdate = true
  voxelMesh.frustumCulled = false
  voxelMesh.userData.keys = keys
  root.add(voxelMesh)
}

function rebuildSelection() {
  selection.clear()
  const g = new THREE.BoxGeometry(1.06, 1.06, 1.06)
  const m = new THREE.MeshBasicMaterial({ color: 0xffff00, wireframe: true })
  for (const k of state.selected) { const [x, y, z] = parseKey(k); const mesh = new THREE.Mesh(g, m); mesh.position.set(x, y, z); selection.add(mesh) }
}

function pick(event) {
  const rect = canvas.getBoundingClientRect()
  mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1
  mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1
  raycaster.setFromCamera(mouse, camera)
  const gizmoActive = !!(transform.visible && transform.object)
  const gizmoHelper = gizmoActive ? transform.getHelper() : null
  const modelRoots = models.map((m) => m.group)
  const hit = raycaster.intersectObjects([voxelGroup, voxelMesh, ...modelRoots, ground, gizmoHelper].filter(Boolean), true)[0]
  if (!hit) return null
  if (gizmoActive && gizmoHelper) {
    let p = hit.object
    while (p) {
      if (p === gizmoHelper) return { type: 'gizmo', point: hit.point }
      p = p.parent
    }
  }
  if (hit.object?.userData?.isFloor) {
    return { type: 'floor', point: hit.point, normal: new THREE.Vector3(0, 1, 0) }
  }
  const getStableHitNormal = () => {
    const n = hit.face?.normal?.clone() ?? new THREE.Vector3(0, 1, 0)
    n.transformDirection(hit.object.matrixWorld).normalize()
    // With DoubleSide materials, raycasts can return back-side hits; force outward normal toward camera.
    const viewDir = new THREE.Vector3().subVectors(camera.position, hit.point).normalize()
    if (n.dot(viewDir) < 0) n.negate()
    return n
  }
  if (hit.object?.userData?.key) {
    return { type: 'voxel', key: hit.object.userData.key, normal: getStableHitNormal(), point: hit.point }
  }
  if (hit.object?.userData?.isVoxelChunkMesh) {
    const n = getStableHitNormal()
    // Map to voxel key using hit point projected into the voxel cell across the outward face.
    // Use floor-ish mapping here; round was flaky depending on camera side/tri interpolation.
    const eps = 1e-4
    const px = hit.point.x - n.x * (0.5 + eps)
    const py = hit.point.y - n.y * (0.5 + eps)
    const pz = hit.point.z - n.z * (0.5 + eps)
    // floor(x + 0.5) maps a world point to the voxel-center integer for a voxel cube spanning [i-0.5, i+0.5).
    // This is more stable than Math.round for negative coordinates around half-integers.
    const key = keyOf(Math.floor(px + 0.5), Math.floor(py + 0.5), Math.floor(pz + 0.5))
    return { type: 'voxel', key, normal: n, point: hit.point, layerId: hit.object.userData.layerId }
  }
  if (voxelMesh && hit.object === voxelMesh) {
    return { type: 'voxel', key: voxelMesh.userData.keys[hit.instanceId], normal: hit.face?.normal?.clone() ?? new THREE.Vector3(0, 1, 0), point: hit.point }
  }
  if (models.length) {
    let p = hit.object
    while (p && !p.userData?.isModelRoot) p = p.parent
    if (p?.userData?.isModelRoot && hit.object?.isMesh) return { type: 'model', point: hit.point, modelGroup: p }
  }
  return null
}

function pickAtClientXY(clientX, clientY) {
  // If the interpolated point is outside the canvas, ignore it.
  // Without this, fast drags can raycast using out-of-bounds coords and hit the scene unexpectedly.
  const rect = canvas.getBoundingClientRect()
  if (clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom) return null
  // Minimal event-like object for pick()
  return pick({ clientX, clientY })
}

function pickPaint(eventLike) {
  const rect = canvas.getBoundingClientRect()
  mouse.x = ((eventLike.clientX - rect.left) / rect.width) * 2 - 1
  mouse.y = -((eventLike.clientY - rect.top) / rect.height) * 2 + 1
  raycaster.setFromCamera(mouse, camera)
  // Painting/erasing: don't let gizmos/models steal ray hits.
  const hit = raycaster.intersectObjects([voxelGroup, voxelMesh, ground].filter(Boolean), true)[0]
  if (!hit) return null
  if (hit.object?.userData?.isFloor) {
    return { type: 'floor', point: hit.point, normal: new THREE.Vector3(0, 1, 0) }
  }
  const getStableHitNormal = () => {
    const n = hit.face?.normal?.clone() ?? new THREE.Vector3(0, 1, 0)
    n.transformDirection(hit.object.matrixWorld).normalize()
    const viewDir = new THREE.Vector3().subVectors(camera.position, hit.point).normalize()
    if (n.dot(viewDir) < 0) n.negate()
    return n
  }
  if (hit.object?.userData?.key) {
    return { type: 'voxel', key: hit.object.userData.key, normal: getStableHitNormal(), point: hit.point }
  }
  if (hit.object?.userData?.isVoxelChunkMesh) {
    const n = getStableHitNormal()
    const eps = 1e-4
    const px = hit.point.x - n.x * (0.5 + eps)
    const py = hit.point.y - n.y * (0.5 + eps)
    const pz = hit.point.z - n.z * (0.5 + eps)
    const key = keyOf(Math.floor(px + 0.5), Math.floor(py + 0.5), Math.floor(pz + 0.5))
    return { type: 'voxel', key, normal: n, point: hit.point, layerId: hit.object.userData.layerId }
  }
  if (voxelMesh && hit.object === voxelMesh) {
    return { type: 'voxel', key: voxelMesh.userData.keys[hit.instanceId], normal: hit.face?.normal?.clone() ?? new THREE.Vector3(0, 1, 0), point: hit.point }
  }
  return null
}
function pickPaintAtClientXY(clientX, clientY) {
  const rect = canvas.getBoundingClientRect()
  if (clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom) return null
  return pickPaint({ clientX, clientY })
}

  function pickTransformTarget(event) {
  const rect = canvas.getBoundingClientRect()
  mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1
  mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1
  raycaster.setFromCamera(mouse, camera)
  const gizmoActive = !!(transform.visible && transform.object)
  const gizmoHelper = gizmoActive ? transform.getHelper() : null

  if (gizmoHelper) {
    const gizmoHit = raycaster.intersectObject(gizmoHelper, true)[0]
    // TransformControls has large internal helper planes; only treat as gizmo when an axis/handle is actually active.
    if (gizmoHit && transform.axis) return { type: 'gizmo', point: gizmoHit.point }
  }
    if (models.length) {
      const hits = raycaster.intersectObjects(models.map((m) => m.group), true)
      const modelHit = hits.find((h) => h.object?.isMesh)
      if (modelHit) {
        let p = modelHit.object
        while (p && !p.userData?.isModelRoot) p = p.parent
        if (p?.userData?.isModelRoot) return { type: 'model', point: modelHit.point, modelGroup: p }
      }
    }
    return null
  }

function hoveredScreenCircle(event, anchor = null) {
  const p = anchor || { x: event.clientX, y: event.clientY }
  brushCursor.style.left = `${p.x}px`; brushCursor.style.top = `${p.y}px`
  const px = Math.max(12, state.brushSize * 14)
  brushCursor.style.width = `${px}px`; brushCursor.style.height = `${px}px`
  toolCursor.style.left = `${p.x + 14}px`; toolCursor.style.top = `${p.y + 14}px`
  const resizing = !!state.pointer.resizeBrush || (!!event && event.ctrlKey && event.altKey)
  const showToolIcon = !resizing && (state.tool === 'bucket' || state.tool === 'picker' || state.tool === 'select' || state.tool === 'rotate' || state.tool === 'scale' || !!state.pointer.prevTool || state.pointer.altEyedropActive)
  brushCursor.style.display = showToolIcon ? 'none' : 'block'
  toolCursor.style.display = showToolIcon ? 'flex' : 'none'
  const ct = state.pointer.altEyedropActive ? 'picker' : (state.pointer.prevTool || state.tool)
  const src = (
    ct === 'picker' ? './branding/icons/eye_dropper_icon.png' :
    ct === 'bucket' ? './branding/icons/paint_bucket_icon.png' :
    ct === 'select' ? './branding/icons/move_icon.png' :
    ct === 'rotate' ? './branding/icons/rotate_icon.png' :
    ct === 'scale' ? './branding/icons/scale_icon.png' :
    null
  )
  toolCursor.innerHTML = src ? `<img draggable="false" src="${src}" alt="${ct}">` : ''
}

const _scratchVec3A = new THREE.Vector3()
function sphereOffsets(radius) {
  const r = Math.max(1, Math.round(radius))
  const cached = state.brushCache.get(r)
  if (cached) return cached
  const out = []
  for (let x = -r; x <= r; x++)
    for (let y = -r; y <= r; y++)
      for (let z = -r; z <= r; z++)
        if ((x * x + y * y + z * z) <= (r + 0.01) * (r + 0.01)) out.push([x, y, z])
  state.brushCache.set(r, out)
  return out
}
function brushKeys(centerKey, hitPoint = null) {
  if (state.brushSize <= 1) return [centerKey]
  const [cx, cy, cz] = parseKey(centerKey); const out = []
  const rect = canvas.getBoundingClientRect()
  const dist = hitPoint ? camera.position.distanceTo(hitPoint) : camera.position.distanceTo(_scratchVec3A.set(cx, cy, cz))
  const worldPerPixel = 2 * Math.tan(THREE.MathUtils.degToRad(camera.fov * 0.5)) * dist / rect.height
  const radiusVoxels = Math.max(1, Math.round((state.brushSize * 14 * worldPerPixel) / 2))
  const offs = sphereOffsets(radiusVoxels)
  for (const o of offs) out.push(keyOf(cx + o[0], cy + o[1], cz + o[2]))
  return out
}
function setVoxel(key, color) {
  const c = color ?? hexToRgb(state.activeColor)
  const safe = {
    r: Number.isFinite(c?.r) ? c.r : 122,
    g: Number.isFinite(c?.g) ? c.g : 162,
    b: Number.isFinite(c?.b) ? c.b : 255
  }
  state.voxelMap.set(key, safe)
}
function setVoxelInLayer(layer, key, color) {
  ensureLayerIndex(layer)
  const c = color ?? hexToRgb(state.activeColor)
  const safe = {
    r: Number.isFinite(c?.r) ? c.r : 122,
    g: Number.isFinite(c?.g) ? c.g : 162,
    b: Number.isFinite(c?.b) ? c.b : 255
  }
  layer.voxelMap.set(key, safe)
  indexVoxelKey(layer, key)
  markDirtyChunksForVoxelKey(layer, key)
}
function deleteVoxelInLayer(layer, key) {
  ensureLayerIndex(layer)
  if (!layer.voxelMap.has(key)) return
  layer.voxelMap.delete(key)
  deindexVoxelKey(layer, key)
  markDirtyChunksForVoxelKey(layer, key)
}
function hexToRgb(h) {
  if (!h || typeof h !== 'string' || !h.startsWith('#') || h.length < 7) return { r: 122, g: 162, b: 255 }
  const n = Number.parseInt(h.slice(1), 16)
  if (!Number.isFinite(n)) return { r: 122, g: 162, b: 255 }
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 }
}
function neighbors(k) { const [x, y, z] = parseKey(k); return [[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]].map((d) => keyOf(x + d[0], y + d[1], z + d[2])) }

function ensureStrokeOverlayMeshes() {
  if (state.strokeOverlay.addInst && state.strokeOverlay.delInst) return
  const box = new THREE.BoxGeometry(1, 1, 1)
  const addMat = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.75, vertexColors: true, depthWrite: false })
  const delMat = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.28, color: 0xff3b5c, depthWrite: false })
  const addInst = new THREE.InstancedMesh(box, addMat, state.strokeOverlay.max)
  addInst.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(state.strokeOverlay.max * 3), 3)
  addInst.count = 0
  addInst.frustumCulled = true
  addInst.renderOrder = 998
  addInst.userData.__stroke = 'add'
  // Never let the stroke overlay intercept raycasts/picking.
  addInst.raycast = () => null

  const delInst = new THREE.InstancedMesh(box, delMat, state.strokeOverlay.max)
  delInst.count = 0
  delInst.frustumCulled = true
  delInst.renderOrder = 998
  delInst.userData.__stroke = 'del'
  delInst.raycast = () => null

  root.add(addInst)
  root.add(delInst)
  state.strokeOverlay.addInst = addInst
  state.strokeOverlay.delInst = delInst
}
function strokeOverlayReset() {
  ensureStrokeOverlayMeshes()
  state.strokeOverlay.active = false
  state.strokeOverlay.addKeyToIndex.clear()
  state.strokeOverlay.delKeyToIndex.clear()
  state.strokeOverlay.addCount = 0
  state.strokeOverlay.delCount = 0
  state.strokeOverlay.addInst.count = 0
  state.strokeOverlay.delInst.count = 0
  state.strokeOverlay.addInst.visible = false
  state.strokeOverlay.delInst.visible = false
  state.strokeOverlay.addInst.instanceMatrix.needsUpdate = true
  state.strokeOverlay.delInst.instanceMatrix.needsUpdate = true
  state.strokeOverlay.addInst.instanceColor.needsUpdate = true
}
function strokeOverlaySetAdd(key, color) {
  ensureStrokeOverlayMeshes()
  const inst = state.strokeOverlay.addInst
  const map = state.strokeOverlay.addKeyToIndex
  let i = map.get(key)
  if (i == null) {
    i = state.strokeOverlay.addCount
    if (i >= state.strokeOverlay.max) return
    map.set(key, i)
    state.strokeOverlay.addCount++
    inst.count = state.strokeOverlay.addCount
  }
  const [x, y, z] = parseKey(key)
  inst.setMatrixAt(i, _strokeMat4.makeTranslation(x, y, z))
  const cr = Math.max(0, Math.min(255, color?.r ?? 255)) / 255
  const cg = Math.max(0, Math.min(255, color?.g ?? 255)) / 255
  const cb = Math.max(0, Math.min(255, color?.b ?? 255)) / 255
  inst.instanceColor.setXYZ(i, cr, cg, cb)
  inst.instanceMatrix.needsUpdate = true
  inst.instanceColor.needsUpdate = true
}
function strokeOverlaySetDel(key) {
  ensureStrokeOverlayMeshes()
  const inst = state.strokeOverlay.delInst
  const map = state.strokeOverlay.delKeyToIndex
  let i = map.get(key)
  if (i == null) {
    i = state.strokeOverlay.delCount
    if (i >= state.strokeOverlay.max) return
    map.set(key, i)
    state.strokeOverlay.delCount++
    inst.count = state.strokeOverlay.delCount
  }
  const [x, y, z] = parseKey(key)
  inst.setMatrixAt(i, _strokeMat4.makeTranslation(x, y, z))
  inst.instanceMatrix.needsUpdate = true
}
const _strokeMat4 = new THREE.Matrix4()

function beginStrokeOps() {
  state.strokeOps = new Map()
  state.strokeOverlay.active = true
  ensureStrokeOverlayMeshes()
  state.strokeOverlay.addInst.visible = true
  state.strokeOverlay.delInst.visible = true
}
function queueStrokeOp(key, op, color = null) {
  if (!state.strokeOps) return
  state.strokeOps.set(key, op === 'set' ? { op: 'set', color } : { op: 'del' })
  if (op === 'set') strokeOverlaySetAdd(key, color)
  else strokeOverlaySetDel(key)
}
function effectiveVoxelExists(baseMap, key) {
  const o = state.strokeOps?.get(key)
  if (o?.op === 'del') return false
  if (o?.op === 'set') return true
  return baseMap.has(key)
}
function commitStrokeOps() {
  const ops = state.strokeOps
  state.strokeOps = null
  if (!ops || !ops.size) { strokeOverlayReset(); return }
  const layer = getActiveVoxelLayer()
  ensureLayerIndex(layer)
  const changedKeys = []
  for (const [k, o] of ops.entries()) {
    if (o.op === 'del') {
      if (layer.voxelMap.delete(k)) {
        deindexVoxelKey(layer, k)
        changedKeys.push(k)
      }
    } else {
      layer.voxelMap.set(k, o.color)
      indexVoxelKey(layer, k)
      changedKeys.push(k)
    }
  }
  syncStateVoxelMapToActiveLayer()
  // Dirty chunks: rebuild only the affected chunk(s) + neighbors.
  for (const k of changedKeys) markDirtyChunksForVoxelKey(layer, k)
  // Kick rebuild pipeline.
  processChunkRebuildQueue()
  // If outlines are enabled, we keep correctness by rebuilding outlines after the commit (not during stroke).
  const outlineOn = document.getElementById('toggleOutlineBtn')?.classList.contains('active')
  if (outlineOn) rebuildVoxelMesh()
  rebuildSelection()
  strokeOverlayReset()
}

function applyTool(hit, addMask = true) {
  if (!hit) return
  // Most tools operate on the active voxel layer (drawing target).
  // Some tools (bucket/picker) operate on the clicked layer.
  syncStateVoxelMapToActiveLayer()
  const c = hexToRgb(state.activeColor)
  const baseLayer = getActiveVoxelLayer()
  const baseMap = baseLayer?.voxelMap || state.voxelMap
  if (hit.type === 'floor' && (state.tool === 'voxelBrush' || state.tool === 'eraser')) {
    const gx = Math.floor(hit.point.x)
    const gy = 0
    const gz = Math.floor(hit.point.z)
    const floorKey = keyOf(gx, gy, gz)
    const keys = brushKeys(floorKey, hit.point)
    if (state.tool === 'voxelBrush') {
      for (const k of keys) {
        setVoxelInLayer(baseLayer, k, c)
      }
    } else {
      for (const k of keys) {
        deleteVoxelInLayer(baseLayer, k)
      }
    }
    syncStateVoxelMapToActiveLayer()
    processChunkRebuildQueue()
    return
  }
  if (hit.type !== 'voxel') return
  if (state.pointer.lastKey === hit.key && state.tool !== 'airBrush') return
  state.pointer.lastKey = hit.key
  if (state.tool === 'voxelBrush') {
    const [x, y, z] = parseKey(hit.key)
    const n = hit.normal.clone().round()
    const viewDir = new THREE.Vector3().subVectors(camera.position, hit.point).normalize()
    const facing = n.dot(viewDir)
    if (facing > 0.6) {
      const now = performance.now()
      if (state.pointer.lastForwardPlaceAt && now - state.pointer.lastForwardPlaceAt < 90) return
      state.pointer.lastForwardPlaceAt = now
    }
    const hoverArea = new Set(brushKeys(hit.key, hit.point))
    let overlapsLockedArea = false
    for (const k of hoverArea) {
      if (state.pointer.lockAreaKeys.has(k)) { overlapsLockedArea = true; break }
    }
    // Must leave the area before placing again.
    if (overlapsLockedArea) return
    const base = keyOf(x + n.x, y + n.y, z + n.z)
    for (const k of brushKeys(base, hit.point)) {
      setVoxelInLayer(baseLayer, k, c)
    }
    state.pointer.lockAreaKeys = hoverArea
    syncStateVoxelMapToActiveLayer()
    processChunkRebuildQueue()
  } else if (state.tool === 'eraser') {
    for (const k of brushKeys(hit.key, hit.point)) {
      deleteVoxelInLayer(baseLayer, k)
    }
    syncStateVoxelMapToActiveLayer()
    processChunkRebuildQueue()
  } else if (state.tool === 'paintBrush') {
    for (const k of brushKeys(hit.key, hit.point)) {
      if (!baseMap.has(k)) continue
      setVoxelInLayer(baseLayer, k, c)
    }
    syncStateVoxelMapToActiveLayer()
    processChunkRebuildQueue()
  } else if (state.tool === 'airBrush') {
    // Soft recolor with radial falloff (strongest at center).
    const [cx, cy, cz] = parseKey(hit.key)
    const keys = brushKeys(hit.key, hit.point)
    let maxD = 1
    for (const k of keys) {
      const [x, y, z] = parseKey(k)
      const d = Math.hypot(x - cx, y - cy, z - cz)
      if (d > maxD) maxD = d
    }
    const sigma = Math.max(0.75, maxD * 0.55)
    const strengthBase = 0.30
    for (const k of keys) {
      const cur = baseLayer.voxelMap.get(k)
      if (!cur) continue
      const [x, y, z] = parseKey(k)
      const d = Math.hypot(x - cx, y - cy, z - cz)
      const falloff = Math.exp(-(d * d) / (2 * sigma * sigma))
      const t = strengthBase * falloff
      baseLayer.voxelMap.set(k, {
        r: Math.round(cur.r + (c.r - cur.r) * t),
        g: Math.round(cur.g + (c.g - cur.g) * t),
        b: Math.round(cur.b + (c.b - cur.b) * t)
      })
      // mark dirty chunks for recolored voxels (surface faces only depend on occupancy, but colors need redraw)
      markDirtyChunksForVoxelKey(baseLayer, k)
    }
    syncStateVoxelMapToActiveLayer()
    processChunkRebuildQueue()
  } else if (state.tool === 'bucket') {
    // Recolor all voxels ON THIS LAYER that match the clicked voxel's color (not flood-fill).
    const layerId = hit.layerId || activeVoxelLayerId
    const layer = voxelLayers.find((l) => l.id === layerId) || getActiveVoxelLayer()
    const base = layer?.voxelMap?.get(hit.key)
    if (!base) return
    for (const [k, cc] of layer.voxelMap.entries()) {
      if (cc && cc.r === base.r && cc.g === base.g && cc.b === base.b) layer.voxelMap.set(k, { r: c.r, g: c.g, b: c.b })
    }
    if (layer.id === activeVoxelLayerId) syncStateVoxelMapToActiveLayer()
    rebuildLayerChunkIndex(layer)
    // many voxels recolored: easiest is full rebuild (still occupancy-same but chunk meshes need new colors)
    rebuildVoxelMesh()
  } else if (state.tool === 'picker') {
    // Pick from the clicked layer, not necessarily the active drawing layer.
    const layerId = hit.layerId || activeVoxelLayerId
    const layer = voxelLayers.find((l) => l.id === layerId) || getActiveVoxelLayer()
    const cc = layer?.voxelMap?.get(hit.key)
    if (cc) {
      state.activeColor = toHex(cc)
      document.getElementById('colorPicker').value = state.activeColor
    }
  }
}

function downloadBlob(blob, name) { const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; a.click(); URL.revokeObjectURL(a.href) }

function exportCub() {
  // Ensure chunk-mesh renderer is not the only source of truth.
  // Export from voxelMap (authoritative) and guarantee integer voxel coords.
  const vox = [...state.voxelMap.entries()].map(([k, c]) => {
    const p = parseKey(k).map((n) => Math.round(n))
    return { p, c }
  }); if (!vox.length) return
  const xs = vox.map((v) => v.p[0]), ys = vox.map((v) => v.p[1]), zs = vox.map((v) => v.p[2])
  const minX = Math.min(...xs), minY = Math.min(...ys), minZ = Math.min(...zs), maxX = Math.max(...xs), maxY = Math.max(...ys), maxZ = Math.max(...zs)
  const sx = maxX - minX + 1, sy = maxY - minY + 1, sz = maxZ - minZ + 1
  const data = new Uint8Array(12 + sx * sy * sz * 3), dv = new DataView(data.buffer)
  dv.setInt32(0, sx, true); dv.setInt32(4, sy, true); dv.setInt32(8, sz, true)
  const map = new Map(vox.map((v) => [keyOf(v.p[0] - minX, v.p[1] - minY, v.p[2] - minZ), v.c]))
  let o = 12; for (let z = 0; z < sz; z++) for (let y = 0; y < sy; y++) for (let x = 0; x < sx; x++) { const c = map.get(keyOf(x, y, z)); data[o++] = c?.r ?? 0; data[o++] = c?.g ?? 0; data[o++] = c?.b ?? 0 }
  downloadBlob(new Blob([data], { type: 'application/octet-stream' }), 'model.cub')
}
function makeCubBytesFromVoxelMap(voxelMap) {
  const vox = [...voxelMap.entries()].map(([k, c]) => {
    const p = parseKey(k).map((n) => Math.round(n))
    return { p, c }
  })
  if (!vox.length) return null
  const xs = vox.map((v) => v.p[0]), ys = vox.map((v) => v.p[1]), zs = vox.map((v) => v.p[2])
  const minX = Math.min(...xs), minY = Math.min(...ys), minZ = Math.min(...zs)
  const maxX = Math.max(...xs), maxY = Math.max(...ys), maxZ = Math.max(...zs)
  const sx = maxX - minX + 1, sy = maxY - minY + 1, sz = maxZ - minZ + 1
  const data = new Uint8Array(12 + sx * sy * sz * 3)
  const dv = new DataView(data.buffer)
  dv.setInt32(0, sx, true); dv.setInt32(4, sy, true); dv.setInt32(8, sz, true)
  const map = new Map(vox.map((v) => [keyOf(v.p[0] - minX, v.p[1] - minY, v.p[2] - minZ), v.c]))
  let o = 12
  for (let z = 0; z < sz; z++) for (let y = 0; y < sy; y++) for (let x = 0; x < sx; x++) {
    const c = map.get(keyOf(x, y, z))
    data[o++] = c?.r ?? 0
    data[o++] = c?.g ?? 0
    data[o++] = c?.b ?? 0
  }
  return data
}
function exportJson() { downloadBlob(new Blob([JSON.stringify({ voxels: [...state.voxelMap.entries()] }, null, 2)], { type: 'application/json' }), 'voxels.json') }
function exportVox() {
  const vox = [...state.voxelMap.entries()].map(([k, c]) => {
    const p = parseKey(k).map((n) => Math.round(n))
    return { p, c }
  }); if (!vox.length) return
  const xs = vox.map((v) => v.p[0]), ys = vox.map((v) => v.p[1]), zs = vox.map((v) => v.p[2])
  const minX = Math.min(...xs), minY = Math.min(...ys), minZ = Math.min(...zs), maxX = Math.max(...xs), maxY = Math.max(...ys), maxZ = Math.max(...zs)
  const sx = maxX - minX + 1, sy = maxY - minY + 1, sz = maxZ - minZ + 1
  const pal = [{ r: 0, g: 0, b: 0, a: 0 }], pi = new Map(), xyzis = []
  for (const v of vox) {
    const k = `${v.c.r},${v.c.g},${v.c.b}`; if (!pi.has(k)) { pi.set(k, Math.min(255, pal.length)); if (pal.length < 256) pal.push({ ...v.c, a: 255 }) }
    xyzis.push({ x: v.p[0] - minX, y: v.p[1] - minY, z: v.p[2] - minZ, i: pi.get(k) })
  }
  while (pal.length < 256) pal.push({ r: 0, g: 0, b: 0, a: 255 })
  const i32 = (vals) => { const b = new Uint8Array(vals.length * 4); const dv = new DataView(b.buffer); vals.forEach((v, i) => dv.setInt32(i * 4, v, true)); return b }
  const chunk = (id, content, child = new Uint8Array(0)) => { const b = new Uint8Array(12 + content.length + child.length); b.set([id.charCodeAt(0), id.charCodeAt(1), id.charCodeAt(2), id.charCodeAt(3)], 0); const dv = new DataView(b.buffer); dv.setInt32(4, content.length, true); dv.setInt32(8, child.length, true); b.set(content, 12); b.set(child, 12 + content.length); return b }
  const cat = (arr) => { const l = arr.reduce((s, a) => s + a.length, 0); const b = new Uint8Array(l); let o = 0; arr.forEach((a) => { b.set(a, o); o += a.length }); return b }
  const xy = new Uint8Array(4 + xyzis.length * 4); new DataView(xy.buffer).setInt32(0, xyzis.length, true); let o = 4; xyzis.forEach((v) => { xy[o++] = v.x; xy[o++] = v.y; xy[o++] = v.z; xy[o++] = v.i })
  const rgba = new Uint8Array(1024); pal.forEach((p, i) => { const q = i * 4; rgba[q] = p.r; rgba[q + 1] = p.g; rgba[q + 2] = p.b; rgba[q + 3] = p.a })
  const main = chunk('MAIN', new Uint8Array(0), cat([chunk('SIZE', i32([sx, sy, sz])), chunk('XYZI', xy), chunk('RGBA', rgba)]))
  const head = new Uint8Array(8); head.set([86, 79, 88, 32], 0); new DataView(head.buffer).setInt32(4, 150, true)
  downloadBlob(new Blob([cat([head, main])], { type: 'application/octet-stream' }), 'model.vox')
}
function buildVoxelGroup() {
  // Build a single merged geometry (much more reliable for exporters than thousands of meshes).
  const box = new THREE.BoxGeometry(1, 1, 1)
  const pos = []
  const col = []
  const idx = []
  let v = 0
  for (const [k, c] of state.voxelMap.entries()) {
    const [x, y, z] = parseKey(k).map((n) => Math.round(n))
    const cr = (c?.r ?? 255) / 255
    const cg = (c?.g ?? 255) / 255
    const cb = (c?.b ?? 255) / 255
    const pAttr = box.attributes.position
    for (let i = 0; i < pAttr.count; i++) {
      pos.push(pAttr.getX(i) + x, pAttr.getY(i) + y, pAttr.getZ(i) + z)
      col.push(cr, cg, cb)
    }
    const iAttr = box.index
    for (let i = 0; i < iAttr.count; i++) idx.push(iAttr.getX(i) + v)
    v += pAttr.count
  }
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3))
  geo.setIndex(idx)
  geo.computeVertexNormals()
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, metalness: 0.02 })
  const mesh = new THREE.Mesh(geo, mat)
  const g = new THREE.Group()
  g.add(mesh)
  return g
}
async function exportAny(fmt) {
  if (!state.voxelMap.size) return
  if (fmt === 'cub') return exportCub()
  if (fmt === 'json') return exportJson()
  if (fmt === 'vox') return exportVox()
  if (fmt === 'fbx') return alert('FBX export is not available in this build.')
  const g = buildVoxelGroup()
  if (fmt === 'stl') return downloadBlob(new Blob([new STLExporter().parse(g, { binary: true })], { type: 'model/stl' }), 'model.stl')
  if (fmt === 'obj') return downloadBlob(new Blob([new OBJExporter().parse(g)], { type: 'text/plain' }), 'model.obj')
  if (fmt === 'gltf' || fmt === 'glb') {
    const out = await new GLTFExporter().parseAsync(g, { binary: fmt === 'glb' })
    return downloadBlob(new Blob([fmt === 'glb' ? out : JSON.stringify(out, null, 2)], { type: fmt === 'glb' ? 'application/octet-stream' : 'model/gltf+json' }), `model.${fmt}`)
  }
}

function buildWorkspaceVoxelMapMerged() {
  // Merge voxel layers according to layerOrder (top layers overwrite bottom layers on overlap).
  // layerOrder is in UI order (top -> bottom). We want bottom-first so top overwrites.
  const merged = new Map()
  const ordered = allLayersList() // uses layerOrder
  for (let i = ordered.length - 1; i >= 0; i--) {
    const l = ordered[i]
    if (l.type !== 'voxel') continue
    const vl = voxelLayers.find((x) => x.id === l.id)
    if (!vl?.voxelMap?.size) continue
    for (const [k, c] of vl.voxelMap.entries()) merged.set(k, c)
  }
  return merged
}

async function exportScoped(scope, fmt) {
  const prev = state.voxelMap
  try {
    if (scope === 'workspace') {
      const merged = buildWorkspaceVoxelMapMerged()
      if (!merged.size) return
      state.voxelMap = merged
      return await exportAny(fmt)
    }

    // scope === 'layer'
    const targetId = (selectedLayer.type === 'voxel' && selectedLayer.id) ? selectedLayer.id : activeVoxelLayerId
    const layer = voxelLayers.find((l) => l.id === targetId) || getActiveVoxelLayer()
    if (!layer?.voxelMap?.size) return
    state.voxelMap = layer.voxelMap
    return await exportAny(fmt)
  } finally {
    state.voxelMap = prev
  }
}

function abToB64(ab) {
  const u8 = new Uint8Array(ab)
  let s = ''
  const CHUNK = 0x8000
  for (let i = 0; i < u8.length; i += CHUNK) s += String.fromCharCode(...u8.subarray(i, i + CHUNK))
  return btoa(s)
}
function b64ToAb(b64) {
  const bin = atob(b64 || '')
  const u8 = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i) & 255
  return u8.buffer
}
async function serializeModelToGlb(group) {
  const exporter = new GLTFExporter()
  const out = await exporter.parseAsync(group, { binary: true, embedImages: true })
  return out
}
function clearWorkspace() {
  // clear models
  for (const m of models) {
    try { root.remove(m.group) } catch {}
  }
  models = []
  activeModelId = null
  // clear voxels
  voxelLayers = []
  activeVoxelLayerId = null
  layerOrder = []
  selectedLayer = { type: null, id: null }
  state.selected.clear()
  rebuildVoxelMesh()
  rebuildSelection()
  rebuildLayersUI()
  transform.detach(); transform.visible = false; state.scaleMode = false
}
async function buildProjectObject() {
  const proj = {
    version: 1,
    layerOrder: layerOrder.map((l) => ({ type: l.type, id: l.id })),
    activeVoxelLayerId,
    activeModelId,
    voxelLayers: voxelLayers.map((l) => ({
      id: l.id,
      name: l.name,
      voxels: [...l.voxelMap.entries()].map(([k, c]) => [k, { r: c.r, g: c.g, b: c.b }])
    })),
    models: []
  }
  // serialize models to embedded glb so projects are self-contained
  for (const m of models) {
    if (m.archived) continue
    const glb = await serializeModelToGlb(m.group)
    proj.models.push({
      id: m.id,
      name: m.name,
      visible: m.group.visible,
      position: [m.group.position.x, m.group.position.y, m.group.position.z],
      rotation: [m.group.rotation.x, m.group.rotation.y, m.group.rotation.z, m.group.rotation.order],
      scale: [m.group.scale.x, m.group.scale.y, m.group.scale.z],
      glbB64: abToB64(glb)
    })
  }
  return proj
}
async function saveProject() {
  const proj = await buildProjectObject()
  const bytes = new TextEncoder().encode(JSON.stringify(proj))
  if (window.novaFS?.saveProject) {
    await window.novaFS.saveProject('project.nvsproj', bytes.buffer)
    return
  }
  downloadBlob(new Blob([bytes], { type: 'application/json' }), 'project.nvsproj')
}
function addModelGroupWithId(sceneObj, name, id) {
  const modelGroup = new THREE.Group()
  modelGroup.add(sceneObj)
  modelGroup.userData.isModelRoot = true
  modelGroup.userData.modelId = id
  root.add(modelGroup)
  modelGroup.traverse((o) => {
    if (o.isMesh && !o.material) o.material = new THREE.MeshStandardMaterial({ color: 0x9098aa, roughness: 0.85, metalness: 0.05 })
    if (o.isMesh) { o.castShadow = true; o.receiveShadow = true }
  })
  models.push({ id, name, group: modelGroup })
  return modelGroup
}
async function openProject() {
  if (!window.novaFS?.openProject) return
  const res = await window.novaFS.openProject()
  if (!res?.ok || !res.arrayBuffer) return
  let proj
  try { proj = JSON.parse(new TextDecoder().decode(new Uint8Array(res.arrayBuffer))) } catch { return }
  clearWorkspace()

  // restore voxels
  voxelLayers = (proj.voxelLayers || []).map((l) => ({
    id: l.id,
    name: l.name,
    voxelMap: new Map((l.voxels || []).map(([k, c]) => [k, c])),
    group: new THREE.Group(),
    chunkIndex: new Map(),
    render: { pivot: null, inner: null, chunks: new Map() }
  }))
  for (const l of voxelLayers) rebuildLayerChunkIndex(l)
  layerOrder = Array.isArray(proj.layerOrder) ? proj.layerOrder.map((l) => ({ type: l.type, id: l.id })) : []
  activeVoxelLayerId = proj.activeVoxelLayerId ?? (voxelLayers[0]?.id ?? null)
  ensureActiveVoxelLayer()
  syncStateVoxelMapToActiveLayer()

  // restore models
  const loader = new GLTFLoader()
  for (const m of (proj.models || [])) {
    const ab = b64ToAb(m.glbB64)
    const sceneObj = await new Promise((res2, rej2) => {
      loader.parse(ab, '', (g) => res2(g.scene), rej2)
    })
    const mg = addModelGroupWithId(sceneObj, m.name || 'model', m.id)
    if (Array.isArray(m.position)) mg.position.set(m.position[0] || 0, m.position[1] || 0, m.position[2] || 0)
    if (Array.isArray(m.rotation)) { mg.rotation.set(m.rotation[0] || 0, m.rotation[1] || 0, m.rotation[2] || 0); mg.rotation.order = m.rotation[3] || 'XYZ' }
    if (Array.isArray(m.scale)) mg.scale.set(m.scale[0] || 1, m.scale[1] || 1, m.scale[2] || 1)
    if (typeof m.visible === 'boolean') mg.visible = m.visible
  }
  activeModelId = proj.activeModelId ?? null

  state.undo = []
  state.redo = []
  rebuildVoxelMesh()
  rebuildSelection()
  rebuildLayersUI()
  rebuildToolState()
}

canvas.addEventListener('pointermove', (e) => {
  const anchor = state.pointer.resizeBrush ? { x: state.pointer.resizeStartX, y: e.clientY } : null
  hoveredScreenCircle(e, anchor)
  if (state.pointer.resizeBrush) {
    const delta = Math.round((e.clientX - state.pointer.resizeStartX) / 14)
    const n = Math.max(1, Math.min(16, state.pointer.resizeStartSize + delta))
    state.brushSize = n; document.getElementById('brushSize').value = String(n)
    return
  }
  if (!state.pointer.painting) return
  // When moving fast, the pointer can skip over voxels between events.
  // We interpolate in screen space and pick/apply along the segment.
  const lx = state.pointer.lastClientX
  const ly = state.pointer.lastClientY
  const curX = e.clientX
  const curY = e.clientY
  const doStep = (sx, sy) => {
    const hit = pickPaintAtClientXY(sx, sy)
    if (!hit) {
      if (state.tool === 'voxelBrush') state.pointer.lockAreaKeys = new Set()
      return
    }
    // Apply tool at the sampled screen-space position only.
    // (Do not "bridge" between voxel keys in voxel-space; that can create chords through tight curves.)
    if (hit.key && strokeVisited.has(hit.key) && state.tool !== 'airBrush') return
    if (hit.key) strokeVisited.add(hit.key)
    applyTool(hit, !state.shiftDown)
  }

  if (lx == null || ly == null) {
    doStep(curX, curY)
  } else {
    const dxp = curX - lx
    const dyp = curY - ly
    const dist = Math.hypot(dxp, dyp)
    const steps = Math.max(1, Math.min(64, Math.ceil(dist / 6))) // ~6px stride, capped
    for (let i = 1; i <= steps; i++) {
      const t = i / steps
      doStep(lx + dxp * t, ly + dyp * t)
    }
  }
  state.pointer.lastClientX = curX
  state.pointer.lastClientY = curY
})

canvas.addEventListener('pointerdown', (e) => {
  // Painting tools use a stricter picker so gizmos/models never block voxel hits.
  const hit = (state.tool === 'voxelBrush' || state.tool === 'eraser' || state.tool === 'paintBrush' || state.tool === 'airBrush' || state.tool === 'bucket' || state.tool === 'picker')
    ? pickPaint(e)
    : pick(e)
  // Brush resize (Ctrl+Alt+LMB) should win over Alt eyedropper.
  if (e.button === 0 && e.ctrlKey && e.altKey) {
    state.pointer.resizeBrush = true; state.pointer.resizeStartX = e.clientX; state.pointer.resizeStartSize = state.brushSize
    controls.enabled = false
    return
  }
  // Eyedropper: works either by holding Alt, or by selecting the picker tool and clicking.
  if (((e.altKey || state.pointer.altEyedropActive) || state.tool === 'picker') && !e.ctrlKey && e.button === 0) {
    if (hit?.type === 'voxel') {
      const layerId = hit.layerId || activeVoxelLayerId
      const layer = voxelLayers.find((l) => l.id === layerId) || getActiveVoxelLayer()
      const cc = layer?.voxelMap?.get(hit.key)
      if (cc) {
        state.activeColor = toHex(cc)
        document.getElementById('colorPicker').value = state.activeColor
      }
    }
    // If picker tool is selected, don't start a paint stroke.
    if (state.tool === 'picker') return
    // If this is Alt-hold eyedropper, also stop here.
    return
  }

  // Transform tools: selecting/moving/scaling/rotating layers (model or voxel).
  if (state.tool === 'select' || state.tool === 'rotate' || state.scaleMode) {
    // Use the more reliable transform-target picking logic so clicking near the gizmo/helper planes
    // doesn't accidentally select/deselect.
    const tHit = pickTransformTarget(e)
    if (tHit?.type === 'gizmo') return // keep selection; let TransformControls handle drag
    if (tHit?.type === 'model' && tHit.modelGroup) {
      // Select entire model layer by root group, but do NOT affect active voxel drawing layer.
      selectedLayer = { type: 'model', id: tHit.modelGroup.userData.modelId }
      setActiveModelByGroup(tHit.modelGroup)
      transform.visible = true
      if (state.scaleMode) transform.setMode('scale')
      else if (state.tool === 'rotate') transform.setMode('rotate')
      else transform.setMode('translate')
      transform.detach()
      transform.attach(tHit.modelGroup)
      rebuildLayersUI()
      return
    }
    if (!state.scaleMode && hit?.type === 'voxel' && hit.layerId) {
      // Select entire voxel layer by layerId (clicking any voxel in that layer).
      selectedLayer = { type: 'voxel', id: hit.layerId }
      attachVoxelLayerProxy(hit.layerId, state.tool === 'rotate' ? 'rotate' : 'translate')
      rebuildLayersUI()
      return
    }

    // Clicked empty space (or floor) => deselect transform target.
    selectedLayer = { type: null, id: null }
    activeModelId = null
    voxelTransformSession = null
    voxelProxySession = null
    voxelGizmoProxy.visible = false
    disposeVoxelGhost()
    transform.detach()
    transform.visible = false
    rebuildLayersUI()
    rebuildToolState()
    return
  }

  if (e.button !== 0) return
  if (hit?.type === 'voxel' || hit?.type === 'floor') {
    controls.enabled = false
    state.pointer.painting = true; state.pointer.lastKey = null; strokeVisited = new Set(); pushUndo()
    state.pointer.lastClientX = e.clientX
    state.pointer.lastClientY = e.clientY
    state.pointer.lockAreaKeys = new Set()
    applyTool(hit, !state.shiftDown)
  } else controls.enabled = true
})

window.addEventListener('pointerup', () => {
  const wasPainting = state.pointer.painting
  state.pointer.painting = false
  state.pointer.lockAreaKeys = new Set()
  state.pointer.lastClientX = null
  state.pointer.lastClientY = null
  // nothing special on stroke end; chunks are rebuilt incrementally while painting
  if (state.pointer.resizeBrush) state.pointer.resizeBrush = false
  if (state.pointer.prevTool && !state.pointer.altEyedropActive) { state.tool = state.pointer.prevTool; state.pointer.prevTool = null; rebuildToolState() }
  controls.enabled = true
})
canvas.addEventListener('contextmenu', (e) => e.preventDefault())

document.getElementById('fileInput').setAttribute('multiple', 'multiple')
document.getElementById('fileInput').onchange = async (e) => {
  const files = [...(e.target.files || [])]
  if (!files.length) return
  for (const f of files) await loadFile(f)
}
document.getElementById('fileInput').addEventListener('click', (e) => { e.target.value = '' })
const canvasWrap = document.querySelector('.canvasWrap')
;['dragenter','dragover'].forEach((t) => canvasWrap.addEventListener(t, (e) => {
  e.preventDefault()
  canvasWrap.classList.add('dragging')
}))
;['dragleave','dragend','drop'].forEach((t) => canvasWrap.addEventListener(t, (e) => {
  e.preventDefault()
  canvasWrap.classList.remove('dragging')
}))
canvasWrap.addEventListener('drop', async (e) => {
  e.preventDefault()
  canvasWrap.classList.remove('dragging')
  const files = [...(e.dataTransfer?.files || [])]
  for (const f of files) await loadFile(f)
})

function closeMenus() {
  document.getElementById('fileMenu')?.classList.add('hidden')
  document.getElementById('settingsMenu')?.classList.add('hidden')
  document.getElementById('helpMenu')?.classList.add('hidden')
  document.getElementById('exportLayerSubMenu')?.classList.add('hidden')
  document.getElementById('exportWorkspaceSubMenu')?.classList.add('hidden')
}
function toggleMenu(id) {
  const m = document.getElementById(id)
  if (!m) return
  const willOpen = m.classList.contains('hidden')
  closeMenus()
  if (willOpen) m.classList.remove('hidden')
}
document.getElementById('fileMenuBtn').onclick = (e) => { e.stopPropagation(); toggleMenu('fileMenu') }
document.getElementById('settingsMenuBtn').onclick = (e) => { e.stopPropagation(); toggleMenu('settingsMenu') }
document.getElementById('helpMenuBtn').onclick = (e) => { e.stopPropagation(); toggleMenu('helpMenu') }
document.getElementById('menuOpenProjectBtn').onclick = async () => { closeMenus(); await openProject() }
document.getElementById('menuNewProjectBtn').onclick = async () => {
  closeMenus()
  if (!confirm('Start a new project? (This will clear the current workspace)')) return
  pushUndo()
  clearWorkspace()
}
document.getElementById('menuSaveProjectBtn').onclick = async () => { closeMenus(); await saveProject() }
document.getElementById('menuImportBtn').onclick = () => { closeMenus(); document.getElementById('fileInput').click() }
document.getElementById('menuExportLayerBtn').onclick = (e) => {
  e.stopPropagation()
  const sub = document.getElementById('exportLayerSubMenu')
  if (!sub) return
  sub.classList.toggle('hidden')
}
document.getElementById('menuExportWorkspaceBtn').onclick = (e) => {
  e.stopPropagation()
  const sub = document.getElementById('exportWorkspaceSubMenu')
  if (!sub) return
  sub.classList.toggle('hidden')
}
document.querySelectorAll('[data-export-fmt]').forEach((b) => b.addEventListener('click', (e) => {
  e.stopPropagation()
  const fmt = e.currentTarget?.dataset?.exportFmt
  const scope = e.currentTarget?.dataset?.exportScope || 'layer'
  if (!fmt) return
  closeMenus()
  exportScoped(scope, fmt)
}))
document.getElementById('settingsThemeBtn').onclick = () => { setTheme(state.theme === 'dark' ? 'light' : 'dark'); closeMenus() }
document.getElementById('settingsShortcutsBtn').onclick = () => { closeMenus(); openShortcutModal() }
document.getElementById('settingsHslBtn').onclick = () => { closeMenus(); openHslWindow() }
window.addEventListener('click', () => closeMenus())

document.querySelectorAll('[data-tool]').forEach((b) => b.onclick = () => {
  const t = b.dataset.tool
  if (t === 'scale') {
    state.scaleMode = true
    state.tool = 'scale'
  } else {
    state.scaleMode = false
    state.tool = t
  }
  rebuildToolState()
})
// Voxelize is now per-model-layer (button in the layer row). No global voxelize button.
document.getElementById('snapFloorBtn').onclick = () => {
  // Snap either the selected model layer OR selected/active voxel layer to the floor (y=0).
  // Keep this undoable.
  pushUndo()

  if (selectedLayer.type === 'voxel') {
    const layer = voxelLayers.find((l) => l.id === selectedLayer.id) || getActiveVoxelLayer()
    if (!layer?.voxelMap?.size) return
    let minY = Infinity
    for (const k of layer.voxelMap.keys()) {
      const y = parseKey(k)[1]
      if (y < minY) minY = y
    }
    if (!Number.isFinite(minY)) return
    const dy = -minY
    if (dy === 0) return
    const out = new Map()
    for (const [k, c] of layer.voxelMap.entries()) {
      const [x, y, z] = parseKey(k)
      out.set(keyOf(x, y + dy, z), c)
    }
    layer.voxelMap = out
    if (layer.id === activeVoxelLayerId) syncStateVoxelMapToActiveLayer()
    rebuildVoxelMesh()
    rebuildSelection()
    rebuildLayersUI()
    return
  }

  if (!models.length) return
  const mg = (selectedLayer.type === 'model')
    ? (models.find((m) => m.id === selectedLayer.id)?.group ?? null)
    : (getActiveModelGroup() || models[0].group)
  if (!mg) return
  mg.updateMatrixWorld(true)
  const box = new THREE.Box3().setFromObject(mg)
  const dy = 0 - box.min.y
  if (dy === 0) return
  mg.position.y += dy
  mg.updateMatrixWorld(true)
}
document.getElementById('brushSize').onchange = (e) => state.brushSize = Number(e.target.value)
document.getElementById('colorPicker').oninput = (e) => { state.activeColor = e.target.value }
document.getElementById('savePalette').onclick = () => { if (!palette.includes(state.activeColor)) { palette.push(state.activeColor); drawPalette() } }
document.getElementById('topUndoBtn').onclick = undo
document.getElementById('topRedoBtn').onclick = redo
document.getElementById('addLayerBtn').onclick = () => {
  const id = `v_${Math.random().toString(36).slice(2, 10)}`
  voxelLayers.push({ id, name: `Voxel Layer ${voxelLayers.length + 1}`, voxelMap: new Map(), group: new THREE.Group() })
  layerOrder.push({ type: 'voxel', id })
  activeVoxelLayerId = id
  syncStateVoxelMapToActiveLayer()
  rebuildVoxelMesh()
  rebuildLayersUI()
}
function removeSelectedLayerOrModel() {
  // Remove selected layer (voxel or model). If nothing selected, remove active voxel layer.
  if (selectedLayer.type === 'model' && selectedLayer.id) {
    const idx = models.findIndex((m) => m.id === selectedLayer.id)
    if (idx < 0) return
    root.remove(models[idx].group)
    models.splice(idx, 1)
    layerOrder = layerOrder.filter((l) => !(l.type === 'model' && l.id === selectedLayer.id))
    if (activeModelId === selectedLayer.id) activeModelId = models[0]?.id ?? null
    selectedLayer = { type: null, id: null }
    transform.detach(); transform.visible = false
    rebuildLayersUI()
    rebuildToolState()
    return
  }
  const targetId = (selectedLayer.type === 'voxel' && selectedLayer.id) ? selectedLayer.id : activeVoxelLayerId
  if (!targetId) return
  const idx = voxelLayers.findIndex((l) => l.id === targetId)
  if (idx < 0) return
  voxelLayers.splice(idx, 1)
  layerOrder = layerOrder.filter((l) => !(l.type === 'voxel' && l.id === targetId))
  if (activeVoxelLayerId === targetId) activeVoxelLayerId = voxelLayers[0]?.id ?? null
  if (selectedLayer.id === targetId) { selectedLayer = { type: null, id: null }; transform.detach(); transform.visible = false }
  ensureActiveVoxelLayer()
  syncStateVoxelMapToActiveLayer()
  rebuildVoxelMesh()
  rebuildLayersUI()
  rebuildToolState()
}

function copySelectedLayerToClipboard() {
  if (!selectedLayer?.type || !selectedLayer?.id) return
  if (selectedLayer.type === 'voxel') {
    const layer = voxelLayers.find((l) => l.id === selectedLayer.id)
    if (!layer) return
    state.layerClipboard = {
      type: 'voxel',
      name: layer.name,
      voxels: [...layer.voxelMap.entries()].map(([k, c]) => [k, { r: c.r, g: c.g, b: c.b }])
    }
  } else if (selectedLayer.type === 'model') {
    const layer = models.find((m) => m.id === selectedLayer.id)
    if (!layer) return
    state.layerClipboard = {
      type: 'model',
      name: layer.name,
      // We can’t serialize source formats; just clone the scene graph.
      cloneGroup: layer.group
    }
  }
}

function pasteLayerFromClipboard() {
  const clip = state.layerClipboard
  if (!clip?.type) return
  pushUndo()
  if (clip.type === 'voxel') {
    const id = `v_${Math.random().toString(36).slice(2, 10)}`
    const vm = new Map(clip.voxels.map(([k, c]) => [k, c]))
    // Paste nudged horizontally so it doesn't overlap.
    const nudged = new Map()
    for (const [k, c] of vm.entries()) {
      const [x, y, z] = parseKey(k)
      nudged.set(keyOf(x + 8, y, z), c)
    }
    const nameBase = (clip.name || 'Voxel Layer Copy')
    voxelLayers.push({ id, name: nameBase, voxelMap: nudged, group: new THREE.Group() })
    layerOrder.push({ type: 'voxel', id })
    selectedLayer = { type: 'voxel', id }
    rebuildVoxelMesh()
    rebuildLayersUI()
    rebuildToolState()
    return
  }
  if (clip.type === 'model') {
    const srcGroup = clip.cloneGroup
    if (!srcGroup) return
    const id = `m_${Math.random().toString(36).slice(2, 10)}`
    const g = srcGroup.clone(true)
    g.userData.isModelRoot = true
    g.userData.modelId = id
    g.position.x += 8
    root.add(g)
    const nameBase = (clip.name || 'Model Copy')
    models.push({ id, name: nameBase, group: g })
    layerOrder.push({ type: 'model', id })
    selectedLayer = { type: 'model', id }
    activeModelId = id
    rebuildLayersUI()
    rebuildToolState()
  }
}
document.getElementById('removeLayerBtn').onclick = () => removeSelectedLayerOrModel()
document.getElementById('mergeLayerBtn').onclick = () => {
  // Merge the selected layer DOWN into the next layer below it (same type only).
  // This matches "merge below" behavior and respects your layer ordering.
  const srcType = selectedLayer.type
  const srcId = selectedLayer.id
  if (!srcType || !srcId) return
  const srcKey = `${srcType}:${srcId}`
  const srcIdx = layerOrder.findIndex((l) => `${l.type}:${l.id}` === srcKey)
  if (srcIdx < 0) return
  let dstEntry = null
  for (let i = srcIdx + 1; i < layerOrder.length; i++) {
    if (layerOrder[i].type === srcType) { dstEntry = layerOrder[i]; break }
  }
  if (!dstEntry) return

  if (srcType === 'voxel') {
    const src = voxelLayers.find((l) => l.id === srcId)
    const dst = voxelLayers.find((l) => l.id === dstEntry.id)
    if (!src || !dst) return
    pushUndo()
    for (const [k, c] of src.voxelMap.entries()) dst.voxelMap.set(k, c)
    voxelLayers = voxelLayers.filter((l) => l.id !== src.id)
    layerOrder = layerOrder.filter((l) => !(l.type === 'voxel' && l.id === src.id))
    if (activeVoxelLayerId === src.id) activeVoxelLayerId = dst.id
    if (selectedLayer.id === src.id) selectedLayer = { type: 'voxel', id: dst.id }
    syncStateVoxelMapToActiveLayer()
    rebuildVoxelMesh()
    rebuildLayersUI()
    rebuildToolState()
    return
  }

  if (srcType === 'model') {
    const src = models.find((m) => m.id === srcId)
    const dst = models.find((m) => m.id === dstEntry.id)
    if (!src || !dst) return
    pushUndo()
    src.group.updateMatrixWorld(true)
    dst.group.updateMatrixWorld(true)
    const invDstWorld = new THREE.Matrix4().copy(dst.group.matrixWorld).invert()
    const srcWorld = new THREE.Matrix4().copy(src.group.matrixWorld)
    const srcToDst = new THREE.Matrix4().multiplyMatrices(invDstWorld, srcWorld)
    const children = [...src.group.children]
    for (const ch of children) {
      ch.applyMatrix4(srcToDst)
      dst.group.add(ch)
    }
    root.remove(src.group)
    models = models.filter((m) => m.id !== src.id)
    layerOrder = layerOrder.filter((l) => !(l.type === 'model' && l.id === src.id))
    if (activeModelId === src.id) activeModelId = dst.id
    if (selectedLayer.id === src.id) selectedLayer = { type: 'model', id: dst.id }
    rebuildLayersUI()
    rebuildToolState()
  }
}
document.getElementById('toggleShadowsBtn').onclick = () => {
  shadowsEnabled = !shadowsEnabled
  const on = shadowsEnabled
  document.getElementById('toggleShadowsBtn').classList.toggle('active', on)
  renderer.shadowMap.enabled = on
  d.castShadow = on
  ground.receiveShadow = on
  for (const m of models) m.group.traverse((o) => { if (o.isMesh) { o.castShadow = on; o.receiveShadow = on } })
  if (voxelGroup) voxelGroup.traverse((o) => { if (o.isMesh) { o.castShadow = on; o.receiveShadow = on } })
  if (voxelMesh) { voxelMesh.castShadow = on; voxelMesh.receiveShadow = on }
}
document.getElementById('toggleOutlineBtn').onclick = () => { document.getElementById('toggleOutlineBtn').classList.toggle('active'); rebuildVoxelMesh() }
document.getElementById('toggleShaderBtn').onclick = () => {
  shaderEnabled = !shaderEnabled
  document.getElementById('toggleShaderBtn').classList.toggle('active', shaderEnabled)
  for (const mm of models) {
    mm.group.traverse((o) => {
      if (!o.isMesh) return
      const col = o.material?.color ? o.material.color.clone() : new THREE.Color(0x9098aa)
      const map = o.material?.map || null
      o.material = shaderEnabled
        ? new THREE.MeshStandardMaterial({ color: col, map, roughness: 0.85, metalness: 0.05 })
        : new THREE.MeshBasicMaterial({ color: col, map })
      o.castShadow = shadowsEnabled
      o.receiveShadow = shadowsEnabled
    })
  }
  rebuildVoxelMesh()
}

function openShortcutModal() {
  const modal = document.getElementById('shortcutModal')
  modal.className = 'modal'
  // Only show supported shortcuts. (Old saved configs may have wand/mask keys; hide them.)
  const allowedKeys = Object.keys(DEFAULT_SHORTCUTS)
  const label = (k) => {
    if (k === 'eyedropHoldAlt') return 'eyedrop (hold)'
    if (k === 'select') return 'move'
    return k
  }
  modal.innerHTML = `<div class="modalCard"><h3>Keyboard Shortcuts</h3>${
    allowedKeys.map((k) => `<div class="scRow"><span>${label(k)}</span><input data-k="${k}" value="${state.shortcuts[k] ?? DEFAULT_SHORTCUTS[k]}"></div>`).join('')
  }<div class="row"><button id="saveShortcuts">Save</button><button id="closeShortcuts">Close</button></div></div>`
  modal.querySelector('#closeShortcuts').onclick = () => modal.className = 'modal hidden'
  modal.querySelector('#saveShortcuts').onclick = () => {
    modal.querySelectorAll('input[data-k]').forEach((i) => state.shortcuts[i.dataset.k] = i.value.trim().toLowerCase())
    localStorage.setItem('nova.shortcuts', JSON.stringify(state.shortcuts))
    modal.className = 'modal hidden'
  }
}

function openHslWindow() {
  const win = document.getElementById('hslWindow')
  if (!win) return

  const targetId = (selectedLayer.type === 'voxel' && selectedLayer.id) ? selectedLayer.id : activeVoxelLayerId
  const layer = voxelLayers.find((l) => l.id === targetId) || getActiveVoxelLayer()
  if (!layer?.voxelMap?.size) return

  // Snapshot for cancel/revert (do not mutate this map).
  const original = new Map([...layer.voxelMap.entries()].map(([k, c]) => [k, { r: c.r, g: c.g, b: c.b }]))
  const undoSnap = makeSnapshot()

  state.uiTyping = true
  win.classList.remove('hidden')
  win.style.left = '60px'
  win.style.top = '80px'
  win.innerHTML = `
    <div class="hslHeader" id="hslHeader">
      <button class="hslCloseBtn" id="hslCloseX" title="Close (discard)">×</button>
      <div class="hslTitle">Hue / Saturation / Luminosity</div>
      <div style="width:30px;height:30px;"></div>
    </div>
    <div class="hslBody">
      <div class="assetHint" style="margin-bottom:10px;">Live preview on: <b>${escapeHtml(layer.name || 'Layer')}</b></div>
      <div class="scRow"><span>Hue</span><input id="hslHue" type="range" min="-180" max="180" value="0"></div>
      <div class="scRow"><span>Saturation</span><input id="hslSat" type="range" min="-100" max="100" value="0"></div>
      <div class="scRow"><span>Luminosity</span><input id="hslLum" type="range" min="-100" max="100" value="0"></div>
      <div class="row" style="justify-content:flex-end;margin-top:10px;">
        <button id="hslOkBtn">OK</button>
      </div>
    </div>
  `

  // Draggable window.
  const header = win.querySelector('#hslHeader')
  let dragging = false, dragOffX = 0, dragOffY = 0
  const onMove = (e) => {
    if (!dragging) return
    win.style.left = `${Math.max(0, e.clientX - dragOffX)}px`
    win.style.top = `${Math.max(0, e.clientY - dragOffY)}px`
  }
  const onUp = () => { dragging = false; window.removeEventListener('pointermove', onMove); window.removeEventListener('pointerup', onUp) }
  header?.addEventListener('pointerdown', (e) => {
    e.preventDefault()
    e.stopPropagation()
    dragging = true
    const r = win.getBoundingClientRect()
    dragOffX = e.clientX - r.left
    dragOffY = e.clientY - r.top
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp, { once: true })
  })

  // Live preview: recompute immediately on slider change (slow on massive layers, but accurate).
  const col = new THREE.Color()
  let modified = false
  let raf = 0
  const applyPreview = () => {
    raf = 0
    const hue = Number(win.querySelector('#hslHue')?.value || 0)
    const sat = Number(win.querySelector('#hslSat')?.value || 0)
    const lum = Number(win.querySelector('#hslLum')?.value || 0)
    const hDelta = hue / 360
    const sMul = 1 + sat / 100
    const lMul = 1 + lum / 100

    for (const [k, c] of original.entries()) {
      col.setRGB((c.r ?? 0) / 255, (c.g ?? 0) / 255, (c.b ?? 0) / 255)
      const hsl = { h: 0, s: 0, l: 0 }
      col.getHSL(hsl)
      hsl.h = (hsl.h + hDelta) % 1
      if (hsl.h < 0) hsl.h += 1
      hsl.s = Math.max(0, Math.min(1, hsl.s * sMul))
      hsl.l = Math.max(0, Math.min(1, hsl.l * lMul))
      col.setHSL(hsl.h, hsl.s, hsl.l)
      layer.voxelMap.set(k, { r: Math.round(col.r * 255), g: Math.round(col.g * 255), b: Math.round(col.b * 255) })
    }
    modified = true
    if (layer.id === activeVoxelLayerId) syncStateVoxelMapToActiveLayer()
    rebuildVoxelMesh()
  }
  const schedule = () => {
    if (raf) return
    raf = requestAnimationFrame(applyPreview)
  }
  ;['hslHue', 'hslSat', 'hslLum'].forEach((id) => win.querySelector(`#${id}`)?.addEventListener('input', schedule))

  const cleanup = () => {
    state.uiTyping = false
    win.classList.add('hidden')
    win.innerHTML = ''
    if (raf) cancelAnimationFrame(raf)
    raf = 0
  }
  const revert = () => {
    layer.voxelMap = new Map([...original.entries()].map(([k, c]) => [k, { r: c.r, g: c.g, b: c.b }]))
    if (layer.id === activeVoxelLayerId) syncStateVoxelMapToActiveLayer()
    rebuildVoxelMesh()
  }

  win.querySelector('#hslCloseX')?.addEventListener('click', (e) => {
    e.stopPropagation()
    revert()
    cleanup()
  })

  win.querySelector('#hslOkBtn')?.addEventListener('click', (e) => {
    e.stopPropagation()
    if (modified) {
      // Treat the whole slider session as one operation.
      state.undo.push(undoSnap)
      if (state.undo.length > 50) state.undo.shift()
      state.redo = []

      // Bake final colors once.
      const hue = Number(win.querySelector('#hslHue')?.value || 0)
      const sat = Number(win.querySelector('#hslSat')?.value || 0)
      const lum = Number(win.querySelector('#hslLum')?.value || 0)
      const hDelta = hue / 360
      const sMul = 1 + sat / 100
      const lMul = 1 + lum / 100
      for (const [k, c] of original.entries()) {
        col.setRGB((c.r ?? 0) / 255, (c.g ?? 0) / 255, (c.b ?? 0) / 255)
        const hsl = { h: 0, s: 0, l: 0 }
        col.getHSL(hsl)
        hsl.h = (hsl.h + hDelta) % 1
        if (hsl.h < 0) hsl.h += 1
        hsl.s = Math.max(0, Math.min(1, hsl.s * sMul))
        hsl.l = Math.max(0, Math.min(1, hsl.l * lMul))
        col.setHSL(hsl.h, hsl.s, hsl.l)
        layer.voxelMap.set(k, { r: Math.round(col.r * 255), g: Math.round(col.g * 255), b: Math.round(col.b * 255) })
      }
      if (layer.id === activeVoxelLayerId) syncStateVoxelMapToActiveLayer()
    }
    cleanup()
  })

  // Keep hotkeys from firing while interacting with this window.
  win.addEventListener('keydown', (e) => e.stopPropagation())
  win.addEventListener('pointerdown', (e) => e.stopPropagation())
}

function combo(e) { const p = []; if (e.ctrlKey) p.push('ctrl'); if (e.shiftKey) p.push('shift'); if (e.altKey) p.push('alt'); p.push(e.key.toLowerCase()); return p.join('+') }
window.addEventListener('keydown', (e) => {
  // When typing in an inline text field (layer rename, shortcut editor, etc) do not let hotkeys affect tools.
  const ae = document.activeElement
  const isTextEntry = state.uiTyping || (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.isContentEditable))
  if (isTextEntry) {
    // Allow Escape to close menus or cancel typing handlers attached to the input itself.
    if (e.key !== 'Escape') return
  }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c') {
    e.preventDefault()
    copySelectedLayerToClipboard()
    return
  }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'v') {
    e.preventDefault()
    pasteLayerFromClipboard()
    return
  }
  if (e.key === 'Delete') {
    e.preventDefault()
    removeSelectedLayerOrModel()
    return
  }
  state.shiftDown = e.shiftKey
  if (e.key === 'Alt' && !state.pointer.altEyedropActive && !e.ctrlKey) {
    state.pointer.altEyedropActive = true
    if (state.tool !== 'picker') {
      state.pointer.prevTool = state.tool
      state.tool = 'picker'
      rebuildToolState()
    }
  }
  // If Alt was held first (activating eyedrop) and then Ctrl is pressed for Ctrl+Alt brush-resize,
  // force the circle cursor and disable the temporary eyedropper state.
  if ((e.key === 'Control' || e.key === 'Meta') && state.pointer.altEyedropActive) {
    state.pointer.altEyedropActive = false
    if (state.pointer.prevTool) {
      state.tool = state.pointer.prevTool
      state.pointer.prevTool = null
      rebuildToolState()
    }
  }
  const c = combo(e)
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); saveProject(); return }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !e.shiftKey) { e.preventDefault(); return undo() }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && e.shiftKey) { e.preventDefault(); return redo() }
  if (e.key === 'F1') {
    e.preventDefault()
    const bar = document.getElementById('topMenuBar')
    if (bar) bar.classList.toggle('hidden')
    closeMenus()
    return
  }
  if (c === state.shortcuts.scale && models.length) {
    e.preventDefault()
    state.scaleMode = !state.scaleMode
    if (state.scaleMode) {
      state.tool = 'scale'
      transform.setMode('scale')
      const mg = getActiveModelGroup()
      if (mg) transform.attach(mg)
      transform.visible = true
      rebuildToolState()
    }
    else { transform.detach(); transform.visible = false }
    return
  }
  const m = {
    [state.shortcuts.select]: 'select',
    [state.shortcuts.rotate]: 'rotate',
    [state.shortcuts.voxelBrush]: 'voxelBrush', [state.shortcuts.paintBrush]: 'paintBrush',
    [state.shortcuts.airBrush]: 'airBrush', [state.shortcuts.eraser]: 'eraser',
    [state.shortcuts.bucket]: 'bucket'
  }
  if (m[c]) { e.preventDefault(); state.tool = m[c]; state.scaleMode = false; rebuildToolState() }
})
window.addEventListener('keyup', (e) => {
  state.shiftDown = e.shiftKey
  if (e.key === 'Alt') {
    state.pointer.altEyedropActive = false
    if (state.pointer.prevTool) {
      state.tool = state.pointer.prevTool
      state.pointer.prevTool = null
      rebuildToolState()
    }
  }
})

function animate() {
  requestAnimationFrame(animate)
  controls.update()
  updateChunkVisibility()
  if (state.chunkRebuild.queue.length) processChunkRebuildQueue()
  renderer.render(scene, camera)
}
animate()

// Asset Viewer
const assetState = {
  root: localStorage.getItem('nova.assetRoot') || '',
  query: '',
  dbFiles: [],
  selectedDb: null,
  selectedKey: null,
  keys: []
}
const assetPanel = document.getElementById('assetPanel')
const assetSearch = document.getElementById('assetSearch')
const assetPickRoot = document.getElementById('assetPickRoot')
const assetBackupBtn = document.getElementById('assetBackupBtn')
const assetList = document.getElementById('assetList')
const assetRootLabel = document.getElementById('assetRootLabel')
const assetPreviewCanvas = document.getElementById('assetPreview')
const assetPreviewLabel = document.getElementById('assetPreviewLabel')
const assetBackBtn = document.getElementById('assetBackBtn')

const apRenderer = new THREE.WebGLRenderer({ canvas: assetPreviewCanvas, antialias: true, alpha: true })
apRenderer.setPixelRatio(Math.min(2, devicePixelRatio))
const apScene = new THREE.Scene()
apScene.background = new THREE.Color(0x0f1420)
const apCamera = new THREE.PerspectiveCamera(55, 1, 0.1, 2000)
apCamera.position.set(28, 20, 28)
const apControls = new OrbitControls(apCamera, assetPreviewCanvas)
apControls.enablePan = false
apControls.enableZoom = true
apControls.enableDamping = true
apControls.dampingFactor = 0.08
apControls.rotateSpeed = 0.7
const apLight = new THREE.DirectionalLight(0xffffff, 0.95)
apLight.position.set(24, 42, 18)
apScene.add(new THREE.AmbientLight(0xffffff, 0.55))
apScene.add(apLight)
let apMesh = null
function fitAssetPreview() {
  const w = assetPreviewCanvas.clientWidth, h = assetPreviewCanvas.clientHeight
  apRenderer.setSize(w, h, false)
  apCamera.aspect = w / h
  apCamera.updateProjectionMatrix()
}
new ResizeObserver(fitAssetPreview).observe(assetPreviewCanvas)
fitAssetPreview()
function apRender() { apRenderer.render(apScene, apCamera) }
function apAnimate() {
  requestAnimationFrame(apAnimate)
  apControls.update()
  apRender()
}
apAnimate()

function parseCubToVoxelMap(arrayBuffer) {
  const dv = new DataView(arrayBuffer)
  if (arrayBuffer.byteLength < 12) throw new Error('Invalid .cub')
  const sx = dv.getInt32(0, true), sy = dv.getInt32(4, true), sz = dv.getInt32(8, true)
  const expected = 12 + sx * sy * sz * 3
  if (sx <= 0 || sy <= 0 || sz <= 0 || arrayBuffer.byteLength < expected) throw new Error('Invalid .cub')
  const vox = new Map()
  let o = 12
  const ox = Math.floor(sx / 2), oy = 0, oz = Math.floor(sz / 2)
  for (let z = 0; z < sz; z++) for (let y = 0; y < sy; y++) for (let x = 0; x < sx; x++) {
    const r = dv.getUint8(o++), g = dv.getUint8(o++), b = dv.getUint8(o++)
    if (r === 0 && g === 0 && b === 0) continue
    vox.set(keyOf(x - ox, y - oy, z - oz), { r, g, b })
  }
  return { sx, sy, sz, vox }
}

function buildPreviewMesh(voxelMap, maxVoxels = 18000) {
  const box = new THREE.BoxGeometry(1, 1, 1)
  const pos = []
  const col = []
  const idx = []
  let v = 0
  const entries = [...voxelMap.entries()]
  const step = Math.max(1, Math.ceil(entries.length / maxVoxels))
  for (let ei = 0; ei < entries.length; ei += step) {
    const [k, c] = entries[ei]
    const [x, y, z] = parseKey(k)
    const cr = (c?.r ?? 255) / 255
    const cg = (c?.g ?? 255) / 255
    const cb = (c?.b ?? 255) / 255
    const pAttr = box.attributes.position
    for (let i = 0; i < pAttr.count; i++) {
      pos.push(pAttr.getX(i) + x, pAttr.getY(i) + y, pAttr.getZ(i) + z)
      col.push(cr, cg, cb)
    }
    const iAttr = box.index
    for (let i = 0; i < iAttr.count; i++) idx.push(iAttr.getX(i) + v)
    v += pAttr.count
  }
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3))
  geo.setIndex(idx)
  geo.computeVertexNormals()
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0.02 })
  const mesh = new THREE.Mesh(geo, mat)
  mesh.castShadow = false
  mesh.receiveShadow = false
  return mesh
}

async function refreshAssetList() {
  if (!window.novaFS) {
    assetRootLabel.textContent = 'Root: (asset browser needs Electron restart)'
    assetList.innerHTML = '<div class="assetHint">Restart the app to enable asset browser.</div>'
    return
  }
  assetRootLabel.textContent = assetState.root ? `Root: ${assetState.root}` : 'Root: (not set)'
  assetList.innerHTML = '<div class="assetHint">Loading…</div>'
  if (!assetState.root) { assetList.innerHTML = '<div class="assetHint">Click “Set Root” to choose your Cube World folder.</div>'; return }
  const dbs = await window.novaFS.listDbFiles(assetState.root)
  // Show ONLY .db containers in this panel (plus folders, if we add them later).
  assetState.dbFiles = (dbs || []).filter((d) => d.name?.toLowerCase().endsWith('.db'))
  assetList.innerHTML = ''
  if (!assetState.dbFiles.length) {
    assetList.innerHTML = '<div class="assetHint">No .db files found under this root.</div>'
    return
  }
  // Render DB list like folders; click to load its .cub keys.
  for (const dbFile of assetState.dbFiles) {
    const row = document.createElement('div')
    row.className = 'assetItem' + (assetState.selectedDb?.full === dbFile.full ? ' active' : '')
    row.innerHTML = `<div class="assetPath">📦 ${dbFile.rel}</div>`
    row.addEventListener('click', async () => {
      assetState.selectedDb = dbFile
      assetState.selectedKey = null
      assetPreviewLabel.textContent = dbFile.name
      assetBackBtn.classList.remove('hidden')
      ;[...assetList.querySelectorAll('.assetItem')].forEach((el) => el.classList.remove('active'))
      row.classList.add('active')
      await loadDbKeysAndRender()
    })
    assetList.appendChild(row)
  }
}

async function loadDbKeysAndRender() {
  if (!assetState.selectedDb) return
  assetPreviewLabel.textContent = assetState.selectedDb.name
  assetList.innerHTML = '<div class="assetHint">Loading DB…</div>'
  try {
    const keys = await window.novaFS.listDbAssets(assetState.selectedDb.full, assetState.query || '')
    assetState.keys = (keys || []).slice(0, 8000)
    renderKeyList()
  } catch (e) {
    assetList.innerHTML = '<div class="assetHint">Failed to read data.db (is root correct?).</div>'
  }
}

function renderKeyList() {
  assetList.innerHTML = ''
  // Remove any previous context menu.
  document.getElementById('assetCtxMenu')?.remove()
  const head = document.createElement('div')
  head.className = 'assetHint'
  head.textContent = assetState.selectedDb ? `In ${assetState.selectedDb.name}: ${assetState.keys.length.toLocaleString()} .cub` : ''
  assetList.appendChild(head)
  for (const key of assetState.keys) {
    const div = document.createElement('div')
    div.className = 'assetItem' + (assetState.selectedKey === key ? ' active' : '')
    div.draggable = true
    div.innerHTML = `<div class="assetPath">${key}</div>`
    div.addEventListener('click', async () => {
      assetState.selectedKey = key
      ;[...assetList.querySelectorAll('.assetItem')].forEach((el) => el.classList.remove('active'))
      div.classList.add('active')
      await previewSelectedAsset()
    })
    div.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('application/x-nova-asset', JSON.stringify({ type: 'dbAsset', dbPath: assetState.selectedDb.full, key }))
      e.dataTransfer.effectAllowed = 'copy'
    })
    // Right-click context: Replace this DB entry with the current voxel layer.
    div.addEventListener('contextmenu', (e) => {
      e.preventDefault()
      e.stopPropagation()
      if (!assetState.selectedDb) return
      const existing = document.getElementById('assetCtxMenu')
      if (existing) existing.remove()

      const menu = document.createElement('div')
      menu.id = 'assetCtxMenu'
      menu.className = 'assetCtxMenu'
      menu.style.left = `${e.clientX}px`
      menu.style.top = `${e.clientY}px`
      menu.innerHTML = `<button id="assetReplaceBtn">Replace with current layer?</button>`
      document.body.appendChild(menu)

      const close = () => { try { menu.remove() } catch {} }
      const onDoc = (ev) => {
        if (!menu.contains(ev.target)) close()
        document.removeEventListener('pointerdown', onDoc)
      }
      document.addEventListener('pointerdown', onDoc)

      menu.querySelector('#assetReplaceBtn')?.addEventListener('click', async () => {
        close()
        if (!window.novaFS?.replaceDbAsset) {
          alert('Replace requires Electron main-process support. Restart the app if needed.')
          return
        }
        const targetId = (selectedLayer.type === 'voxel' && selectedLayer.id) ? selectedLayer.id : activeVoxelLayerId
        const layer = voxelLayers.find((l) => l.id === targetId) || getActiveVoxelLayer()
        if (!layer?.voxelMap?.size) { alert('Current layer has no voxels.'); return }
        const ok = confirm(`Replace ${key} inside ${assetState.selectedDb.name}?\n\nThis will modify the .db file on disk. A .bak will be created.`)
        if (!ok) return
        const bytes = makeCubBytesFromVoxelMap(layer.voxelMap)
        if (!bytes) { alert('Failed to build .cub bytes from current layer.'); return }
        try {
          const res = await window.novaFS.replaceDbAsset(assetState.selectedDb.full, key, bytes.buffer)
          if (!res?.ok) throw new Error(res?.error || 'Replace failed')
          // refresh preview + list
          await previewSelectedAsset()
          alert('Replaced successfully.')
        } catch (err) {
          alert(`Replace failed: ${err?.message || err}`)
        }
      })
    })
    assetList.appendChild(div)
  }
  if (!assetState.keys.length) assetList.innerHTML = '<div class="assetHint">No .cub entries found in this db (or search too narrow).</div>'
}

async function readSelectedAssetBytes() {
  if (!assetState.selectedDb || !assetState.selectedKey) return null
  return window.novaFS.readDbAsset(assetState.selectedDb.full, assetState.selectedKey)
}

async function previewSelectedAsset() {
  if (!assetState.selectedDb || !assetState.selectedKey) return
  assetPreviewLabel.textContent = assetState.selectedKey.split('/').pop()
  try {
    const ab = await readSelectedAssetBytes()
    if (!ab) throw new Error('Missing')
    const { vox } = parseCubToVoxelMap(ab)
    if (apMesh) { apScene.remove(apMesh); apMesh.geometry.dispose(); apMesh.material.dispose(); apMesh = null }
    apMesh = buildPreviewMesh(vox)
    apScene.add(apMesh)
    apCamera.position.set(28, 20, 28)
    apCamera.lookAt(0, 8, 0)
    apRender()
  } catch {
    assetPreviewLabel.textContent = 'Preview failed'
  }
}

assetSearch.addEventListener('input', () => {
  assetState.query = assetSearch.value || ''
  if (assetState.selectedDb) loadDbKeysAndRender()
  else refreshAssetList()
})
assetPickRoot.addEventListener('click', async () => {
  if (!window.novaFS) return
  const dir = await window.novaFS.pickDirectory()
  if (!dir) return
  assetState.root = dir
  localStorage.setItem('nova.assetRoot', dir)
  refreshAssetList()
})
assetBackupBtn?.addEventListener('click', async () => {
  if (!window.novaFS?.createDbBackup) {
    alert('Backup requires Electron main-process support. Restart the app if needed.')
    return
  }
  if (!assetState.selectedDb?.full) {
    alert('Open a .db file first (ex: data1.db).')
    return
  }
  const outDir = await window.novaFS.pickDirectory()
  if (!outDir) return
  try {
    assetBackupBtn.disabled = true
    assetBackupBtn.textContent = 'Backing up...'
    const res = await window.novaFS.createDbBackup(assetState.selectedDb.full, outDir)
    if (!res?.ok) throw new Error(res?.error || 'Backup failed')
    alert(`Backup created.\n\nCopied: ${res.copied || 0} .db file(s)\nTo: ${res.outDir || outDir}`)
  } catch (e) {
    alert(`Backup failed: ${e?.message || e}`)
  } finally {
    assetBackupBtn.disabled = false
    assetBackupBtn.textContent = 'Create Backup'
  }
})
assetBackBtn.addEventListener('click', () => {
  assetState.selectedDb = null
  assetState.selectedKey = null
  assetState.keys = []
  assetPreviewLabel.textContent = 'No selection'
  assetBackBtn.classList.add('hidden')
  refreshAssetList()
})

// Allow dropping assets into the main viewport to import.
canvasWrap.addEventListener('drop', async (e) => {
  const raw = e.dataTransfer?.getData('application/x-nova-asset')
  if (!raw) return
  try {
    const data = JSON.parse(raw)
    if (data.type === 'dbAsset') {
      // Ensure db selected and loaded
      if (!assetState.selectedDb || assetState.selectedDb.full !== data.dbPath) {
        assetState.selectedDb = assetState.dbFiles.find((d) => d.full === data.dbPath) || { full: data.dbPath, name: data.dbPath.split(/[\\/]/).pop() }
        await loadDbKeysAndRender()
      }
      assetState.selectedKey = data.key
      const ab = await readSelectedAssetBytes()
      if (!ab) return
      const blob = new Blob([ab], { type: 'application/octet-stream' })
      const file = new File([blob], (data.key.split('/').pop() || 'asset.cub'))
      await loadFile(file)
    }
  } catch {}
})

// Initial load
assetSearch.value = assetState.query
refreshAssetList()
