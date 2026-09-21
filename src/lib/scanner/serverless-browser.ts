import { startPublicProxy } from './public-proxy';

/** Separate ephemeral browser per invocation; no customer profile or credentials. */
export async function launchServerlessBrowser() {
  if (process.platform !== 'linux' || !process.env.AWS_LAMBDA_FUNCTION_NAME) {
    throw new Error('The serverless browser requires the isolated Linux function runtime');
  }
  const [{ default: puppeteer }, { default: chromium }] = await Promise.all([
    import('puppeteer-core'), import('@sparticuz/chromium'),
  ]);
  const proxy = await startPublicProxy();
  try {
    chromium.setGraphicsMode = false;
    const executablePath = await chromium.executablePath();
    // Do not pass Supabase, AI, Stripe, or AWS credentials to the browser process.
    const env: Record<string, string> = {};
    for (const key of ['PATH', 'LD_LIBRARY_PATH', 'FONTCONFIG_PATH', 'HOME', 'TMPDIR']) {
      if (process.env[key]) env[key] = process.env[key]!;
    }
    const browser = await puppeteer.launch({
      executablePath, headless: 'shell', env, pipe: true,
      // Keep normal web origin and mixed-content protections. Lambda provides
      // process isolation; these arguments are never used by the local worker.
      args: [...chromium.args.filter(arg => !['--disable-web-security', '--allow-running-insecure-content'].includes(arg)),
        `--proxy-server=${proxy.url}`, '--proxy-bypass-list=<-loopback>',
        '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1', '--disable-quic',
        '--force-webrtc-ip-handling-policy=disable_non_proxied_udp'],
      defaultViewport: { width: 1440, height: 900 },
    });
    return { browser, close: async () => {
      try { await browser.close(); } finally { await proxy.close(); }
    } };
  } catch (error) { await proxy.close(); throw error; }
}
