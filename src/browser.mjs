import puppeteer from 'puppeteer';
import { sleep } from './util.mjs';

export const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/148.0.0.0 Safari/537.36';

export async function launchBrowser({ headful = false } = {}) {
  return puppeteer.launch({
    headless: !headful,
    defaultViewport: { width: 1440, height: 900, deviceScaleFactor: 1 },
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled',
      '--hide-scrollbars',
      '--mute-audio',
      '--disable-background-networking',
    ],
  });
}

/**
 * Create a page with CSP bypass (so injected <style> tags are not blocked),
 * a realistic UA, and dialogs auto-dismissed.
 */
export async function createPage(browser, opts) {
  const page = await browser.newPage();
  page.setDefaultTimeout(opts.timeout);
  page.setDefaultNavigationTimeout(opts.timeout);
  await page.setBypassCSP(true);
  await page.setUserAgent(opts.userAgent || DEFAULT_USER_AGENT);
  await page.setExtraHTTPHeaders({ 'accept-language': 'en-US,en;q=0.9' });
  page.on('dialog', (dialog) => dialog.dismiss().catch(() => {}));
  return page;
}

/** Navigate and give the page a bounded chance to finish its network work. */
export async function openPage(page, url, opts) {
  const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: opts.timeout });
  await page
    .waitForNetworkIdle({ idleTime: 600, concurrency: 2, timeout: Math.min(opts.timeout, 20000) })
    .catch(() => {});
  return response;
}

/** Scroll through the document so lazy-loaded images and embeds materialise. */
export async function autoscroll(page) {
  await page
    .evaluate(async () => {
      const step = 700;
      const limit = 40000;
      await new Promise((resolve) => {
        let travelled = 0;
        const timer = setInterval(() => {
          const height = Math.max(
            document.body ? document.body.scrollHeight : 0,
            document.documentElement ? document.documentElement.scrollHeight : 0,
          );
          window.scrollBy(0, step);
          travelled += step;
          if (travelled >= height + step || travelled > limit) {
            clearInterval(timer);
            resolve();
          }
        }, 70);
      });
      window.scrollTo(0, 0);
      try {
        if (document.fonts && document.fonts.ready) await document.fonts.ready;
      } catch {
        /* fonts API can be missing */
      }
      await new Promise((resolve) => setTimeout(resolve, 300));
    })
    .catch(() => {});
  await sleep(250);
}
