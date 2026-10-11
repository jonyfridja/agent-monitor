// Apply the saved theme before first paint (no dark flash for light-theme users). A file, not inline: the CSP forbids inline scripts.
try {
  var p = JSON.parse(localStorage.getItem('am.prefs') || 'null') || {};
  var t = p.theme === 'light' || p.theme === 'dark' ? p.theme : (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
  document.documentElement.setAttribute('data-theme', t);
} catch (e) {}
