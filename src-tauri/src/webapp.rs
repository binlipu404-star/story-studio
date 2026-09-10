// ============================================================
// V7.2-D1 松绑（方案 A′）：覆盖注册 `tauri` 协议，从松文件目录伺服前端。
//
// 原理（本仓库实证的两条源码前提）：
//  1) tauri-2.11.5/src/manager/webview.rs:267 —— 内置 tauri 协议是**条件注册**：
//     应用自己 register 了同名协议，内置实现就不再注册。
//  2) Windows 上页面真实 origin = http://tauri.localhost（wry 的 custom-protocol
//     workaround），与我们注册的协议名无关 → **origin 不变，WebView2 的
//     IndexedDB 原地保留**（红线：老用户书稿数据零迁移）。
//
// 双根伺服（回答"升级会不会冲掉我改的文件"）：
//  · 用户区 %APPDATA%\town.cafero.storystudio\webapp —— 优先命中；NSIS 永不触碰；
//  · 出厂区 <安装目录>\webapp（bundle.resources 随包）—— 兜底，随更新刷新。
// 用户在用户区放一份改过的 index.html/assets 即接管；删掉用户区=恢复出厂。
//
// dev（tauri dev 走 devUrl=5199）不经过本协议；三个管理命令在 dev 下同样可用。
// ============================================================

use std::borrow::Cow;
use std::path::{Component, Path, PathBuf};

use tauri::http::{header::CONTENT_TYPE, Response, StatusCode};
use tauri::{AppHandle, Manager};

const WINDOW_ORIGIN: &str = "http://tauri.localhost";

/// 用户区（可编辑）：<app_config_dir>\webapp
pub fn user_root(app: &AppHandle) -> Option<PathBuf> {
  app.path().app_config_dir().ok().map(|d| d.join("webapp"))
}

/// 出厂区（随更新）：<resource_dir>\webapp
pub fn factory_root(app: &AppHandle) -> Option<PathBuf> {
  app.path().resource_dir().ok().map(|d| d.join("webapp"))
}

/// 把请求 URI 还原成相对路径（wry 在 Windows 上会把 http://tauri.localhost/x
/// revert 回 tauri://localhost/x 再交给 handler，两种前缀都兼容）。
fn request_path(uri: &str) -> String {
  let stripped = uri
    .strip_prefix("tauri://localhost")
    .or_else(|| uri.strip_prefix("http://tauri.localhost"))
    .or_else(|| uri.strip_prefix("https://tauri.localhost"))
    .unwrap_or(if uri.starts_with('/') { uri } else { "/" });
  // 忽略 query 与 fragment；空路径归一为根
  let cut = stripped.split(['?', '#']).next().unwrap_or("/");
  if cut.is_empty() {
    "/".to_string()
  } else {
    cut.to_string()
  }
}

/// 最小百分号解码（打包产物文件名都是 ASCII；中文手放文件也支持）
fn pct_decode(s: &str) -> String {
  let bytes = s.as_bytes();
  let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
  let mut i = 0;
  while i < bytes.len() {
    if bytes[i] == b'%' && i + 2 < bytes.len() {
      let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).ok();
      if let Some(v) = hex.and_then(|h| u8::from_str_radix(h, 16).ok()) {
        out.push(v);
        i += 3;
        continue;
      }
    }
    out.push(bytes[i]);
    i += 1;
  }
  String::from_utf8_lossy(&out).into_owned()
}

/// 在 root 下安全解析 rel：拒绝 .. / 绝对路径 / 盘符；canonicalize 后仍须在 root 内。
fn resolve_in(root: &Path, rel: &str) -> Option<PathBuf> {
  let rel_path = Path::new(rel);
  if rel_path.is_absolute() || rel.contains(':') {
    return None;
  }
  if rel_path
    .components()
    .any(|c| !matches!(c, Component::Normal(_)))
  {
    return None;
  }
  let joined = root.join(rel_path);
  let canonical = joined.canonicalize().ok()?;
  let root_canonical = root.canonicalize().ok()?;
  if canonical.starts_with(&root_canonical) && canonical.is_file() {
    Some(canonical)
  } else {
    None
  }
}

