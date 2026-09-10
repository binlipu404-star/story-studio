// Story Studio 桌面壳入口（V7-A1）
// - 单实例：二次启动聚焦已有窗口（IndexedDB 单连接，多开会互踩）
// - 窗口状态：尺寸/位置记忆（关窗即存，重开还原）
// - A2 的本地代理将挂在这里（proxy 模块 + proxy_port 命令）

use tauri::Manager;

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
    .setup(|app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }
      Ok(())
    })
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
