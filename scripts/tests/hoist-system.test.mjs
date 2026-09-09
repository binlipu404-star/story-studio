// v6.1 system 置顶规范化测试：DeepSeek 官方端点要求「System message must be at the beginning」
// （出网点 client.ts 用它收口；这里测纯函数本体）。
import { hoistSystemMessages } from "../../dist-test/ai/messages.js";

export default async (t) => {
  // ---------- 合规输入零拷贝 ----------
  {
    const ok = [
      { role: "system", content: "s" },
      { role: "user", content: "u" },
      { role: "assistant", content: "a" },
    ];
    t.ok(hoistSystemMessages(ok) === ok, "system 已在最前 → 返回原数组引用（零拷贝）");
  }
  {
    const none = [
      { role: "user", content: "u" },
      { role: "assistant", content: "a" },
    ];
    t.ok(hoistSystemMessages(none) === none, "无 system → 原引用");
  }
  {
    const all = [
      { role: "system", content: "s1" },
      { role: "system", content: "s2" },
    ];
    t.ok(hoistSystemMessages(all) === all, "全 system（leading 连段覆盖全列）→ 原引用");
  }
  t.ok(hoistSystemMessages([]).length === 0, "空数组 → 长度 0 不抛错");

  // ---------- 中置 system 前移（RP 楼层系统条） ----------
  {
    const mid = [
      { role: "system", content: "sys-main" },
      { role: "user", content: "u1" },
      { role: "system", content: "sys-floor" },
      { role: "assistant", content: "a1" },
      { role: "user", content: "u2" },
    ];
    const out = hoistSystemMessages(mid);
    t.eq(
      out.map((m) => m.role).join(","),
      "system,system,user,assistant,user",
      "中置 system 提到 leading 连段，非 system 相对顺序不变",
    );
    t.eq(out[1].content, "sys-floor", "前移的 system 落在 leading 连段尾部");
  }

  // ---------- 多条后置 system 保持相对顺序（摘要条+选材块场景） ----------
  {
    const many = [
      { role: "system", content: "main" },
      { role: "user", content: "u1" },
      { role: "system", content: "late-b" },
      { role: "assistant", content: "a1" },
      { role: "system", content: "late-c" },
    ];
    const out = hoistSystemMessages(many);
    t.eq(
      out.filter((m) => m.role === "system").map((m) => m.content).join(","),
      "main,late-b,late-c",
      "多条 system 按原相对顺序并入首位连段",
    );
    t.eq(
      out.filter((m) => m.role !== "system").map((m) => m.content).join(","),
      "u1,a1",
      "非 system 顺序与内容原样",
    );
  }

  // ---------- 附加字段与宽形消息原样保留（chatTools 的 tool/assistant 条） ----------
  {
    const wide = [
      { role: "user", content: "u" },
      { role: "assistant", content: null, tool_calls: [{ id: "1" }] },
      { role: "tool", tool_call_id: "1", content: "res" },
      { role: "system", content: "late" },
    ];
    const out = hoistSystemMessages(wide);
    t.eq(out[0].content, "late", "后置 system 提到最前（此前无 leading system）");
    const asst = out.find((m) => m.role === "assistant");
    t.ok(asst && Array.isArray(asst.tool_calls), "assistant 的 tool_calls 附加字段保留");
    const tool = out.find((m) => m.role === "tool");
    t.eq(tool?.tool_call_id, "1", "tool 消息的 tool_call_id 保留");
    t.eq(
      out.map((m) => m.role).join(","),
      "system,user,assistant,tool",
      "非 system 相对顺序（user→assistant→tool 原列序）不变",
    );
  }
};
