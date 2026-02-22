import { chromium } from "playwright";
import path from "node:path";

const USER_DATA_DIR = path.resolve("./x-profile"); // ブラウザプロファイル（cookie等）保存先

// スマホ版っぽい UA（iPhone Safari）
const MOBILE_USER_AGENT =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";

async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString("utf8").trim();
}

function log(msg) {
  console.error(`[postToX] ${msg}`);
}

async function openComposePage(text) {
  log("launchPersistentContext 開始…");
  // 1回目だけ headful 推奨（手動ログインさせるため）
  const context = await chromium.launchPersistentContext(USER_DATA_DIR, {
    headless: false,
    // だいたい iPhone 14 Pro 相当
    viewport: { width: 430, height: 900 },
    userAgent: MOBILE_USER_AGENT,
    isMobile: true,
    deviceScaleFactor: 3,
    hasTouch: true,
    locale: "ja-JP",
    // 自動制御フラグを外して bot 検知を弱める（navigator.webdriver まわりが緩和される場合あり）
    args: ["--disable-blink-features=AutomationControlled"],
  });
  log("launchPersistentContext 完了");

  // 🍪 cookie確認（launch直後）
  const cookies = await context.cookies("https://x.com");
  log("cookies count=" + cookies.length);
  log("has auth_token=" + cookies.some(c => c.name === "auth_token"));
  log("has ct0=" + cookies.some(c => c.name === "ct0"));

  const page = await context.newPage();
  log("newPage 完了");

  // compose URL を開くだけ
  log("goto compose 開始…");
  await page.goto("https://x.com/compose/post", { waitUntil: "domcontentloaded" });
  log("goto compose 完了 url=" + page.url());

  // ログインが必要なら手動で済ませてもらう（突破しようとしない）
  if (page.url().includes("/login")) {
    console.log("🔐 ログインが必要です。ブラウザ上で手動ログインしてください。");
    console.log("✅ ログインできたら、このターミナルで Enter を押して続行します。");

    await new Promise((resolve) => {
      process.stdin.resume();
      process.stdin.once("data", () => resolve());
    });

    log("goto compose 再試行…");
    await page.goto("https://x.com/compose/post", { waitUntil: "domcontentloaded" });
    log("goto compose 再試行 完了 url=" + page.url());
  }

  if (text) {
    log("テキストエリア locator 取得・待機…");
    const box = page.locator('[data-testid="tweetTextarea_0"][role="textbox"]').first();
    await box.waitFor({ state: "visible" });
    log("テキストエリア visible");

    log("box.click()…");
    await box.click();

    // MacならMeta+A / WinならControl+A
    const mod = process.platform === "darwin" ? "Meta" : "Control";
    log(`keyboard ${mod}+A…`);
    await page.keyboard.press(`${mod}+A`);

    // IME絡みの事故が少ない
    log("insertText…");
    await page.keyboard.insertText(text);
    log("insertText 完了");
  }

  log("Enter 待ち…");
  console.log("📝 compose を開きました。終了するにはこのターミナルで Enter を押してください。");
  await new Promise((resolve) => {
    process.stdin.resume();
    process.stdin.once("data", () => resolve());
  });

  log("context.close()…");
  await context.close();
  log("完了");
  return { ok: true };
}

async function main() {
  log("main: テキスト取得…");
  const text = process.argv.slice(2).join(" ") || (await readStdin());
  if (!text) {
    console.log(JSON.stringify({ ok: false, error: "NO_TEXT" }));
    process.exit(1);
  }

  log("main: openComposePage 呼び出し text=" + JSON.stringify(text.slice(0, 30)) + (text.length > 30 ? "…" : ""));
  try {
    const result = await openComposePage(text);
    console.log(JSON.stringify(result));
  } catch (e) {
    log("error: " + e);
    console.log(JSON.stringify({ ok: false, error: String(e) }));
    process.exit(1);
  }
}

main();
