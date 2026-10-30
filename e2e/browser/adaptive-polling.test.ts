import { afterAll, beforeAll, expect, test } from 'bun:test';
import { chromium, type Browser } from '@playwright/test';
import { resolve } from 'node:path';

// Exercise the shared hook in a real browser without a backend or Mina node.
const ui = resolve(import.meta.dir, '../../ui');
let browser: Browser;
let script: string;

beforeAll(async () => {
  const build = await Bun.build({
    entrypoints: ['adaptive-polling-harness'],
    target: 'browser',
    define: {
      'process.env.NEXT_PUBLIC_MINA_NETWORK': '"mainnet"',
      'process.env.NEXT_PUBLIC_POLL_INTERVAL_MS': '"30000"',
    },
    plugins: [{ name: 'adaptive-polling-harness', setup(builder) {
      builder.onResolve({ filter: /^adaptive-polling-harness$/ }, () => ({ path: 'entry', namespace: 'harness' }));
      builder.onResolve({ filter: /^react(?:\/.*)?$/ }, ({ path }) => ({ path: Bun.resolveSync(path, ui) }));
      builder.onLoad({ filter: /.*/, namespace: 'harness' }, () => ({ loader: 'js', contents: `
        import React from ${JSON.stringify(Bun.resolveSync('react', ui))};
        import { createRoot } from ${JSON.stringify(Bun.resolveSync('react-dom/client', ui))};
        import { flushSync } from ${JSON.stringify(Bun.resolveSync('react-dom', ui))};
        import { useAdaptivePolling } from ${JSON.stringify(resolve(ui, 'hooks/useAdaptivePolling.ts'))};
        let visible = true;
        Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visible ? 'visible' : 'hidden' });
        Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => false });
        window.refreshCount = 0;
        function Harness({ busy }) {
          useAdaptivePolling(() => { window.refreshCount++; }, { busy });
          return null;
        }
        const root = createRoot(document.getElementById('root'));
        window.renderPolling = busy => flushSync(() => root.render(React.createElement(Harness, { busy })));
        window.setVisible = value => {
          visible = value;
          document.dispatchEvent(new Event('visibilitychange'));
        };
      ` }));
    } }],
  });
  if (!build.success) throw new Error(build.logs.join('\n'));
  script = await build.outputs[0].text();
  browser = await chromium.launch({ headless: true });
});

afterAll(async () => { await browser?.close(); });

test('mainnet polling pauses in hidden tabs but keeps trying a reachable backend when browser reports offline', async () => {
  const page = await browser.newPage();
  try {
    await page.clock.install();
    await page.setContent('<div id="root"></div>');
    await page.addScriptTag({ content: script });
    const count = () => page.evaluate(() => (window as any).refreshCount as number);

    await page.evaluate(() => (window as any).renderPolling(false));
    await page.clock.runFor(30_000);
    expect(await count()).toBe(1);

    await page.evaluate(() => (window as any).setVisible(false));
    await page.clock.runFor(60_000);
    expect(await count()).toBe(1);
    await page.evaluate(() => (window as any).setVisible(true));
    expect(await count()).toBe(2);

    await page.clock.runFor(30_000);
    expect(await count()).toBe(3);
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    expect(await count()).toBe(4);

    await page.evaluate(() => (window as any).renderPolling(true));
    await page.clock.runFor(5_000);
    expect(await count()).toBe(5);
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    expect(await count()).toBe(6);
  } finally {
    await page.close();
  }
});
