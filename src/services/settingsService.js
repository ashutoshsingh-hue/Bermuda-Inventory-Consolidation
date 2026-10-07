/* ===== Bermuda Sort Station — layout settings admin (PLAN.md §5.5, pilot Settings tab) ===== */
import { planCap, locationsInUse, validateLayoutSettings, updateLayoutSettings } from '../core/index.js';

export function createSettingsService({ app, persist }) {
  function getLayout() {
    return { settings: app.st.settings, planCapacity: planCap(app.st.settings), locked: locationsInUse(app.st) };
  }

  function updateLayout(input) {
    const validated = validateLayoutSettings(input);
    if (!validated.ok) return { ok: false, errors: validated.errors };
    const result = updateLayoutSettings(app.st, validated.settings);
    if (!result.ok) return result;
    persist.persistLayoutChange(app.st);
    return { ok: true, settings: app.st.settings, planCapacity: planCap(app.st.settings) };
  }

  return { getLayout, updateLayout };
}
