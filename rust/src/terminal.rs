use std::sync::{Arc, Mutex};

use wasmer_wasix::os::tty::{TtyBridge, TtyOptions as WasiTtyOptions, WasiTtyState};

/// Initial dimensions for an interactive terminal.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct TerminalOptions {
    pub columns: u32,
    pub rows: u32,
}

impl Default for TerminalOptions {
    fn default() -> Self {
        Self {
            columns: 80,
            rows: 24,
        }
    }
}

impl TerminalOptions {
    #[must_use]
    pub const fn new(columns: u32, rows: u32) -> Self {
        Self { columns, rows }
    }
}

#[derive(Debug)]
pub(crate) struct TerminalBridge {
    state: Mutex<WasiTtyState>,
    options: WasiTtyOptions,
}

impl TerminalBridge {
    pub(crate) fn new(options: TerminalOptions) -> Arc<Self> {
        let tty_options = WasiTtyOptions::default();
        tty_options.set_cols(options.columns);
        tty_options.set_rows(options.rows);
        Arc::new(Self {
            state: Mutex::new(Self::initial_state(options)),
            options: tty_options,
        })
    }

    pub(crate) fn options(&self) -> WasiTtyOptions {
        self.options.clone()
    }

    pub(crate) fn resize(&self, columns: u32, rows: u32) {
        self.options.set_cols(columns);
        self.options.set_rows(rows);
        let mut state = self.state.lock().unwrap();
        state.cols = columns;
        state.rows = rows;
    }

    fn initial_state(options: TerminalOptions) -> WasiTtyState {
        WasiTtyState {
            cols: options.columns,
            rows: options.rows,
            echo: true,
            line_buffered: true,
            line_feeds: true,
            ..WasiTtyState::default()
        }
    }
}

impl TtyBridge for TerminalBridge {
    fn reset(&self) {
        let current = self.state.lock().unwrap().clone();
        let state = Self::initial_state(TerminalOptions::new(current.cols, current.rows));
        self.options.set_echo(state.echo);
        self.options.set_line_buffering(state.line_buffered);
        self.options.set_line_feeds(state.line_feeds);
        *self.state.lock().unwrap() = state;
    }

    fn tty_get(&self) -> WasiTtyState {
        self.state.lock().unwrap().clone()
    }

    fn tty_set(&self, state: WasiTtyState) {
        self.options.set_cols(state.cols);
        self.options.set_rows(state.rows);
        self.options.set_echo(state.echo);
        self.options.set_line_buffering(state.line_buffered);
        self.options.set_line_feeds(state.line_feeds);
        *self.state.lock().unwrap() = state;
    }
}

#[cfg(test)]
mod tests {
    use wasmer_wasix::os::tty::TtyBridge;

    use super::{TerminalBridge, TerminalOptions};

    #[test]
    fn guest_terminal_updates_drive_the_line_discipline() {
        let bridge = TerminalBridge::new(TerminalOptions::new(120, 40));
        let mut state = bridge.tty_get();
        assert_eq!((state.cols, state.rows), (120, 40));
        assert!(state.stdin_tty && state.stdout_tty && state.stderr_tty);
        assert!(bridge.options().echo());
        assert!(bridge.options().line_buffering());

        state.echo = false;
        state.line_buffered = false;
        bridge.tty_set(state);
        assert!(!bridge.options().echo());
        assert!(!bridge.options().line_buffering());

        bridge.resize(90, 30);
        let resized = bridge.tty_get();
        assert_eq!((resized.cols, resized.rows), (90, 30));
    }
}
