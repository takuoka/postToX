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

/** ブラウザコンテキストで直接querySelectorを実行して要素を探す（デバッグ用） */
async function debugFindElement(page, selector) {
  return await page.evaluate((sel) => {
    // 通常のDOM
    let el = document.querySelector(sel);
    if (el) {
      return {
        found: true,
        tagName: el.tagName,
        role: el.getAttribute('role'),
        testid: el.getAttribute('data-testid'),
        contenteditable: el.getAttribute('contenteditable'),
        isVisible: el.offsetWidth > 0 && el.offsetHeight > 0,
        display: window.getComputedStyle(el).display,
        visibility: window.getComputedStyle(el).visibility,
        parentTag: el.parentElement?.tagName,
        inShadow: el.getRootNode() !== document,
      };
    }
    
    // Shadow DOM内も探索
    const walker = (node) => {
      if (node.shadowRoot) {
        const shadowEl = node.shadowRoot.querySelector(sel);
        if (shadowEl) {
          return {
            found: true,
            tagName: shadowEl.tagName,
            role: shadowEl.getAttribute('role'),
            testid: shadowEl.getAttribute('data-testid'),
            contenteditable: shadowEl.getAttribute('contenteditable'),
            isVisible: shadowEl.offsetWidth > 0 && shadowEl.offsetHeight > 0,
            display: window.getComputedStyle(shadowEl).display,
            visibility: window.getComputedStyle(shadowEl).visibility,
            parentTag: shadowEl.parentElement?.tagName,
            inShadow: true,
            shadowHost: node.tagName,
          };
        }
        // Shadow DOM内を再帰的に探索
        for (const child of node.shadowRoot.children) {
          const result = walker(child);
          if (result) return result;
        }
      }
      for (const child of node.children) {
        const result = walker(child);
        if (result) return result;
      }
      return null;
    };
    
    return walker(document.body) || null;
  }, selector).catch(() => null);
}

/** ページ内のテキストボックス候補をすべて列挙（モバイル版で何があるか確認用） */
async function dumpTextboxCandidates(page) {
  return await page.evaluate(() => {
    const out = [];
    const walk = (node) => {
      if (!node || !node.querySelector) return;
      const role = node.getAttribute?.('role');
      const testid = node.getAttribute?.('data-testid');
      const ce = node.getAttribute?.('contenteditable');
      const tag = node.tagName?.toLowerCase();
      if (
        (role === 'textbox') ||
        (ce === 'true' && (tag === 'div' || tag === 'span')) ||
        (testid && String(testid).includes('tweet'))
      ) {
        out.push({
          tag: tag,
          role,
          'data-testid': testid,
          contenteditable: ce,
          visible: node.offsetWidth > 0 && node.offsetHeight > 0,
          placeholder: node.getAttribute?.('data-placeholder') || (node.placeholder || '').slice(0, 40),
        });
      }
      if (node.shadowRoot) {
        for (const c of node.shadowRoot.children) walk(c);
      }
      for (const c of node.children) walk(c);
    };
    walk(document.body);
    return out;
  }).catch(() => []);
}

