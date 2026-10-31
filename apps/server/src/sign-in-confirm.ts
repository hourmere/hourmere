// An emailed sign-in link opens this self-contained page. Only pressing its submit button
// consumes the link, so email scanners can safely open it. Language changes never navigate.
import { createHash } from 'node:crypto'
import { MAGIC_LINK_CONFIRM_PATH, MAGIC_LINK_VERIFY_PARAMS } from '@hourmere/auth'
import {
  type InterfaceLanguage,
  LANGUAGE_COOKIE,
  resolveAdminLanguage,
} from '@hourmere/core/language'
import type { Context } from 'hono'
import { confirmationCatalogues, confirmationLocales } from './i18n/confirmation.ts'

const escapeHtml = (value: string) =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')

export { MAGIC_LINK_CONFIRM_PATH }

// The fragment never reaches the server. Only the explicit sign-in GET form carries its
// existing Better Auth parameters; the language menu cannot submit or rewrite that form.
const SCRIPT = `
const params = new URLSearchParams(location.hash.slice(1));
const form = document.getElementById('confirm');
if (params.get('token')) {
  for (const name of ${JSON.stringify(MAGIC_LINK_VERIFY_PARAMS)}) {
    const value = params.get(name);
    if (value === null) continue;
    const input = document.createElement('input');
    input.type = 'hidden';
    input.name = name;
    input.value = value;
    form.append(input);
  }
  form.hidden = false;
} else {
  document.getElementById('incomplete').hidden = false;
}
const languages = ${JSON.stringify(confirmationCatalogues).replaceAll('<', '\\u003c')};
const localeNames = ${JSON.stringify(Object.fromEntries(confirmationLocales.map(({ code, nativeName }) => [code, nativeName]))).replaceAll('<', '\\u003c')};
const languagePicker = document.getElementById('language-picker');
const languageTrigger = document.getElementById('language-trigger');
const languageMenu = document.getElementById('language-menu');
const languageOptions = languageMenu ? Array.from(languageMenu.querySelectorAll('[role="menuitemradio"]')) : [];
function closeLanguageMenu(returnFocus = false) {
  languageMenu.hidden = true;
  languageTrigger.setAttribute('aria-expanded', 'false');
  if (returnFocus) languageTrigger.focus();
}
function openLanguageMenu() {
  languageMenu.hidden = false;
  languageTrigger.setAttribute('aria-expanded', 'true');
  languageOptions.find(option => option.getAttribute('aria-checked') === 'true')?.focus();
}
function setLanguage(language) {
  if (!Object.hasOwn(languages, language)) return;
  const words = languages[language];
  document.documentElement.lang = language;
  document.documentElement.dir = 'ltr';
  document.title = words.title;
  document.getElementById('page-title').textContent = words.title;
  document.getElementById('confirm-instruction').textContent = words.instruction;
  document.getElementById('scanner-note').textContent = words.note;
  document.getElementById('incomplete').textContent = words.incomplete;
  const javascriptNote = document.getElementById('javascript-note');
  if (javascriptNote) javascriptNote.textContent = words.javascript;
  document.querySelector('#confirm button[type="submit"]').textContent = words.title;
  languageTrigger.setAttribute('aria-label', words.language);
  document.getElementById('language-current').textContent = localeNames[language];
  document.getElementById('language-current').setAttribute('lang', language);
  for (const option of languageOptions) {
    const selected = option.getAttribute('lang') === language;
    option.setAttribute('aria-checked', String(selected));
    option.querySelector('[data-language-check]').textContent = selected ? '✓' : '';
  }
  try { localStorage.setItem(${JSON.stringify(LANGUAGE_COOKIE)}, language); } catch {}
  try {
    document.cookie = ${JSON.stringify(`${LANGUAGE_COOKIE}=`)} + language + '; Path=/; SameSite=Lax; Max-Age=31536000' + (location.protocol === 'https:' ? '; Secure' : '');
  } catch {}
}
if (languagePicker && languageTrigger && languageMenu) {
  languageTrigger.addEventListener('click', () => {
    if (languageMenu.hidden) openLanguageMenu();
    else closeLanguageMenu();
  });
  languageTrigger.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      openLanguageMenu();
    } else if (event.key === 'Escape' && !languageMenu.hidden) {
      event.preventDefault();
      closeLanguageMenu(true);
    }
  });
  for (const option of languageOptions) {
    option.addEventListener('click', () => {
      setLanguage(option.getAttribute('lang'));
      closeLanguageMenu(true);
    });
  }
  languageMenu.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      closeLanguageMenu(true);
    } else if (event.key === 'Tab' && event.shiftKey) {
      event.preventDefault();
      closeLanguageMenu(true);
    } else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      const current = languageOptions.indexOf(document.activeElement);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? languageOptions.length - 1 :
        (current + (event.key === 'ArrowDown' ? 1 : -1) + languageOptions.length) % languageOptions.length;
      languageOptions[next].focus();
    }
  });
  document.addEventListener('pointerdown', (event) => {
    if (!languagePicker.contains(event.target)) closeLanguageMenu();
  });
  document.addEventListener('focusin', (event) => {
    if (!languagePicker.contains(event.target)) closeLanguageMenu();
  });
}
`

