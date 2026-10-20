/**
 * Filament mapping popup UI.
 * Handles the full pipeline: load from IndexedDB → analyze → map → convert → download.
 * Runs in a popup window with full DOM access (DOMParser, XMLSerializer, URL.createObjectURL).
 */

const PHYSICAL_SLOTS = self.C3MF.PHYSICAL_SLOTS;
let outputSlots = [];
let slotMapping = {};
let inputFilaments = [];
let currentTarget = self.C3MF.TARGETS.u1;

// Parsed state for conversion
let parsedZip = null;
let hasSupport = false;
let originalName = 'model';
let isManualMode = false; // true when user picked a local file (vs intercepted download)

// Batch state (multi-file drop): groups of files sharing an identical filament configuration
let batchGroups = null;
let batchIndex = 0;
let batchResult = null;

const btnConvert = document.getElementById('btn-convert');
const btnOriginal = document.getElementById('btn-original');
const convertIcon = document.getElementById('convert-icon');
const convertLabel = document.getElementById('convert-label');
const loadingText = document.getElementById('loading-text');

/** Resize the popup window to fit its content. */
function resizeToFit() {
  requestAnimationFrame(() => {
    const width = 560;
    const height = Math.min(document.documentElement.scrollHeight + 40, screen.availHeight - 100);
    chrome.windows.getCurrent((win) => {
      chrome.windows.update(win.id, { width, height });
    });
  });
}

/** Detect macOS (desktop, not iOS). */
function isMacOS() {
  // navigator.userAgentData is available in Chrome 90+ but not Firefox
  if (navigator.userAgentData) {
    return navigator.userAgentData.platform === 'macOS';
  }
  return /Mac/.test(navigator.userAgent) && !/iPhone|iPad|iPod/.test(navigator.userAgent);
}

/**
 * Close this popup window reliably. window.close() silently no-ops for windows
 * created by chrome.windows.create (which is how this popup is opened), so remove
 * the window by id instead, falling back to window.close().
 */
async function closeWindow() {
  try {
    const win = await chrome.windows.getCurrent();
    await chrome.windows.remove(win.id);
  } catch {
    window.close();
  }
}

// Names handed out in this window, so a batch never reuses a name before Chrome records it
const usedDownloadNames = new Set();

/**
 * Resolve `desired` to a name not yet in the download folder: "model-A1.3mf",
 * then "model-A1-2.3mf", "model-A1-3.3mf"... Existing files are known through Chrome's
 * download history; files placed there by other means are not visible to extensions.
 */
async function resolveUniqueFilename(desired) {
  const taken = new Set(usedDownloadNames);
  const stem = desired.replace(/\.[^.]+$/, '');
  try {
    const items = await chrome.downloads.search({ query: [stem], exists: true });
    for (const item of items) taken.add((item.filename || '').split(/[/\\]/).pop());
  } catch {
    // downloads API unavailable — rely on names used in this window
  }
  const name = self.C3MF.uniqueFilename(desired, taken);
  usedDownloadNames.add(name);
  return name;
}

/** Download a blob as a file, waiting for completion before returning. */
async function downloadBlob(blob, filename) {
  filename = await resolveUniqueFilename(filename);
  const blobUrl = URL.createObjectURL(blob);
  // On macOS, chrome.downloads.download() with a blob URL ignores the filename
  // parameter and uses the blob UUID instead. Use the anchor-click approach there.
  if (chrome.downloads && !isMacOS()) {
    // Register listener BEFORE starting download to avoid race where
    // download completes before listener is attached
    let downloadId = null;
    await new Promise((resolve) => {
      const timeout = setTimeout(() => {
        chrome.downloads.onChanged.removeListener(listener);
        resolve();
      }, 60000);
      function listener(delta) {
        if (downloadId !== null && delta.id !== downloadId) return;
        if (delta.state?.current === 'complete' || delta.state?.current === 'interrupted') {
          clearTimeout(timeout);
          chrome.downloads.onChanged.removeListener(listener);
          resolve();
        }
      }
      chrome.downloads.onChanged.addListener(listener);
      chrome.downloads.download({ url: blobUrl, filename, saveAs: false }).then(id => {
        downloadId = id;
      });
    });
  } else {
    const a = document.createElement('a');
    a.href = blobUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    await new Promise(r => setTimeout(r, 5000));
  }
  URL.revokeObjectURL(blobUrl);
}

