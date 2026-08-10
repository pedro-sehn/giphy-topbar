use std::fs;
use std::path::PathBuf;

use serde_json::{Map, Value};
use tauri::image::Image;
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, LogicalSize, Manager, PhysicalPosition, Runtime, WebviewWindow};
use tauri_plugin_clipboard_manager::ClipboardExt;

const WIDTH: f64 = 380.0;
const HEIGHT: f64 = 520.0;
const EDGE_MARGIN: f64 = 8.0;

fn config_path<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("config.json"))
}

fn read_config<R: Runtime>(app: &AppHandle<R>) -> Map<String, Value> {
    config_path(app)
        .ok()
        .and_then(|p| fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str::<Map<String, Value>>(&s).ok())
        .unwrap_or_default()
}

#[tauri::command]
fn get_config(app: AppHandle) -> Map<String, Value> {
    read_config(&app)
}

#[tauri::command]
fn set_config(app: AppHandle, patch: Map<String, Value>) -> Result<(), String> {
    let mut config = read_config(&app);
    config.extend(patch);
    let path = config_path(&app)?;
    fs::write(path, serde_json::to_string_pretty(&config).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn copy_text(app: AppHandle, text: String) -> Result<(), String> {
    app.clipboard().write_text(text).map_err(|e| e.to_string())
}

#[tauri::command]
fn hide_window(window: WebviewWindow) -> Result<(), String> {
    window.hide().map_err(|e| e.to_string())
}

#[tauri::command]
fn quit_app(app: AppHandle) {
    app.exit(0);
}

/// Places the popup under the tray icon, clamped so it never runs off the display.
/// The tray rect arrives in physical pixels, so the window size is converted to match.
fn position_under_tray(window: &WebviewWindow, tray_rect: tauri::Rect) -> tauri::Result<()> {
    let scale = window.scale_factor()?;
    let size = LogicalSize::new(WIDTH, HEIGHT).to_physical::<f64>(scale);

    let tray_pos = tray_rect.position.to_physical::<f64>(scale);
    let tray_size = tray_rect.size.to_physical::<f64>(scale);

    let mut x = tray_pos.x + tray_size.width / 2.0 - size.width / 2.0;
    let y = tray_pos.y + tray_size.height;

    if let Some(monitor) = window.monitor_from_point(tray_pos.x, tray_pos.y)? {
        let m_pos = monitor.position();
        let m_size = monitor.size();
        let margin = EDGE_MARGIN * scale;
        let min_x = m_pos.x as f64 + margin;
        let max_x = (m_pos.x + m_size.width as i32) as f64 - size.width - margin;
        x = x.clamp(min_x, max_x.max(min_x));
    }

    window.set_position(PhysicalPosition::new(x, y))
}

fn toggle_window(app: &AppHandle, tray_rect: Option<tauri::Rect>) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };

    if window.is_visible().unwrap_or(false) {
        let _ = window.hide();
        return;
    }

    if let Some(rect) = tray_rect {
        let _ = position_under_tray(&window, rect);
    }

    let _ = window.show();
    let _ = window.set_focus();
    let _ = window.emit("window-shown", ());
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_clipboard_manager::init())
        .invoke_handler(tauri::generate_handler![
            get_config,
            set_config,
            copy_text,
            hide_window,
            quit_app
        ])
        .setup(|app| {
            // Menu bar only: no Dock icon, no app switcher entry.
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            let icon = Image::from_bytes(include_bytes!("../icons/tray.png"))?;

            TrayIconBuilder::with_id("main")
                .icon(icon)
                .icon_as_template(true)
                .tooltip("Fast Giphy")
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        rect,
                        ..
                    } = event
                    {
                        toggle_window(tray.app_handle(), Some(rect));
                    }
                })
                .build(app)?;

            // Dismiss the popup as soon as it loses focus, like a native menu.
            let window = app.get_webview_window("main").expect("main window missing");
            let handle = window.clone();
            window.on_window_event(move |event| {
                if let tauri::WindowEvent::Focused(false) = event {
                    let _ = handle.hide();
                }
            });

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
