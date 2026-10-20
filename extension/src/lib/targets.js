self.MWU1 = self.MWU1 || {};

/**
 * Conversion targets. Each slot holds { color, type }, where `type` is one of the
 * target's `choices` values: a filament type for the U1, a filament preset name for the A1.
 */

/** Pick the U1 filament type closest to the source file's type string. */
function defaultU1Type(original) {
  const types = self.MWU1.FILAMENT_PROFILES || [];
  if (!original || types.length === 0) return types[0]?.type || 'PLA';
  const up = original.toUpperCase();
  for (const ft of types) {
    if (up.includes(ft.type.toUpperCase().replace(/-HF$/, '').replace(/-/g, ''))) return ft.type;
  }
  return types[0]?.type || 'PLA';
}

const A1_DEFAULT_FILAMENT = 'eSUN - PLA+ 2025';
const A1_DEFAULT_PRINT_PROFILE = '0.20mm A1 - principal';
// Purge volume between two different filaments. Bambu Studio derives it from the color
// pair; this fixed value errs on the safe side and can be recalculated in the slicer.
const A1_DEFAULT_FLUSH = '400';

/**
 * Build project_settings.config for the Bambu Lab A1 from the user's presets.
 * Every slot takes the values of its own filament preset.
 */
function buildA1ProjectSettings(outputSlots, hasSupport, { printProfile } = {}) {
  const data = self.MWU1.A1_DATA;
  const print = data.print_profiles[printProfile] || data.print_profiles[A1_DEFAULT_PRINT_PROFILE];
  const presets = outputSlots.map(s => data.filament_profiles[s.type] || data.filament_profiles[A1_DEFAULT_FILAMENT]);

  const cfg = JSON.parse(JSON.stringify(data.base));
  Object.assign(cfg, JSON.parse(JSON.stringify(print.delta)));

  for (const key of data.per_filament_keys) cfg[key] = presets.map(p => p.values[key]);
  for (const key of Object.keys(data.chunk_keys)) cfg[key] = presets.flatMap(p => p.chunks[key]);
  cfg.filament_colour = outputSlots.map(s => s.color.toUpperCase());

  const n = presets.length;
  cfg.flush_volumes_matrix = [];
  for (let from = 0; from < n; from++) {
    for (let to = 0; to < n; to++) cfg.flush_volumes_matrix.push(from === to ? '0' : A1_DEFAULT_FLUSH);
  }

  cfg.inherits_group = [print.inherits, ...presets.map(p => p.inherits), data.printer_inherits];
  cfg.different_settings_to_system = [print.diff, ...presets.map(p => p.diff), data.printer_diff];

  if (hasSupport) cfg.enable_support = '1';

  return JSON.stringify(cfg, null, 4);
}

self.MWU1.TARGETS = {
  u1: {
    id: 'u1',
    label: 'Snapmaker U1',
    suffix: '-U1',
    printerModelId: 'Snapmaker U1',
    application: null,
    minFilaments: self.MWU1.MIN_FILAMENTS,
    slotsLabel: 'Slots de la U1',
    choices: (self.MWU1.FILAMENT_PROFILES || []).map(p => ({ value: p.type, label: p.type })),
    printProfiles: [],
    defaultChoice: defaultU1Type,
    filamentType: slot => slot.type,
    buildProjectSettings: (slots, hasSupport) => buildProjectSettings(slots, hasSupport),
  },
  a1: {
    id: 'a1',
    label: 'Bambu A1',
    suffix: '-A1',
    printerModelId: null,
    application: `BambuStudio-${self.MWU1.A1_DATA.source.application}`,
    minFilaments: 0,
    slotsLabel: 'Slots AMS Lite de la A1',
    choices: Object.keys(self.MWU1.A1_DATA.filament_profiles).map(name => ({ value: name, label: name })),
    printProfiles: Object.keys(self.MWU1.A1_DATA.print_profiles),
    defaultChoice: () => A1_DEFAULT_FILAMENT,
    filamentType: slot => (self.MWU1.A1_DATA.filament_profiles[slot.type] || {}).type || 'PLA',
    buildProjectSettings: buildA1ProjectSettings,
  },
};
