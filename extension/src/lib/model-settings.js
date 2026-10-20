self.MWU1 = self.MWU1 || {};

/**
 * Model parameters carried over from the source project to the target printer.
 * Bambu Studio, OrcaSlicer and Snapmaker Orca share these key names. Speeds,
 * accelerations, temperatures and G-code are never copied: they belong to the printer.
 */
self.MWU1.MODEL_SETTING_KEYS = [
  'layer_height',
  'wall_loops',
  'top_shell_layers',
  'bottom_shell_layers',
  'sparse_infill_density',
  'sparse_infill_pattern',
  'enable_support',
  'support_type',
  'support_on_build_plate_only',
  'brim_type',
  'brim_width',
  'ironing_type',
];

// Copied even when the author kept the system value: a 0.12 mm profile is a choice for the model.
const ALWAYS_COPIED = new Set(['layer_height']);

/**
 * Pick the model parameters from a parsed Bambu/Orca project_settings.config.
 * Only keys the author changed (listed in the print diff) are copied, so the
 * target profile keeps its own values for everything else.
 * @returns {Object<string, string>}
 */
self.MWU1.extractModelSettings = function(cfg) {
  const settings = {};
  if (!cfg || typeof cfg !== 'object') return settings;
  const diff = Array.isArray(cfg.different_settings_to_system) ? cfg.different_settings_to_system[0] : '';
  const changed = new Set(typeof diff === 'string' ? diff.split(';') : []);
  for (const key of self.MWU1.MODEL_SETTING_KEYS) {
    if (typeof cfg[key] !== 'string') continue;
    if (changed.has(key) || ALWAYS_COPIED.has(key)) settings[key] = cfg[key];
  }
  return settings;
};

/** Read the model parameters from a source .3mf (empty for non-Bambu/Orca files). */
self.MWU1.readModelSettings = async function(zip) {
  const file = zip.file('Metadata/project_settings.config');
  if (!file) return {};
  try {
    return self.MWU1.extractModelSettings(JSON.parse(await file.async('string')));
  } catch {
    return {};
  }
};

/**
 * Apply model parameters over a built project_settings.config JSON string and
 * mark them as changed in the print diff. Returns the input unchanged when empty.
 */
self.MWU1.applyModelSettings = function(json, settings) {
  const keys = Object.keys(settings || {});
  if (keys.length === 0) return json;
  const cfg = JSON.parse(json);
  Object.assign(cfg, settings);
  const diff = cfg.different_settings_to_system;
  if (Array.isArray(diff) && typeof diff[0] === 'string') {
    const changed = diff[0].split(';').filter(Boolean);
    for (const key of keys) if (!changed.includes(key)) changed.push(key);
    diff[0] = changed.sort().join(';');
  }
  return JSON.stringify(cfg, null, 4);
};
