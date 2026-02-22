import { chromium } from "playwright";
import path from "node:path";

const USER_DATA_DIR = path.resolve("./x-profile");
const MOBILE_USER_AGENT =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";

const SELECTORS = {
  TEXTAREA: '[data-testid="tweetTextarea_0"]',
  POST_BUTTON: '[data-testid="tweetButton"]',
};

const COMPOSE_URL = "https://x.com/compose/post";

async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString("utf8").trim();
}

function log(msg) {
  console.error(`[postToX] ${msg}`);
}

async function createBrowserContext() {
  log("launchPersistentContext 開始…");
  const context = await chromium.launchPersistentContext(USER_DATA_DIR, {
    headless: false,
    viewport: { width: 430, height: 900 },
    userAgent: MOBILE_USER_AGENT,
    isMobile: true,
    deviceScaleFactor: 3,
    hasTouch: true,
    locale: "ja-JP",
    args: ["--disable-blink-features=AutomationControlled"],
  });
  log("launchPersistentContext 完了");
  return context;
}

async function checkAuth(context) {
  const cookies = await context.cookies("https://x.com");
  log(`cookies count=${cookies.length}`);
  log(`has auth_token=${cookies.some((c) => c.name === "auth_token")}`);
  log(`has ct0=${cookies.some((c) => c.name === "ct0")}`);
}

async function navigateToCompose(page) {
  log("goto compose 開始…");
  await page.goto(COMPOSE_URL, { waitUntil: "domcontentloaded" });
  log(`goto compose 完了 url=${page.url()}`);

  if (page.url().includes("/login")) {
    console.log("🔐 ログインが必要です。ブラウザ上で手動ログインしてください。");
    console.log("✅ ログインできたら、このターミナルで Enter を押して続行します。");

    await new Promise((resolve) => {
      process.stdin.resume();
      process.stdin.once("data", () => resolve());
    });

    log("goto compose 再試行…");
    await page.goto(COMPOSE_URL, { waitUntil: "domcontentloaded" });
    log(`goto compose 再試行 完了 url=${page.url()}`);
  }
}

async function inputTweetText(page, text) {
  log("テキストエリア待機…");
  await page.waitForSelector(SELECTORS.TEXTAREA, { state: "visible", timeout: 10000 });
  const textarea = page.locator(SELECTORS.TEXTAREA).first();

  await textarea.scrollIntoViewIfNeeded().catch(() => {});
  await textarea.click({ timeout: 2000 }).catch(() => textarea.click({ force: true }));

  const mod = process.platform === "darwin" ? "Meta" : "Control";
  await page.keyboard.press(`${mod}+A`).catch(() => {});
  await page.keyboard.insertText(text);
  log("入力OK");
}

async function clickPostButton(page) {
  log("ポストボタン待機…");
  const postButton = page.locator(SELECTORS.POST_BUTTON).first();
  await postButton.waitFor({ state: "visible", timeout: 5000 });
  
  await page
    .waitForFunction(
      () => {
        const btn = document.querySelector(SELECTORS.POST_BUTTON);
        return btn && !btn.hasAttribute("disabled") && btn.getAttribute("aria-disabled") !== "true";
      },
      { timeout: 10000 }
    )
    .catch(() => {});

  await page.waitForTimeout(200);
  await postButton.click({ timeout: 3000 });
  log("ポストボタンクリック完了");
}

async function waitForPostCompletion(page) {
  log("投稿完了待機…");
  await page.waitForTimeout(2000);
  const finalUrl = page.url();
  const posted = !finalUrl.includes("/compose/post");
  log(`投稿${posted ? "成功" : "確認中"} url=${finalUrl}`);
  return { posted, url: finalUrl };
}

async function postTweet(text) {
  const context = await createBrowserContext();
  try {
    await checkAuth(context);
    const page = await context.newPage();
    log("newPage 完了");

    await navigateToCompose(page);

    if (!text) {
      return { ok: true, posted: false };
    }

    await inputTweetText(page, text);
    await clickPostButton(page);
    const result = await waitForPostCompletion(page);

    return { ok: true, ...result };
  } finally {
    log("context.close()…");
    await context.close();
    log("完了");
  }
}

async function main() {
  log("main: テキスト取得…");
  const text = process.argv.slice(2).join(" ") || (await readStdin());
  if (!text) {
    console.log(JSON.stringify({ ok: false, error: "NO_TEXT" }));
    process.exit(1);
  }

  log(`main: postTweet 呼び出し text=${JSON.stringify(text.slice(0, 30))}${text.length > 30 ? "…" : ""}`);
  try {
    const result = await postTweet(text);
    console.log(JSON.stringify(result));
  } catch (e) {
    log(`error: ${e}`);
    console.log(JSON.stringify({ ok: false, error: String(e) }));
    process.exit(1);
  }
}

main();