fn guess_mime(path: &Path) -> &'static str {
  // dist 产物类型可枚举，手写表零新依赖（免引 crate、免杀软拦 build script 风险）
  match path
    .extension()
    .and_then(|e| e.to_str())
    .unwrap_or("")
    .to_ascii_lowercase()
    .as_str()
  {
    "html" | "htm" => "text/html; charset=utf-8",
    "js" | "mjs" => "text/javascript; charset=utf-8",
    "css" => "text/css; charset=utf-8",
    "json" | "map" => "application/json",
    "svg" => "image/svg+xml",
    "png" => "image/png",
    "jpg" | "jpeg" => "image/jpeg",
    "gif" => "image/gif",
    "webp" => "image/webp",
    "ico" => "image/x-icon",
    "woff" => "font/woff",
    "woff2" => "font/woff2",
    "ttf" => "font/ttf",
    "otf" => "font/otf",
    "txt" => "text/plain; charset=utf-8",
    "wasm" => "application/wasm",
    _ => "application/octet-stream",
  }
}

fn respond(body: Vec<u8>, mime: &str, status: StatusCode) -> Response<Cow<'static, [u8]>> {
  Response::builder()
    .status(status)
    .header(CONTENT_TYPE, mime)
    .header("Access-Control-Allow-Origin", WINDOW_ORIGIN)
    .header("Cache-Control", "no-cache")
    .body(Cow::Owned(body))
    .unwrap()
}

fn not_found_page() -> Response<Cow<'static, [u8]>> {
  let html = "<!doctype html><meta charset=\"utf-8\"><title>Story Studio · webapp 缺失</title>\
    <body style=\"font-family:sans-serif;padding:40px;background:#111;color:#eee\">\
    <h2>找不到网页程序（webapp）</h2>\
    <p>用户区与出厂区都没有可用的 index.html。请在 设置 → 桌面版 → 网页程序 里点\
    「打开文件夹」，把 Story Studio 的 dist 构建产物放进去，然后重启应用。</p>\
    <p>也可以从旧版本恢复：点「恢复出厂」删掉用户区覆盖。</p></body>";
  respond(html.as_bytes().to_vec(), "text/html; charset=utf-8", StatusCode::NOT_FOUND)
}

/// 在有序根列表里依序找 rel（用户区在前=覆盖出厂区），返回第一个命中的文件。
fn hit_file(roots: &[&Path], rel: &str) -> Option<PathBuf> {
  roots.iter().find_map(|root| resolve_in(root, rel))
}

/// 核心伺服：用户区 → 出厂区 → exe 内嵌资产（三层兜底）；
/// 命中不了且是无扩展名路径 → index.html（SPA 兜底）。
/// pub：lib.rs 的同名协议注册闭包调用它。
pub fn serve(app: &AppHandle, uri: &str) -> Response<Cow<'static, [u8]>> {
  let decoded = pct_decode(&request_path(uri));
  let rel = decoded.trim_start_matches('/');
  let rel = if rel.is_empty() { "index.html" } else { rel };

  let owned_roots = [user_root(app), factory_root(app)];
  let roots: Vec<&Path> = owned_roots.iter().flatten().map(PathBuf::as_path).collect();

  // 1. 直接命中（用户区优先）
  if let Some(file) = hit_file(&roots, rel) {
    if let Ok(bytes) = std::fs::read(&file) {
      return respond(bytes, guess_mime(&file), StatusCode::OK);
    }
  }
  // 2. exe 内嵌资产（内置协议同款通道：frontendDist 仍随编译嵌入，
  //    用户区/出厂区都没有时兜底——松绑失败也不白屏，等于回到旧行为）
  if let Some(asset) = app.asset_resolver().get(rel.to_string()) {
    return respond(asset.bytes, &asset.mime_type, StatusCode::OK);
  }
  // 3. SPA 兜底：无扩展名的"路由"回 index.html（本前端是 tab 状态机，
  //    正常用不到；防第三方魔改 dist 引入 router 后刷新 404）
  if Path::new(rel).extension().is_none() {
    let html = hit_file(&roots, "index.html")
      .and_then(|f| std::fs::read(f).ok())
      .or_else(|| app.asset_resolver().get("index.html".into()).map(|a| a.bytes));
    if let Some(bytes) = html {
      return respond(bytes, "text/html; charset=utf-8", StatusCode::OK);
    }
  }
  not_found_page()
}