// ---- Initialize: check for pending file or show drop zone ----
(async function init() {
  // Session-restore guard: the service worker sets swSessionActive whenever it opens
  // a popup. If it's missing, the browser restored this window on relaunch (session
  // storage is wiped on restart) — close it so stale converter windows don't reappear.
  try {
    const { swSessionActive } = await chrome.storage.session.get('swSessionActive');
    if (!swSessionActive) { closeWindow(); return; }
  } catch {
    // storage.session unavailable — proceed normally
  }

  await loadTarget();

  // Check if there's a pending intercepted download in IndexedDB.
  // Don't clear the store here: clearFile() wipes the whole store, so clearing on
  // load would race a near-simultaneous second download and erase its file before
  // its window loads. Stale files are instead dropped on manual open and onStartup.
  const fileData = await self.C3MF.loadFile();
  if (fileData) {
    await processArrayBuffer(fileData.arrayBuffer, fileData.metadata?.originalName || 'model');
  } else {
    // No pending download — show the drop zone for manual file selection
    document.getElementById('loading-state').classList.add('hidden');
    document.getElementById('drop-zone-state').classList.remove('hidden');
    resizeToFit();
  }
})();

// ---- Target printer ----
const printProfileSelect = document.getElementById('print-profile');

/** Restore the last chosen target printer. */
async function loadTarget() {
  let id = 'u1';
  try {
    ({ target: id = 'u1' } = await chrome.storage.local.get('target'));
  } catch {
    // storage unavailable — keep the default
  }
  applyTarget(self.C3MF.TARGETS[id] || self.C3MF.TARGETS.u1);
}

/** Update every target-dependent label and control. */
function applyTarget(target) {
  currentTarget = target;
  document.querySelectorAll('.target-option').forEach(btn => {
    const active = btn.dataset.target === target.id;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-checked', String(active));
  });
  document.getElementById('brand-target').textContent = target.label;
  document.getElementById('slots-label').textContent = target.slotsLabel;

  printProfileSelect.innerHTML = '';
  for (const name of target.printProfiles) {
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = name;
    printProfileSelect.appendChild(opt);
  }
  document.getElementById('print-profile-row').classList.toggle('hidden', target.printProfiles.length === 0);
}

document.querySelectorAll('.target-option').forEach(btn => {
  btn.addEventListener('click', () => {
    const target = self.C3MF.TARGETS[btn.dataset.target];
    if (!target || target === currentTarget || btnConvert.disabled && !document.getElementById('mapping-ui').classList.contains('hidden')) return;
    applyTarget(target);
    try { chrome.storage.local.set({ target: target.id }); } catch {}

    // Keep colors and routing; switch each slot to the new target's filament choice
    if (!document.getElementById('mapping-ui').classList.contains('hidden')) {
      outputSlots.forEach(s => { s.type = target.defaultChoice(s.sourceType); });
      convertLabel.textContent = idleConvertLabel();
      rebuildDOM();
    }
    resizeToFit();
  });
});

/** Process an ArrayBuffer (from either intercepted download or manual file pick). */
async function processArrayBuffer(arrayBuffer, name) {
  try {
    document.getElementById('drop-zone-state').classList.add('hidden');
    document.getElementById('loading-state').classList.remove('hidden');
    loadingText.textContent = 'Analizando filamentos...';

    originalName = name || 'model';

    const analysis = await self.C3MF.analyze(arrayBuffer);
    parsedZip = analysis.zip;
    hasSupport = analysis.hasSupport;

    if (analysis.filaments.length === 0) throw new Error('No se encontraron filamentos en este archivo');

    // Files already set up for the target still open the configuration, so colors
    // and presets can be reviewed before downloading
    showMappingUI(analysis.filaments);
  } catch (err) {
    document.getElementById('loading-state').classList.add('hidden');
    document.getElementById('error-state').classList.remove('hidden');
    document.getElementById('error-message').textContent = err.message || 'No se pudo procesar el archivo';
  }
}

