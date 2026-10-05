// Records the dashboard against a running stack (API + worker + dashboard)
// as numbered PNG frames plus frames.json; compose-preview.py turns them into
// docs/preview.gif.
//
//   APP_URL=http://localhost:5173 API_URL=http://localhost:4000 node scripts/capture-preview.mjs
//
// Expects a fresh database: every service starts undeployed.
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';

const APP_URL = process.env.APP_URL ?? 'http://localhost:5173';
const API_URL = process.env.API_URL ?? 'http://localhost:4000';
const OUT = new URL('../.capture/', import.meta.url);
const CHROMIUM = process.env.PLAYWRIGHT_CHROMIUM_PATH;

const frames = [];
let caption = '';

async function api(query, variables = {}) {
  const res = await fetch(`${API_URL}/graphql`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  const body = await res.json();
  if (body.errors) throw new Error(JSON.stringify(body.errors));
  return body.data;
}

async function snap(page) {
  const file = `frame-${String(frames.length).padStart(4, '0')}.png`;
  await page.screenshot({ path: new URL(file, OUT).pathname });
  frames.push({ file, t: Date.now(), caption });
}

async function hold(page, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    await snap(page);
    await page.waitForTimeout(120);
  }
}

async function until(page, selector, timeout = 30_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    await snap(page);
    if (await page.locator(selector).count()) return;
    await page.waitForTimeout(80);
  }
  throw new Error(`timed out waiting for ${selector}`);
}

const firstRow = (status) => `.deployments li:first-child [data-status="${status}"]`;

await rm(OUT, { recursive: true, force: true });
await mkdir(OUT, { recursive: true });

const browser = await chromium.launch(CHROMIUM ? { executablePath: CHROMIUM } : {});
const page = await browser.newPage({ viewport: { width: 1280, height: 760 }, deviceScaleFactor: 1 });
await page.goto(APP_URL);
await page.waitForSelector('.card');

const { projects } = await api('{ projects { id environments { id name } services { id name } } }');
const project = projects[0];
const production = project.environments.find((e) => e.name === 'production');
const byName = Object.fromEntries(project.services.map((s) => [s.name, s.id]));
const deploy = (name) =>
  api('mutation ($s: ID!, $e: ID!) { deployService(serviceId: $s, environmentId: $e) { id } }', { s: byName[name], e: production.id });

caption = 'A project with four services, nothing deployed yet';
await hold(page, 1200);

caption = 'Deploying every service: one Temporal lane per service and environment';
await Promise.all(['web', 'worker', 'billing'].map(deploy));
await page.getByRole('button', { name: 'Open api' }).click();
await page.locator('.panel .btn--primary').click();
await until(page, firstRow('BUILDING'));
caption = 'Build and deploy logs stream from ClickHouse as they are written';
await until(page, firstRow('ACTIVE'));
await hold(page, 1500);

caption = 'Simulating a flaky npm registry for the next build';
await page.locator('select[aria-label^="Simulate"]').selectOption('0');
await hold(page, 900);
caption = 'The build fails on a registry timeout; Temporal retries the activity';
await page.locator('.panel .btn--primary').click();
await until(page, firstRow('ACTIVE'), 60_000);
caption = 'Attempt 2 succeeded; the previous deployment was retired atomically';
await hold(page, 2200);

caption = 'Rollback: a new deployment of the previous image, no rebuild';
await page.locator('.deployments li', { has: page.locator('[data-status="REMOVED"]') }).first().getByRole('button', { name: 'Rollback' }).click();
await until(page, firstRow('DEPLOYING'));
await until(page, firstRow('ACTIVE'));
await hold(page, 2500);

await browser.close();
await writeFile(new URL('frames.json', OUT), JSON.stringify(frames, null, 2));
console.log(`captured ${frames.length} frames over ${((frames.at(-1).t - frames[0].t) / 1000).toFixed(1)} s`);