// Minimal copies of apps/web/src/styles.css tokens: this page must load no external assets.
const STYLE = `
:root {
  --cobalt: #1f4fd8;
  --bg: #f7f9fe;
  --surface: #ffffff;
  --text: #0e1015;
  --muted: #475066;
  --border: #d6deef;
  --border-strong: #7a8ab0;
  --accent: var(--cobalt);
  --accent-hover: #1a43b8;
  --accent-text: #ffffff;
  --accent-soft: #eaf0fd;
  --accent-soft-text: #0a1e4a;
  --focus: var(--cobalt);
  --mark: var(--cobalt);
  --radius: 10px;
  --radius-small: 6px;
  --space-2: 8px;
  --space-3: 12px;
  --space-4: 16px;
  --space-5: 24px;
  --space-6: 32px;
  --shadow: 0 1px 2px rgb(14 16 21 / 6%), 0 2px 8px rgb(14 16 21 / 6%);
  color-scheme: light;
  font-family: system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", sans-serif;
  line-height: 1.55;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0e1015;
    --surface: #151c2e;
    --text: #e9edf7;
    --muted: #a9b3c9;
    --border: #283252;
    --border-strong: #64719a;
    --accent: #3d68e6;
    --accent-hover: #3360e0;
    --accent-soft: #16244a;
    --accent-soft-text: #dbe5ff;
    --focus: #8faeff;
    --mark: #ffffff;
    --shadow: none;
    color-scheme: dark;
  }
}
:lang(zh) {
  font-family: "PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", sans-serif;
}
*, *::before, *::after { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; text-size-adjust: 100%; }
body { margin: 0; background: var(--bg); color: var(--text); font-size: 1rem; overflow-wrap: anywhere; }
.centered { display: grid; place-items: center; min-height: 100vh; min-height: 100svh; min-width: 0; padding: var(--space-5) var(--space-4); }
.card {
  width: 100%; max-width: 420px; min-width: 0; padding: var(--space-6) var(--space-5);
  background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius);
  box-shadow: var(--shadow);
}
.card-header { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: var(--space-3); }
.logo { display: inline-flex; align-items: center; gap: var(--space-2); color: var(--text); }
.logo svg { display: block; flex-shrink: 0; color: var(--mark); }
.logo-word { font-size: 1.2rem; font-weight: 800; letter-spacing: -0.02em; }
h1 { font-size: 1.5rem; line-height: 1.25; letter-spacing: -0.01em; margin: var(--space-5) 0 var(--space-4); }
p { margin: 0 0 var(--space-3); }
button {
  display: inline-flex; align-items: center; justify-content: center;
  min-height: 42px; padding: var(--space-2) var(--space-4);
  border: 1px solid var(--border-strong); border-radius: var(--radius-small);
  background: var(--surface); color: var(--text); font: inherit; font-size: max(16px, 1rem); font-weight: 600;
  line-height: 1.2; cursor: pointer;
}
#confirm button[type="submit"] { width: 100%; border-color: var(--accent); background: var(--accent); color: var(--accent-text); }
@media (hover: hover) {
  button:hover { background: var(--accent-soft); }
  #confirm button[type="submit"]:hover { border-color: var(--accent-hover); background: var(--accent-hover); }
}
@media (pointer: coarse) {
  button { min-height: 44px; }
}
:focus-visible { outline: 3px solid var(--focus); outline-offset: 2px; }
.note { color: var(--muted); font-size: 0.875rem; margin-bottom: 0; }
.language-picker { position: relative; min-width: 0; max-width: 100%; }
.language-trigger { gap: 6px; min-height: 44px; max-width: 100%; padding: 6px 8px; font-size: 0.875rem; }
.language-trigger svg { flex-shrink: 0; }
.language-menu {
  position: absolute; z-index: 1; top: calc(100% + 6px); right: 0;
  width: max-content; min-width: 100%; max-width: min(16rem, calc(100vw - 64px)); padding: 4px;
  background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-small); box-shadow: var(--shadow);
}
.language-option { display: flex; justify-content: space-between; gap: var(--space-3); min-height: 44px; width: 100%; padding: 8px; border: 0; font-size: 0.875rem; text-align: start; }
.language-option[aria-checked="true"] { color: var(--accent-soft-text); background: var(--accent-soft); }
[hidden] { display: none !important; }
`