/** Show the mapping UI with filament data. */
function showMappingUI(filaments) {
  renderMappingUI(filaments);
  document.getElementById('loading-state').classList.add('hidden');
  document.getElementById('mapping-ui').classList.remove('hidden');

  if (isManualMode) {
    btnOriginal.classList.add('hidden');
  }
  convertLabel.textContent = idleConvertLabel();
  resizeToFit();
}

function idleConvertLabel() {
  if (batchGroups) {
    const n = batchGroups[batchIndex].items.length;
    return n === 1 ? 'Convertir' : `Convertir ${n} archivos`;
  }
  return isManualMode ? 'Convertir' : 'Convertir y descargar';
}


// ---- Manual file selection (drop zone) ----
const dropZone = document.getElementById('drop-zone');
const fileUpload = document.getElementById('file-upload');

dropZone.addEventListener('dragover', (e) => { e.preventDefault(); dropZone.classList.add('drag-over'); });
dropZone.addEventListener('dragleave', () => { dropZone.classList.remove('drag-over'); });
dropZone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropZone.classList.remove('drag-over');
  handleLocalFiles(e.dataTransfer.files);
});
fileUpload.addEventListener('change', (e) => handleLocalFiles(e.target.files));

function handleLocalFiles(fileList) {
  const files = Array.from(fileList || []);
  if (files.length <= 1) handleLocalFile(files[0]);
  else startBatch(files);
}

function handleLocalFile(file) {
  if (!file) return;
  if (!file.name.toLowerCase().endsWith('.3mf')) {
    document.getElementById('drop-zone-state').classList.add('hidden');
    document.getElementById('error-state').classList.remove('hidden');
    document.getElementById('error-message').textContent = 'Solo se admiten archivos .3mf';
    return;
  }
  const name = file.name.replace(/\.3mf$/i, '');
  const reader = new FileReader();
  reader.onload = () => { isManualMode = true; processArrayBuffer(reader.result, name); };
  reader.onerror = () => {
    document.getElementById('error-state').classList.remove('hidden');
    document.getElementById('error-message').textContent = 'No se pudo leer el archivo';
  };
  reader.readAsArrayBuffer(file);
}

// ---- Error close / Cancel ----
document.getElementById('btn-close-error').addEventListener('click', () => closeWindow());
document.getElementById('btn-cancel').addEventListener('click', () => {
  if (!batchGroups) { closeWindow(); return; }
  if (btnConvert.disabled) return; // group conversion in progress
  for (const item of batchGroups[batchIndex].items) batchResult.skipped.push({ name: item.name, reason: 'omitido' });
  showNextBatchGroup();
});
document.getElementById('btn-close-batch').addEventListener('click', () => closeWindow());

// ---- Batch mode (multiple local files) ----

/** Analyze every dropped file, group identical filament configurations, then map group by group. */
async function startBatch(files) {
  isManualMode = true;
  batchResult = { converted: [], skipped: [], failed: [] };
  document.getElementById('drop-zone-state').classList.add('hidden');
  document.getElementById('loading-state').classList.remove('hidden');
  resizeToFit();

  const items = [];
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const name = file.name.replace(/\.3mf$/i, '');
    loadingText.textContent = `Analizando archivo ${i + 1} de ${files.length}...`;
    if (!file.name.toLowerCase().endsWith('.3mf')) {
      batchResult.skipped.push({ name: file.name, reason: 'no es un archivo .3mf' });
      continue;
    }
    try {
      const analysis = await self.C3MF.analyze(await file.arrayBuffer());
      if (analysis.filaments.length === 0) throw new Error('No se encontraron filamentos en este archivo');
      items.push({ name, analysis });
    } catch (err) {
      batchResult.failed.push({ name: file.name, reason: err.message || 'No se pudo procesar el archivo' });
    }
  }

  batchGroups = self.C3MF.groupBySignature(items);
  batchIndex = -1;
  document.getElementById('cancel-label').textContent = 'Saltar';
  showNextBatchGroup();
}

