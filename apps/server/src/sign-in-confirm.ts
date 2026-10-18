// An emailed sign-in link opens this self-contained page. Only pressing its submit button
// consumes the link, so email scanners can safely open it. Language changes never navigate.
import { createHash } from 'node:crypto'
import { MAGIC_LINK_CONFIRM_PATH, MAGIC_LINK_VERIFY_PARAMS } from '@hourmere/auth'
import {
  acceptLanguage,
  cookieLanguage,
  type InterfaceLanguage,
  LANGUAGE_COOKIE,
} from '@hourmere/core/language'
import type { Context } from 'hono'

export { MAGIC_LINK_CONFIRM_PATH }

interface ConfirmationWords {
  title: string
  instruction: string
  note: string
  incomplete: string
  javascript: string
  language: string
}

const WORDS = {
  en: {
    title: 'Sign in to Hourmere',
    instruction: 'Press the button to finish signing in.',
    note: 'This extra step keeps email security scanners, which open links to check them, from using up your sign-in link.',
    incomplete:
      'This sign-in link is incomplete. Open the whole link from the email, or ask for a new one.',
    javascript:
      'Signing in needs JavaScript. Turn it on for this page, then open the link from the email again.',
    language: 'Interface language',
  },
  'zh-CN': {
    title: '登录 Hourmere',
    instruction: '点击按钮完成登录。',
    note: '此步骤可防止邮件安全扫描程序在检查链接时提前用掉你的一次性登录链接。',
    incomplete: '此登录链接不完整。请打开邮件中的完整链接，或重新申请登录链接。',
    javascript: '登录需要 JavaScript。请为此页面启用 JavaScript，然后重新打开邮件中的链接。',
    language: '界面语言',
  },
} satisfies Record<InterfaceLanguage, ConfirmationWords>

// The fragment never reaches the server. Only the explicit sign-in GET form carries its
// existing Better Auth parameters; language buttons cannot submit or rewrite that form.
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
const languages = ${JSON.stringify(WORDS)};
function setLanguage(language) {
  if (language !== 'en' && language !== 'zh-CN') return;
  const words = languages[language];
  document.documentElement.lang = language;
  document.title = words.title;
  document.getElementById('page-title').textContent = words.title;
  document.getElementById('confirm-instruction').textContent = words.instruction;
  document.getElementById('scanner-note').textContent = words.note;
  document.getElementById('incomplete').textContent = words.incomplete;
  const javascriptNote = document.getElementById('javascript-note');
  if (javascriptNote) javascriptNote.textContent = words.javascript;
  document.querySelector('#confirm button[type="submit"]').textContent = words.title;
  document.getElementById('language-controls').setAttribute('aria-label', words.language);
  document.getElementById('language-en').setAttribute('aria-pressed', String(language === 'en'));
  document.getElementById('language-zh').setAttribute('aria-pressed', String(language === 'zh-CN'));
  try { localStorage.setItem(${JSON.stringify(LANGUAGE_COOKIE)}, language); } catch {}
  try {
    document.cookie = ${JSON.stringify(`${LANGUAGE_COOKIE}=`)} + language + '; Path=/; SameSite=Lax; Max-Age=31536000' + (location.protocol === 'https:' ? '; Secure' : '');
  } catch {}
}
document.getElementById('language-en')?.addEventListener('click', () => setLanguage('en'));
document.getElementById('language-zh')?.addEventListener('click', () => setLanguage('zh-CN'));
`

const STYLE = `
:root { color-scheme: light dark; font-family: system-ui, sans-serif; line-height: 1.5; }
body { margin: 0; padding: 48px 16px; }
main { max-width: 420px; margin: 0 auto; }
h1 { font-size: 1.5rem; margin: 0 0 16px; }
button { font: inherit; font-weight: 600; padding: 10px 20px; border: 0; border-radius: 6px;
  background: CanvasText; color: Canvas; cursor: pointer; }
.note { color: GrayText; font-size: 0.875rem; }
.languages { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 24px; }
.languages button { padding: 6px 10px; background: Canvas; color: CanvasText; border: 1px solid GrayText; }
.languages button[aria-pressed="true"] { outline: 2px solid CanvasText; outline-offset: 2px; }
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
  const words = WORDS[language]
  return `<!doctype html>
<html lang="${language}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${words.title}</title>
<style>${STYLE}</style>
</head>
<body>
<main>
<div class="languages" id="language-controls" role="group" aria-label="${words.language}">
<button type="button" id="language-en" lang="en" aria-pressed="${language === 'en'}">English</button>
<button type="button" id="language-zh" lang="zh-CN" aria-pressed="${language === 'zh-CN'}">简体中文</button>
</div>
<h1 id="page-title">${words.title}</h1>
<form id="confirm" method="get" action="/api/auth/magic-link/verify" hidden>
<p id="confirm-instruction">${words.instruction}</p>
<p><button type="submit">${words.title}</button></p>
<p id="scanner-note" class="note">${words.note}</p>
</form>
<p id="incomplete" hidden>${words.incomplete}</p>
<noscript><p id="javascript-note">${words.javascript}</p></noscript>
</main>
<script>${SCRIPT}</script>
</body>
</html>
`
}

/** GET/HEAD renders only static language data. Opening a link creates no preference cookie. */
export function signInConfirmPage(c: Context) {
  const language =
    cookieLanguage(c.req.header('Cookie')) ?? acceptLanguage(c.req.header('Accept-Language'))
  return c.html(page(language), 200, {
    'Content-Security-Policy': CSP,
    'Referrer-Policy': 'no-referrer',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    Vary: 'Accept-Language, Cookie',
  })
}
