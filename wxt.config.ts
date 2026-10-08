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
        name: 'marginalia-ascii-only',
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
  manifest: {
    name: 'Marginalia',
    description:
      'Save, annotate and organize research papers on arXiv and OpenReview. Optional AI features with your own Claude API key.',
    version: '0.2.0',
    permissions: [
      'storage',
      'unlimitedStorage',
      'sidePanel',
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
    action: { default_title: 'Marginalia' },
    content_security_policy: {
      extension_pages:
        "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'; img-src 'self' data: blob: https://arxiv.org https://www.arxiv.org; form-action 'none'",
    },
    commands: {
      'save-paper': {
        suggested_key: { default: 'Alt+Shift+S' },
        description: 'Save the paper in the current tab',
      },
      'open-side-panel': {
        suggested_key: { default: 'Alt+Shift+M' },
        description: 'Open the Marginalia side panel',
      },
      'open-library': {
        suggested_key: { default: 'Alt+Shift+L' },
        description: 'Open the Marginalia library',
      },
    },
  },
});