function showNextBatchGroup() {
  batchIndex++;
  if (batchIndex >= batchGroups.length) { showBatchDone(); return; }

  const group = batchGroups[batchIndex];
  parsedZip = group.items[0].analysis.zip;
  document.getElementById('convert-error').classList.remove('visible');
  document.getElementById('batch-banner').classList.remove('hidden');
  const files = group.items.length === 1 ? '1 archivo' : `${group.items.length} archivos con filamentos idénticos`;
  document.getElementById('batch-banner-title').textContent =
    `Grupo ${batchIndex + 1} de ${batchGroups.length} — ${files}`;
  fillFileList(document.getElementById('batch-banner-files'), group.items.map(item => `${item.name}.3mf`));
  showMappingUI(group.filaments);
}

/** Convert and download every file of the current group with the same slot setup. */
async function convertBatchGroup(filteredSlots, filteredMapping) {
  const items = batchGroups[batchIndex].items;
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    convertLabel.textContent = `Convirtiendo ${i + 1}/${items.length}…`;
    try {
      const blob = await self.C3MF.convert({
        zip: item.analysis.zip,
        outputSlots: filteredSlots,
        mapping: filteredMapping,
        hasSupport: item.analysis.hasSupport,
        target: currentTarget,
        printProfile: printProfileSelect.value,
      });
      await downloadBlob(blob, `${item.name}${currentTarget.suffix}.3mf`);
      batchResult.converted.push({ name: `${item.name}.3mf` });
    } catch (err) {
      batchResult.failed.push({ name: `${item.name}.3mf`, reason: err.message || 'Falló la conversión.' });
    }
    item.analysis.zip = null; // release the parsed archive
  }
  setConverting(false);
  showNextBatchGroup();
}

function showBatchDone() {
  batchGroups = null;
  document.getElementById('loading-state').classList.add('hidden');
  document.getElementById('mapping-ui').classList.add('hidden');
  document.getElementById('batch-done-state').classList.remove('hidden');
  const n = batchResult.converted.length;
  document.getElementById('batch-done-title').textContent = `${n} archivo${n === 1 ? '' : 's'} convertido${n === 1 ? '' : 's'}`;
  fillFileList(document.getElementById('batch-done-list'), [
    ...batchResult.converted.map(f => `${f.name} — convertido`),
    ...batchResult.skipped.map(f => `${f.name} — ${f.reason}`),
    ...batchResult.failed.map(f => `${f.name} — falló: ${f.reason}`),
  ]);
  resizeToFit();
}

/** Fill a list with untrusted file names via textContent. */
function fillFileList(listEl, lines) {
  listEl.innerHTML = '';
  for (const line of lines) {
    const li = document.createElement('li');
    li.textContent = line;
    listEl.appendChild(li);
  }
}

// Download original (unconverted) file
btnOriginal.addEventListener('click', async () => {
  if (!parsedZip || btnOriginal.disabled) return;
  btnOriginal.disabled = true;
  try {
    const blob = await parsedZip.generateAsync({ type: 'blob', mimeType: 'application/octet-stream' });
    await downloadBlob(blob, `${originalName}.3mf`);
    closeWindow();
  } catch (err) {
    showConvertError(err.message || 'No se pudo descargar.');
    btnOriginal.disabled = false;
  }
});

// Inline conversion error
function showConvertError(msg) {
  const el = document.getElementById('convert-error');
  document.getElementById('convert-error-msg').textContent = msg;
  el.classList.add('visible');
}
document.getElementById('convert-error-dismiss').addEventListener('click', () => {
  document.getElementById('convert-error').classList.remove('visible');
});

function setConverting(active) {
  btnConvert.disabled = active;
  btnOriginal.disabled = active;
  if (active) {
    convertIcon.className = 'fa-solid fa-circle-notch fa-spin';
    convertLabel.textContent = 'Convirtiendo\u2026';
  } else {
    convertIcon.className = 'fa-solid fa-bolt';
    convertLabel.textContent = idleConvertLabel();
  }
}