/** iframe 含め全フレームからツイート用テキストボックスを探す */
async function findTweetTextbox(page, timeoutMs = 30000) {
  // モバイルは <textarea data-testid="tweetTextarea_0"> で role なし。デスクトップは div+role="textbox"
  const selCandidates = [
    '[data-testid="tweetTextarea_0"]',
    '[data-testid="tweetTextarea_0"][role="textbox"]',
    'div[role="textbox"][contenteditable="true"]',
    'div.public-DraftEditor-content[contenteditable="true"]',
  ];

  const deadline = Date.now() + timeoutMs;
  let attemptCount = 0;

  while (Date.now() < deadline) {
    attemptCount++;
    
    // まず page.evaluate で直接 querySelector を試す（デバッグ情報付き）
    for (const sel of selCandidates) {
      const debugInfo = await debugFindElement(page, sel);
      if (debugInfo?.found) {
        log(`DEBUG: querySelector found "${sel}" - visible=${debugInfo.isVisible}, display=${debugInfo.display}, inShadow=${debugInfo.inShadow}`);
        if (debugInfo.isVisible) {
          // querySelectorで見つかったら、locatorでも取得を試みる
          const loc = page.locator(sel).first();
          const n = await loc.count().catch(() => 0);
          if (n > 0) {
            await loc.waitFor({ state: "attached", timeout: 5000 }).catch(() => {});
            if (await loc.isVisible().catch(() => false)) {
              log(`FOUND via locator after querySelector check: "${sel}"`);
              return loc;
            }
          }
          // locatorで見つからないがquerySelectorで見つかった場合（Shadow DOM等）
          // → page.evaluateで直接操作するラッパーを返す
          if (debugInfo.inShadow) {
            log(`WARNING: Element found in Shadow DOM, using evaluate fallback for "${sel}"`);
            return {
              // locatorの代わりにpage.evaluateで操作する擬似locator
              _isEvaluateFallback: true,
              _selector: sel,
              _page: page,
            };
          }
        }
      }
    }

    // フレーム単位でも探す
    for (const f of page.frames()) {
      for (const sel of selCandidates) {
        const loc = f.locator(sel).first();
        const n = await loc.count().catch(() => 0);
        if (n > 0) {
          await loc.waitFor({ state: "attached", timeout: 5000 }).catch(() => {});
          if (await loc.isVisible().catch(() => false)) {
            log(`FOUND via locator in frame: ${f === page.mainFrame() ? "MAIN" : "SUB"} url=${f.url()}`);
            return loc;
          }
        }
      }
    }

    if (attemptCount % 20 === 0) {
      log(`findTweetTextbox retrying... (attempt ${attemptCount}, ${Math.round((deadline - Date.now()) / 1000)}s remaining)`);
    }
    await page.waitForTimeout(250);
  }

  // 最終デバッグ: querySelector 結果と「DOM に実際にある候補」を出力
  log("FINAL DEBUG: checking with querySelector...");
  for (const sel of selCandidates) {
    const debugInfo = await debugFindElement(page, sel);
    if (debugInfo) {
      log(`FINAL: "${sel}" - ${JSON.stringify(debugInfo)}`);
    }
  }
  const candidates = await dumpTextboxCandidates(page);
  log(`FINAL: DOM内のテキストボックス候補数 = ${candidates.length}`);
  candidates.slice(0, 15).forEach((c, i) => {
    log(`  [${i}] ${JSON.stringify(c)}`);
  });
  if (candidates.length > 15) {
    log(`  ... 他 ${candidates.length - 15} 件`);
  }

  throw new Error("TWEET_TEXTBOX_NOT_FOUND_IN_ANY_FRAME");
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
    log("テキストエリア待機…");
    const sel = '[data-testid="tweetTextarea_0"]';
    await page.waitForSelector(sel, { state: "visible", timeout: 10000 });
    const box = page.locator(sel).first();

    await box.scrollIntoViewIfNeeded().catch(() => {});
    await box.click({ timeout: 2000 }).catch(() => box.click({ force: true }));

    const mod = process.platform === "darwin" ? "Meta" : "Control";
    await page.keyboard.press(`${mod}+A`).catch(() => {});
    await page.keyboard.insertText(text);
    log("入力OK");

    log("ポストボタン待機…");
    const postButton = page.locator('[data-testid="tweetButton"]').first();
    await postButton.waitFor({ state: "visible", timeout: 5000 });
    await page.waitForFunction(
      () => {
        const btn = document.querySelector('[data-testid="tweetButton"]');
        return btn && !btn.hasAttribute('disabled') && btn.getAttribute('aria-disabled') !== 'true';
      },
      { timeout: 10000 }
    ).catch(() => {});
    await page.waitForTimeout(200);
    await postButton.click({ timeout: 3000 });
    log("ポストボタンクリック完了");

    log("投稿完了待機…");
    await page.waitForTimeout(2000);
    
    const finalUrl = page.url();
    const posted = !finalUrl.includes("/compose/post");
    log(`投稿${posted ? "成功" : "確認中"} url=${finalUrl}`);
    
    log("context.close()…");
    await context.close();
    log("完了");
    
    return { ok: true, posted, url: finalUrl };
  }

  log("context.close()…");
  await context.close();
  log("完了");
  return { ok: true, posted: false };
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
