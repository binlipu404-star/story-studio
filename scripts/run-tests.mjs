// 逻辑冒烟测试入口：node scripts/run-tests.mjs（先 npm run build:logic）
// 约定：scripts/tests/*.test.mjs 默认导出 async function (t)，
// t = { ok(cond, msg), eq(a, b, msg), skip(msg) }；测试从 ../../dist-test/... 导入编译产物。
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const dir = path.join(here, "tests");

if (!existsSync(path.resolve(here, "..", "dist-test", "st"))) {
  console.error("[tests] 未找到 dist-test/，请先运行 npm run build:logic");
  process.exit(1);
}

let total = 0;
let failed = 0;
let skipped = 0;

const files = readdirSync(dir).filter((f) => f.endsWith(".test.mjs")).sort();
for (const file of files) {
  const mod = await import(pathToFileURL(path.join(dir, file)).href);
  const runner = mod.default;
  if (typeof runner !== "function") {
    console.log(`[skip] ${file}：无 default 导出的测试函数`);
    continue;
  }
  const t = {
    ok: (cond, msg) => {
      total++;
      if (cond) console.log(`  ✓ ${msg ?? "ok"}`);
      else {
        failed++;
        console.error(`  ✗ FAIL: ${msg ?? "ok"}`);
      }
    },
    eq: (a, b, msg) =>
      t.ok(
        Object.is(a, b) || JSON.stringify(a) === JSON.stringify(b),
        `${msg ?? "eq"}：${JSON.stringify(a)} === ${JSON.stringify(b)}`,
      ),
    skip: (msg) => {
      skipped++;
      console.log(`  - skip: ${msg}`);
    },
  };
  console.log(`\n=== ${file} ===`);
  try {
    await runner(t);
  } catch (e) {
    total++;
    failed++;
    console.error(`  ✗ ${file} 抛出异常：`, e);
  }
}

console.log(`\n[tests] total=${total} failed=${failed} skipped=${skipped}`);
process.exit(failed ? 1 : 0);
