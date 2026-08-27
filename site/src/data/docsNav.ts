export interface DocsNavItem {
  slug: string;
  title: string;
  blurb: string;
  icon: string;
}

// Single source of truth for the docs sidebar (DocsLayout.astro) and the
// homepage card grid (index.astro) — add a row here when a new docs/<slug>.astro
// page ships so both surfaces stay in sync automatically.
export const docsNav: DocsNavItem[] = [
  { slug: 'getting-started', title: 'Getting started', blurb: 'Project layout, the <component> root tag, and the compile CLI.', icon: '🚀' },
  { slug: 'reactive-state', title: 'Reactive state', blurb: 'field / derived / state, the global store, read/watch.', icon: '🔄' },
  { slug: 'statements', title: 'Statements & expressions', blurb: 'if/else, ternary, ==/!=, chain safety, loops, try/catch, anonymous functions.', icon: '🧮' },
  { slug: 'template-and-binding', title: 'Template & binding', blurb: 'Dynamic attributes, {#if}/{#if:destroy}, {#each}, bind:.', icon: '🧩' },
  { slug: 'focus-and-navigation', title: 'Focus & navigation', blurb: 'focusable, on:key, and the cross-component LRUD focus system.', icon: '🎯' },
  { slug: 'router', title: 'Router', blurb: 'router.navigate, RouterOutlet, default-focus, the vacuum rule.', icon: '🧭' },
  { slug: 'theme', title: 'Theme', blurb: '<theme-template>/<theme>, bare theme.a.b access, switchTheme.', icon: '🎨' },
  { slug: 'classes', title: 'Classes (.flsh)', blurb: 'Reusable BrightScript-only logic: extends, override, super.', icon: '🏛️' },
  { slug: 'streams', title: 'Streams', blurb: 'Per-instance pub-sub between objects inside one component.', icon: '📡' },
  { slug: 'task-manager', title: 'Task manager', blurb: 'taskManager.run/cancel, priority queues, alerting, onResult.', icon: '⚙️' },
  { slug: 'requests', title: 'Requests', blurb: 'request Http {}, response caching, safe build/parse hooks.', icon: '🌐' },
  { slug: 'timers', title: 'Timer statements', blurb: 'setTimeout/setInterval/clearTimeout/clearInterval — JS-shaped Timer sugar.', icon: '⏱️' },
  { slug: 'animation', title: 'Animation', blurb: 'animation {} declarations, transition:/in:/out:, animate:.', icon: '🎬' },
  { slug: 'scale', title: 'Scale', blurb: 'Design-resolution-aware scaling for numbers, arrays, and AAs.', icon: '📐' },
  { slug: 'environments', title: 'Environments', blurb: 'env.<name>, environments/<name>.config.json, manifestOverrides, --env.', icon: '🌎' },
];
