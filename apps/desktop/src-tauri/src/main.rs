// Homelab Music -- a tray-resident player for the home music library.
//
// The window is a thin thing. Everything interesting is that the WebView never
// touches the network: it talks to the `homelab://` scheme, which this process
// answers either from embedded UI bytes or by proxying to music.home.arpa over
// whichever path is live. See proxy.rs for why it has to work that way.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod audio_output;
mod netpath;
mod panel;
mod proxy;
mod routes;
mod uicheck;
mod update;

use std::sync::Arc;

use tauri::menu::{MenuBuilder, MenuItemBuilder};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::utils::config::BackgroundThrottlingPolicy;
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};
use tokio::sync::RwLock;

use netpath::Path;
use proxy::Proxy;
use routes::Ui;

/// Everything the protocol handler needs, shared with the tray and the
/// network-path watcher.
struct AppState {
    ui: Ui,
    proxy: RwLock<Option<Arc<Proxy>>>,
    path: RwLock<Option<Path>>,
    /// Set once, during setup. The protocol handler is built before the app
    /// exists, so the shell's own endpoints have to reach the handle this way
    /// rather than closing over it.
    app: RwLock<Option<tauri::AppHandle>>,
}

impl AppState {
    /// Rebuild the HTTP client for the current network path.
    ///
    /// Called at startup and whenever the path changes. Kept separate from
    /// detection so that a failure to build a client (no tunnel yet, say)
    /// leaves the previous working client in place rather than wedging the app.
    async fn refresh_path(&self, tunnel: Option<std::net::SocketAddr>) -> anyhow::Result<Path> {
        let path = netpath::detect().await;
        let proxy = Proxy::new(path, tunnel)?;
        *self.proxy.write().await = Some(Arc::new(proxy));
        *self.path.write().await = Some(path);
        log::info!("network path: {}", path.label());
        Ok(path)
    }
}

fn main() {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();

    let ui = match Ui::load() {
        Ok(ui) => ui,
        // A bad routes.json is a packaging error, and there is no sensible
        // degraded mode: with no UI there is nothing to show.
        Err(e) => {
            eprintln!("the embedded UI is not usable: {e:#}");
            std::process::exit(1);
        }
    };

    let state = Arc::new(AppState {
        ui,
        proxy: RwLock::new(None),
        path: RwLock::new(None),
        app: RwLock::new(None),
    });

    let protocol_state = state.clone();
    let setup_state = state.clone();

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            // Second launch: surface the window we already have rather than
            // opening another. A tray app that can be started twice is a tray
            // app with two queues and two audio elements.
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.show();
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(update::PendingUpdate::default())
        .manage(panel::Panel::default())
        .register_asynchronous_uri_scheme_protocol("homelab", move |_ctx, request, responder| {
            let state = protocol_state.clone();
            tauri::async_runtime::spawn(async move {
                responder.respond(handle(state, request).await);
            });
        })
        .setup(move |app| {
            let state = setup_state.clone();
            tauri::async_runtime::block_on(async {
                *state.app.write().await = Some(app.handle().clone());
            });

            // Decide the path before the window loads, so the first request
            // does not race the client being built.
            if let Err(error) = tauri::async_runtime::block_on(state.refresh_path(None)) {
                log::warn!("could not build the initial network client: {error:#}");
            }

            WebviewWindowBuilder::new(
                app,
                "main",
                WebviewUrl::CustomProtocol("homelab://localhost/".parse()?),
            )
            .initialization_script(audio_output::initialization_script())
            .initialization_script(panel::HOST_SCRIPT)
            .title("Homelab Music")
            .inner_size(1180.0, 820.0)
            .min_inner_size(420.0, 520.0)
            // WKWebView otherwise suspends the document after a hidden window
            // has been in the background for several minutes. The document
            // owns the audio elements, so suspending it also pauses playback.
            .background_throttling(BackgroundThrottlingPolicy::Disabled)
            .build()?;

            audio_output::start(app.handle().clone());
            panel::build(app)?;
            build_tray(app)?;

            // After the path is settled, not before: a check that races the
            // LAN-vs-tunnel decision fails for the wrong reason and would
            // report "could not check" on a perfectly healthy network.
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                // auto_install: the window has just opened and nothing is
                // playing, so a relaunch here costs the listener nothing.
                update::check(handle, false, true).await;
            });

            // Same reasoning, same moment: ask home whether the UI we embedded
            // is still the one it serves. Only a genuine mismatch is worth
            // interrupting anyone over -- being offline is not news, and the
            // fix for a real mismatch is a rebuild, which cannot happen here.
            let drift_handle = app.handle().clone();
            let drift_state = setup_state.clone();
            tauri::async_runtime::spawn(async move {
                let proxy = { drift_state.proxy.read().await.clone() };
                let Some(proxy) = proxy else { return };
                let drift = uicheck::check(proxy, &drift_state.ui.digest()).await;
                uicheck::report(&drift);
                if let uicheck::Drift::Stale { .. } = drift {
                    use tauri_plugin_notification::NotificationExt;
                    let _ = drift_handle
                        .notification()
                        .builder()
                        .title("Music UI is out of date")
                        .body("This build embeds an older front end than home is serving. Rebuild to pick it up.")
                        .show();
                }
            });

            Ok(())
        })
        .on_window_event(|window, event| match event {
            // Close means "get out of my way", not "quit" -- that is the whole
            // point of living in the tray. Quit is on the tray menu.
            tauri::WindowEvent::CloseRequested { api, .. } => {
                api.prevent_close();
                let _ = window.hide();
            }
            tauri::WindowEvent::Focused(false) if window.label() == panel::LABEL => {
                panel::on_blur(window);
            }
            _ => {}
        })
        .run(tauri::generate_context!())
        .expect("error while running homelab-music");
}

