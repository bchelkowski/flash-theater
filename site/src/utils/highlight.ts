import { createHighlighter, type Highlighter } from 'shiki';

let _h: Highlighter | null = null;
let _initPromise: Promise<Highlighter> | null = null;

function initHighlighter(): Promise<Highlighter> {
  if (_initPromise) return _initPromise;
  _initPromise = createHighlighter({
    themes: ['github-dark'],
    // No dedicated .thr TextMate grammar exists (yet) — .thr's <script>
    // region is close enough to a curly-brace language and its template is
    // valid XML, so 'xml' gives a reasonable approximation for now.
    langs: ['xml', 'typescript', 'javascript', 'json', 'jsonc', 'bash', 'shell'],
  }).then((h) => {
    _h = h;
    return h;
  });
  return _initPromise;
}

async function getHighlighter(): Promise<Highlighter> {
  if (_h) return _h;
  return initHighlighter();
}

export async function highlight(code: string, lang = 'xml'): Promise<string> {
  const h = await getHighlighter();
  return h.codeToHtml(code.trim(), { lang, theme: 'github-dark' });
}
