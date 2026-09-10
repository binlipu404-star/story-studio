// Story Studio 桌面壳入口
// - 单实例：二次启动聚焦已有窗口（IndexedDB 单连接，多开会互踩）
// - 窗口状态：尺寸/位置记忆（关窗即存，重开还原）
// - V7-A2 本地代理：127.0.0.1 动态端口，CORS 根治（proxy 模块 + proxy_port 命令）
// - V7-B1 更新镜像覆盖：app 配置目录下 update-mirror.txt 存在且非空时，
//   用其中端点整表替换 conf 内嵌端点（GitHub 不通时的自救通道；# 开头为注释）

mod proxy;

use proxy::ProxyPort;
use tauri::ipc::Channel;
use tauri::Manager;
use tauri_plugin_updater::UpdaterExt;

/// 前端探测"我在壳里"+拿代理端口：浏览器版里此 invoke 会 reject，据此区分环境。
#[tauri::command]
fn proxy_port(state: tauri::State<'_, ProxyPort>) -> u16 {
  state.0.get().copied().unwrap_or(0)
}

/// 检查并（若有）下载+安装更新的返回值：None=已是最新。
#[derive(serde::Serialize)]
struct UpdateInfo {
  version: String,
  body: Option<String>,
}

/// 读 update-mirror.txt（app 配置目录）：每行一个 https 端点，# 注释、空行跳过。
/// 返回空 Vec = 无覆盖，沿用 conf 内嵌端点。
fn read_mirror_endpoints(app: &tauri::AppHandle) -> Vec<tauri::Url> {
  let mut urls = Vec::new();
  let Ok(dir) = app.path().app_config_dir() else {
    return urls;
  };
  let file = dir.join("update-mirror.txt");
  let Ok(text) = std::fs::read_to_string(&file) else {
    return urls;
  };
  for line in text.lines() {
    let line = line.trim();
    if line.is_empty() || line.starts_with('#') {
      continue;
    }
    match line.parse::<tauri::Url>() {
      Ok(u) => urls.push(u),
      Err(e) => log::warn!("update-mirror.txt 跳过坏行 {line:?}: {e}"),
    }
  }
  if !urls.is_empty() {
    log::info!("更新镜像覆盖生效，端点: {urls:?}");
  }
  urls
}

/// 一步式更新：镜像检查→下载→安装（NSIS passive，装完由安装器拉起新版）。
/// on_progress 通道回传累计字节，前端显示 MB。
#[tauri::command]
async fn updater_update(app: tauri::AppHandle, on_progress: Channel<u64>) -> Result<Option<UpdateInfo>, String> {
  let mut builder = app.updater_builder();
  let mirror = read_mirror_endpoints(&app);
  if !mirror.is_empty() {
    builder = builder.endpoints(mirror).map_err(|e| e.to_string())?;
  }
  let updater = builder.build().map_err(|e| e.to_string())?;
  let Some(update) = updater.check().await.map_err(|e| e.to_string())? else {
    return Ok(None);
  };
  let info = UpdateInfo {
    version: update.version.clone(),
    body: update.body.clone(),
  };
  let mut got: u64 = 0;
  update
    .download_and_install(
      move |chunk, _total| {
        got += chunk as u64;
        let _ = on_progress.send(got);
      },
      || {},
    )
    .await
    .map_err(|e| e.to_string())?;
  Ok(Some(info))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
      // 二次启动：唤起并聚焦主窗口，而不是开出第二个实例
      if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
      }
    }))
    .plugin(tauri_plugin_window_state::Builder::default().build())
    .plugin(tauri_plugin_updater::Builder::new().build())
    .plugin(tauri_plugin_process::init())
    .manage(ProxyPort::default())
    .setup(|app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }
      // 本地代理：tokio 循环挂到专用 OS 线程，与 Tauri 自身运行时互不抢占
      let handle = app.handle().clone();
      std::thread::Builder::new()
        .name("local-proxy".into())
        .spawn(move || {
          let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build();
          if let Ok(rt) = rt {
            rt.block_on(proxy::start(handle));
          }
        })
        .expect("spawn local-proxy thread");
      Ok(())
    })
    .invoke_handler(tauri::generate_handler![proxy_port, updater_update])
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
