import { chromium } from 'playwright';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HOSTS } from './server.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const EXT = path.resolve(HERE, '../.output/chrome-mv3');

export async function launch() {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mg-profile-'));
  const env = { ...process.env };
  for (const k of ['HTTPS_PROXY', 'HTTP_PROXY', 'https_proxy', 'http_proxy', 'ALL_PROXY', 'all_proxy']) delete env[k];
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: true,
    channel: 'chromium',
    viewport: { width: 1280, height: 860 },
    env,
    ignoreDefaultArgs: ['--disable-extensions', '--disable-features=AcceptCHFrame,AvoidUnnecessaryBeforeUnloadCheckSync,DestroyProfileOnBrowserClose,DialMediaRouteProvider,GlobalMediaControls,HttpsUpgrades,LensOverlay,MediaRouter,PaintHolding,ThirdPartyStoragePartitioning,Translate,AutoDeElevate,RenderDocument'],
    args: [
      '--disable-features=AcceptCHFrame,AvoidUnnecessaryBeforeUnloadCheckSync,DestroyProfileOnBrowserClose,DialMediaRouteProvider,GlobalMediaControls,HttpsUpgrades,LensOverlay,MediaRouter,PaintHolding,ThirdPartyStoragePartitioning,Translate,AutoDeElevate,RenderDocument,DisableLoadExtensionCommandLineSwitch',
      `--disable-extensions-except=${EXT}`,
      `--load-extension=${EXT}`,
      `--host-resolver-rules=${HOSTS.map((h) => `MAP ${h} 127.0.0.1`).join(',')}`,
      '--ignore-certificate-errors',
      '--no-proxy-server',
    ],
  });
  let [sw] = context.serviceWorkers();
  if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 15000 });
  const extensionId = sw.url().split('/')[2];
  // close the welcome tab opened on install
  await new Promise((r) => setTimeout(r, 800));
  for (const p of context.pages()) if (p.url().includes('options.html')) await p.close();
  return { context, sw, extensionId, userDataDir };
}
