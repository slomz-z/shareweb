// ShareWeb Theme Management (System, Dark, Light)
import { state } from './state.js';
import { saveUserSettingsToServer } from './settings.js';

export function initTheme() {
  try { localStorage.removeItem('shareweb-theme'); } catch {}
  setTheme(state.settings?.theme || 'system', false);
}

export function setTheme(theme, save = true) {
  state.settings = state.settings || {};
  state.settings.theme = theme;
  if (save) {
    saveUserSettingsToServer({ theme });
  }
  if (theme === 'system') {
    document.documentElement?.removeAttribute('data-theme');
  } else {
    document.documentElement?.setAttribute('data-theme', theme);
  }
  
  // Update button active states in settings
  const buttons = ['light', 'dark', 'system'];
  buttons.forEach(thm => {
    const btn = document.getElementById(`theme-btn-${thm}`);
    if (btn) btn.classList.toggle('active', thm === theme);
  });
}
