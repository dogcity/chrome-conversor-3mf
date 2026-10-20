self.C3MF = self.C3MF || {};

/**
 * Center the objects of a single-plate project on the target bed.
 *
 * Every slicer stores object positions in its own bed coordinates (the U1 bed is
 * offset by 0.5/1 mm, apps may export around the origin), so a file opened on a
 * different printer can sit off-center or past the bed edge. The whole layout is
 * moved as one block: relative positions, rotations and heights are kept.
 * Multi-plate projects are left alone, since each slicer spaces its plates differently.
 */

// Skip centering for model files the browser cannot comfortably hold as one string.
const MAX_MODEL_BYTES = 256 * 1024 * 1024;
const IDENTITY = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0];

/** Bed center from a printable_area list of "XxY" corners, or null when unknown. */
function bedCenter(printableArea) {
  if (!Array.isArray(printableArea) || printableArea.length === 0) return null;
  const pts = printableArea.map(p => String(p).split('x').map(Number));
  if (pts.some(p => p.length !== 2 || p.some(n => !Number.isFinite(n)))) return null;
  const xs = pts.map(p => p[0]);
  const ys = pts.map(p => p[1]);
  return [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2];
}

function parseTransform(attrs) {
  const m = attrs.match(/\btransform="([^"]*)"/);
  if (!m) return IDENTITY;
  const t = m[1].trim().split(/\s+/).map(Number);
  return t.length === 12 && t.every(Number.isFinite) ? t : IDENTITY;
}

/** Axis-aligned box of a box after a 3MF transform (row vector times matrix). */
function transformBox(box, t) {
  const out = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
  for (const x of [box.min[0], box.max[0]]) {
    for (const y of [box.min[1], box.max[1]]) {
      for (const z of [box.min[2], box.max[2]]) {
        const p = [
          x * t[0] + y * t[3] + z * t[6] + t[9],
          x * t[1] + y * t[4] + z * t[7] + t[10],
          x * t[2] + y * t[5] + z * t[8] + t[11],
        ];
        for (let a = 0; a < 3; a++) {
          out.min[a] = Math.min(out.min[a], p[a]);
          out.max[a] = Math.max(out.max[a], p[a]);
        }
      }
    }
  }
  return out;
}

function mergeBox(acc, box) {
  if (!box) return acc;
  if (!acc) return { min: [...box.min], max: [...box.max] };
  for (let a = 0; a < 3; a++) {
    acc.min[a] = Math.min(acc.min[a], box.min[a]);
    acc.max[a] = Math.max(acc.max[a], box.max[a]);
  }
  return acc;
}

function meshBox(body) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  let found = false;
  for (const m of body.matchAll(/<vertex\b([^>]*)>/g)) {
    const attrs = m[1];
    const p = ['x', 'y', 'z'].map(k => Number((attrs.match(new RegExp(`\\b${k}="([^"]*)"`)) || [])[1]));
    if (!p.every(Number.isFinite)) continue;
    found = true;
    for (let a = 0; a < 3; a++) {
      if (p[a] < min[a]) min[a] = p[a];
      if (p[a] > max[a]) max[a] = p[a];
    }
  }
  return found ? { min, max } : null;
}

/** Index the <object> elements of a model file by id. */
function indexObjects(text) {
  const objects = new Map();
  for (const m of text.matchAll(/<object\b([^>]*)>([\s\S]*?)<\/object>/g)) {
    const id = (m[1].match(/\bid="([^"]*)"/) || [])[1];
    if (id) objects.set(id, m[2]);
  }
  return objects;
}

/**
 * Bounding box of every build item in the main model, resolving components that
 * live in other model files of the archive. Returns null when it cannot be measured.
 */
async function buildBox(zip, mainText) {
  const files = new Map([['', indexObjects(mainText)]]);
  const boxes = new Map();

  async function objectsOf(filePath) {
    if (!files.has(filePath)) {
      const entry = zip.file(filePath);
      if (!entry) return null;
      if ((entry._data?.uncompressedSize ?? 0) > MAX_MODEL_BYTES) return null;
      files.set(filePath, indexObjects(await entry.async('string')));
    }
    return files.get(filePath);
  }

  async function objectBox(filePath, id, depth) {
    const key = `${filePath}#${id}`;
    if (boxes.has(key)) return boxes.get(key);
    const objects = await objectsOf(filePath);
    const body = objects && objects.get(id);
    if (body === undefined || depth > 8) return null;
    let box = /<mesh\b/.test(body) ? meshBox(body) : null;
    for (const c of body.matchAll(/<component\b([^>]*)>/g)) {
      const attrs = c[1];
      const ref = (attrs.match(/\bobjectid="([^"]*)"/) || [])[1];
      const pathAttr = (attrs.match(/\b(?:p:)?path="([^"]*)"/) || [])[1];
      const target = pathAttr ? pathAttr.replace(/^\//, '') : filePath;
      const inner = ref && await objectBox(target, ref, depth + 1);
      box = mergeBox(box, inner && transformBox(inner, parseTransform(attrs)));
    }
    boxes.set(key, box);
    return box;
  }

  const build = mainText.match(/<build\b[^>]*>([\s\S]*?)<\/build>/);
  if (!build) return null;
  let total = null;
  for (const item of build[1].matchAll(/<item\b([^>]*)>/g)) {
    const id = (item[1].match(/\bobjectid="([^"]*)"/) || [])[1];
    const box = id && await objectBox('', id, 0);
    if (!box) return null;
    total = mergeBox(total, transformBox(box, parseTransform(item[1])));
  }
  return total;
}

const fmt = n => String(Math.round(n * 1e6) / 1e6);

/** Add (dx, dy) to the translation of every build item. */
function shiftBuildItems(text, dx, dy) {
  return text.replace(/<build\b[^>]*>[\s\S]*?<\/build>/, build =>
    build.replace(/<item\b([^>]*?)(\/?)>/g, (tag, attrs, close) => {
      const t = parseTransform(attrs).slice();
      t[9] += dx;
      t[10] += dy;
      const value = `transform="${t.map(fmt).join(' ')}"`;
      const next = /\btransform="[^"]*"/.test(attrs)
        ? attrs.replace(/\btransform="[^"]*"/, value)
        : attrs.replace(/(\bobjectid="[^"]*")/, `$1 ${value}`);
      return `<item${next}${close}>`;
    }));
}

/**
 * Center a single-plate model on the bed described by `printableArea`.
 * @param {JSZip} zip - Source archive, used to read component model files
 * @param {Uint8Array} modelBytes - Bytes of 3D/3dmodel.model
 * @param {string[]} printableArea - Target bed corners ("XxY")
 * @returns {Promise<Uint8Array>} The input bytes when nothing should change
 */
self.C3MF.centerOnBed = async function(zip, modelBytes, printableArea) {
  const center = bedCenter(printableArea);
  if (!center || modelBytes.length > MAX_MODEL_BYTES) return modelBytes;

  const settings = zip.file('Metadata/model_settings.config');
  if (settings && ((await settings.async('string')).match(/<plate>/g) || []).length > 1) return modelBytes;

  try {
    const text = new TextDecoder('utf-8').decode(modelBytes);
    const box = await buildBox(zip, text);
    if (!box) return modelBytes;
    const dx = center[0] - (box.min[0] + box.max[0]) / 2;
    const dy = center[1] - (box.min[1] + box.max[1]) / 2;
    if (Math.abs(dx) < 0.01 && Math.abs(dy) < 0.01) return modelBytes;
    return new TextEncoder().encode(shiftBuildItems(text, dx, dy));
  } catch {
    return modelBytes;
  }
};
