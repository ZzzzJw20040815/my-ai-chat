import { normalizeGlobalSettings } from '../shared/settings.js';

export function applyMobileDisplayPreferences(settings, root = document.documentElement) {
  const { mobileDisplay } = normalizeGlobalSettings(settings);
  root.dataset.mobileDensity = mobileDisplay.density;
  root.dataset.chatTextSize = mobileDisplay.chatTextSize;
  return mobileDisplay;
}
