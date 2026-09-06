import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Web-first：AI 请求由浏览器直连用户在设置里填写的 baseURL（OpenAI 兼容端点）。
// 需要代理的端点（不允许 CORS 的）属于桌面壳阶段的能力，见规划文档第 6 节。
export default defineConfig({
  // GitHub Pages（项目页挂在 /<仓库名>/ 子路径下）：相对路径资源，免绑仓库名。
  base: "./",
  plugins: [react()],
  server: {
    watch: {
      // 只关注输入：dist 是构建产物；scripts/ 下有 Node 测试与编辑工具的原子写临时文件，
      // 曾以 EBUSY 撞崩 vite 的 FSWatcher（Windows）。
      ignored: ["**/dist/**", "**/dist-test/**", "**/scripts/**", "**/.*tmpdir/**"],
    },
  },
});