const hash = (source: string) => `'sha256-${createHash('sha256').update(source).digest('base64')}'`
const CSP = [
  "default-src 'none'",
  `script-src ${hash(SCRIPT)}`,
  `style-src ${hash(STYLE)}`,
  "form-action 'self'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join('; ')

function page(language: InterfaceLanguage) {
  const words = confirmationCatalogues[language]
  return `<!doctype html>
<html lang="${language}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(words.title)}</title>
<style>${STYLE}</style>
</head>
<body>
<main class="centered">
<div class="card">
<header class="card-header">
<span class="logo">
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="32" height="32" aria-hidden="true" focusable="false">
<defs><clipPath id="hourmere-wave"><circle cx="50" cy="50" r="21"/></clipPath></defs>
<circle cx="50" cy="50" r="32" fill="none" stroke="currentColor" stroke-width="12"/>
<path clip-path="url(#hourmere-wave)" fill="currentColor" d="M18 60 C30 53, 40 53, 50 60 S70 67, 82 60 L82 90 L18 90 Z"/>
<path d="M50 46 L50 31" fill="none" stroke="currentColor" stroke-width="6" stroke-linecap="round"/>
<path d="M50 46 L62 39" fill="none" stroke="#f2a33a" stroke-width="6" stroke-linecap="round"/>
</svg>
<span class="logo-word">Hourmere</span>
</span>
<div id="language-picker" class="language-picker">
<button id="language-trigger" class="language-trigger" type="button" aria-label="${escapeHtml(words.language)}" aria-haspopup="menu" aria-expanded="false" aria-controls="language-menu">
<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a18 18 0 0 1 0 18 18 18 0 0 1 0-18Z"/></svg>
<span id="language-current" lang="${language}">${escapeHtml(confirmationLocales.find(({ code }) => code === language)?.nativeName ?? '')}</span>
</button>
<div id="language-menu" class="language-menu" role="menu" aria-labelledby="language-trigger" hidden>
${confirmationLocales.map(({ code, nativeName }) => `<button id="language-option-${code}" class="language-option" type="button" role="menuitemradio" lang="${code}" aria-checked="${language === code}" tabindex="-1"><span>${escapeHtml(nativeName)}</span><span data-language-check aria-hidden="true">${language === code ? '✓' : ''}</span></button>`).join('\n')}
</div>
</div>
</header>
<h1 id="page-title">${escapeHtml(words.title)}</h1>
<form id="confirm" method="get" action="/api/auth/magic-link/verify" hidden>
<p id="confirm-instruction">${escapeHtml(words.instruction)}</p>
<p><button type="submit">${escapeHtml(words.title)}</button></p>
<p id="scanner-note" class="note">${escapeHtml(words.note)}</p>
</form>
<p id="incomplete" hidden>${escapeHtml(words.incomplete)}</p>
<noscript><p id="javascript-note">${escapeHtml(words.javascript)}</p></noscript>
</div>
</main>
<script>${SCRIPT}</script>
</body>
</html>
`
}

/** GET/HEAD renders only static language data. Opening a link creates no preference cookie. */
export function signInConfirmPage(c: Context) {
  const language = resolveAdminLanguage({
    cookie: c.req.header('Cookie'),
    acceptLanguage: c.req.header('Accept-Language'),
  })
  return c.html(page(language), 200, {
    'Content-Security-Policy': CSP,
    'Referrer-Policy': 'no-referrer',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    Vary: 'Accept-Language, Cookie',
  })
}
