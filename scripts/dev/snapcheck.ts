import "dotenv/config";
import { activeBrowserPage, ensureBrowserChrome } from "../../src/browser/chrome";
(async () => {
  const ctx = await ensureBrowserChrome();
  const page = await activeBrowserPage(ctx);
  console.log("URL:", page.url());
  await page.goto("https://accounts.snapchat.com/accounts/downloadmydata", { waitUntil: "domcontentloaded" }).catch(()=>{});
  console.log("AFTER_MYDATA_URL:", page.url());
  console.log("BODY_SNIP:", (await page.evaluate(()=>document.body.innerText.slice(0,250)).catch(()=>"?")).replace(/\n+/g," | "));
  process.exit(0);
})();