// ---------- 管理命令（前端「设置 → 桌面版 → 网页程序」用） ----------

#[derive(serde::Serialize)]
pub struct WebappStatus {
  /// 用户区目录（绝对路径，可自由放/改 dist 文件）
  pub user_dir: String,
  /// 出厂区目录（随更新刷新）
  pub factory_dir: String,
  /// 用户区已有 index.html（=当前接管生效）
  pub user_active: bool,
  /// 出厂区有货（=松绑版随包资源就位；老包升级前为 false）
  pub factory_present: bool,
  /// 用户区现有条目名（帮用户确认放没放对）
  pub user_entries: Vec<String>,
}

#[tauri::command]
pub fn webapp_status(app: AppHandle) -> WebappStatus {
  let user_dir = user_root(&app);
  let factory_dir = factory_root(&app);
  let user_active = user_dir
    .as_ref()
    .map(|d| d.join("index.html").is_file())
    .unwrap_or(false);
  let factory_present = factory_dir
    .as_ref()
    .map(|d| d.join("index.html").is_file())
    .unwrap_or(false);
  let user_entries = user_dir
    .as_ref()
    .and_then(|d| std::fs::read_dir(d).ok())
    .map(|rd| {
      rd.flatten()
        .filter_map(|e| e.file_name().to_str().map(str::to_string))
        .take(50)
        .collect()
    })
    .unwrap_or_default();
  WebappStatus {
    user_dir: user_dir.map(|d| d.display().to_string()).unwrap_or_default(),
    factory_dir: factory_dir.map(|d| d.display().to_string()).unwrap_or_default(),
    user_active,
    factory_present,
    user_entries,
  }
}

/// 在资源管理器打开用户区（不存在则创建）。explorer 退出码不可靠，忽略。
#[tauri::command]
pub fn webapp_open_folder(app: AppHandle) -> Result<String, String> {
  let dir = user_root(&app).ok_or("拿不到用户区路径")?;
  std::fs::create_dir_all(&dir).map_err(|e| format!("创建用户区失败：{e}"))?;
  let _ = std::process::Command::new("explorer").arg(&dir).spawn();
  Ok(dir.display().to_string())
}

/// 恢复出厂：删除整个用户区覆盖（下次伺服立即回到随包版本）。
#[tauri::command]
pub fn webapp_reset(app: AppHandle) -> Result<(), String> {
  let dir = user_root(&app).ok_or("拿不到用户区路径")?;
  if dir.exists() {
    std::fs::remove_dir_all(&dir).map_err(|e| format!("删除用户区失败：{e}"))?;
  }
  Ok(())
}