// ---- Custom color picker popover ----
const PRESET_COLORS = [
  '#FFFFFF', '#F5F5F5', '#CCCCCC', '#AAAAAA', '#888888', '#555555', '#333333', '#000000',
  '#FF0000', '#CC0000', '#880000', '#FF4444', '#FF6B6B', '#E74C3C', '#C0392B', '#8B0000',
  '#FF6600', '#FF8800', '#FFAA00', '#FFD700', '#FFFF00', '#FFC107', '#F39C12', '#E67E22',
  '#00FF00', '#00CC00', '#008800', '#27AE60', '#2ECC71', '#1ABC9C', '#006400', '#228B22',
  '#00FFFF', '#00CCFF', '#0088FF', '#0000FF', '#0000CC', '#000088', '#3498DB', '#2980B9',
  '#FF00FF', '#FF69B4', '#FF1493', '#E91E63', '#9B59B6', '#8E44AD', '#4B0082', '#800080',
  '#8B4513', '#A0522D', '#D2691E', '#CD853F', '#DEB887', '#C9A84C', '#B8860B', '#DAA520',
];
let colorPop = null;
let activeColorSlot = null;
let activeColorSwatch = null;

function closeColorPop() {
  if (colorPop) { colorPop.remove(); colorPop = null; }
  activeColorSlot = null;
  activeColorSwatch = null;
}

function applyColor(hex) {
  if (activeColorSlot === null) return;
  const color = hex.startsWith('#') ? hex : '#' + hex;
  outputSlots[activeColorSlot].color = color;
  if (activeColorSwatch) activeColorSwatch.style.background = color;
  document.querySelectorAll(`.slot-dot-btn[data-slot="${activeColorSlot}"] .slot-dot-inner`).forEach(dot => {
    dot.style.background = color;
  });
  if (colorPop) {
    colorPop.querySelector('.color-pop-preview').style.background = color;
    const inp = colorPop.querySelector('.color-pop-input');
    if (document.activeElement !== inp) inp.value = color.replace('#', '');
    colorPop.querySelectorAll('.color-pop-preset').forEach(p => {
      p.classList.toggle('active', p.dataset.color.toUpperCase() === color.toUpperCase());
    });
  }
}

function openColorPicker(slotIdx, swatchEl) {
  closeColorPop();
  activeColorSlot = slotIdx;
  activeColorSwatch = swatchEl;
  const currentColor = outputSlots[slotIdx].color;

  const pop = document.createElement('div');
  pop.className = 'color-pop';

  const preview = document.createElement('div');
  preview.className = 'color-pop-preview';
  preview.style.background = currentColor;
  pop.appendChild(preview);

  const hexRow = document.createElement('div');
  hexRow.className = 'color-pop-hex-row';
  hexRow.innerHTML = `<span class="color-pop-hash">#</span><input type="text" class="color-pop-input" maxlength="6" spellcheck="false">`;
  hexRow.querySelector('.color-pop-input').value = currentColor.replace('#', '');
  pop.appendChild(hexRow);

  const hexInput = hexRow.querySelector('.color-pop-input');
  hexInput.addEventListener('input', () => {
    const v = hexInput.value.replace(/[^0-9a-fA-F]/g, '').slice(0, 6);
    if (v.length === 6) applyColor('#' + v);
  });
  hexInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === 'Escape') closeColorPop();
  });

  const presets = document.createElement('div');
  presets.className = 'color-pop-presets';
  PRESET_COLORS.forEach(c => {
    const btn = document.createElement('button');
    btn.className = 'color-pop-preset' + (c.toUpperCase() === currentColor.toUpperCase() ? ' active' : '');
    btn.style.background = c;
    btn.dataset.color = c;
    btn.title = c;
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      applyColor(c);
      hexInput.value = c.replace('#', '');
    });
    presets.appendChild(btn);
  });
  pop.appendChild(presets);

  document.body.appendChild(pop);
  colorPop = pop;

  // Position and clamp to viewport in a single rAF
  const rect = swatchEl.getBoundingClientRect();
  pop.style.top = (rect.bottom + 6) + 'px';
  pop.style.left = rect.left + 'px';

  requestAnimationFrame(() => {
    const popRect = pop.getBoundingClientRect();
    if (popRect.right > window.innerWidth - 8) {
      pop.style.left = (window.innerWidth - popRect.width - 8) + 'px';
    }
    if (popRect.bottom > window.innerHeight - 8) {
      pop.style.top = (rect.top - popRect.height - 6) + 'px';
    }
    hexInput.focus();
    hexInput.select();
  });
}

