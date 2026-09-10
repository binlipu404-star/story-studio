// Story Studio 桌面壳入口
// - 单实例：二次启动聚焦已有窗口（IndexedDB 单连接，多开会互踩）
// - 窗口状态：尺寸/位置记忆（关窗即存，重开还原）
// - V7-A2 本地代理：127.0.0.1 动态端口，CORS 根治（proxy 模块 + proxy_port 命令）

mod proxy;

use proxy::ProxyPort;
use tauri::Manager;

/// 前端探测"我在壳里"+拿代理端口：浏览器版里此 invoke 会 reject，据此区分环境。
#[tauri::command]
fn proxy_port(state: tauri::State<'_, ProxyPort>) -> u16 {
  state.0.get().copied().unwrap_or(0)
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
    .invoke_handler(tauri::generate_handler![proxy_port])
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
