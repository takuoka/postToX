// loginToX.js
import { chromium } from "playwright";
import path from "node:path";

const USER_DATA_DIR = path.resolve("./x-profile"); // postToX.js と同じにする
const STORAGE_PATH = path.resolve("./storageState.mobile.json");

// スマホ版っぽい UA（iPhone Safari）
const MOBILE_USER_AGENT =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";

function log(msg) {
  console.error(`[loginToX] ${msg}`);
}

/** auth_token / ct0 がどのドメインに居ても拾えるように全cookieを見る */
async function getAuthCookies(context) {
  const all = await context.cookies(); // URL指定なし = 全部
  const auth = all.filter((c) => c.name === "auth_token" || c.name === "ct0");
  return { allCount: all.length, auth };
}

async function saveAndClose(context, code = 0) {
  try {
    const { allCount, auth } = await getAuthCookies(context);
    log(`cookies total=${allCount}`);
    if (auth.length === 0) {
      log("auth_token/ct0 = NONE");
    } else {
      for (const c of auth) log(`${c.name} domain=${c.domain} path=${c.path}`);
    }

    await context.storageState({ path: STORAGE_PATH });
    log(`saved storageState -> ${STORAGE_PATH}`);
  } catch (e) {
    log("save error: " + e);
  }

  try {
    // ★ ここが大事：ちゃんと close して書き込みをフラッシュさせる
    await context.close();
    log("context closed");
  } catch (e) {
    log("close error: " + e);
  }

  process.exit(code);
}

async function main() {
  log(`USER_DATA_DIR=${USER_DATA_DIR}`);

  const context = await chromium.launchPersistentContext(USER_DATA_DIR, {
    headless: false,
    viewport: { width: 430, height: 900 }, // iPhone 14 Pro 相当
    userAgent: MOBILE_USER_AGENT,
    isMobile: true,
    deviceScaleFactor: 3,
    hasTouch: true,
    locale: "ja-JP",
    args: ["--disable-blink-features=AutomationControlled"],
  });

  // ✅ 途中で Ctrl+C しても保存して閉じる（正常終了を強制）
  process.on("SIGINT", () => saveAndClose(context, 0));
  process.on("SIGTERM", () => saveAndClose(context, 0));
  process.on("uncaughtException", (e) => {
    log("uncaughtException: " + e);
    saveAndClose(context, 1);
  });
  process.on("unhandledRejection", (e) => {
    log("unhandledRejection: " + e);
    saveAndClose(context, 1);
  });

  // 起動直後のcookie状況（ゲストcookieしか無いのが普通）
  {
    const { allCount, auth } = await getAuthCookies(context);
    log(`after launch cookies total=${allCount}`);
    log(`after launch has auth_token/ct0 = ${auth.length > 0}`);
  }

  const page = await context.newPage();

  // ログインフローへ（ホーム→loginでもいいけど、これが一番素直）
  await page.goto("https://x.com/i/flow/login", { waitUntil: "domcontentloaded" });
  log("opened " + page.url());

  log("🟦 ブラウザで手動ログインしてね（2FA/メール確認もOK）");
  log("🟩 ログイン完了したら、このターミナルで Enter（保存して終了する）");

  await new Promise((resolve) => {
    process.stdin.resume();
    process.stdin.once("data", resolve);
  });

  // ログイン直後はcookie反映が遅れることがあるので少し待つ
  await page.waitForTimeout(1200);

  const { auth } = await getAuthCookies(context);
  if (auth.length === 0) {
    log("❌ auth_token/ct0 が見つからない（ログイン未成立 or 直後無効化の可能性）");
    log("   いったんXのホームに遷移できてるかブラウザで確認して、もう一度Enterで保存し直してもOK");
  } else {
    log("✅ auth_token/ct0 を検出。保存して終了します");
  }

  await saveAndClose(context, auth.length > 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});