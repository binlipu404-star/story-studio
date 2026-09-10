// v6.2 AI 端点预设的纯函数测试（parsePresets/upsert/overwrite/remove/matches）。
import {
  matchesConfig,
  overwritePreset,
  parsePresets,
  removePreset,
  upsertPreset,
} from "../../dist-test/ai/presets.js";

const CFG = {
  writer: { baseURL: "https://a.example/v1", model: "m-a", apiKey: "sk-a" },
  analyzer: { baseURL: "https://b.example/v1", model: "m-b", apiKey: "sk-b" },
};

export default async (t) => {
  // ---------- parsePresets 宽容解析 ----------
  t.eq(parsePresets(null).length, 0, "null → 空表");
  t.eq(parsePresets("{坏 json").length, 0, "坏 JSON → 空表不抛错");
  t.eq(parsePresets('{"not":"array"}').length, 0, "非数组 → 空表");
  {
    const raw = JSON.stringify([
      { id: "x1", name: " 官方 ", cfg: { writer: CFG.writer, analyzer: CFG.analyzer } },
      { id: "", name: "无id丢弃" },
      { id: "x2", name: "   " },
      null,
      42,
    ]);
    const out = parsePresets(raw);
    t.eq(out.length, 1, "坏条目逐条丢弃，只留合法条目");
    t.eq(out[0].name, "官方", "名字 trim 收边");
    t.eq(out[0].cfg.writer.baseURL, "https://a.example/v1", "cfg 走 toEndpoint 规整保留");
    t.eq(out[0].cfg.analyzer.model, "m-b", "analyzer 槽完整");
  }
  {
    // 残缺 cfg：坏字段逐条回落默认值（与 loadAppConfig 同一规整规则）
    const out = parsePresets(JSON.stringify([{ id: "x", name: "n", cfg: { writer: { model: 123 } } }]));
    t.eq(out[0].cfg.writer.model, "", "非字符串 model 回落空");
    t.ok(out[0].cfg.writer.baseURL.includes("."), "缺 baseURL 回落默认端点");
  }
  {
    const many = JSON.stringify(
      Array.from({ length: 60 }, (_, i) => ({ id: `p${i}`, name: `n${i}`, cfg: {} })),
    );
    t.eq(parsePresets(many).length, 50, "上限 50 条防爆桶");
  }

  // ---------- upsertPreset ----------
  {
    const a = upsertPreset([], " 官方 ", CFG);
    t.eq(a.length, 1, "新名追加");
    t.eq(a[0].name, "官方", "入库前 trim");
    t.ok(a[0].id.length > 0, "自动发 id");
    t.eq(upsertPreset(a, "", CFG).length, 1, "空名拒绝：原列表返回");
    const b = upsertPreset(a, "官方", { ...CFG, writer: { ...CFG.writer, model: "m-x" } });
    t.eq(b.length, 1, "同名=覆盖内容不追加");
    t.eq(b[0].id, a[0].id, "同名覆盖保留原 id/位置");
    t.eq(b[0].cfg.writer.model, "m-x", "内容确实被换");
    const c = upsertPreset(b, "官方", CFG, b[0].id);
    t.eq(c[0].cfg.writer.model, "m-a", "显式 id 定位替换");
    t.eq(upsertPreset(c, "改名", CFG, "不存在的id").length, 1, "显式 id 不存在=不增条目");
  }

  // ---------- overwrite / remove ----------
  {
    const list = upsertPreset(upsertPreset([], "A", CFG), "B", CFG);
    t.eq(overwritePreset(list, "不存在", { ...CFG, writer: { ...CFG.writer, model: "z" } }).length, 2, "未知 id 原样");
    const ov = overwritePreset(list, list[0].id, { ...CFG, writer: { ...CFG.writer, model: "z" } });
    t.eq(ov[0].name, "A", "overwrite 不动名字");
    t.eq(ov[0].cfg.writer.model, "z", "overwrite 换内容");
    t.eq(removePreset(ov, list[0].id).length, 1, "remove 精确剔除");
    t.eq(removePreset(ov, list[0].id)[0].name, "B", "留下的是另一条");
  }

  // ---------- matchesConfig（下拉框「使用中」标记的依据） ----------
  {
    const p = { id: "x", name: "n", cfg: CFG };
    t.ok(matchesConfig(p, JSON.parse(JSON.stringify(CFG))), "深相等 → true");
    t.ok(!matchesConfig(p, { ...CFG, writer: { ...CFG.writer, model: "其他" } }), "创作槽模型不同 → false");
    t.ok(!matchesConfig(p, { ...CFG, analyzer: { ...CFG.analyzer, apiKey: "sk-z" } }), "分析槽 Key 不同 → false");
    t.ok(
      matchesConfig(
        { id: "x", name: "n", cfg: { writer: { ...CFG.writer, temperature: undefined }, analyzer: CFG.analyzer } },
        CFG,
      ),
      "temperature undefined 与缺省等价（?? null 归一）",
    );
    t.ok(
      !matchesConfig(
        { id: "x", name: "n", cfg: { writer: { ...CFG.writer, maxTokens: 999 }, analyzer: CFG.analyzer } },
        CFG,
      ),
      "maxTokens 差异也算不同",
    );
  }
};
