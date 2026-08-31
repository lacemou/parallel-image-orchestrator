export function validatePreflight(input) {
  if (!input.userConfirmedLogin) return { ok: false, reason: 'login_not_confirmed' };
  if (!/^https:\/\/chatgpt\.com\/g\/[^/]+\/project\/?$/.test(input.projectUrl || '')) return { ok: false, reason: 'invalid_project_url' };
  if (!input.composerVisible) return { ok: false, reason: 'composer_not_visible' };
  return { ok: true, reason: null };
}
