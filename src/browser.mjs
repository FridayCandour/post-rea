import puppeteer from 'puppeteer';

export const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/148.0.0.0 Safari/537.36';

/**
 * Analytics / tag-manager / session-replay hosts. They never contribute to the
 * captured page, but they keep the network busy (defeating network-idle) and
 * burn CPU. Aborting them is safe.
 */
const TRACKER_HOSTS =
  /(?:google-analytics\.com|googletagmanager\.com|doubleclick\.net|googlesyndication\.com|adservice\.google\.|facebook\.net|facebook\.com\/tr|hotjar\.(?:com|io)|segment\.(?:com|io)|mixpanel\.com|clarity\.ms|sentry\.io|intercom\.io|drift\.com|hubspot\.com|hs-scripts\.com|hs-analytics\.net|tiktok\.com|analytics\.tiktok\.com|linkedin\.com|snap\.li|posthog\.com|plausible\.io|vercel-insights\.com|vercel-scripts\.com|newrelic\.com|datadoghq-browser-agent\.com|fullstory\.com|smartlook\.com|mouseflow\.com|logrocket\.(?:io|com)|optimizely\.com|criteo\.(?:com|net)|taboola\.com|outbrain\.com|adroll\.com|quantserve\.com|scorecardresearch\.com|bat\.bing\.com|cloudflareinsights\.com)/i;

/**
 * The archiver downloads images/fonts/media itself (from attributes and CSS)
 * so the browser does not need them. Aborting those requests removes the
 * single biggest cause of slow captures.
 */
export async function blockHeavyResources(page) {
  await page.setRequestInterception(true);
  page.on('request', (request) => {
    const type = request.resourceType();
    if (type === 'image' || type === 'media' || type === 'font' || type === 'ping') {
      request.abort().catch(() => {});
      return;
    }
    if (TRACKER_HOSTS.test(request.url())) {
      request.abort().catch(() => {});
      return;
    }
    request.continue().catch(() => {});
  });
}

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

/**
 * Navigate and give the page a bounded chance to finish its network work.
 * Discovery uses a short settle window (links are usually in the served HTML),
 * archiving uses the longer default so late images/styles are captured.
 */
export async function openPage(page, url, opts, { idleTime = 600, idleTimeout = 20000 } = {}) {
  const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: opts.timeout });
  await page
    .waitForNetworkIdle({ idleTime, concurrency: 2, timeout: Math.min(opts.timeout, idleTimeout) })
    .catch(() => {});
  return response;
}

/**
 * Scroll through the document only when something actually needs it (JS-driven
 * lazy images with no src/data-src). With plain `loading="lazy"` or `data-src`
 * markup the archiver resolves sources itself, so scrolling is pure latency.
 */
export async function autoscroll(page, { maxSteps = 16, interval = 40 } = {}) {
  await page
    .evaluate(
      async ({ maxSteps, interval }) => {
        const needsScroll = [...document.images].some((img) => {
          const src = img.getAttribute('src') || '';
          const lazyAttr = img.getAttribute('data-src') || img.getAttribute('data-lazy-src');
          return !lazyAttr && (!src || /^data:image\/(?:gif|png);base64,R0lGOD/i.test(src));
        });

        if (needsScroll) {
          await new Promise((resolve) => {
            let steps = 0;
            const timer = setInterval(() => {
              window.scrollBy(0, Math.round(window.innerHeight * 0.9));
              steps += 1;
              const height = Math.max(
                document.body ? document.body.scrollHeight : 0,
                document.documentElement ? document.documentElement.scrollHeight : 0,
              );
              if (steps >= maxSteps || window.scrollY + window.innerHeight >= height - 2) {
                clearInterval(timer);
                resolve();
              }
            }, interval);
          });
          window.scrollTo(0, 0);
        }

        try {
          if (document.fonts && document.fonts.ready) await document.fonts.ready;
        } catch {
          /* fonts API can be missing */
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      },
      { maxSteps, interval },
    )
    .catch(() => {});
}
