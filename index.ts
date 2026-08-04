import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, rmSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type SelectItem, SelectList, type TUI } from "@earendil-works/pi-tui";
import {
	effectiveRunState,
	inboxDir,
	listRuns,
	readMetadata,
	type InboxMessage,
	type RunMetadata,
	updateMetadata,
} from "./shared.ts";

const packageDir = dirname(fileURLToPath(import.meta.url));

function isInboxMessage(value: unknown): value is InboxMessage {
	if (typeof value !== "object" || value === null) return false;
	const message = value as Record<string, unknown>;
	return typeof message.message === "string" && (message.delivery === "auto" || message.delivery === "followUp");
}

function displayState(metadata: RunMetadata): string {
	return effectiveRunState(metadata).padEnd(8);
}

export default function subagentExtension(pi: ExtensionAPI) {
	const runDir = process.env.PI_SUBAGENT_RUN_DIR;
	if (!runDir) {
		pi.on("resources_discover", () => ({ skillPaths: [join(packageDir, "skills")] }));
	}

	pi.registerCommand("subagent", {
		description: "Select and attach to a subagent spawned by this session",
		handler: async (_args, ctx) => {
			const runs = listRuns(ctx.sessionManager.getSessionId()).filter((run) => effectiveRunState(run) !== "exited");
			if (runs.length === 0) {
				ctx.ui.notify("No active subagents spawned by this session", "info");
				return;
			}

			const items: SelectItem[] = runs.map((run) => ({
				value: run.handle,
				label: `${run.handle}  ${displayState(run)}  ${run.provider}/${run.model}  ${run.thinking}`,
			}));
			let tui: TUI | undefined;
			const selected = await ctx.ui.custom<string | undefined>((customTui, theme, _keybindings, done) => {
				tui = customTui;
				const list = new SelectList(items, Math.min(items.length, 10), {
					selectedPrefix: (text) => theme.fg("accent", text),
					selectedText: (text) => theme.fg("accent", text),
					description: (text) => theme.fg("muted", text),
					scrollInfo: (text) => theme.fg("dim", text),
					noMatch: (text) => theme.fg("warning", text),
				});
				list.onSelect = (item) => done(item.value);
				list.onCancel = () => done(undefined);
				return {
					render: (width) => list.render(width),
					invalidate: () => list.invalidate(),
					handleInput: (data) => {
						list.handleInput(data);
						customTui.requestRender();
					},
				};
			});
			if (!selected || !tui) return;
			const run = runs.find((candidate) => candidate.handle === selected);
			if (!run) return;

			if (process.env.TMUX) {
				const exitCode = await new Promise<number | null>((resolveExit) => {
					const child = spawn("tmux", ["switch-client", "-t", run.tmuxSession], { stdio: "inherit" });
					child.on("error", () => resolveExit(null));
					child.on("close", resolveExit);
				});
				if (exitCode !== 0) ctx.ui.notify(`Could not switch to ${run.handle}`, "error");
				return;
			}

			tui.stop();
			try {
				const exitCode = await new Promise<number | null>((resolveExit) => {
					const child = spawn("tmux", ["attach-session", "-t", run.tmuxSession], { stdio: "inherit" });
					child.on("error", () => resolveExit(null));
					child.on("close", resolveExit);
				});
				if (exitCode !== 0) process.stderr.write(`Could not attach to ${run.handle}\n`);
			} finally {
				tui.start();
				tui.requestRender(true);
			}
		},
	});

	if (!runDir) {
		let widgetTimer: ReturnType<typeof setInterval> | undefined;
		let widgetContext: ExtensionContext | undefined;

		const refreshWidget = (): void => {
			if (!widgetContext) return;
			const activeRuns = listRuns(widgetContext.sessionManager.getSessionId())
				.map((run) => ({ run, state: effectiveRunState(run) }))
				.filter(({ state }) => state !== "exited");
			if (activeRuns.length === 0) {
				widgetContext.ui.setWidget("subagents", undefined);
				return;
			}

			const visible = activeRuns.slice(0, 5).map(({ run, state }) => {
				const color =
					state === "busy" ? "warning" : state === "idle" ? "success" : state === "error" ? "error" : "muted";
				return widgetContext!.ui.theme.fg(color, `${run.handle}:${state}`);
			});
			if (activeRuns.length > visible.length) {
				visible.push(widgetContext.ui.theme.fg("muted", `+${activeRuns.length - visible.length}`));
			}
			widgetContext.ui.setWidget(
				"subagents",
				[widgetContext.ui.theme.fg("dim", "subagents: ") + visible.join(widgetContext.ui.theme.fg("dim", " | "))],
				{ placement: "belowEditor" },
			);
		};

		pi.on("session_start", (_event, ctx) => {
			if (!ctx.hasUI) return;
			widgetContext = ctx;
			refreshWidget();
			widgetTimer = setInterval(refreshWidget, 1000);
			widgetTimer.unref();
		});

		pi.on("session_shutdown", (event, ctx) => {
			if (widgetTimer) clearInterval(widgetTimer);
			widgetTimer = undefined;
			widgetContext = undefined;
			ctx.ui.setWidget("subagents", undefined);
			if (event.reason === "reload") return;
			for (const run of listRuns(ctx.sessionManager.getSessionId())) {
				spawnSync("tmux", ["kill-session", "-t", run.tmuxSession], { stdio: "ignore" });
				rmSync(run.runDir, { recursive: true, force: true });
			}
		});
		return;
	}

	let currentContext: ExtensionContext | undefined;
	let timer: ReturnType<typeof setInterval> | undefined;
	let processing = false;

	const processInbox = async (): Promise<void> => {
		if (processing || !currentContext) return;
		const queueDir = inboxDir(runDir);
		if (!existsSync(queueDir)) return;
		processing = true;
		try {
			for (const name of readdirSync(queueDir)
				.filter((entry) => entry.endsWith(".json"))
				.sort()) {
				const path = join(queueDir, name);
				let payload: InboxMessage;
				try {
					const value: unknown = JSON.parse(readFileSync(path, "utf8"));
					if (!isInboxMessage(value)) throw new Error("Invalid inbox message");
					payload = value;
				} catch (error) {
					unlinkSync(path);
					updateMetadata(runDir, {
						state: "error",
						error: error instanceof Error ? error.message : String(error),
					});
					continue;
				}

				updateMetadata(runDir, { state: "busy", error: undefined });
				try {
					if (currentContext.isIdle()) {
						pi.sendUserMessage(payload.message);
					} else {
						pi.sendUserMessage(payload.message, {
							deliverAs: payload.delivery === "followUp" ? "followUp" : "steer",
						});
					}
					unlinkSync(path);
				} catch (error) {
					updateMetadata(runDir, {
						state: currentContext.isIdle() ? "idle" : "busy",
						error: error instanceof Error ? error.message : String(error),
					});
					return;
				}
			}
		} finally {
			processing = false;
		}
	};

	pi.on("session_start", (_event, ctx) => {
		currentContext = ctx;
		const metadata = readMetadata(runDir);
		if (!metadata) return;
		updateMetadata(runDir, {
			childSessionId: ctx.sessionManager.getSessionId(),
			sessionFile: ctx.sessionManager.getSessionFile() ?? metadata.sessionFile,
			state: ctx.isIdle() ? "idle" : "busy",
			error: undefined,
		});
		pi.setSessionName(`subagent ${metadata.handle}`);
		if (!timer) {
			timer = setInterval(() => void processInbox(), 250);
			timer.unref();
		}
		void processInbox();
	});

	pi.on("agent_start", (_event, ctx) => {
		currentContext = ctx;
		updateMetadata(runDir, { state: "busy", hasStarted: true, error: undefined });
	});

	pi.on("agent_settled", (_event, ctx) => {
		currentContext = ctx;
		if (ctx.isIdle()) updateMetadata(runDir, { state: "idle" });
	});

	pi.on("session_shutdown", (event) => {
		currentContext = undefined;
		if (timer) {
			clearInterval(timer);
			timer = undefined;
		}
		if (event.reason === "quit") updateMetadata(runDir, { state: "exited" });
	});
}
