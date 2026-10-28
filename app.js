// Janela do Provas Girlie (web): escolher provas → personalizar → gerar o .docx.
import { init } from "./src/env.js";
import { DEFAULT_OUTPUT, SUPPORTED, UserError, compareNatural, generate } from "./src/pipeline.js";

const VERSION = "1.0.2";
const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------------------
// Preferências (só neste aparelho)

const prefs = {
	get(key, fallback) {
		try {
			const v = localStorage.getItem(`provas-girlie:${key}`);
			return v === null ? fallback : JSON.parse(v);
		} catch {
			return fallback;
		}
	},
	set(key, value) {
		try {
			localStorage.setItem(`provas-girlie:${key}`, JSON.stringify(value));
		} catch { /* modo privado: tudo bem */ }
	},
};

// ---------------------------------------------------------------------------
// Dependências pesadas (leitor de PDF em WebAssembly), carregadas uma vez

let depsPromise = null;
function loadDeps() {
	if (!depsPromise) {
		depsPromise = (async () => {
			const bytes = async (url) => {
				const r = await fetch(url);
				if (!r.ok) throw new Error(`${url}: ${r.status}`);
				return new Uint8Array(await r.arrayBuffer());
			};
			const [mupdf, coverPng, templateZip] = await Promise.all([
				import("./vendor/mupdf/mupdf.js"),
				bytes("assets/cover.png"),
				bytes("assets/template.zip"),
				waitFor(() => window.JSZip),
			]);
			init({ mupdf, JSZip: window.JSZip, DOMParser: window.DOMParser });
			return { coverPng, templateZip };
		})();
		depsPromise.catch(() => { depsPromise = null; });
	}
	return depsPromise;
}

function waitFor(test) {
	return new Promise((resolve) => {
		const tick = () => (test() ? resolve() : setTimeout(tick, 30));
		tick();
	});
}

// ---------------------------------------------------------------------------
// Lista de provas

const files = []; // { name, size, file }
let busy = false;
let lastUrl = null;
let lastBlob = null;

function fmtSize(n) {
	if (n < 1024) return `${n} B`;
	if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
	return `${(n / 1024 / 1024).toFixed(1).replace(".", ",")} MB`;
}

function extOf(name) {
	const i = name.lastIndexOf(".");
	return i < 0 ? "" : name.slice(i).toLowerCase();
}

function addFiles(list) {
	const incoming = [...list].sort((a, b) => compareNatural(a.name, b.name));
	const rejected = [];
	let added = 0;
	for (const f of incoming) {
		if (!SUPPORTED.includes(extOf(f.name))) {
			rejected.push(f.name);
			continue;
		}
		if (files.some((x) => x.name === f.name && x.size === f.size)) continue;
		files.push({ name: f.name, size: f.size, file: f });
		added++;
	}
	if (rejected.length) showStatus(`${rejected.join(", ")}: formato não suportado (use PDF ou DOCX).`, "err");
	else if (added) showStatus(files.length === 1 ? "1 prova na lista. ♡" : `${files.length} provas na lista. ♡`);
	clearResult();
	render();
}

function move(i, delta) {
	const j = i + delta;
	if (j < 0 || j >= files.length) return;
	[files[i], files[j]] = [files[j], files[i]];
	clearResult();
	render(j, delta < 0 ? "up" : "down");
}

function removeAt(i) {
	files.splice(i, 1);
	clearResult();
	render(Math.min(i, files.length - 1), "remove");
}