// ============================================================
// 单元测试（cargo test -p story-studio --lib）：URI 还原 + 路径安全
// ============================================================
#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn 三种前缀都还原成相对路径() {
    assert_eq!(request_path("tauri://localhost/assets/a.js"), "/assets/a.js");
    assert_eq!(request_path("http://tauri.localhost/assets/a.js"), "/assets/a.js");
    assert_eq!(request_path("https://tauri.localhost/index.html"), "/index.html");
    // query/fragment 剥掉
    assert_eq!(request_path("tauri://localhost/a.css?v=3"), "/a.css");
    assert_eq!(request_path("tauri://localhost/#/x"), "/");
    // 裸协议头 → 根
    assert_eq!(request_path("tauri://localhost"), "/");
    // 怪输入一律根，不 panic
    assert_eq!(request_path("ftp://evil/x"), "/");
    assert_eq!(request_path("relative/path"), "/");
  }

  #[test]
  fn 百分号解码() {
    assert_eq!(pct_decode("/a%20b.js"), "/a b.js");
    assert_eq!(pct_decode("/%E4%B8%AD.txt"), "/中.txt");
    // 非法转义原样保留，不 panic
    assert_eq!(pct_decode("/100%zz"), "/100%zz");
    assert_eq!(pct_decode("/end%a"), "/end%a");
    assert_eq!(pct_decode("plain"), "plain");
  }

  #[test]
  fn 路径安全_拒绝穿越与绝对路径() {
    let root = std::env::temp_dir().join(format!("ss-webapp-test-{}", std::process::id()));
    std::fs::create_dir_all(root.join("assets")).unwrap();
    std::fs::write(root.join("index.html"), b"ok").unwrap();
    std::fs::write(root.join("assets/main.js"), b"js").unwrap();

    // 正常命中
    assert!(resolve_in(&root, "index.html").is_some());
    assert!(resolve_in(&root, "assets/main.js").is_some());
    // 穿越/绝对/盘符/空字节成分：全部拒绝
    assert!(resolve_in(&root, "../index.html").is_none());
    assert!(resolve_in(&root, "assets/../../etc/passwd").is_none());
    assert!(resolve_in(&root, "/etc/passwd").is_none());
    assert!(resolve_in(&root, "C:/Windows/win.ini").is_none());
    assert!(resolve_in(&root, "nope.html").is_none());
    // . 开头的隐藏成分也拒（Component::CurDir 不属于 Normal）
    assert!(resolve_in(&root, "./index.html").is_none());

    std::fs::remove_dir_all(&root).ok();
  }

  #[test]
  fn 双根顺序_用户区覆盖出厂区() {
    let tag = std::process::id();
    let user = std::env::temp_dir().join(format!("ss-user-{tag}"));
    let factory = std::env::temp_dir().join(format!("ss-factory-{tag}"));
    std::fs::create_dir_all(&user).unwrap();
    std::fs::create_dir_all(&factory).unwrap();
    std::fs::write(user.join("index.html"), b"USER").unwrap();
    std::fs::write(factory.join("index.html"), b"FACTORY").unwrap();
    std::fs::write(factory.join("only-factory.js"), b"js").unwrap();

    let roots = [user.as_path(), factory.as_path()];
    // 同名：用户区赢（这就是"改过的文件接管界面"）
    assert_eq!(hit_file(&roots, "index.html").and_then(|f| std::fs::read(f).ok()).unwrap(), b"USER");
    // 用户区没有的：落出厂区（"随包资源兜底"）
    assert!(hit_file(&roots, "only-factory.js").is_some());
    // 两边都没有
    assert!(hit_file(&roots, "ghost.css").is_none());

    std::fs::remove_dir_all(&user).ok();
    std::fs::remove_dir_all(&factory).ok();
  }

  #[test]
  fn MIME_覆盖前端产物类型() {
    let p = |s: &str| Path::new(s).to_path_buf();
    assert_eq!(guess_mime(&p("a.html")), "text/html; charset=utf-8");
    assert_eq!(guess_mime(&p("a.JS")), "text/javascript; charset=utf-8");
    assert_eq!(guess_mime(&p("a.css")), "text/css; charset=utf-8");
    assert_eq!(guess_mime(&p("a.woff2")), "font/woff2");
    assert_eq!(guess_mime(&p("a.svg")), "image/svg+xml");
    assert_eq!(guess_mime(&p("a")), "application/octet-stream");
  }
}
