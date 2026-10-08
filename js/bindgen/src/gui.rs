//! The GUI grant of a sandbox: windows that are canvases of the page.
//!
//! The JavaScript facade says which canvases a sandbox's guests may have and
//! what they may do with them; `wasmer_gui::web` is the window system that
//! makes those canvases windows.

use std::sync::Arc;

use js_sys::Reflect;
use wasm_bindgen::prelude::*;
use wasmer_sdk::gui::{ClipboardRead, GuiCtx, GuiLimits, GuiPolicy};

use crate::{custom_error, validate_usize};

/// What the JavaScript facade passes as plain data.
#[derive(Debug, Default)]
struct GuiSettings {
    /// Names the sandbox's GUI among those of this page.
    scope: u32,
    fullscreen: Option<bool>,
    cursor_lock: Option<bool>,
    custom_cursors: Option<bool>,
    text_input: Option<bool>,
    clipboard_write: Option<bool>,
    /// `"deny"`, `"on-paste"` or `"allow"`.
    clipboard_read: Option<String>,
    raw_input: Option<bool>,
    max_windows: Option<f64>,
    max_pending_events: Option<f64>,
}

impl GuiSettings {
    /// Read field by field: these few do not need a deserializer's weight.
    fn read(settings: &JsValue) -> Result<Self, JsValue> {
        let get = |name: &str| {
            Reflect::get(settings, &JsValue::from_str(name)).unwrap_or(JsValue::UNDEFINED)
        };
        let wrong = |name: &str, what: &str| {
            custom_error("INVALID_ARGUMENT", &format!("gui: `{name}` must be {what}"))
        };
        let flag = |name: &str| -> Result<Option<bool>, JsValue> {
            let value = get(name);
            if value.is_undefined() {
                return Ok(None);
            }
            value
                .as_bool()
                .map(Some)
                .ok_or_else(|| wrong(name, "a boolean"))
        };
        let number = |name: &str| -> Result<Option<f64>, JsValue> {
            let value = get(name);
            if value.is_undefined() {
                return Ok(None);
            }
            value
                .as_f64()
                .map(Some)
                .ok_or_else(|| wrong(name, "a number"))
        };
        let clipboard_read = get("clipboardRead");
        Ok(Self {
            scope: number("scope")?.unwrap_or(0.0) as u32,
            fullscreen: flag("fullscreen")?,
            cursor_lock: flag("cursorLock")?,
            custom_cursors: flag("customCursors")?,
            text_input: flag("textInput")?,
            clipboard_write: flag("clipboardWrite")?,
            clipboard_read: if clipboard_read.is_undefined() {
                None
            } else {
                Some(
                    clipboard_read
                        .as_string()
                        .ok_or_else(|| wrong("clipboardRead", "a string"))?,
                )
            },
            raw_input: flag("rawInput")?,
            max_windows: number("maxWindows")?,
            max_pending_events: number("maxPendingEvents")?,
        })
    }
}

/// Makes the GUI context of a sandbox. `page` is what `createGuiPage` of
/// wasmer-gui's page half is given: the functions that find the canvases.
///
/// Has to be called on the thread that owns the page's canvases.
pub(crate) fn context(settings: JsValue, page: &JsValue) -> Result<GuiCtx, JsValue> {
    let settings = GuiSettings::read(&settings)?;
    let default = GuiPolicy::default();
    let policy = GuiPolicy {
        fullscreen: settings.fullscreen.unwrap_or(default.fullscreen),
        cursor_grab: settings.cursor_lock.unwrap_or(default.cursor_grab),
        custom_cursors: settings.custom_cursors.unwrap_or(default.custom_cursors),
        text_input: settings.text_input.unwrap_or(default.text_input),
        clipboard_write: settings.clipboard_write.unwrap_or(default.clipboard_write),
        clipboard_read: match settings.clipboard_read.as_deref() {
            None => default.clipboard_read,
            Some("deny") => ClipboardRead::Deny,
            Some("on-paste") => ClipboardRead::OnPaste,
            Some("allow") => ClipboardRead::Allow,
            Some(other) => {
                return Err(custom_error(
                    "INVALID_ARGUMENT",
                    &format!(
                        "gui.permissions.clipboardRead is {other:?}; expected \"deny\", \
                         \"on-paste\" or \"allow\""
                    ),
                ));
            }
        },
        raw_input: settings.raw_input.unwrap_or(default.raw_input),
        ..default
    };
    let default = GuiLimits::default();
    let limits = GuiLimits {
        max_windows: settings
            .max_windows
            .map(|value| validate_usize("gui.limits.maxWindows", value, 1))
            .transpose()?
            .or(default.max_windows),
        max_pending_events: settings
            .max_pending_events
            .map(|value| validate_usize("gui.limits.maxPendingEvents", value, 16))
            .transpose()?
            .or(default.max_pending_events),
        ..default
    };
    let windows = wasmer_sdk::gui::web::open(settings.scope, page)?;
    Ok(GuiCtx::builder()
        .window_system(Arc::new(windows))
        .policy(policy)
        .limits(limits)
        .build())
}

/// The sandbox whose GUI `scope` names is gone: its canvases go back to the
/// page. Has to be called on the thread the sandbox was created on.
#[wasm_bindgen(js_name = closeGui)]
pub fn close_gui(scope: u32) {
    wasmer_sdk::gui::web::close(scope);
}
