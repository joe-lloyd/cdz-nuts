// Self-updating, on the app's terms.
//
// Tauri's updater downloads the whole bundle rather than a delta. That sounds
// wasteful and is not: these builds are 3-8 MB, so a full replacement costs
// less than the machinery to avoid one would.
//
// When it installs is the whole design. Installing means relaunching, and
// relaunching mid-album to save someone thirty seconds is a bad trade. So the
// startup check installs -- nothing is playing yet, the window has just
// opened, and a relaunch there costs nothing. After that the app looks again
// every hour while it sits in the tray, and installs as soon as a check finds
// the player quiet; an update found mid-song waits for the next quiet check.
//
// The effect is that the app keeps itself current without being asked, which
// is what "auto-update" has to mean for something that lives in the tray for
// weeks at a time.

use std::sync::atomic::{AtomicBool, Ordering};

use tauri::{AppHandle, Manager};
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_updater::UpdaterExt;

/// Told to the user, so it says what happened rather than what failed.
fn notify(app: &AppHandle, title: &str, body: &str) {
    let _ = app.notification().builder().title(title).body(body).show();
}

/// What a check found, for a caller that shows it rather than notifies it.
#[derive(Clone, serde::Serialize)]
#[serde(tag = "state", rename_all = "kebab-case")]
pub enum Found {
    Current { version: String },
    Available { version: String },
    Failed { error: String },
}

/// Look for a newer release.
///
/// `announce_when_current` separates the callers: one that asked a question
/// deserves an answer either way, while a background check should stay quiet
/// unless it has news. `auto_install` is the startup path, where relaunching
/// is free because nothing is playing yet.
pub async fn check(app: AppHandle, announce_when_current: bool, auto_install: bool) -> Found {
    let updater = match app.updater() {
        Ok(u) => u,
        Err(e) => {
            log::warn!("updater unavailable: {e}");
            if announce_when_current {
                notify(&app, "Could not check for updates", &e.to_string());
            }
            return Found::Failed {
                error: e.to_string(),
            };
        }
    };

    match updater.check().await {
        Ok(Some(update)) => {
            let version = update.version.clone();
            log::info!("update available: {version}");
            app.state::<PendingUpdate>().set(Some(update));

            if auto_install {
                log::info!("installing {version} while nothing is playing");
                install(app, true).await;
                return Found::Available { version };
            }

            notify(
                &app,
                &format!("cdz-nutz {version} is available"),
                "It installs by itself once nothing is playing, or now from settings or the tray.",
            );
            Found::Available { version }
        }
        Ok(None) => {
            log::info!("already on the latest version");
            if announce_when_current {
                notify(&app, "cdz-nutz is up to date", env!("CARGO_PKG_VERSION"));
            }
            Found::Current {
                version: env!("CARGO_PKG_VERSION").to_string(),
            }
        }
        Err(e) => {
            // A failed check is not worth interrupting anyone over unless they
            // asked. Off the LAN and outside the tunnel this simply cannot
            // reach GitHub, which is an ordinary state, not a fault.
            log::warn!("update check failed: {e}");
            if announce_when_current {
                notify(&app, "Could not check for updates", &e.to_string());
            }
            Found::Failed {
                error: e.to_string(),
            }
        }
    }
}

/// How often a running app looks again. It lives in the tray for weeks, so
/// the startup check alone would leave it behind every release.
const RECHECK: std::time::Duration = std::time::Duration::from_secs(60 * 60);

/// Keep up to date while running. An update found while music plays waits,
/// silently, and installs at the first check that finds the player quiet, so
/// the relaunch never cuts a song off.
pub async fn watch(app: AppHandle) {
    let mut ticker = tokio::time::interval(RECHECK);
    ticker.tick().await; // the first tick is immediate, and startup has just checked
    loop {
        ticker.tick().await;
        let quiet = !app.state::<crate::panel::Panel>().is_playing();
        if app.state::<PendingUpdate>().is_pending() {
            if quiet {
                install(app.clone(), true).await;
            }
            continue;
        }
        check(app.clone(), false, quiet).await;
    }
}

/// Install whatever the last check found, then relaunch.
///
/// `wait_for_quiet` is for the automatic paths: the check and the download
/// both take time, and a song started meanwhile must not be cut off. So the
/// download comes first and the install waits until the player is quiet;
/// installing is what ends playback (Windows quits the app to run the
/// installer). Asked from the tray or settings, it goes straight through, and
/// if an automatic install is already waiting for quiet, it ends that wait.
pub async fn install(app: AppHandle, wait_for_quiet: bool) {
    let pending = app.state::<PendingUpdate>();
    if pending.waiting.load(Ordering::SeqCst) {
        if !wait_for_quiet {
            pending.hurry.store(true, Ordering::SeqCst);
        }
        return;
    }
    let Some(update) = pending.take() else {
        notify(&app, "Nothing to install", "Check for updates first.");
        return;
    };

    let version = update.version.clone();
    notify(
        &app,
        &format!("Installing {version}"),
        "The app will restart when it is done.",
    );

    let installed = match update.download(|_chunk, _total| {}, || {}).await {
        Ok(bytes) => {
            if wait_for_quiet {
                pending.waiting.store(true, Ordering::SeqCst);
                while app.state::<crate::panel::Panel>().is_playing()
                    && !pending.hurry.load(Ordering::SeqCst)
                {
                    tokio::time::sleep(std::time::Duration::from_secs(5)).await;
                }
                pending.waiting.store(false, Ordering::SeqCst);
                pending.hurry.store(false, Ordering::SeqCst);
            }
            update.install(bytes)
        }
        Err(e) => Err(e),
    };

    match installed {
        Ok(()) => {
            log::info!("installed {version}, restarting");
            app.restart();
        }
        Err(e) => {
            log::error!("update install failed: {e}");
            notify(&app, "Update failed", &e.to_string());
        }
    }
}

/// Holds the update between finding it and installing it. `waiting` is set
/// while a downloaded update waits for the player to go quiet; `hurry` is a
/// manual request to stop waiting.
#[derive(Default)]
pub struct PendingUpdate {
    slot: std::sync::Mutex<Option<tauri_plugin_updater::Update>>,
    waiting: AtomicBool,
    hurry: AtomicBool,
}

impl PendingUpdate {
    fn set(&self, update: Option<tauri_plugin_updater::Update>) {
        if let Ok(mut slot) = self.slot.lock() {
            *slot = update;
        }
    }

    fn take(&self) -> Option<tauri_plugin_updater::Update> {
        self.slot.lock().ok().and_then(|mut slot| slot.take())
    }

    /// Whether an update is found or downloaded and not yet installed, for
    /// the tray label and the settings button.
    pub fn is_pending(&self) -> bool {
        self.waiting.load(Ordering::SeqCst)
            || self.slot.lock().map(|slot| slot.is_some()).unwrap_or(false)
    }
}