document.addEventListener('mousedown', (e) => {
  if (colorPop && !colorPop.contains(e.target) && !e.target.closest('.slot-color-trigger')) {
    closeColorPop();
  }
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && colorPop) closeColorPop();
});

// ---- Mapping UI ----
function renderMappingUI(filaments) {
  inputFilaments = filaments;
  outputSlots = filaments.map(f => ({ color: f.color, type: currentTarget.defaultChoice(f.type), sourceType: f.type }));
  slotMapping = {};
  filaments.forEach((f, i) => { slotMapping[f.id] = i; });

  const hint = document.getElementById('route-hint');
  if (filaments.length > PHYSICAL_SLOTS) {
    hint.textContent = '\u2014 haz clic en un punto para enviar cada color a un slot';
  } else {
    hint.textContent = '';
  }

  btnConvert.disabled = false;

  const strip = document.getElementById('slots-strip');
  const list = document.getElementById('input-list');
  strip.classList.add('animate-in');
  list.classList.add('animate-in');
  rebuildDOM();
  setTimeout(() => { strip.classList.remove('animate-in'); list.classList.remove('animate-in'); }, 500);
}

function getUsedSlots() {
  const used = new Set();
  for (const fid in slotMapping) used.add(slotMapping[fid]);
  return used;
}

function syncUsedState() {
  const used = getUsedSlots();

  document.querySelectorAll('.printer-slot').forEach(el => {
    const si = +el.querySelector('.slot-color-trigger')?.dataset.slot;
    if (isNaN(si)) return;
    const isUnused = !used.has(si);
    el.classList.toggle('slot-unused', isUnused);
    if (isUnused) {
      el.title = 'Ningún color del archivo va a este slot \u2014 se excluirá del resultado';
    } else if (si >= PHYSICAL_SLOTS) {
      el.title = 'La impresora tiene 4 slots físicos \u2014 este supera ese límite';
    } else {
      el.title = '';
    }
    const tag = el.querySelector('.slot-unused-tag');
    if (isUnused && !tag) {
      const t = document.createElement('span');
      t.className = 'slot-unused-tag';
      t.textContent = 'Sin uso';
      el.appendChild(t);
    } else if (!isUnused && tag) {
      tag.remove();
    }
  });

  document.querySelectorAll('.slot-dot-btn').forEach(d => {
    const si = +d.dataset.slot;
    const isActive = d.classList.contains('active');
    d.classList.toggle('unused', !isActive && !used.has(si));
  });
}

function reorderSlot(fromIdx, toIdx) {
  const [moved] = outputSlots.splice(fromIdx, 1);
  outputSlots.splice(toIdx, 0, moved);

  for (const fid in slotMapping) {
    const old = slotMapping[fid];
    if (old === fromIdx) {
      slotMapping[fid] = toIdx;
    } else if (fromIdx < toIdx && old > fromIdx && old <= toIdx) {
      slotMapping[fid] = old - 1;
    } else if (fromIdx > toIdx && old >= toIdx && old < fromIdx) {
      slotMapping[fid] = old + 1;
    }
  }

  rebuildDOM();
}

function rebuildDOM() {
  buildSlotsStrip();
  buildInputList();
}

