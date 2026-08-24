/**
 * dsh-fulltext-search — client half.
 *
 * Registers a "全文搜索" tab in dsh-better-sidebar's side card through the
 * `ctx.betterSidebar` service. The tab lets the user type a query and search
 * the WORKING DIRECTORY of the current conversation's files by CONTENT
 * (not just file names): the host half walks the tree and returns
 * file + line-number + matching-line previews; clicking a row opens the file
 * in the sidebar editor.
 *
 * Search options mirror VSCode Search: literal or regex queries, match case,
 * smart case, and whole-word exact matching. Preview highlights are rendered
 * from the host-provided span offsets (`matchStart`/`matchEnd`/`spans`), so
 * highlighting is exact even for regexes and truncated previews.
 *
 * Bundle format: DSH client plugins are plain `window.__ModuleLoader__.load`
 * definitions — no JSX, no TypeScript, no module imports beyond the externals
 * the loader table provides (`react`). `apply`/`inject` are the plugin's
 * exported surface; `inject` declares the cordis services it reads
 * (`betterSidebar`).
 */
window.__ModuleLoader__.load({
	id: "dsh-fulltext-search",
	factory: (require) => {
		const { createElement: h, useEffect, useRef, useState } = require("react");

		// ── styles (injected once; token-driven so skins keep working) ──────
		const CSS_ID = "dsh-fulltext-search/css";
		if (typeof document !== "undefined" && !document.querySelector("style[data-plugin-css=\"" + CSS_ID + "\"]")) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-fulltext-search";
			tag.dataset.pluginCss = CSS_ID;
			tag.textContent = [
				".fts-root{display:flex;flex-direction:column;height:100%;min-height:0}",
				".fts-bar{display:flex;gap:6px;padding:8px 10px;border-bottom:1px solid var(--dsw-alias-border-l2,#333)}",
				".fts-input{flex:1;min-width:0;height:30px;padding:0 10px;border-radius:6px;border:1px solid var(--dsw-alias-border-l2,#444);background:var(--dsw-alias-bg-layer-3,#1b1b22);color:var(--dsw-alias-label-primary,#eee);font-size:13px;outline:none}",
				".fts-input:focus{border-color:var(--dsw-alias-brand-primary,#4d6bfe)}",
				".fts-input-err{border-color:var(--dsw-alias-state-error-primary,#e5484d)!important}",
				".fts-go{height:30px;padding:0 12px;border:none;border-radius:6px;background:var(--dsw-alias-brand-primary,#4d6bfe);color:#fff;font-size:13px;cursor:pointer;flex:none}",
				".fts-go:disabled{opacity:.5;cursor:default}",
				".fts-tgl{height:30px;min-width:30px;padding:0 8px;border:1px solid var(--dsw-alias-border-l2,#444);border-radius:6px;background:transparent;color:var(--dsw-alias-label-tertiary,#999);font-size:12px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;cursor:pointer;flex:none}",
				".fts-tgl:hover{color:var(--dsw-alias-label-primary,#eee)}",
				".fts-tgl-on{border-color:var(--dsw-alias-brand-primary,#4d6bfe);color:var(--dsw-alias-brand-primary,#4d6bfe);background:rgba(77,107,254,.12)}",
				".fts-opts{display:flex;align-items:center;gap:4px;padding:2px 10px;font-size:12px;color:var(--dsw-alias-label-tertiary,#999)}",
				".fts-body{flex:1;min-height:0;overflow-y:auto;padding:4px 0}",
				".fts-hint{padding:20px 14px;color:var(--dsw-alias-label-tertiary,#999);font-size:12px;line-height:1.7;white-space:pre-wrap}",
				".fts-err{padding:10px 14px;color:var(--dsw-alias-state-warn-primary,#e8a33d);font-size:12px;line-height:1.6;white-space:pre-wrap}",
				".fts-summary{padding:6px 14px;font-size:12px;color:var(--dsw-alias-label-tertiary,#999)}",
				".fts-file{padding:7px 14px 2px;font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary,#ccc);cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}",
				".fts-file:hover{color:var(--dsw-alias-brand-primary,#4d6bfe)}",
				".fts-row{display:flex;gap:8px;padding:2px 14px 2px 18px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;line-height:1.6;cursor:pointer;color:var(--dsw-alias-label-primary,#eee)}",
				".fts-row:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.06))}",
				".fts-ln{flex:none;color:var(--dsw-alias-label-tertiary,#888);min-width:34px;text-align:right;user-select:none}",
				".fts-txt{flex:1;min-width:0;white-space:pre-wrap;word-break:break-all}",
				".fts-txt mark{background:rgba(230,160,60,.35);color:inherit;border-radius:2px}",
			].join("\n");
			document.head.appendChild(tag);
		}

		// ── search state + wire call ───────────────────────────────────────
		/**
		 * Run one content search against the host half. Returns the parsed
		 * `{matches, files, truncated, engine}` value; throws on wire failure
		 * with `err.code` set (e.g. `invalid-regex`).
		 */
		function searchApi(scope, query, opts, signal) {
			const payload = {
				sessionId: scope.sessionId,
				...(scope.cwd !== undefined && scope.cwd !== "" ? { cwd: scope.cwd } : {}),
				query,
				caseSensitive: opts.caseSensitive,
				wholeWord: opts.wholeWord,
				isRegex: opts.isRegex,
				smartCase: opts.smartCase,
			};
			return fetch("/fts/api/search", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(payload),
				signal,
			}).then(async (response) => {
				let parsed = null;
				try {
					parsed = await response.json();
				} catch {
					/* fall through */
				}
				if (!response.ok || parsed === null || parsed.ok !== true || parsed.value === undefined) {
					const message = parsed && parsed.error && parsed.error.message
						? parsed.error.message
						: "HTTP " + response.status;
					const err = new Error(message);
					err.code = parsed && parsed.error ? parsed.error.code : undefined;
					throw err;
				}
				return parsed.value;
			});
		}

		/** Render one preview line using host-provided highlight spans. */
		function renderLine(line, spans, key) {
			const parts = [];
			if (!spans || spans.length === 0) {
				return h("span", { className: "fts-txt" }, line);
			}
			let pos = 0;
			for (let i = 0; i < spans.length; i += 1) {
				const s = spans[i][0];
				const e = spans[i][1];
				if (s > pos) parts.push(line.slice(pos, s));
				if (e > s) parts.push(h("mark", { key: key + "-m" + i }, line.slice(s, e)));
				if (e > pos) pos = e;
			}
			if (pos < line.length) parts.push(line.slice(pos));
			return h("span", { className: "fts-txt" }, ...parts);
		}

		/** Fallback highlight when a row has no spans (legacy host). */
		function highlightParts(line, query, caseSensitive) {
			if (!query) return [line];
			const needle = caseSensitive ? query : query.toLowerCase();
			const hay = caseSensitive ? line : line.toLowerCase();
			const parts = [];
			let pos = 0;
			for (;;) {
				const idx = hay.indexOf(needle, pos);
				if (idx === -1) {
					if (pos < line.length) parts.push(line.slice(pos));
					break;
				}
				if (idx > pos) parts.push(line.slice(pos, idx));
				parts.push(h("mark", { key: "m" + idx }, line.slice(idx, idx + needle.length)));
				pos = idx + needle.length;
				if (pos >= line.length) break;
			}
			return parts;
		}

		/** Group matches by file (order preserved), with count. */
		function groupByFile(matches) {
			const groups = [];
			const index = new Map();
			for (const m of matches) {
				let g = index.get(m.abs);
				if (g === undefined) {
					g = { abs: m.abs, rel: m.rel, rows: [] };
					index.set(m.abs, g);
					groups.push(g);
				}
				g.rows.push(m);
			}
			return groups;
		}

		/** One toggle button (VSCode-search style). */
		function Toggle({ active, title, label, onClick }) {
			return h("button", {
				className: "fts-tgl" + (active ? " fts-tgl-on" : ""),
				title: title,
				"aria-pressed": active,
				onClick: onClick,
			}, label);
		}

		// ── tab component ──────────────────────────────────────────────────
		function SearchTab(props) {
			const { ctx, scope } = props;
			const [query, setQuery] = useState("");
			const [caseSensitive, setCaseSensitive] = useState(false);
			const [wholeWord, setWholeWord] = useState(false);
			const [isRegex, setIsRegex] = useState(false);
			const [smartCase, setSmartCase] = useState(false);
			const [status, setStatus] = useState("idle"); // idle | searching | done | error
			const [result, setResult] = useState(null);
			const [error, setError] = useState("");
			const [invalidRegex, setInvalidRegex] = useState(false);
			const abortRef = useRef(null);

			useEffect(() => () => abortRef.current?.abort(), []);

			const run = () => {
				const q = query.trim();
				if (q === "" || status === "searching") return;
				abortRef.current?.abort();
				const controller = new AbortController();
				abortRef.current = controller;
				setStatus("searching");
				setError("");
				setInvalidRegex(false);
				searchApi(scope, q, { caseSensitive, wholeWord, isRegex, smartCase }, controller.signal)
					.then((value) => {
						setResult(value);
						setStatus("done");
					})
					.catch((err) => {
						if (err && err.name === "AbortError") return;
						if (err && err.code === "invalid-regex") setInvalidRegex(true);
						setError(err instanceof Error ? err.message : String(err));
						setStatus("error");
					});
			};

			const onInputChange = (e) => {
				setQuery(e.target.value);
				setInvalidRegex(false);
				setError("");
			};

			const openFile = (abs) => {
				try {
					// Prefer the service's own open (targeted to this session);
					// fall back to the tab host's callback when unavailable.
					if (ctx && ctx.betterSidebar && typeof ctx.betterSidebar.openFile === "function") {
						ctx.betterSidebar.openFile(scope, abs);
						return;
					}
				} catch {
					/* fall through */
				}
				if (props.onOpenFile) props.onOpenFile(abs);
			};

			const groups = result && status === "done" ? groupByFile(result.matches) : [];

			return h("div", { className: "fts-root" },
				h("div", { className: "fts-bar" },
					h("input", {
						className: "fts-input" + (invalidRegex ? " fts-input-err" : ""),
						placeholder: "搜索文件内容… (Enter)",
						value: query,
						spellCheck: false,
						onChange: onInputChange,
						onKeyDown: (e) => { if (e.key === "Enter") run(); },
					}),
					h(Toggle, { active: isRegex, title: "正则表达式 (.*)", label: ".*", onClick: () => setIsRegex(!isRegex) }),
					h(Toggle, { active: caseSensitive, title: "区分大小写 (Aa)", label: "Aa", onClick: () => setCaseSensitive(!caseSensitive) }),
					h(Toggle, { active: wholeWord, title: "全字匹配 (Ab)", label: "Ab", onClick: () => setWholeWord(!wholeWord) }),
					h("button", { className: "fts-go", onClick: run, disabled: status === "searching" },
						status === "searching" ? "搜索中…" : "搜索"),
				),
				h("div", { className: "fts-opts" },
					h("label", { style: { display: "inline-flex", alignItems: "center", gap: 4, cursor: "pointer" } },
						h("input", {
							type: "checkbox",
							checked: smartCase,
							onChange: (e) => setSmartCase(e.target.checked),
							style: { margin: 0 },
						}),
						"智能大小写"),
					result && status === "done"
						? h("span", { style: { marginLeft: "auto" } },
							result.matches.length + " 行 / " + result.files + " 个文件" +
							(result.engine === "rg" ? " · ripgrep" : result.engine === "js" ? " · js" : "") +
							(result.truncated ? "（已截断）" : ""))
						: null,
				),
				h("div", { className: "fts-body" }, renderBody()),
			);

			/** The body section: hint / progress / error / empty / results. */
			function renderBody() {
				if (status === "idle") {
					return h("div", { className: "fts-hint" },
						"按文件内容全文搜索当前工作区。\n" +
						"支持：正则 (.*)、区分大小写 (Aa)、全字匹配 (Ab)、智能大小写。\n" +
						"输入关键字后回车，点击结果行在编辑器中打开文件。");
				}
				if (status === "searching") {
					return h("div", { className: "fts-hint" }, "搜索中…");
				}
				if (status === "error") {
					return h("div", { className: "fts-err" }, error);
				}
				if (!result || result.matches.length === 0) {
					return h("div", { className: "fts-hint" }, "没有匹配的内容。");
				}
				return groups.map(renderGroup);
			}

			/** One file group: a clickable file header + its match rows. */
			function renderGroup(g) {
				return h("div", { key: g.abs },
					h("div",
						{
							className: "fts-file",
							title: "打开 " + g.abs,
							onClick: () => openFile(g.abs),
						},
						g.rel),
					g.rows.map(renderRow));
			}

			/** One match row: line number + highlighted line text. */
			function renderRow(m) {
				const spans = Array.isArray(m.spans) ? m.spans : null;
				const content = spans
					? renderLine(m.line, spans, m.abs + ":" + m.lineNumber)
					: h("span", { className: "fts-txt" },
						...highlightParts(m.line, query, caseSensitive));
				return h("div",
					{
						key: m.abs + ":" + m.lineNumber,
						className: "fts-row",
						title: "打开 " + m.abs + ":" + m.lineNumber,
						onClick: () => openFile(m.abs),
					},
					h("span", { className: "fts-ln" }, String(m.lineNumber)),
					content);
			}
		}

		// ── plugin surface ──────────────────────────────────────────────────
		/** Services this plugin reads: the better-sidebar registry. */
		const inject = ["betterSidebar"];

		/** Client plugin body: register the search tab. */
		function apply(ctx) {
			ctx.effect(() =>
				ctx.betterSidebar.registerTab({
					id: "fulltext-search",
					title: "全文搜索",
					icon: (size) => h("svg",
						{
							width: size,
							height: size,
							viewBox: "0 0 24 24",
							fill: "none",
							stroke: "currentColor",
							strokeWidth: 2,
							strokeLinecap: "round",
						},
						h("circle", { cx: 11, cy: 11, r: 7 }),
						h("line", { x1: 21, y1: 21, x2: 16.2, y2: 16.2 }),
					),
					order: 25,
					single: true,
					component: SearchTab,
				}),
				"dsh-fulltext-search: register tab",
			);
		}

		return { apply, inject };
	},
});
