/**
 * LinkedIn first-time authentication.
 *
 * Launches a headed Chromium browser, waits for you to log in,
 * then saves the session state so the LinkedIn channel can run headlessly.
 *
 * Usage:
 *   npm run linkedin:auth
 */

import fs from 'fs';
import path from 'path';

import { chromium } from 'playwright';

import { LINKEDIN_AUTH_PATH } from '../src/channels/linkedin.js';

async function main() {
  console.log('LinkedIn Authentication Setup');
  console.log('─────────────────────────────');
  console.log('A browser window will open. Log in to LinkedIn, then come back here.\n');

  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();

  await page.goto('https://www.linkedin.com/login');

  console.log('Waiting for you to log in... (timeout: 5 minutes)');
  await page.waitForURL('**/feed/**', { timeout: 300_000 });
  console.log('Logged in!');

  fs.mkdirSync(path.dirname(LINKEDIN_AUTH_PATH), { recursive: true });
  await context.storageState({ path: LINKEDIN_AUTH_PATH });
  console.log(`\nAuth state saved to:\n  ${LINKEDIN_AUTH_PATH}`);

  await browser.close();
  console.log('\nDone. Restart NanoClaw to activate the LinkedIn channel.');
}

main().catch((err) => {
  console.error('Auth failed:', err);
  process.exit(1);
});