// ---- Printer Slots strip ----
function buildSlotsStrip() {
  const strip = document.getElementById('slots-strip');
  strip.innerHTML = '';
  const usedSlots = getUsedSlots();

  outputSlots.forEach((slot, i) => {
    const isOver = i >= PHYSICAL_SLOTS;
    const isUnused = !usedSlots.has(i);
    const classes = ['printer-slot'];
    if (isOver) classes.push('slot-warn');
    if (isUnused) classes.push('slot-unused');

    const el = document.createElement('div');
    el.className = classes.join(' ');
    el.draggable = true;
    el.dataset.slotIdx = i;
    if (isUnused) el.title = 'Ningún color del archivo va a este slot \u2014 se excluirá del resultado';
    else if (isOver) el.title = 'La impresora tiene 4 slots físicos \u2014 este supera ese límite';

    // Built via DOM APIs (not innerHTML) so untrusted colors/types can't inject markup.
    const top = document.createElement('div');
    top.className = 'slot-top';
    const num = document.createElement('span');
    num.className = 'slot-num';
    num.textContent = i + 1;
    const remove = document.createElement('button');
    remove.className = 'slot-remove' + (outputSlots.length <= 1 ? ' gone' : '');
    remove.dataset.slot = i;
    remove.setAttribute('aria-label', 'Quitar');
    const removeIcon = document.createElement('i');
    removeIcon.className = 'fa-solid fa-xmark';
    removeIcon.setAttribute('aria-hidden', 'true');
    remove.appendChild(removeIcon);
    top.append(num, remove);

    const swatch = document.createElement('button');
    swatch.className = 'color-well-swatch slot-color-trigger';
    swatch.style.background = slot.color;
    swatch.dataset.slot = i;
    swatch.setAttribute('aria-label', `Color del slot ${i + 1}`);

    const select = document.createElement('select');
    select.className = 'type-select slot-type';
    select.dataset.slot = i;
    select.setAttribute('aria-label', `Filamento del slot ${i + 1}`);
    select.title = slot.type;
    for (const choice of currentTarget.choices) {
      const opt = document.createElement('option');
      opt.value = choice.value;
      opt.textContent = choice.label;
      if (choice.value === slot.type) opt.selected = true;
      select.appendChild(opt);
    }

    el.append(top, swatch, select);

    if (isUnused) {
      const tag = document.createElement('span');
      tag.className = 'slot-unused-tag';
      tag.textContent = 'Sin uso';
      el.appendChild(tag);
    }

    strip.appendChild(el);
  });

  // Drag & drop reorder
  strip.querySelectorAll('.printer-slot').forEach(el => {
    el.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('text/plain', el.dataset.slotIdx);
      el.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
    });
    el.addEventListener('dragend', () => {
      el.classList.remove('dragging');
      strip.querySelectorAll('.printer-slot').forEach(s => s.classList.remove('drag-over-left', 'drag-over-right'));
    });
    el.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      const dragIdx = +strip.querySelector('.dragging')?.dataset.slotIdx;
      const targetIdx = +el.dataset.slotIdx;
      if (targetIdx === dragIdx || isNaN(dragIdx)) return;
      el.classList.remove('drag-over-left', 'drag-over-right');
      el.classList.add(dragIdx < targetIdx ? 'drag-over-right' : 'drag-over-left');
    });
    el.addEventListener('dragleave', () => {
      el.classList.remove('drag-over-left', 'drag-over-right');
    });
    el.addEventListener('drop', (e) => {
      e.preventDefault();
      el.classList.remove('drag-over-left', 'drag-over-right');
      const dragIdx = +e.dataTransfer.getData('text/plain');
      const targetIdx = +el.dataset.slotIdx;
      if (isNaN(dragIdx) || dragIdx === targetIdx) return;
      reorderSlot(dragIdx, targetIdx);
    });
  });

  // Add button
  const addBtn = document.createElement('button');
  addBtn.className = 'btn-add-slot';
  addBtn.setAttribute('aria-label', 'Agregar slot');
  addBtn.innerHTML = '<i class="fa-solid fa-plus" aria-hidden="true"></i>';
  addBtn.title = 'Agregar slot';
  strip.appendChild(addBtn);

  // Events — color swatch click + keyboard
  strip.querySelectorAll('.slot-color-trigger').forEach(el => {
    el.addEventListener('click', () => {
      openColorPicker(+el.dataset.slot, el);
    });
  });
  strip.querySelectorAll('.slot-type').forEach(el => {
    el.addEventListener('change', (e) => {
      outputSlots[+e.target.dataset.slot].type = e.target.value;
      e.target.title = e.target.value;
    });
  });
  strip.querySelectorAll('.slot-remove').forEach(el => {
    el.addEventListener('click', (e) => {
      const idx = +e.currentTarget.dataset.slot;
      outputSlots.splice(idx, 1);
      for (const fid in slotMapping) {
        if (slotMapping[fid] === idx) slotMapping[fid] = 0;
        else if (slotMapping[fid] > idx) slotMapping[fid]--;
      }
      rebuildDOM();
    });
  });
  addBtn.addEventListener('click', () => {
    outputSlots.push({ color: '#FFFFFF', type: currentTarget.defaultChoice() });
    rebuildDOM();
  });
}

