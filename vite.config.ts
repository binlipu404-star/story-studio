import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

// Web-first：AI 请求由浏览器直连用户在设置里填写的 baseURL（OpenAI 兼容端点）。
// 需要代理的端点（不允许 CORS 的）属于桌面壳阶段的能力，见规划文档第 6 节。
//
// dev 代理逃生口（v6.1）：不少网关（如 sub2api）零 CORS 头、OPTIONS 预检 403，
// 浏览器直连必挂。在 .env.local（已 gitignore）里写
//   LLM_PROXY_TARGET=https://你的网关
// dev server 即把 /llm/* 同源转发到该网关（Authorization 头原样透传，Key 仍只在
// 浏览器 localStorage）。设置页 baseURL 填相对路径 /llm/v1 即可绕开跨域。
// 不配该变量 = 无代理，行为与原来完全一致；生产构建（Pages）无 dev server，不受影响。
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "LLM_");
  const proxyTarget = (env.LLM_PROXY_TARGET || "").trim();
  return {
    // GitHub Pages（项目页挂在 /<仓库名>/ 子路径下）：相对路径资源，免绑仓库名。
    base: "./",
    plugins: [react()],
    server: {
      watch: {
        // 只关注输入：dist 是构建产物；scripts/ 下有 Node 测试与编辑工具的原子写临时文件，
        // 曾以 EBUSY 撞崩 vite 的 FSWatcher（Windows）；src-tauri/target 是 cargo 编译
        // 产物（cargo check 时 exe 被占用，同样 EBUSY 崩 vite），一律不进 watch。
        ignored: [
          "**/dist/**",
          "**/dist-test/**",
          "**/scripts/**",
          "**/.*tmpdir/**",
          "**/src-tauri/**",
        ],
      },
      ...(proxyTarget
        ? {
            proxy: {
              "/llm": {
                target: proxyTarget,
                changeOrigin: true,
                rewrite: (p: string) => p.replace(/^\/llm/, ""),
              },
            },
          }
        : {}),
    },
  };
});
