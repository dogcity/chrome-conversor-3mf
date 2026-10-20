const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');

function loadScripts(dir, files) {
  const ctx = vm.createContext({ TextDecoder, TextEncoder });
  ctx.self = ctx;
  for (const f of files) vm.runInContext(fs.readFileSync(path.join(ROOT, dir, f), 'utf8'), ctx, { filename: f });
  return ctx;
}

const M = loadScripts('extension/src/lib', [
  'constants.js', 'color-utils.js', 'filament-profiles.js', 'template-settings.js', 'converter.js',
  'targets/a1-profiles.js', 'targets.js', 'model-settings.js',
]).C3MF;
const plain = v => JSON.parse(JSON.stringify(v));

// Shape of an Orca/Snapmaker U1 project: the print diff lists what the author changed.
const SOURCE = {
  layer_height: '0.12',
  initial_layer_print_height: '0.25',
  wall_loops: '3',
  top_shell_layers: '5',
  sparse_infill_density: '10%',
  sparse_infill_pattern: 'gyroid',
  brim_type: 'no_brim',
  outer_wall_speed: '300',
  nozzle_temperature: ['220'],
  different_settings_to_system: ['brim_type;outer_wall_speed;sparse_infill_density;sparse_infill_pattern;wall_loops', '', ''],
};

test('A1 picks the PETG preset for PETG filaments and eSUN for everything else', () => {
  const pick = M.TARGETS.a1.defaultChoice;
  assert.strictEqual(pick('PETG'), 'Elegoo Rapid PETG A1');
  assert.strictEqual(pick('PETG-HF'), 'Elegoo Rapid PETG A1');
  assert.strictEqual(pick('PLA'), 'eSUN - PLA+ 2025');
  assert.strictEqual(pick('ABS'), 'eSUN - PLA+ 2025');
  assert.strictEqual(pick(undefined), 'eSUN - PLA+ 2025');
});

test('copies the model parameters the author changed, plus layer height', () => {
  assert.deepStrictEqual(plain(M.extractModelSettings(SOURCE)), {
    layer_height: '0.12',
    wall_loops: '3',
    sparse_infill_density: '10%',
    sparse_infill_pattern: 'gyroid',
    brim_type: 'no_brim',
  });
});

test('never copies speeds, temperatures, or unchanged parameters', () => {
  const s = M.extractModelSettings(SOURCE);
  assert.ok(!('outer_wall_speed' in s));
  assert.ok(!('nozzle_temperature' in s));
  assert.ok(!('top_shell_layers' in s));
  assert.ok(!('initial_layer_print_height' in s));
});

test('a source without Bambu/Orca settings yields nothing to copy', () => {
  assert.deepStrictEqual(plain(M.extractModelSettings(null)), {});
  assert.deepStrictEqual(plain(M.extractModelSettings({ filament_colour: ['#FFF'] })), {});
});

test('applies the parameters over the A1 profile and marks them as changed', () => {
  const built = M.TARGETS.a1.buildProjectSettings([{ color: '#FFFFFF', type: 'eSUN - PLA+ 2025' }], false, {});
  const cfg = JSON.parse(M.applyModelSettings(built, M.extractModelSettings(SOURCE)));
  assert.strictEqual(cfg.layer_height, '0.12');
  assert.strictEqual(cfg.wall_loops, '3');
  assert.strictEqual(cfg.sparse_infill_pattern, 'gyroid');
  assert.strictEqual(cfg.brim_type, 'no_brim');
  assert.strictEqual(cfg.print_settings_id, '0.20mm A1 - principal');
  const diff = cfg.different_settings_to_system[0].split(';');
  for (const k of ['layer_height', 'wall_loops', 'sparse_infill_pattern', 'brim_type']) assert.ok(diff.includes(k), k);
  assert.strictEqual(new Set(diff).size, diff.length);
});

test('with nothing to copy the project settings stay byte-identical', () => {
  const built = M.TARGETS.u1.buildProjectSettings([{ color: '#FFFFFF', type: 'PLA' }], false);
  assert.strictEqual(M.applyModelSettings(built, {}), built);
});