// ---- File Colors (input rows) ----
function buildInputList() {
  const list = document.getElementById('input-list');
  list.innerHTML = '';
  const usedSlots = getUsedSlots();

  inputFilaments.forEach((fil) => {
    const row = document.createElement('div');
    row.className = 'input-row';

    const colorDot = document.createElement('span');
    colorDot.className = 'input-color-dot';
    colorDot.style.background = fil.color;

    // fil.type and fil.color come from untrusted ZIP XML — set via textContent.
    const label = document.createElement('span');
    label.className = 'input-label';
    const strong = document.createElement('strong');
    strong.textContent = fil.type || 'Desconocido';
    label.appendChild(strong);
    // Show color hex for disambiguation when multiple filaments share the same type
    const hexSpan = document.createElement('span');
    hexSpan.textContent = ` ${fil.color}`;
    hexSpan.style.cssText = 'font-family:Source Code Pro,monospace;font-size:0.8rem;color:var(--text-dim);margin-left:0.25rem';
    label.appendChild(hexSpan);

    const arrow = document.createElement('i');
    arrow.className = 'fa-solid fa-arrow-right input-arrow';
    arrow.setAttribute('aria-hidden', 'true');

    const selector = document.createElement('span');
    selector.className = 'slot-selector';
    outputSlots.forEach((s, si) => {
      const active = slotMapping[fil.id] === si;
      const unused = !active && !usedSlots.has(si);
      const btn = document.createElement('button');
      btn.className = 'slot-dot-btn' + (active ? ' active' : '') + (unused ? ' unused' : '');
      btn.dataset.filId = fil.id;
      btn.dataset.slot = si;
      btn.setAttribute('aria-label', `Asignar al slot ${si + 1}`);
      btn.title = `Slot ${si + 1}`;
      const inner = document.createElement('span');
      inner.className = 'slot-dot-inner';
      inner.style.background = s.color;
      btn.appendChild(inner);
      selector.appendChild(btn);
    });

    row.append(colorDot, label, arrow, selector);
    list.appendChild(row);
  });

  list.querySelectorAll('.slot-dot-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const filId = btn.dataset.filId;
      const newSlot = +btn.dataset.slot;
      const oldSlot = slotMapping[filId];
      if (newSlot === oldSlot) return;

      slotMapping[filId] = newSlot;

      const row = btn.closest('.input-row');
      row.querySelectorAll('.slot-dot-btn').forEach(d => d.classList.remove('active'));
      btn.classList.add('active');

      syncUsedState();
    });
  });
}

// ---- Convert & Download ----
btnConvert.addEventListener('click', async () => {
  if (btnConvert.disabled || !parsedZip) return;
  if (outputSlots.length === 0) { showConvertError('Agrega al menos un slot de salida.'); return; }

  // Filter out unused slots and remap indices
  const usedSlots = getUsedSlots();
  const filteredSlots = [];
  const oldToNew = {};
  outputSlots.forEach((s, i) => {
    if (usedSlots.has(i)) {
      oldToNew[i] = filteredSlots.length;
      filteredSlots.push(s);
    }
  });
  const filteredMapping = {};
  for (const fid in slotMapping) {
    const newIdx = oldToNew[slotMapping[fid]];
    if (newIdx !== undefined) {
      filteredMapping[fid] = newIdx;
    }
  }

  if (filteredSlots.length === 0) { showConvertError('No hay slots en uso.'); return; }

  setConverting(true);
  if (batchGroups) {
    await convertBatchGroup(filteredSlots, filteredMapping);
    return;
  }
  try {
    const blob = await self.C3MF.convert({
      zip: parsedZip,
      outputSlots: filteredSlots,
      mapping: filteredMapping,
      hasSupport,
      target: currentTarget,
      printProfile: printProfileSelect.value,
    });

    await downloadBlob(blob, `${originalName}${currentTarget.suffix}.3mf`);
    setConverting(false);
    closeWindow();
  } catch (err) {
    showConvertError(err.message || 'Falló la conversión.');
    setConverting(false);
  }
});