/// Answer one `homelab://` request: embedded UI, or proxied to home.
async fn handle(state: Arc<AppState>, request: http::Request<Vec<u8>>) -> http::Response<Vec<u8>> {
    let path = request.uri().path().to_string();
    let query = request
        .uri()
        .query()
        .map(|q| format!("?{q}"))
        .unwrap_or_default();

    // The UI itself never leaves the binary.
    if let Some(asset) = state.ui.resolve(&path) {
        return http::Response::builder()
            .status(200)
            .header("content-type", asset.content_type.clone())
            .header("cache-control", asset.cache_control.clone())
            .body(asset.body.to_vec())
            .expect("static response is well-formed");
    }

    // Client-side routes are real paths now, so /album/<id> is not an asset and
    // is not the server's either -- it is the app's. Serve the document from
    // embedded bytes and let the router take it.
    //
    // Doing this here rather than letting it fall through to the proxy matters:
    // the server would answer with the same document, but only after a round
    // trip over the tunnel, so every in-app navigation to an unvisited route
    // would wait on the network for a page we are already holding.
    if is_client_route(&path) {
        if let Some(document) = state.ui.resolve("/") {
            return http::Response::builder()
                .status(200)
                .header("content-type", document.content_type.clone())
                .header("cache-control", document.cache_control.clone())
                .body(document.body.to_vec())
                .expect("document response is well-formed");
        }
    }

    // The shell's own endpoints, answered here and never proxied. They live
    // under /api/ on purpose: music.home.arpa 404s an /api path it does not
    // know, so the same UI bundle can ask "am I in the desktop app?" and get a
    // straight answer instead of an HTML page from the SPA fallback.
    if path.starts_with("/api/desktop/") {
        return desktop_endpoint(&state, &path, request.method(), request.body()).await;
    }

    // Everything else is the server's: /api/*, /img/*, and anything added later.
    let proxy = { state.proxy.read().await.clone() };
    let Some(proxy) = proxy else {
        return text(
            503,
            "No route to home yet -- still working out how to reach it.",
        );
    };

    let headers = proxy::sanitise(request.headers());
    let method = request.method().as_str().to_owned();
    match proxy
        .forward(
            &method,
            &format!("{path}{query}"),
            &headers,
            request.into_body(),
        )
        .await
    {
        Ok(response) => response,
        Err(e) => {
            log::warn!("proxy {path} failed: {e:#}");
            text(502, &format!("Could not reach home: {e}"))
        }
    }
}

