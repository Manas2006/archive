import { defineConfig } from 'wxt';

// Chrome refuses extension scripts that contain Unicode noncharacters (U+FFFF etc.),
// which minifiers emit when they un-escape library regexes. Re-escape all non-ASCII.
function asciiOnly(code: string): string {
  return code.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\uffff]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

export default defineConfig({
  srcDir: 'src',
  vite: () => ({
    plugins: [
      {
        name: 'archive-ascii-only',
        enforce: 'post' as const,
        generateBundle(_opts: unknown, bundle: Record<string, any>) {
          for (const chunk of Object.values(bundle)) {
            if (chunk.type === 'chunk') chunk.code = asciiOnly(chunk.code);
          }
        },
      },
    ],
  }),
  modules: ['@wxt-dev/module-react'],
  // Firefox (desktop and Android) builds with `wxt build -b firefox --mv3`. WXT turns the
  // side panel entrypoint into Firefox's sidebar_action; the rest differs here.
  manifest: ({ browser }) => {
    const firefox = browser === 'firefox';
    return {
      name: 'Archive for Papers',
      description:
        'Save, annotate and organize research papers on arXiv and OpenReview. Optional AI features with your own Claude API key.',
      version: '0.2.0',
      permissions: [
        'storage',
        'unlimitedStorage',
        // Firefox has no side panel API (its sidebar needs no permission)
        ...(firefox ? [] : ['sidePanel']),
        'contextMenus',
        'alarms',
        'notifications',
        'clipboardWrite',
      ],
      host_permissions: [
        'https://arxiv.org/*',
        'https://export.arxiv.org/*',
        'https://openreview.net/*',
        'https://api.openreview.net/*',
        'https://api2.openreview.net/*',
        'https://api.semanticscholar.org/*',
        'https://dblp.org/*',
        'https://api.anthropic.com/*',
      ],
      action: { default_title: 'Archive' },
      content_security_policy: {
        extension_pages:
          "script-src 'self'; object-src 'self'; img-src 'self' data: blob: https://arxiv.org https://www.arxiv.org; form-action 'none'",
      },
      commands: {
        'save-paper': {
          suggested_key: { default: 'Alt+Shift+S' },
          description: 'Save the paper in the current tab',
        },
        // Firefox opens and closes its sidebar itself with this built-in command
        ...(firefox
          ? { _execute_sidebar_action: { suggested_key: { default: 'Alt+Shift+M' }, description: 'Open the Archive sidebar' } }
          : { 'open-side-panel': { suggested_key: { default: 'Alt+Shift+M' }, description: 'Open the Archive side panel' } }),
        'open-library': {
          suggested_key: { default: 'Alt+Shift+L' },
          description: 'Open the Archive library',
        },
      },
      ...(firefox && {
        browser_specific_settings: {
          gecko: {
            id: 'archive@manaspathak.com',
            // 140 is the first release with the data-collection consent below (older releases reject the key);
            // MV3 (109), storage.session (115) and sidebar_action all predate it
            strict_min_version: '140.0',
            // Nothing is collected for the developer. Page text and the person's own Claude API key go to
            // Anthropic only when they turn on the AI features, so those are optional and asked for then.
            data_collection_permissions: {
              required: ['none'],
              optional: ['websiteContent', 'authenticationInfo'],
            },
          },
          gecko_android: { strict_min_version: '142.0' },
        },
      }),
    };
  },
  hooks: {
    'build:manifestGenerated': (wxt, manifest) => {
      const sidebar = (manifest as { sidebar_action?: Record<string, unknown> }).sidebar_action;
      if (wxt.config.browser !== 'firefox' || !sidebar) return;
      sidebar.default_title ??= 'Archive';
      sidebar.default_icon ??= { 16: 'icon/16.png', 32: 'icon/32.png', 48: 'icon/48.png' };
      // Firefox opens a new extension's sidebar at install unless told not to; the welcome page is enough
      sidebar.open_at_install = false;
    },
  },
});
