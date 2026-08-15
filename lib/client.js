/**
 * dsh-hindsight-plugins - browser half.
 *
 * Contributes the 「外部记忆」tab to the Plugins settings section through the
 * `settings.plugins.tab` root list slot. The tab shows the CURRENT state
 * (effective addresses, route, adapter status) and a 「管理」button that opens
 * a modal dialog for editing everything (内网地址 / 外网地址 / 当前路由 /
 * 写入范围) with per-address connectivity tests and save.
 *
 * When the OFFICIAL adapter (@vectorize-io/hindsight-coding-agents) is not
 * installed or not mounted, the tab shows a warning banner with a
 * 「一键安装官方适配器」 button - one click runs the official installer
 * through the host half (auto-checked on plugin startup as well) - plus the
 * manual install command and a「?」help popover with the documentation link.
 *
 * Host half's HTTP surface:
 *   GET  /plugins/dsh-hindsight-plugins/config
 *   POST /plugins/dsh-hindsight-plugins/config
 *   POST /plugins/dsh-hindsight-plugins/test
 *   POST /plugins/dsh-hindsight-plugins/install
 *
 * Hand-written in the web2 lazy-CJS bundle format
 * (`window.__ModuleLoader__.load({ id, factory })`, peer modules resolved via
 * the provided `require`) so this package ships without a build step.
 */