/// The desktop shell's own small API: status, reconnection, updates, and the
/// tray panel. The web build has to cope without these native-only endpoints.
async fn desktop_endpoint(
    state: &Arc<AppState>,
    path: &str,
    method: &http::Method,
    body: &[u8],
) -> http::Response<Vec<u8>> {
    let handle = state.app.read().await.clone();
    let Some(handle) = handle else {
        return json(
            503,
            &serde_json::json!({ "error": "the app is still starting" }),
        );
    };

    match path {
        "/api/desktop/audio-output" => json(200, &audio_output::current()),
        "/api/desktop/panel" => http::Response::builder()
            .status(200)
            .header("content-type", "text/html; charset=utf-8")
            .header("cache-control", "no-store")
            .body(panel::PAGE.as_bytes().to_vec())
            .expect("panel response is well-formed"),
        // GET from the panel when it loads; POST from the player when it changes.
        "/api/desktop/now-playing" if method == http::Method::GET => {
            let latest = handle.state::<panel::Panel>().latest();
            let latest = latest.as_deref().unwrap_or("null").as_bytes().to_vec();
            http::Response::builder()
                .status(200)
                .header("content-type", "application/json")
                .header("cache-control", "no-store")
                .body(latest)
                .expect("json response is well-formed")
        }
        "/api/desktop/now-playing" => {
            panel::publish(&handle, body);
            json(204, &serde_json::Value::Null)
        }
        "/api/desktop/command" if panel::command(&handle, body) => {
            json(202, &serde_json::Value::Null)
        }
        "/api/desktop/command" => json(400, &serde_json::json!({ "error": "unknown command" })),
        "/api/desktop/status" => json(
            200,
            &serde_json::json!({
                "version": env!("CARGO_PKG_VERSION"),
                "update_pending": handle.state::<update::PendingUpdate>().is_pending(),
            }),
        ),
        "/api/desktop/reconnect" => match state.refresh_path(None).await {
            Ok(path) => json(
                200,
                &serde_json::json!({ "state": "connected", "path": path.label() }),
            ),
            Err(error) => {
                log::warn!("could not reconnect to home: {error:#}");
                json(
                    503,
                    &serde_json::json!({ "error": format!("could not reconnect: {error}") }),
                )
            }
        },
        "/api/desktop/update/check" => {
            let found = update::check(handle, false, false).await;
            json(200, &found)
        }
        "/api/desktop/update/install" => {
            // Spawned rather than awaited: a successful install restarts the
            // process, and the caller should get its answer before that
            // happens rather than seeing the connection die.
            tauri::async_runtime::spawn(async move { update::install(handle).await });
            json(202, &serde_json::json!({ "state": "installing" }))
        }
        _ => json(
            404,
            &serde_json::json!({ "error": "no such desktop endpoint" }),
        ),
    }
}

fn json<T: serde::Serialize>(status: u16, body: &T) -> http::Response<Vec<u8>> {
    let bytes = serde_json::to_vec(body).unwrap_or_else(|_| b"{}".to_vec());
    http::Response::builder()
        .status(status)
        .header("content-type", "application/json")
        .header("cache-control", "no-store")
        .body(bytes)
        .expect("json response is well-formed")
}

/// Is this a path the app's own router should answer?
///
/// Scoped by exclusion, matching what apps/server does, because the
/// route table lives in TypeScript in the UI package and neither consumer can
/// import it. Anything under /api or /img belongs to the server -- a mistyped
/// endpoint must keep its honest 404 rather than being answered with a page --
/// and anything else is the app's.
fn is_client_route(path: &str) -> bool {
    !path.starts_with("/api/") && !path.starts_with("/img/")
}

fn text(status: u16, message: &str) -> http::Response<Vec<u8>> {
    http::Response::builder()
        .status(status)
        .header("content-type", "text/plain; charset=utf-8")
        .body(message.as_bytes().to_vec())
        .expect("error response is well-formed")
}

fn build_tray(app: &tauri::App) -> tauri::Result<()> {
    let show = MenuItemBuilder::with_id("show", "Show player").build(app)?;
    let update_item = MenuItemBuilder::with_id("update", "Check for updates…").build(app)?;
    let quit = MenuItemBuilder::with_id("quit", "Quit").build(app)?;
    let menu = MenuBuilder::new(app)
        .items(&[&show])
        .separator()
        .items(&[&update_item])
        .separator()
        .items(&[&quit])
        .build()?;

    TrayIconBuilder::with_id("main")
        .icon(app.default_window_icon().expect("bundled icon").clone())
        .tooltip("Homelab Music")
        .menu(&menu)
        // Left click opens the now-playing panel; the menu is on right click.
        .show_menu_on_left_click(false)
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                rect,
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                panel::toggle(tray.app_handle(), rect);
            }
        })
        .on_menu_event(|app, event| match event.id().as_ref() {
            "show" => {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.show();
                    let _ = w.set_focus();
                }
            }
            // One item does both jobs: it checks when there is nothing
            // waiting, and installs when a check has already found something.
            // Two menu entries where one will do is just more to read.
            "update" => {
                let handle = app.clone();
                tauri::async_runtime::spawn(async move {
                    if handle.state::<update::PendingUpdate>().is_pending() {
                        update::install(handle).await;
                    } else {
                        update::check(handle, true, false).await;
                    }
                });
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .build(app)?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::is_client_route;

    #[test]
    fn app_routes_are_the_apps() {
        for path in [
            "/",
            "/artists",
            "/album/4aawyAB9vmqN3uQ7FjRGTy",
            "/radio/artist/Converge",
        ] {
            assert!(is_client_route(path), "{path} should route in the app");
        }
    }

    #[test]
    fn server_paths_keep_their_honest_404() {
        // If these were treated as client routes, a mistyped endpoint would
        // answer 200 with a page and the caller would parse HTML as JSON.
        for path in [
            "/api/overview",
            "/api/nonsense",
            "/img/folder",
            "/img/albums/x.jpg",
        ] {
            assert!(!is_client_route(path), "{path} belongs to the server");
        }
    }
}
