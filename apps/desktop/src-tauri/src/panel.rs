//! The now-playing panel that drops down from the tray icon.
//!
//! The player lives in the main window and stays the only thing that decodes
//! audio. It already mirrors what it tells the OS to a native host (see
//! packages/ui/src/player/nativeBridge.ts); `HOST_SCRIPT` makes this shell that
//! host. Each message lands here, is kept as the latest state, and is handed to
//! the panel. The panel's buttons come back the same way the phone app's lock
//! screen does: as `window.__homearpaMusic.command(...)` in the main window.
//!
//! Everything travels over `homelab://` requests, so neither page needs Tauri's
//! IPC and the main window's permissions stay as narrow as they were.

use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::{Manager, PhysicalPosition, Rect, WebviewUrl, WebviewWindowBuilder};

pub const LABEL: &str = "panel";
const WIDTH: f64 = 380.0;
const HEIGHT: f64 = 144.0;
/// Gap between the menu bar and the panel, in logical pixels.
const GAP: f64 = 6.0;

/// The page itself. Desktop-only, so it ships with the shell rather than in
/// the shared UI package, and it starts no player of its own.
pub const PAGE: &str = include_str!("panel.html");

/// Injected into the main window: the host the bridge posts to.
pub const HOST_SCRIPT: &str = "window.__homearpaDesktop = { postMessage(body) { \
    fetch('/api/desktop/now-playing', { method: 'POST', body }).catch(() => {}); } };";

/// The latest state, and when blur last hid the panel.
#[derive(Default)]
pub struct Panel {
    latest: Mutex<Option<String>>,
    blurred_at: Mutex<Option<Instant>>,
}

impl Panel {
    pub fn latest(&self) -> Option<String> {
        self.latest.lock().unwrap().clone()
    }
}

pub fn build(app: &tauri::App) -> tauri::Result<()> {
    let builder = WebviewWindowBuilder::new(
        app,
        LABEL,
        WebviewUrl::CustomProtocol("homelab://localhost/api/desktop/panel".parse().unwrap()),
    )
    .title("Now playing")
    .inner_size(WIDTH, HEIGHT)
    .resizable(false)
    .decorations(false)
    .always_on_top(true)
    .skip_taskbar(true)
    .visible_on_all_workspaces(true)
    .visible(false)
    .focused(false)
    // Dark whatever the system is set to, so the frosted material is too.
    .theme(Some(tauri::Theme::Dark));

    // The same frosted material as the system's own menu bar panels.
    #[cfg(target_os = "macos")]
    let builder = {
        use tauri::utils::config::WindowEffectsConfig;
        use tauri::window::{Effect, EffectState};
        builder
            .transparent(true)
            .effects(WindowEffectsConfig {
                effects: vec![Effect::Popover],
                state: Some(EffectState::Active),
                radius: Some(14.0),
                color: None,
            })
            .initialization_script("document.documentElement.classList.add('frosted');")
    };

    builder.build()?;
    Ok(())
}

/// Store a message from the player and hand it to the panel.
pub fn publish(app: &tauri::AppHandle, body: &[u8]) {
    // Parsed only to refuse anything that is not JSON before it is evaluated
    // as a script literal in the panel.
    let Ok(message) = serde_json::from_slice::<serde_json::Value>(body) else {
        return;
    };
    let message = message.to_string();
    *app.state::<Panel>().latest.lock().unwrap() = Some(message.clone());
    if let Some(panel) = app.get_webview_window(LABEL) {
        let _ = panel.eval(format!("window.__nowPlaying?.({message})"));
    }
}

/// A button press in the panel.
pub fn command(app: &tauri::AppHandle, body: &[u8]) -> bool {
    #[derive(serde::Deserialize)]
    struct Command {
        action: String,
        #[serde(default)]
        detail: serde_json::Value,
    }
    let Ok(Command { action, detail }) = serde_json::from_slice(body) else {
        return false;
    };
    match action.as_str() {
        "show" => {
            hide(app);
            if let Some(main) = app.get_webview_window("main") {
                let _ = main.show();
                let _ = main.unminimize();
                let _ = main.set_focus();
            }
            true
        }
        "hide" => {
            hide(app);
            true
        }
        "play" | "pause" | "nexttrack" | "previoustrack" | "seekto" => {
            let Some(main) = app.get_webview_window("main") else {
                return false;
            };
            main.eval(format!(
                "window.__homearpaMusic?.command({}, {detail})",
                serde_json::Value::String(action)
            ))
            .is_ok()
        }
        _ => false,
    }
}

/// Left click on the tray icon.
pub fn toggle(app: &tauri::AppHandle, icon: Rect) {
    let Some(panel) = app.get_webview_window(LABEL) else {
        return;
    };
    // Clicking the icon while the panel is open blurs the panel first, which
    // hides it. Without this check the click would then open it straight back.
    let just_blurred = app
        .state::<Panel>()
        .blurred_at
        .lock()
        .unwrap()
        .is_some_and(|at| at.elapsed() < Duration::from_millis(300));
    if panel.is_visible().unwrap_or(false) || just_blurred {
        let _ = panel.hide();
        return;
    }
    if let Some(position) = position_under(&panel, icon) {
        let _ = panel.set_position(position);
    }
    let _ = panel.show();
    let _ = panel.set_focus();
}

/// Centre the panel on the icon, below it in a top menu bar and above it in a
/// bottom taskbar, kept inside the icon's monitor.
fn position_under(panel: &tauri::WebviewWindow, icon: Rect) -> Option<PhysicalPosition<f64>> {
    let scale = panel.scale_factor().ok()?;
    let icon_at = icon.position.to_physical::<f64>(scale);
    let icon_size = icon.size.to_physical::<f64>(scale);
    let monitor = panel.monitor_from_point(icon_at.x, icon_at.y).ok()??;
    let (screen_at, screen_size) = (monitor.position(), monitor.size());
    let (width, height, gap) = (WIDTH * scale, HEIGHT * scale, GAP * scale);

    let centre = icon_at.x + icon_size.width / 2.0;
    let left = screen_at.x as f64;
    let right = left + screen_size.width as f64 - width;
    let x = (centre - width / 2.0).clamp(left, right.max(left));

    let screen_middle = screen_at.y as f64 + screen_size.height as f64 / 2.0;
    let y = if icon_at.y < screen_middle {
        icon_at.y + icon_size.height + gap
    } else {
        icon_at.y - height - gap
    };
    Some(PhysicalPosition::new(x, y))
}

fn hide(app: &tauri::AppHandle) {
    if let Some(panel) = app.get_webview_window(LABEL) {
        let _ = panel.hide();
    }
}

/// The panel is a transient: it goes away as soon as it is not the focus.
pub fn on_blur(window: &tauri::Window) {
    *window.state::<Panel>().blurred_at.lock().unwrap() = Some(Instant::now());
    let _ = window.hide();
}