window.__ModuleLoader__.load({
	id: "dsh-hindsight-plugins",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		const react = require("react");
		const { useEffect, useState } = react;
		const h = react.createElement;

		/** Client services required by the settings tab registration. */
		const inject = ["slots"];

		const BASE = "/plugins/dsh-hindsight-plugins";
		const DOCS_URL = "https://hindsight.vectorize.io/sdks/integrations/coding-agents";
		const INSTALL_CMD = "npx @vectorize-io/hindsight-coding-agents install dsh";

		async function api(path, init) {
			const res = await fetch(BASE + path, Object.assign({
				headers: { "content-type": "application/json" },
			}, init));
			const data = await res.json().catch(() => ({}));
			if (!res.ok) throw new Error(data.error || "HTTP " + res.status);
			return data;
		}

		const CSS = [
			".dhs-root{box-sizing:border-box;display:flex;flex-direction:column;gap:14px;max-width:640px;font:inherit;color:var(--dsw-alias-label-primary)}",
			".dhs-head{display:flex;align-items:center;gap:8px}",
			".dhs-title{font-size:14px;font-weight:600}",
			".dhs-chip{border:1px solid var(--dsw-alias-line-strong);border-radius:999px;padding:1px 8px;font-size:11px;color:var(--dsw-alias-label-tertiary)}",
			".dhs-kv{border:1px solid var(--dsw-alias-line-normal);background:var(--dsw-alias-bg-module);border-radius:10px;padding:10px 12px;display:flex;flex-direction:column;gap:4px;font-size:12.5px}",
			".dhs-kv-first{font-weight:600}",
			".dhs-fixed{font-size:12.5px;color:var(--dsw-alias-label-secondary)}",
			".dhs-switch{width:34px;height:19px;border-radius:999px;border:1px solid var(--dsw-alias-line-strong);background:var(--dsw-alias-bg-module);position:relative;cursor:pointer;padding:0;flex:none;transition:background .15s,border-color .15s}",
			".dhs-switch .dhs-knob{position:absolute;top:1px;left:1px;width:15px;height:15px;border-radius:50%;background:var(--dsw-alias-label-tertiary);transition:left .15s,background .15s;display:block}",
			".dhs-switch-on{background:rgba(63,185,80,.3);border-color:rgba(63,185,80,.5)}",
			".dhs-switch-on .dhs-knob{left:16px;background:#3fb950}",
			".dhs-switch:disabled{opacity:.6;cursor:default}",
			".dhs-k{color:var(--dsw-alias-label-tertiary);margin-right:6px}",
			".dhs-v{color:var(--dsw-alias-label-primary);font-family:ui-monospace,Consolas,monospace;word-break:break-all}",
			".dhs-row{display:flex;flex-direction:column;gap:6px}",
			".dhs-label{font-size:12.5px;font-weight:600;color:var(--dsw-alias-label-secondary)}",
			".dhs-inline{display:flex;align-items:center;gap:8px}",
			".dhs-input{box-sizing:border-box;flex:1;min-width:0;background:var(--dsw-alias-bg-module);border:1px solid var(--dsw-alias-line-normal);border-radius:8px;padding:6px 10px;font:inherit;font-size:12.5px;color:var(--dsw-alias-label-primary)}",
			".dhs-input:focus{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:-1px}",
			".dhs-btn{border:1px solid var(--dsw-alias-line-strong);background:var(--dsw-alias-bg-module);color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;font-weight:600;border-radius:8px;padding:5px 12px;cursor:pointer}",
			".dhs-btn:hover{border-color:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-state-business-primary)}",
			".dhs-btn:disabled{opacity:.6;cursor:default}",
			".dhs-primary{background:var(--dsw-alias-state-business-primary);border-color:var(--dsw-alias-state-business-primary);color:#fff}",
			".dhs-primary:hover{color:#fff;border-color:var(--dsw-alias-state-business-primary);filter:brightness(1.12)}",
			".dhs-radios{display:flex;gap:16px;flex-wrap:wrap}",
			".dhs-radio{display:inline-flex;align-items:center;gap:6px;font-size:12.5px;color:var(--dsw-alias-label-secondary);cursor:pointer}",
			".dhs-test{font-size:11.5px;white-space:nowrap}",
			".dhs-ok{color:#3fb950}",
			".dhs-err{color:#f85149}",
			".dhs-muted{color:var(--dsw-alias-label-tertiary);font-size:11.5px;line-height:1.6}",
			".dhs-actions{display:flex;align-items:center;gap:10px;flex-wrap:wrap}",
			".dhs-banner{border:1px solid rgba(248,81,73,.35);background:rgba(248,81,73,.07);border-radius:10px;padding:10px 12px;display:flex;flex-direction:column;gap:6px;font-size:12.5px}",
			".dhs-code{font-family:ui-monospace,Consolas,monospace;background:var(--dsw-alias-bg-module);border:1px solid var(--dsw-alias-line-normal);border-radius:6px;padding:3px 8px;font-size:11.5px;word-break:break-all;user-select:all}",
			".dhs-link{color:var(--dsw-alias-state-business-primary);text-decoration:none;font-size:12px}",
			".dhs-link:hover{text-decoration:underline}",
			".dhs-log{border:1px solid var(--dsw-alias-line-normal);background:var(--dsw-alias-bg-module);border-radius:8px;padding:6px 10px;font-family:ui-monospace,Consolas,monospace;font-size:11px;color:var(--dsw-alias-label-secondary);max-height:110px;overflow:auto;white-space:pre-wrap}",
			".dhs-help{position:relative;display:inline-flex;margin-left:auto}",
			".dhs-helpdot{width:18px;height:18px;border-radius:50%;border:1px solid var(--dsw-alias-line-strong);background:var(--dsw-alias-bg-module);color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px;cursor:pointer;padding:0;text-align:center}",
			".dhs-pop{position:absolute;top:24px;right:0;z-index:30;width:340px;border:1px solid var(--dsw-alias-line-strong);background:var(--dsw-alias-bg-module-platform);border-radius:10px;padding:10px 12px;box-shadow:0 8px 24px rgba(0,0,0,.35);display:flex;flex-direction:column;gap:6px;font-size:12px;text-align:left}",
			".dhs-overlay{position:fixed;inset:0;z-index:60;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;padding:24px}",
			".dhs-modal{width:100%;max-width:560px;max-height:85vh;overflow:auto;border:1px solid var(--dsw-alias-line-strong);background:var(--dsw-alias-bg-module-platform);border-radius:12px;padding:16px 18px;display:flex;flex-direction:column;gap:14px;box-shadow:0 12px 40px rgba(0,0,0,.45);font:inherit;color:var(--dsw-alias-label-primary)}",
			".dhs-modal-head{display:flex;align-items:center;gap:8px}",
			".dhs-modal-title{font-size:14px;font-weight:600;flex:1}",
			".dhs-x{border:none;background:none;color:var(--dsw-alias-label-tertiary);font-size:18px;cursor:pointer;line-height:1;padding:2px 4px}",
			".dhs-modal-actions{display:flex;justify-content:flex-end;gap:8px}",
		].join("");

		(function installCss() {
			if (typeof document === "undefined") return;
			const tagId = "dsh-hindsight-plugins/style";
			if (document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
				const tag = document.createElement("style");
				tag.dataset.plugin = "dsh-hindsight-plugins";
				tag.dataset.pluginCss = tagId;
				tag.textContent = CSS;
				document.head.appendChild(tag);
			}
		})();

		function formFromData(data) {
			const sidecar = (data && data.sidecar) || {};
			return {
				intranetUrl: sidecar.intranetUrl || "",
				extranetUrl: sidecar.extranetUrl || "",
				route: sidecar.route === "extranet" ? "extranet" : "intranet",
				// Write scope is fixed to DSH-only (harnesses.dsh.apiUrl);
				// the global option was removed from the UI by request.
				scope: "dsh",
			};
		}

		function adapterOk(data) {
			const adapter = data && data.adapter;
			// Legacy host half (no adapter field): unknown, not broken - never
			// false-warn; the banner only appears on an explicit negative.
			if (adapter === undefined) return true;
			return !!(adapter && adapter.runtimePresent && adapter.mounted);
		}

		function docsLink(text) {
			return h("a", { className: "dhs-link", href: DOCS_URL, target: "_blank", rel: "noreferrer" }, text);
		}

		function testLine(test) {
			if (!test) return null;
			if (test.busy) return h("span", { className: "dhs-test dhs-muted" }, "测试中…");
			if (test.ok) {
				return h("span", { className: "dhs-test dhs-ok" }, "✓ HTTP " + test.status + " · " + test.ms + "ms");
			}
			return h("span", { className: "dhs-test dhs-err" }, "✗ " + (test.error || "不可达"));
		}

		/**「?」help popover: install command + docs link + effect notes. */
		function HelpDot() {
			const [open, setOpen] = useState(false);
			return h("div", { className: "dhs-help" },
				h("button", {
					className: "dhs-helpdot",
					"aria-label": "安装与使用帮助",
					title: "安装与使用帮助",
					onClick: () => setOpen(!open),
				}, "?"),
				open ? h("div", { className: "dhs-pop" },
					h("div", { className: "dhs-muted" }, "官方 DSH 适配器安装（本插件可自动完成）："),
					h("div", { className: "dhs-code" }, INSTALL_CMD),
					h("div", null, docsLink("官方文档：Hindsight Coding Agents ->")),
					h("div", { className: "dhs-muted" },
						"安装或切换配置后，对新会话生效；本插件只负责配置与安装，官方运行时负责记忆。")) : null);
		}

		/**
		 * Warning banner with one-click install. Shown when the official
		 * adapter is explicitly reported missing.
		 */
		function AdapterWarning({ install, busy, onInstall }) {
			const phase = install && install.phase;
			return h("div", { className: "dhs-banner" },
				h("div", { className: "dhs-err" }, "⚠ 外部记忆库当前不可用：官方 DSH 适配器未安装或未挂载。"),
				phase === 'running'
					? h("div", { className: "dhs-ok" }, "正在自动安装官方适配器…")
					: h("div", { className: "dhs-actions" },
						h("button", {
							className: "dhs-btn dhs-primary",
							onClick: onInstall,
							disabled: busy,
						}, busy ? "安装中…" : "一键安装官方适配器"),
						phase === 'needs-url'
							? h("span", { className: "dhs-err" }, (install && install.note) || "需先配置服务器地址")
							: null),
				install && install.note && phase !== 'running'
					? h("div", { className: "dhs-muted" }, install.note)
					: null,
				install && install.log && install.log.length
					? h("div", { className: "dhs-log" }, install.log.slice(-6).join("\n"))
					: null,
				h("div", { className: "dhs-muted" }, "或手动在终端执行："),
				h("div", { className: "dhs-code" }, INSTALL_CMD),
				h("div", null, docsLink("查看官方安装文档 ->")));
		}

		/** Editable form rows shared by the manage dialog. */
		function FormRows({ form, setField, tests, runTest }) {
			return h(react.Fragment, null,
				h("div", { className: "dhs-row" },
					h("label", { className: "dhs-label" }, "内网地址"),
					h("div", { className: "dhs-inline" },
						h("input", {
							className: "dhs-input",
							value: form.intranetUrl,
							placeholder: "http://192.168.1.100:18888",
							spellCheck: false,
							onChange: (e) => setField("intranetUrl", e.target.value),
						}),
						h("button", {
							className: "dhs-btn",
							onClick: () => runTest("intranet", "intranetUrl"),
						}, "测试"),
						testLine(tests.intranet))),
				h("div", { className: "dhs-row" },
					h("label", { className: "dhs-label" }, "外网地址"),
					h("div", { className: "dhs-inline" },
						h("input", {
							className: "dhs-input",
							value: form.extranetUrl,
							placeholder: "https://hindsight.example.com",
							spellCheck: false,
							onChange: (e) => setField("extranetUrl", e.target.value),
						}),
						h("button", {
							className: "dhs-btn",
							onClick: () => runTest("extranet", "extranetUrl"),
						}, "测试"),
						testLine(tests.extranet))),
				h("div", { className: "dhs-row" },
					h("label", { className: "dhs-label" }, "当前路由"),
					h("div", { className: "dhs-radios" },
						h("label", { className: "dhs-radio" },
							h("input", {
								type: "radio",
								checked: form.route === "intranet",
								onChange: () => setField("route", "intranet"),
							}), " 使用内网"),
						h("label", { className: "dhs-radio" },
							h("input", {
								type: "radio",
								checked: form.route === "extranet",
								onChange: () => setField("route", "extranet"),
							}), " 使用外网"))),
				h("div", { className: "dhs-row" },
					h("label", { className: "dhs-label" }, "写入范围"),
					h("div", {
						className: "dhs-fixed",
						title: "写入 harnesses.dsh.apiUrl 分节",
					}, "仅 DSH 生效")));
		}

		/**「管理」modal: edit everything, test addresses, save. */
		function ManageDialog({ api, initial, onClose, onSaved }) {
			const [form, setForm] = useState(initial);
			const [tests, setTests] = useState({});
			const [saving, setSaving] = useState(false);
			const [error, setError] = useState(null);

			useEffect(() => {
				const onKey = (e) => { if (e.key === "Escape") onClose(); };
				window.addEventListener("keydown", onKey);
				return () => window.removeEventListener("keydown", onKey);
			}, [onClose]);

			const setField = (key, value) => setForm((prev) => Object.assign({}, prev, { [key]: value }));

			const runTest = async (key, urlKey) => {
				const url = form[urlKey];
				if (!url) return;
				setTests((prev) => Object.assign({}, prev, { [key]: { busy: true } }));
				try {
					const result = await api("/test", { method: "POST", body: JSON.stringify({ url }) });
					setTests((prev) => Object.assign({}, prev, { [key]: result }));
				} catch (err) {
					setTests((prev) => Object.assign({}, prev, {
						[key]: { ok: false, error: String((err && err.message) || err) },
					}));
				}
			};

			const save = async () => {
				setSaving(true);
				setError(null);
				try {
					const data = await api("/config", { method: "POST", body: JSON.stringify(form) });
					onSaved(data);
				} catch (err) {
					setError(String((err && err.message) || err));
					setSaving(false);
				}
			};

			return h("div", {
				className: "dhs-overlay",
				onMouseDown: (e) => { if (e.target === e.currentTarget) onClose(); },
			},
				h("div", { className: "dhs-modal" },
					h("div", { className: "dhs-modal-head" },
						h("div", { className: "dhs-modal-title" }, "管理外部记忆配置"),
						h("button", { className: "dhs-x", "aria-label": "关闭", onClick: onClose }, "×")),
					h(FormRows, { form, setField, tests, runTest }),
					error ? h("div", { className: "dhs-err" }, error) : null,
					h("div", { className: "dhs-modal-actions" },
						h("button", { className: "dhs-btn", onClick: onClose, disabled: saving }, "取消"),
						h("button", {
							className: "dhs-btn dhs-primary",
							onClick: save,
							disabled: saving,
						}, saving ? "保存中…" : "保存设置")),
					h("div", { className: "dhs-muted" },
						"保存会更新 ~/.hindsight/coding-agent.json（自动备份）；对新会话生效。")));
		}

		function HindsightSettingsTab({ api }) {
			const [state, setState] = useState({ phase: "loading" });
			const [manageOpen, setManageOpen] = useState(false);
			const [installBusy, setInstallBusy] = useState(false);
			const [retainBusy, setRetainBusy] = useState(false);

			useEffect(() => {
				let alive = true;
				api("/config")
					.then((data) => {
						if (!alive) return;
						setState({ phase: "ready", data, form: formFromData(data), notice: null, error: null });
					})
					.catch((error) => {
						if (alive) {
							setState({ phase: "error", error: String((error && error.message) || error) });
						}
					});
				return () => { alive = false; };
			}, []);

			const installPhase = state.phase === "ready" && state.data.install ? state.data.install.phase : null;

			// Poll while an adapter install is running (auto or manual).
			useEffect(() => {
				if (installPhase !== "running") return;
				const timer = setInterval(async () => {
					try {
						const data = await api("/config");
						setState((s) => (s.phase !== "ready" ? s : Object.assign({}, s, { data })));
					} catch {
						// transient - keep polling
					}
				}, 2500);
				return () => clearInterval(timer);
			}, [installPhase]);

			const installAdapter = async () => {
				setInstallBusy(true);
				try {
					const data = await api("/install", { method: "POST", body: "{}" });
					setState((s) => (s.phase !== "ready" ? s : Object.assign({}, s, { data })));
				} catch (error) {
					const message = String((error && error.message) || error);
					setState((s) => (s.phase !== "ready" ? s : Object.assign({}, s, { error: message })));
				}
				setInstallBusy(false);
			};

			const toggleRetain = async () => {
				setRetainBusy(true);
				try {
					const saved = await api("/retain", {
						method: "POST",
						body: JSON.stringify({ enabled: !(data.retainSessions !== false) }),
					});
					setState((s) => (s.phase !== "ready"
						? s
						: Object.assign({}, s, { data: saved, notice: saved.notice || "已更新", error: null })));
				} catch (error) {
					const message = String((error && error.message) || error);
					setState((s) => (s.phase !== "ready" ? s : Object.assign({}, s, { error: message })));
				}
				setRetainBusy(false);
			};

			if (state.phase === "loading") {
				return h("div", { className: "dhs-muted" }, "正在读取 Hindsight 配置…");
			}
			if (state.phase === "error") {
				return h("div", { className: "dhs-banner" },
					h("div", { className: "dhs-err" }, "读取失败：" + state.error),
					h("div", { className: "dhs-muted" },
						"请确认 dsh-hindsight-plugins 已挂载（宿主半边提供 /plugins/dsh-hindsight-plugins 路由）。"));
			}

			const { data, notice, error } = state;
			const eff = data.effective || {};
			const sidecar = data.sidecar || {};
			const adapterUnknown = data.adapter === undefined;
			const ok = adapterOk(data);
			const install = data.install || { phase: "idle" };
			return h("div", { className: "dhs-root" },
				h("div", { className: "dhs-head" },
					h("div", { className: "dhs-title" }, "Hindsight 外部记忆"),
					h(HelpDot)),

				ok ? null : h(AdapterWarning, { install, busy: installBusy, onInstall: installAdapter }),

				h("div", { className: "dhs-kv" },
					h("div", { className: "dhs-kv-first" },
						h("span", { className: "dhs-k" }, "当前路由："),
						h("span", { className: "dhs-v" }, sidecar.route === "extranet" ? "外网" : "内网"),
						h("span", { className: "dhs-k" }, "　写入范围："),
						h("span", { className: "dhs-v" }, "仅 DSH")),
					h("div", null,
						h("span", { className: "dhs-k" },
							sidecar.route === "extranet" ? "当前外网地址：" : "当前内网地址："),
						h("span", { className: "dhs-v" },
							(sidecar.route === "extranet" ? sidecar.extranetUrl : sidecar.intranetUrl)
							|| eff.apiUrl || "（未设置）")),
					h("div", null,
						h("span", { className: "dhs-k" }, "Hindsight 服务端版本号："),
						h("span", { className: "dhs-v" },
							data.serverVersion ? "v" + data.serverVersion : "未知")),
					h("div", null,
						h("span", { className: "dhs-k" }, "Coding Agents 版本号："),
						h("span", { className: "dhs-v" }, data.runtimeVersion ? "v" + data.runtimeVersion : "-")),
					h("div", null,
						h("span", { className: "dhs-k" }, "Coding Agents 安装状态："),
						h("span", {
							className: "dhs-v "
								+ (adapterUnknown ? "" : (ok ? "dhs-ok" : "dhs-err")),
						}, adapterUnknown ? "未知" : (ok ? "已安装" : "未安装")))),

				// Session write-back switch (feature-detected: hidden while the
				// running host half predates the /retain route).
				// Semantics: ON = 主动同步 (auto write-back every idle turn);
				// OFF = 不主动同步 (no auto write-back; passive on-demand
				// retention - "记住这个" requests - still works normally).
				data.retainSessions === undefined ? null : h("div", { className: "dhs-kv" },
					h("div", { className: "dhs-inline" },
						h("span", { className: "dhs-k" }, "主动同步："),
						h("button", {
							className: "dhs-switch"
								+ (data.retainSessions !== false ? " dhs-switch-on" : ""),
							role: "switch",
							"aria-checked": data.retainSessions !== false ? "true" : "false",
							title: data.retainSessions !== false
								? "点击切换为不主动同步：停止自动写入，按需入库不受影响"
								: "点击开启：恢复每轮自动写入",
							disabled: retainBusy,
							onClick: toggleRetain,
						}, h("span", { className: "dhs-knob" })),
						h("span", {
							className: data.retainSessions !== false ? "dhs-ok" : "dhs-err",
						}, data.retainSessions !== false ? "已开启" : "不主动同步")),
					h("div", { className: "dhs-muted" },
						data.retainSessions !== false
							? "AI 每轮答完后自动写入 Hindsight（对新会话生效）。"
							: "已停止自动写入；对话中明确要求记住的内容仍会正常入库（被动同步，服务正常时可用）。")),

				h("div", { className: "dhs-actions" },
					h("button", {
						className: "dhs-btn dhs-primary",
						onClick: () => setManageOpen(true),
					}, "管理"),
					notice ? h("span", { className: "dhs-ok" }, notice) : null,
					error ? h("span", { className: "dhs-err" }, error) : null),

				h("div", { className: "dhs-muted" },
					"点击「管理」编辑内网/外网地址、当前路由与写入范围；配置对新会话生效。"),

				manageOpen
					? h(ManageDialog, {
						api,
						initial: state.form,
						onClose: () => setManageOpen(false),
						onSaved: (saved) => {
							setState({
								phase: "ready",
								data: saved,
								form: formFromData(saved),
								notice: saved.notice || "已保存",
								error: null,
							});
							setManageOpen(false);
						},
					})
					: null);
		}

		/**
		 * Contribute the tab: `settings.plugins.tab` is a root list slot owned
		 * by the Plugins settings section; each contribution becomes one tab
		 * (`id`, `order`, localized `label`), and the component receives the
		 * inject face built by the `inject` option factory.
		 */
		function apply(ctx) {
			ctx.slots.inject("settings.plugins.tab", () => ctx.slots.register({
				name: "settings.plugins.tab",
				id: "hindsight",
				order: 30,
				label: () => "外部记忆",
				inject: () => ({ api }),
			}, HindsightSettingsTab));
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
