import { defineContentScript } from 'wxt/utils/define-content-script';
import { createShadowRootUi } from 'wxt/utils/content-script-ui/shadow-root';
import { createRoot, type Root } from 'react-dom/client';
import '@/assets/tailwind.css';
import { HIGHLIGHT_CSS } from '@/lib/anchoring/highlighter';
import { App } from './App';

export default defineContentScript({
  matches: [
    'https://arxiv.org/abs/*',
    'https://arxiv.org/html/*',
    'https://www.arxiv.org/abs/*',
    'https://www.arxiv.org/html/*',
    'https://openreview.net/forum*',
  ],
  cssInjectionMode: 'ui',
  runAt: 'document_idle',
  async main(ctx) {
    if (!document.getElementById('marginalia-highlight-css')) {
      const style = document.createElement('style');
      style.id = 'marginalia-highlight-css';
      style.textContent = HIGHLIGHT_CSS;
      (document.head ?? document.documentElement).append(style);
    }
    const ui = await createShadowRootUi<Root>(ctx, {
      name: 'marginalia-ui',
      position: 'inline',
      anchor: 'body',
      append: 'last',
      isolateEvents: ['keydown', 'keyup', 'keypress'],
      onMount(container, _shadow, host) {
        host.setAttribute('data-mg-ui', '');
        const root = createRoot(container);
        root.render(<App ctx={ctx} />);
        return root;
      },
      onRemove(root) {
        root?.unmount();
      },
    });
    ui.mount();
  },
});
