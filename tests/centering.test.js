const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const ctx = vm.createContext({ TextDecoder, TextEncoder });
ctx.self = ctx;
vm.runInContext(fs.readFileSync(path.join(ROOT, 'extension/src/lib/centering.js'), 'utf8'), ctx);
const M = ctx.C3MF;

const A1_BED = ['0x0', '256x0', '256x256', '0x256'];
const U1_BED = ['0.5x1', '270.5x1', '270.5x271', '0.5x271'];

/** Minimal stand-in for a JSZip instance holding text entries. */
function fakeZip(files) {
  return {
    file: name => (name in files ? { async: async () => files[name] } : null),
  };
}

const cube = (x0, y0, x1, y1) => `<mesh><vertices>
  <vertex x="${x0}" y="${y0}" z="0"/><vertex x="${x1}" y="${y0}" z="0"/>
  <vertex x="${x1}" y="${y1}" z="2"/><vertex x="${x0}" y="${y1}" z="2"/>
</vertices><triangles/></mesh>`;

const model = (objects, items) => `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06">
 <metadata name="Application">llavero-de-texto</metadata>
 <resources>${objects}</resources>
 <build>${items}</build>
</model>`;

const bytes = s => new TextEncoder().encode(s);
const text = b => new TextDecoder().decode(b);
const itemTransforms = s => [...s.matchAll(/<item\b[^>]*>/g)].map(m => (m[0].match(/transform="([^"]*)"/) || [])[1]);

test('moves a keychain exported around the origin to the center of the A1 bed', async () => {
  const src = model(`<object id="1" type="model">${cube(-40, -10, 40, 10)}</object>`, '<item objectid="1" printable="1"/>');
  const out = text(await M.centerOnBed(fakeZip({}), bytes(src), A1_BED));
  assert.deepStrictEqual(itemTransforms(out), ['1 0 0 0 1 0 0 0 1 128 128 0']);
});

test('recenters an A1-centered object on the offset U1 bed', async () => {
  const src = model(`<object id="1" type="model">${cube(-5, -5, 5, 5)}</object>`,
    '<item objectid="1" transform="1 0 0 0 1 0 0 0 1 128 128 1.45" printable="1"/>');
  const out = text(await M.centerOnBed(fakeZip({}), bytes(src), U1_BED));
  assert.deepStrictEqual(itemTransforms(out), ['1 0 0 0 1 0 0 0 1 135.5 136 1.45']);
});

test('keeps the relative layout and rotations, measuring meshes in component files', async () => {
  const objects = `<object id="2" type="model"><components>
      <component p:path="/3D/Objects/object_1.model" objectid="1" transform="1 0 0 0 1 0 0 0 1 0 0 0"/>
    </components></object>
    <object id="4" type="model"><components>
      <component p:path="/3D/Objects/object_1.model" objectid="1" transform="1 0 0 0 1 0 0 0 1 0 0 0"/>
    </components></object>`;
  // Two 10 mm squares: one at x 0..10, one rotated 90° at x 40..50 → block spans x 0..50, y 0..10.
  const items = '<item objectid="2" transform="1 0 0 0 1 0 0 0 1 5 5 0" printable="1"/>'
    + '<item objectid="4" transform="0 1 0 -1 0 0 0 0 1 45 5 0" printable="1"/>';
  const zip = fakeZip({ '3D/Objects/object_1.model': model(`<object id="1" type="model">${cube(-5, -5, 5, 5)}</object>`, '') });
  const out = text(await M.centerOnBed(zip, bytes(model(objects, items)), A1_BED));
  assert.deepStrictEqual(itemTransforms(out), [
    '1 0 0 0 1 0 0 0 1 108 128 0',
    '0 1 0 -1 0 0 0 0 1 148 128 0',
  ]);
});

test('leaves files with several plates untouched', async () => {
  const src = bytes(model(`<object id="1" type="model">${cube(-5, -5, 5, 5)}</object>`, '<item objectid="1" printable="1"/>'));
  const zip = fakeZip({ 'Metadata/model_settings.config': '<config><plate></plate><plate></plate></config>' });
  assert.strictEqual(await M.centerOnBed(zip, src, A1_BED), src);
});

test('leaves the model untouched when it is already centered or the bed is unknown', async () => {
  const src = bytes(model(`<object id="1" type="model">${cube(-5, -5, 5, 5)}</object>`,
    '<item objectid="1" transform="1 0 0 0 1 0 0 0 1 128 128 0" printable="1"/>'));
  assert.strictEqual(await M.centerOnBed(fakeZip({}), src, A1_BED), src);
  assert.strictEqual(await M.centerOnBed(fakeZip({}), src, undefined), src);
});
