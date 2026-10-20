const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');

/** Load extension scripts into an isolated context, like the popup's <script> tags. */
function loadScripts(dir, files) {
  const ctx = vm.createContext({ TextDecoder, TextEncoder });
  ctx.self = ctx;
  for (const f of files) vm.runInContext(fs.readFileSync(path.join(ROOT, dir, f), 'utf8'), ctx, { filename: f });
  return ctx;
}

const LIBS = ['constants.js', 'color-utils.js', 'filament-profiles.js', 'template-settings.js', 'converter.js'];
const current = loadScripts('extension/src/lib', [...LIBS, 'targets/a1-profiles.js', 'targets.js']).MWU1;
const original = loadScripts('original/v1.1.5/src/lib', LIBS);
const A1 = current.TARGETS.a1;

const build = (slots, opts = {}) => JSON.parse(A1.buildProjectSettings(slots, !!opts.hasSupport, opts));

test('A1 targets the Bambu Lab A1 printer with the user print profile', () => {
  const cfg = build([{ color: '#FFFFFF', type: 'eSUN - PLA+ 2025' }]);
  assert.strictEqual(cfg.printer_model, 'Bambu Lab A1');
  assert.strictEqual(cfg.printer_settings_id, 'Bambu Lab A1 0.4 nozzle');
  assert.strictEqual(cfg.print_settings_id, '0.20mm A1 - principal');
});

test('non-PETG A1 slots default to eSUN - PLA+ 2025', () => {
  assert.strictEqual(A1.defaultChoice('PLA'), 'eSUN - PLA+ 2025');
  assert.ok(A1.choices.some(c => c.value === 'eSUN - PLA+ 2025'));
});

test('each slot gets the values of its own filament profile', () => {
  const cfg = build([
    { color: '#FF0000', type: 'eSUN - PLA+ 2025' },
    { color: '#00FF00', type: 'Elegoo Rapid PETG A1' },
    { color: '#0000FF', type: 'Elegoo PLA+' },
  ]);
  assert.deepStrictEqual(cfg.filament_settings_id, ['eSUN - PLA+ 2025', 'Elegoo Rapid PETG A1', 'Elegoo PLA+']);
  assert.deepStrictEqual(cfg.filament_type, ['PLA', 'PETG', 'PLA']);
  assert.deepStrictEqual(cfg.filament_colour, ['#FF0000', '#00FF00', '#0000FF']);
  assert.deepStrictEqual(cfg.nozzle_temperature, ['220', '245', '215']);
  assert.deepStrictEqual(cfg.hot_plate_temp, ['60', '80', '55']);
  assert.deepStrictEqual(cfg.inherits_group,
    ['0.20mm Standard @BBL A1', 'eSUN PLA+ @BBL A1', 'Generic PETG @BBL A1', 'Generic PLA @BBL A1', '']);
  assert.strictEqual(cfg.different_settings_to_system.length, 5);
});

test('multi-value per-filament lists scale with the slot count', () => {
  const n = 3;
  const cfg = build(Array.from({ length: n }, () => ({ color: '#FFFFFF', type: 'eSUN - PLA+ 2025' })));
  for (const key of current.A1_DATA.per_filament_keys) assert.strictEqual(cfg[key].length, n, key);
  for (const [key, width] of Object.entries(current.A1_DATA.chunk_keys)) assert.strictEqual(cfg[key].length, n * width, key);
  assert.strictEqual(cfg.flush_volumes_matrix.length, n * n);
  assert.deepStrictEqual([0, 4, 8].map(i => cfg.flush_volumes_matrix[i]), ['0', '0', '0']);
});

test('the ironing print profile applies its own settings', () => {
  const cfg = build([{ color: '#FFFFFF', type: 'eSUN - PLA+ 2025' }], { printProfile: '0.20mm A1 - alisado eSUN' });
  assert.strictEqual(cfg.print_settings_id, '0.20mm A1 - alisado eSUN');
  assert.strictEqual(cfg.ironing_type, 'top');
  assert.strictEqual(cfg.wall_generator, 'arachne');
});

test('supports are enabled only when the source file uses them', () => {
  const slots = [{ color: '#FFFFFF', type: 'eSUN - PLA+ 2025' }];
  assert.strictEqual(build(slots, { hasSupport: true }).enable_support, '1');
  assert.notStrictEqual(build(slots).enable_support, '1');
});

test('U1 project settings are identical to v1.1.5', () => {
  const slots = [{ color: '#FF0000', type: 'PLA' }, { color: '#00FF00', type: 'PETG-HF' }];
  for (const hasSupport of [false, true]) {
    // buildProjectSettings is a script-level function in v1.1.5, so evaluate it inside that context
    const before = vm.runInContext(`buildProjectSettings(${JSON.stringify(slots)}, ${hasSupport})`, original);
    assert.strictEqual(current.TARGETS.u1.buildProjectSettings(slots, hasSupport, {}), before);
  }
});

const enc = s => new TextEncoder().encode(s);
const dec = b => new TextDecoder().decode(b);

test('A1 output declares Bambu Studio as the application (else Bambu Studio rejects the config)', () => {
  assert.strictEqual(A1.application, 'BambuStudio-02.08.02.61');
  assert.strictEqual(current.TARGETS.u1.application, null);
});

test('setApplicationMetadata replaces an existing Application entry and keeps the rest intact', () => {
  const xml = '<?xml version="1.0"?>\n<model unit="millimeter">\n <metadata name="Application">Snapmaker_Orca-2.4.0</metadata>\n <resources>ñ</resources>\n</model>';
  const out = dec(current.setApplicationMetadata(enc(xml), 'BambuStudio-02.08.02.61'));
  assert.strictEqual(out, xml.replace('Snapmaker_Orca-2.4.0', 'BambuStudio-02.08.02.61'));
});

test('setApplicationMetadata inserts the entry when the model has none', () => {
  const xml = '<?xml version="1.0"?>\n<model unit="millimeter" xmlns="x">\n <resources/>\n</model>';
  const out = dec(current.setApplicationMetadata(enc(xml), 'BambuStudio-02.08.02.61'));
  assert.strictEqual(out, xml.replace('xmlns="x">', 'xmlns="x">\n <metadata name="Application">BambuStudio-02.08.02.61</metadata>'));
});
