export function tokenFromFragment() {
  const fragment = window.location.hash.startsWith('#') ? window.location.hash.slice(1) : window.location.hash;
  if (!fragment) return '';
  const params = new URLSearchParams(fragment);
  const namedToken = params.get('token') || params.get('access_token');
  if (namedToken) return namedToken;
  if (!fragment.includes('=')) {
    try { return decodeURIComponent(fragment); } catch (_) { return fragment; }
  }
  return '';
}