function render(focusIndex = null, focusKind = null) {
	const ol = $("file-list");
	ol.textContent = "";
	files.forEach((f, i) => {
		const li = document.createElement("li");
		li.className = "file";
		const ext = extOf(f.name).slice(1);
		li.innerHTML = `<span class="num" aria-hidden="true">${i + 1}</span>
			<span class="meta"><span class="name"></span><span class="sub"><span class="badge ${ext}">${ext.toUpperCase()}</span>${fmtSize(f.size)}</span></span>
			<button class="icon-btn" type="button" data-act="up" aria-label="Subir">▲</button>
			<button class="icon-btn" type="button" data-act="down" aria-label="Descer">▼</button>
			<button class="icon-btn" type="button" data-act="del" aria-label="Remover">✕</button>`;
		li.querySelector(".name").textContent = f.name;
		li.querySelector(".name").title = f.name;
		li.querySelector('[data-act="up"]').disabled = i === 0;
		li.querySelector('[data-act="down"]').disabled = i === files.length - 1;
		li.querySelector('[data-act="up"]').setAttribute("aria-label", `Subir ${f.name}`);
		li.querySelector('[data-act="down"]').setAttribute("aria-label", `Descer ${f.name}`);
		li.querySelector('[data-act="del"]').setAttribute("aria-label", `Remover ${f.name}`);
		li.dataset.index = String(i);
		ol.appendChild(li);
	});
	const has = files.length > 0;
	$("empty").hidden = has;
	$("drop").classList.toggle("filled", has);
	$("btn-clear").hidden = !has;
	if (focusIndex !== null && focusIndex >= 0 && has) {
		const target = ol.children[focusIndex]?.querySelector(`[data-act="${focusKind === "remove" ? "del" : focusKind}"]:not([disabled])`)
			|| ol.children[focusIndex]?.querySelector(".icon-btn:not([disabled])");
		target?.focus();
	}
}

// ---------------------------------------------------------------------------
// Mensagens

function showStatus(text, kind = "") {
	const s = $("status");
	s.textContent = text;
	s.className = `status ${kind}`;
}

function setProgress(frac) {
	const pct = Math.max(0, Math.min(100, Math.round(frac * 100)));
	$("bar").style.width = `${pct}%`;
	document.querySelector(".progress").setAttribute("aria-valuenow", String(pct));
}

function log(text, kind) {
	const ul = $("log");
	ul.hidden = false;
	const li = document.createElement("li");
	li.className = kind;
	li.textContent = text;
	ul.appendChild(li);
}

function clearResult() {
	$("result").hidden = true;
	$("error").hidden = true;
	$("log").hidden = true;
	$("log").textContent = "";
	if (lastUrl) URL.revokeObjectURL(lastUrl);
	lastUrl = null;
	lastBlob = null;
	if (!busy) setProgress(0);
}

function showError(msg, tech) {
	$("error").hidden = false;
	$("error-msg").textContent = msg;
	$("error-details").hidden = !tech;
	$("error-tech").textContent = tech ? `Provas Girlie v${VERSION} (web)\n${navigator.userAgent}\n\n${tech}` : "";
}

// ---------------------------------------------------------------------------
// Gerar

