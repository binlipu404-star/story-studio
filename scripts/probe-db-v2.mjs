// 实证：Dexie v1→v2 升级路径 + personas 表属性可见性（fake-indexeddb）
import "fake-indexeddb/auto";
import Dexie from "dexie";

const V1 = {
  projects: "id, updatedAt",
  outlineNodes: "id, projectId, [projectId+parentId], [projectId+level]",
  characters: "id, projectId",
  loreEntries: "id, projectId, [projectId+uid]",
  sessions: "id, projectId",
  ledger: "id, projectId, [projectId+status]",
};

// 场景A：全新库直接按 v2 定义构造 → 构造完成后 db.personas 应立刻可用
class V2Fresh extends Dexie {
  constructor() {
    super("fresh-v2");
    this.version(1).stores(V1);
    this.version(2).stores({ personas: "id, updatedAt" });
  }
}
const a = new V2Fresh();
console.log("A1 构造后 db.personas 存在:", a.personas !== undefined);
await a.open();
await a.personas.add({ id: "p1", name: "测试", updatedAt: 1 });
console.log("A2 add+toArray:", (await a.personas.toArray()).map((x) => x.name).join(","));
a.close();

// 场景B：老浏览器状态——先有 v1 库开着，再出现带 v2 的新代码（模拟 HMR 后整页刷新）
class V1Old extends Dexie {
  constructor() {
    super("legacy-v1");
    this.version(1).stores(V1);
  }
}
const old = new V1Old();
await old.open(); // 库定格在 v1
console.log("B1 v1 库已建立，personas 应不存在:", old.personas === undefined);
const oldInstanceKeepsRunning = { personasUndefined: old.personas === undefined }; // 旧单例视角
class V2Up extends Dexie {
  constructor() {
    super("legacy-v1"); // 同名库，v2 定义
    this.version(1).stores(V1);
    this.version(2).stores({ personas: "id, updatedAt" });
  }
}
const up = new V2Up();
console.log("B2 新实例构造后 db.personas 存在:", up.personas !== undefined);
await up.personas.add({ id: "p2", name: "升级后来客", updatedAt: 2 });
console.log("B3 升级事务自动完成，toArray:", (await up.personas.toArray()).map((x) => x.name).join(","));
console.log("B4 旧单例仍看不到表（这就是浏览器里 F5 前的状态）:", oldInstanceKeepsRunning.personasUndefined);
up.close();
console.log("PROBE DONE");
process.exit(0);
