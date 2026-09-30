import { afterAll, beforeAll, expect, test } from 'bun:test';
import { chromium, type Browser } from '@playwright/test';
import { resolve } from 'node:path';

// Exercise the actual hook in React/Chromium, including effect cleanup and timers.
// No backend, database, chain, or signing worker is needed.
const ui = resolve(import.meta.dir, '../../ui');
let browser: Browser;
let script: string;
beforeAll(async () => {
  const build = await Bun.build({
    entrypoints: ['preflight-harness'],
    target: 'browser',
    plugins: [{ name: 'preflight-harness', setup(builder) {
      builder.onResolve({ filter: /^preflight-harness$/ }, () => ({ path: 'entry', namespace: 'harness' }));
      builder.onResolve({ filter: /^react(?:\/.*)?$/ }, ({ path }) => ({ path: Bun.resolveSync(path, ui) }));
      builder.onLoad({ filter: /.*/, namespace: 'harness' }, () => ({ loader: 'js', contents: `
        import React from ${JSON.stringify(Bun.resolveSync('react', ui))};
        import { createRoot } from ${JSON.stringify(Bun.resolveSync('react-dom/client', ui))};
        import { flushSync } from ${JSON.stringify(Bun.resolveSync('react-dom', ui))};
        import { usePreflightCheck } from ${JSON.stringify(resolve(ui, 'hooks/usePreflightCheck.ts'))};
        window.requests = [];
        function Harness({ inputKey }) {
          const result = usePreflightCheck(inputKey, () => new Promise((resolve, reject) => {
            window.requests.push({ key: inputKey, resolve, reject });
          }));
          return React.createElement('div', { id: 'result' }, result ?? 'inactive');
        }
        const root = createRoot(document.getElementById('root'));
        window.renderCheck = (inputKey) => flushSync(() => root.render(React.createElement(Harness, { inputKey })));
      ` }));
    } }],
  });
  if (!build.success) throw new Error(build.logs.join('\n'));
  script = await build.outputs[0].text();
  browser = await chromium.launch({ headless: true });
});
afterAll(async () => { await browser?.close(); });

async function harness() {
  const page = await browser.newPage();
  await page.clock.install();
  await page.setContent('<div id="root"></div>');
  await page.addScriptTag({ content: script });
  return {
    page,
    render: (key: string | null) => page.evaluate(key => (window as any).renderCheck(key), key),
    settle: (index: number, value: string) => page.evaluate(({ index, value }) =>
      (window as any).requests[index].resolve(value), { index, value }),
    count: () => page.evaluate(() => (window as any).requests.length),
    state: async (expected: string) => {
      await page.waitForFunction(value => document.getElementById('result')?.textContent === value, expected);
    },
  };
}

for (const result of ['match', 'mismatch', 'unexecutable', 'sameKeyHolder']) {
  test(`unchanged polling retains ${result} without another check`, async () => {
    const h = await harness();
    try {
      await h.render('proposal-inputs');
      await h.settle(0, result);
      await h.state(result);
      for (let i = 0; i < 5; i++) await h.render('proposal-inputs');
      await h.page.clock.fastForward(30_000);
      await h.state(result);
      expect(await h.count()).toBe(1);
    } finally { await h.page.close(); }
  });
}

test('unavailable data retries without blinking or overlapping a slow request', async () => {
  const h = await harness();
  try {
    await h.render('proposal-inputs');
    await h.settle(0, 'unavailable');
    await h.state('unavailable');
    await h.render('proposal-inputs');
    await h.page.clock.fastForward(10_000);
    expect(await h.count()).toBe(2);
    await h.state('unavailable');
    await h.page.clock.fastForward(30_000);
    expect(await h.count()).toBe(2);
    await h.settle(1, 'mismatch');
    await h.state('mismatch');
    await h.page.clock.fastForward(30_000);
    expect(await h.count()).toBe(2);
  } finally { await h.page.close(); }
});

test('changed inputs ignore late results and terminal status cancels retries', async () => {
  const h = await harness();
  try {
    await h.render('old-inputs');
    await h.render('new-inputs');
    await h.settle(1, 'mismatch');
    await h.state('mismatch');
    await h.settle(0, 'match');
    await h.state('mismatch');
    await h.render(null);
    await h.state('inactive');
    await h.render('new-inputs');
    await h.state('checking');
    expect(await h.count()).toBe(3);
    await h.page.evaluate(() => (window as any).requests[2].reject(new Error('offline')));
    await h.state('unavailable');
    await h.render(null);
    await h.page.clock.fastForward(30_000);
    expect(await h.count()).toBe(3);
    await h.state('inactive');
  } finally { await h.page.close(); }
});