function outputName() {
	const raw = $("in-name").value.trim().replace(/\.docx$/i, "");
	const clean = raw.replace(/[\\/:*?"<>|\x00-\x1f]+/g, " ").replace(/\s+/g, " ").trim();
	return `${clean || DEFAULT_OUTPUT.replace(/\.docx$/, "")}.docx`;
}

async function start() {
	if (busy) return;
	if (!files.length) {
		showStatus("Adicione pelo menos um PDF de prova primeiro. ♡", "err");
		$("file-input").click();
		return;
	}
	busy = true;
	clearResult();
	$("btn-go").disabled = true;
	setProgress(0.02);
	const header = $("in-header").value.trim();
	const split = $("in-split").checked;
	prefs.set("header", header);
	prefs.set("split", split);
	prefs.set("name", $("in-name").value.trim());
	try {
		showStatus("Preparando o leitor de PDF…");
		const deps = await loadDeps();
		const inputs = [];
		for (const f of files) inputs.push({ name: f.name, data: new Uint8Array(await f.file.arrayBuffer()) });
		const res = await generate(inputs, {
			header,
			title: $("in-title").value.trim(),
			subtitle: $("in-sub").value.trim(),
			split_in_parts: split,
			coverPng: deps.coverPng,
			templateZip: deps.templateZip,
			progress: (msg, frac) => {
				showStatus(msg);
				setProgress(frac);
			},
		});
		finish(res);
	} catch (exc) {
		fail(exc);
	} finally {
		busy = false;
		$("btn-go").disabled = false;
	}
}

function finish(res) {
	const name = outputName();
	lastBlob = new Blob([res.data], { type: DOCX_MIME });
	lastUrl = URL.createObjectURL(lastBlob);
	const dl = $("btn-download");
	dl.href = lastUrl;
	dl.download = name;
	const nq = res.exams.reduce((a, e) => a + e.questions.length, 0);
	for (const e of res.exams) log(`✓ ${e.title}: ${e.questions.length} questões (${{ moodle: "revisão do Moodle", prova: "prova com gabarito" }[e.kind] || "conteúdo corrido"})`, "ok");
	for (const w of res.warnings) log(`⚠ ${w}`, "warn");
	setProgress(1);
	showStatus(`Pronto! ${res.exams.length} prova(s), ${nq} questões → ${name}`, "ok");
	$("result-info").textContent = `${name} · ${fmtSize(res.data.length)}`;
	$("btn-share").hidden = !canShareFile(name);
	$("share-tip").hidden = $("btn-share").hidden;
	// com o botão de compartilhar visível, baixar vira a opção secundária
	$("btn-download").className = $("btn-share").hidden ? "btn mint" : "btn mint-soft";
	$("result").hidden = false;
	$("result").scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function fail(exc) {
	setProgress(0);
	showStatus("Não deu certo desta vez.", "err");
	if (exc instanceof UserError) {
		log(`✗ ${exc.message}`, "err");
		showError(exc.message, "");
		return;
	}
	const cause = `${exc?.name || "Erro"}: ${String(exc?.message || exc).slice(0, 180)}`;
	const notes = (exc?.notes || []).join("\n");
	const msg = `Algo inesperado aconteceu ao gerar o documento.\n\nCausa: ${cause}${notes ? `\n${notes}` : ""}`;
	log(`✗ ${msg}`, "err");
	showError(msg, `${msg}\n\n${exc?.stack || ""}`);
	console.error(exc);
}

function shareFile(name) {
	return new File([lastBlob], name, { type: DOCX_MIME });
}

function canShareFile(name) {
	try {
		return Boolean(navigator.canShare && navigator.share && navigator.canShare({ files: [shareFile(name)] }));
	} catch {
		return false;
	}
}

async function share() {
	if (!lastBlob) return;
	const name = $("btn-download").download;
	try {
		await navigator.share({ files: [shareFile(name)], title: name });
	} catch (exc) {
		if (exc?.name !== "AbortError") $("btn-download").click();
	}
}

// ---------------------------------------------------------------------------
// Eventos

function wire() {
	$("version").textContent = VERSION;
	$("in-header").value = prefs.get("header", "");
	$("in-split").checked = prefs.get("split", true);
	$("in-name").value = prefs.get("name", "") || DEFAULT_OUTPUT.replace(/\.docx$/, "");

	$("file-input").addEventListener("change", (e) => {
		addFiles(e.target.files);
		e.target.value = "";
	});
	$("btn-clear").addEventListener("click", () => {
		files.length = 0;
		clearResult();
		render();
		showStatus("Lista vazia. Pronta para começar ♡");
	});
	$("file-list").addEventListener("click", (e) => {
		const btn = e.target.closest("button[data-act]");
		if (!btn || busy) return;
		const i = Number(btn.closest("li").dataset.index);
		if (btn.dataset.act === "up") move(i, -1);
		else if (btn.dataset.act === "down") move(i, 1);
		else removeAt(i);
	});
	const drop = $("drop");
	const prevent = (e) => { e.preventDefault(); e.stopPropagation(); };
	for (const ev of ["dragenter", "dragover"]) drop.addEventListener(ev, (e) => { prevent(e); drop.classList.add("over"); });
	for (const ev of ["dragleave", "drop"]) drop.addEventListener(ev, (e) => { prevent(e); drop.classList.remove("over"); });
	drop.addEventListener("drop", (e) => { if (e.dataTransfer?.files?.length) addFiles(e.dataTransfer.files); });
	$("empty").addEventListener("click", () => $("file-input").click());
	$("btn-go").addEventListener("click", start);
	$("btn-share").addEventListener("click", share);
	$("btn-copy").addEventListener("click", async () => {
		try {
			await navigator.clipboard.writeText($("error-tech").textContent);
			$("btn-copy").textContent = "Copiado ✓";
		} catch {
			const r = document.createRange();
			r.selectNodeContents($("error-tech"));
			getSelection().removeAllRanges();
			getSelection().addRange(r);
		}
	});
	for (const id of ["in-header", "in-title", "in-sub", "in-split"]) $(id).addEventListener("change", clearResult);

	render();
	loadDeps().then(
		() => { if (!busy && !files.length) showStatus("Pronta para começar ♡"); },
		() => showStatus("Não consegui carregar o leitor de PDF. Verifique a internet e recarregue a página.", "err"),
	);

	if ("serviceWorker" in navigator && location.protocol === "https:") {
		navigator.serviceWorker.register("sw.js").catch(() => { /* sem modo offline */ });
	}
}

wire();
