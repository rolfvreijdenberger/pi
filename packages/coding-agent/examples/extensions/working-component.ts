/**
 * Working Component Extension
 *
 * Demonstrates `ctx.ui.setWorkingComponent()` for replacing the entire
 * working loader shown during streaming with a custom component.
 *
 * Usage:
 *   pi --extension examples/extensions/working-component.ts
 *
 * The factory receives `tui` and `theme`, giving full control over:
 *   - Spinner character sequence and animation interval
 *   - Spinner color function
 *   - Message color function
 *   - Message text
 *
 * Register the factory at session scope so interactive mode can create the
 * custom loader at the normal agent_start point. Call with undefined to restore
 * the built-in loader.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Loader } from "@earendil-works/pi-tui";

export default function (pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		ctx.ui.setWorkingComponent(
			(tui, theme) =>
				new Loader(
					tui,
					(spinner) => theme.fg("warning", spinner),
					(text) => theme.fg("accent", text),
					"Working...",
					{ frames: ["●"], intervalMs: 0 },
				),
		);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		ctx.ui.setWorkingComponent(undefined);
	});
}
