// Chrome control for the local scanner.
//
// Two hard-won constraints shape this file:
//  1. Chrome 136+ refuses a CDP connection against the DEFAULT user profile. We
//     always use a dedicated --user-data-dir, which sidesteps that and keeps our
//     cookies away from David's real browsing.
//  2. A stale `--no-startup-window` Chrome can hold the debug port with ZERO tabs
//     and look exactly like "not running". We probe /json/version, not the process
//     list, and we always create our own page rather than reusing whatever is open.

import puppeteer from 'puppeteer-core';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const CHROME = process.env.CHROME_PATH
  || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = Number(process.env.SCANNER_CDP_PORT || 9333);
const PROFILE = process.env.SCANNER_PROFILE
  || join(homedir(), '.ad-assist', 'chrome-profile');

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function portAlive(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, {
      signal: AbortSignal.timeout(1500),
    });
    return res.ok;
  } catch {
    return false;
  }
}

let launched = null;

/**
 * Two jobs starting together both probe a dead port, both spawn Chrome against
 * the SAME --user-data-dir, and the second dies on the profile lock — leaving a
 * failed job next to a working one for no reason a log would explain. So the
 * launch is serialised: the first caller in owns this promise, everyone else
 * waits on it and then re-probes.
 */
let launching = null;

/** Connect to our Chrome, starting it if it isn't already up. */
export async function getBrowser({ headless = false } = {}) {
  if (!(await portAlive(PORT))) {
    if (launching) await launching.catch(() => {});
    else {
      launching = launchChrome(headless);
      try { await launching; } finally { launching = null; }
    }
    if (!(await portAlive(PORT))) {
      throw new Error(`Chrome did not open a debug port on ${PORT}`);
    }
  }

  return puppeteer.connect({
    browserURL: `http://127.0.0.1:${PORT}`,
    defaultViewport: { width: 1440, height: 900 },
  });
}

async function launchChrome(headless) {
  // Re-probed inside the mutex: by the time a queued caller gets here the
  // first one has usually already started it, and spawning a second Chrome
  // over a live profile is the exact failure this guard exists to prevent.
  if (!(await portAlive(PORT))) {
    mkdirSync(PROFILE, { recursive: true });
    const args = [
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${PROFILE}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-blink-features=AutomationControlled',
      `--user-agent=${UA}`,
      '--window-size=1440,900',
    ];
    if (headless) args.push('--headless=new');

    launched = spawn(CHROME, args, { detached: true, stdio: 'ignore' });
    launched.unref();

    // A ChildProcess that cannot be spawned emits 'error', and an 'error' with
    // no listener is an UNCAUGHT EXCEPTION — it kills the worker rather than
    // the job. Found with CHROME_PATH pointed at a path that does not exist:
    // the process died on ENOENT, the job stayed 'running' until the reaper
    // came for it, and nothing anywhere recorded a reason. Which is precisely
    // the failure this file's header says it exists to avoid. Catch it and let
    // the wait below turn it into a job error with the real cause in it.
    let spawnError = null;
    launched.on('error', (e) => { spawnError = e; });

    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      if (spawnError) throw new Error(`could not start Chrome at ${CHROME}: ${spawnError.message}`);
      if (await portAlive(PORT)) break;
      await sleep(250);
    }
  }
}

/** A fresh page with the automation tells filed off. */
export async function newPage(browser) {
  const page = await browser.newPage();
  await page.setUserAgent(UA);
  await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-AU,en;q=0.9' });
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });
  return page;
}

/**
 * Human-ish scroll to the bottom. Lazy-loaded reviews and the Ad Library's
 * infinite list both need this; neither renders below the fold until you arrive.
 */
export async function scrollThrough(page, { maxScrolls = 40, pause = 400 } = {}) {
  let lastHeight = 0;
  for (let i = 0; i < maxScrolls; i++) {
    const height = await page.evaluate(() => {
      window.scrollBy(0, window.innerHeight * 0.85);
      return document.body.scrollHeight;
    });
    await sleep(pause + Math.random() * 250);
    if (height === lastHeight && i > 2) break;
    lastHeight = height;
  }
}

export { sleep };
