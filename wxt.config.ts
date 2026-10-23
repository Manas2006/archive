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
        'Read, highlight, sort and cite papers from arXiv and OpenReview. Syncs to your phone and iPad. Optional AI with your own Claude key.',
      version: '0.3.0',
      permissions: [
        'storage',
        'unlimitedStorage',
        // Firefox has no side panel API (its sidebar needs no permission)
        ...(firefox ? [] : ['sidePanel']),
        'contextMenus',
        'alarms',
        'notifications',
        'clipboardWrite',
        // Google sign-in for the optional Drive features. Chrome asks for it only when you click
        // Connect; Firefox doesn't accept it as optional, and it shows no install warning there.
        ...(firefox ? ['identity'] : []),
      ],
      ...(firefox ? {} : { optional_permissions: ['identity'] }),
      // The Drive API allows cross-origin requests, so these are only requested on Connect, to be safe.
      optional_host_permissions: ['https://www.googleapis.com/*', 'https://oauth2.googleapis.com/*'],
      host_permissions: [
        'https://arxiv.org/*',
        'https://export.arxiv.org/*',
        'https://openreview.net/*',
        'https://api.openreview.net/*',
        'https://api2.openreview.net/*',
        'https://api.semanticscholar.org/*',
        'https://dblp.org/*',
        'https://api.anthropic.com/*',
        // Firefox lets people grant or revoke hosts one by one; the content script also runs here
        ...(firefox ? ['https://www.arxiv.org/*'] : []),
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
            // Nothing goes to the developer. The ids and titles of papers you save go to Semantic Scholar,
            // DBLP and OpenReview to look them up (browsing activity). Page text and your own Claude API key
            // go to Anthropic only when you turn on AI, and PDFs go to your Google Drive only when you
            // connect it, so those are optional and asked for at that moment.
            data_collection_permissions: {
              required: ['browsingActivity'],
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
