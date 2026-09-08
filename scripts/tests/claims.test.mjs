// 「完成式宣称」话术检测 claimsCompletion 冒烟测试（v6 P1）
// 家法：宁可漏报不可误报——正例全 true、反例（否定/疑问/名词化/空串）全 false。
import { claimsCompletion } from "../../dist-test/core/claims.js";

export default async function (t) {
  // 1. 正例：完成式宣称全命中
  t.eq(claimsCompletion("已写入档案"), true, "1. 已写入档案 → true");
  t.eq(claimsCompletion("已经帮你填好了"), true, "1. 已经帮你填好了 → true");
  t.eq(claimsCompletion("已完成"), true, "1. 已完成 → true");
  t.eq(claimsCompletion("已记录在案"), true, "1. 已记录在案 → true");
  t.eq(claimsCompletion("我已经创建了第一卷"), true, "1. 我已经创建了第一卷 → true");

  // 2. 反例：否定/疑问/名词化/空串一律放行（false）
  t.eq(claimsCompletion("还没有完成"), false, "2. 还没有完成 → false");
  t.eq(claimsCompletion("还没写入档案"), false, "2. 还没写入档案 → false");
  t.eq(claimsCompletion("尚未记录"), false, "2. 尚未记录 → false");
  t.eq(claimsCompletion("已经写入了吗？"), false, "2. 疑问句 → false");
  t.eq(claimsCompletion("本轮没有提案"), false, "2. 没有提案 → false");
  t.eq(claimsCompletion("已完成度还很低"), false, "2. 名词化（完成度）→ false");
  t.eq(claimsCompletion(""), false, "2. 空串 → false");

  // 3. 混合语境：一句里有宣称就命中；疑问守卫只保护所在小句
  t.eq(claimsCompletion("我们聊聊节奏吧，我已经更新了世界设定"), true, "3. 复合句后半宣称 → true");
  t.eq(claimsCompletion("还没有完成，等你想好我再写"), false, "3. 纯否定长句 → false");
  t.eq(claimsCompletion("已经生成了吗？还没有呢"), false, "3. 两个疑问小句都不算 → false");

  // 4. 中英混排与多余空白容忍
  t.eq(claimsCompletion("已经  写入 档案"), true, "4. 多余空白容忍 → true");
  t.eq(claimsCompletion("I 已经 created 了新卷"), false, "4. 中英混排但动词不邻接（created 前隔词）→ false（保守）");
  t.eq(claimsCompletion("OK 我已经保存了"), true, "4. 中英混排 → true");
  t.eq(claimsCompletion("已经 保存 了吗?"), false, "4. 英文问号+空白 → false");
}
