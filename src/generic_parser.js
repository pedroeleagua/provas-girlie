// Modo genérico: arquivos que não são revisão do Moodle viram conteúdo corrido,
// preservando todo o texto, a formatação básica e as imagens na posição original.
import { BlockBuilder } from "./blocks.js";
import { env } from "./env.js";
import { Exam, Image, Paragraph, Run } from "./models.js";
import { body_size, content_width } from "./pdf_extract.js";
import { clean_exam_title, clean_runs } from "./textutils.js";
import { basename, splitext, strip } from "./py.js";

const EMU_PER_PT = 12700;
const W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const R_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const A_NS = "http://schemas.openxmlformats.org/drawingml/2006/main";
const WP_NS = "http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing";
const REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships";
const CT_NS = "http://schemas.openxmlformats.org/package/2006/content-types";

export function parse_generic_pdf(content) {
	const lines = content.all_lines();
	const images = content.pages.flatMap((p) => p.images);
	const bsize = lines.length ? body_size(lines) : 10.0;
	const builder = new BlockBuilder(content, bsize * 1.25);
	const [blocks] = builder.build([...lines, ...images]);
	const title = clean_exam_title(content.title || content.header_title) || _first_heading(blocks) || splitext(basename(content.path))[0];
	const exam = new Exam({
		title,
		source: content.path,
		kind: "generic",
		blocks,
		content_width: lines.length ? content_width(lines) : content.pages[0].width * 0.85,
	});
	if (!lines.length) exam.warnings.push("O PDF não tem texto selecionável (provavelmente é digitalizado); as páginas entram como imagens.");
	return exam;
}

function _first_heading(blocks) {
	for (const b of blocks.slice(0, 5)) {
		if (b instanceof Paragraph && b.heading) {
			const n = strip(b.text).length;
			if (3 <= n && n <= 90) return strip(b.text);
		}
	}
	return "";
}

// NodeList → array (no Node, o xmldom não tem iterador)
const byTag = (node, ns, name) => Array.from(node.getElementsByTagNameNS(ns, name));

// Filhos diretos com um nome (namespace do Word)
function children(el, local, ns = W_NS) {
	const out = [];
	for (let c = el.firstChild; c; c = c.nextSibling) if (c.nodeType === 1 && c.localName === local && c.namespaceURI === ns) out.push(c);
	return out;
}
function child(el, local, ns = W_NS) {
	return children(el, local, ns)[0] || null;
}
function attr(el, local, ns = W_NS) {
	const v = el.getAttributeNS(ns, local);
	return v === "" && !el.hasAttributeNS(ns, local) ? null : v;
}

function resolvePart(base, target) {
	if (target.startsWith("/")) return target.slice(1);
	const parts = base.split("/").slice(0, -1);
	for (const seg of target.split("/")) {
		if (seg === "..") parts.pop();
		else if (seg !== ".") parts.push(seg);
	}
	return parts.join("/");
}

export async function parse_docx(data, path) {
	const { JSZip, DOMParser } = env;
	let zip, root, rels, ctypes;
	try {
		zip = await JSZip.loadAsync(data);
		const ct = await zip.file("[Content_Types].xml").async("string");
		ctypes = new DOMParser().parseFromString(ct, "application/xml");
		const relsDoc = await zip.file("_rels/.rels").async("string");
		const officeRel = byTag(new DOMParser().parseFromString(relsDoc, "application/xml"), REL_NS, "Relationship")
			.find((r) => r.getAttribute("Type").endsWith("/officeDocument"));
		const docPath = resolvePart("", officeRel.getAttribute("Target"));
		root = new DOMParser().parseFromString(await zip.file(docPath).async("string"), "application/xml");
		const relPath = docPath.replace(/[^/]+$/, (n) => `_rels/${n}.rels`);
		rels = new Map();
		const relFile = zip.file(relPath);
		if (relFile) {
			const rd = new DOMParser().parseFromString(await relFile.async("string"), "application/xml");
			for (const r of byTag(rd, REL_NS, "Relationship")) {
				if (r.getAttribute("TargetMode") === "External") continue;
				rels.set(r.getAttribute("Id"), resolvePart(docPath, r.getAttribute("Target")));
			}
		}
		if (!root.documentElement || root.documentElement.localName !== "document") throw new Error("documento inválido");
	} catch (exc) {
		throw new Error("não consegui abrir este arquivo Word. Confira se ele é mesmo .docx (o formato antigo .doc não funciona) e, se for, salve-o de novo no Word.");
	}

	const contentType = (partName) => {
		for (const o of byTag(ctypes, CT_NS, "Override")) if (o.getAttribute("PartName") === "/" + partName) return o.getAttribute("ContentType");
		const ext = partName.split(".").pop().toLowerCase();
		for (const d of byTag(ctypes, CT_NS, "Default")) if (d.getAttribute("Extension").toLowerCase() === ext) return d.getAttribute("ContentType");
		return "";
	};

	// Carrega os blobs das imagens referenciadas antes de percorrer (o resto é síncrono).
	const blobs = new Map();
	for (const blip of byTag(root, A_NS, "blip")) {
		const rid = blip.getAttributeNS(R_NS, "embed");
		if (rid && rels.has(rid) && !blobs.has(rid)) {
			const f = zip.file(rels.get(rid));
			if (f) blobs.set(rid, { data: await f.async("uint8array"), ctype: contentType(rels.get(rid)) });
		}
	}

	const warnings = [];
	const seen = new Set();

	const para_blocks = (p_el) => {
		const ppr = child(p_el, "pPr");
		let style_name = "";
		if (ppr !== null && child(ppr, "pStyle") !== null) {
			const style_id = attr(child(ppr, "pStyle"), "val") || "";
			style_name = style_id.toLowerCase();
		}
		let runs = [];
		const out = [];
		for (const r of byTag(p_el, W_NS, "r")) {
			const rpr = child(r, "rPr");
			const flag = (tag) => {
				if (rpr === null) return false;
				const el = child(rpr, tag);
				return el !== null && !["0", "false"].includes(attr(el, "val"));
			};
			let va = rpr !== null ? child(rpr, "vertAlign") : null;
			va = va !== null ? attr(va, "val") : "";
			for (let c = r.firstChild; c; c = c.nextSibling) {
				if (c.nodeType !== 1 || c.namespaceURI !== W_NS) continue;
				if (c.localName === "t") runs.push(new Run(c.textContent || "", flag("b"), flag("i"), va === "subscript", va === "superscript"));
				else if (c.localName === "tab") runs.push(new Run(" "));
				else if (c.localName === "br") runs.push(new Run(" "));
			}
			for (const blip of byTag(r, A_NS, "blip")) {
				const rid = blip.getAttributeNS(R_NS, "embed");
				const img = _docx_image(blobs, r, rid);
				if (img === null) {
					warnings.push("Uma imagem em formato não suportado foi ignorada.");
					continue;
				}
				if (seen.has(img.key)) continue;
				seen.add(img.key);
				const cleaned = clean_runs(runs);
				if (cleaned.length) out.push(new Paragraph(cleaned));
				runs = [];
				out.push(img);
			}
		}
		const cleaned = clean_runs(runs);
		if (cleaned.length) {
			const heading = ["heading", "ttulo", "titulo", "title"].some((p) => style_name.startsWith(p));
			out.push(new Paragraph(cleaned, heading));
		}
		return out;
	};

	const walk = (container) => {
		const out = [];
		for (let el = container.firstChild; el; el = el.nextSibling) {
			if (el.nodeType !== 1 || el.namespaceURI !== W_NS) continue;
			if (el.localName === "p") out.push(...para_blocks(el));
			else if (el.localName === "tbl") {
				for (const tr of children(el, "tr")) {
					const cells = [];
					const row_images = [];
					for (const tc of children(tr, "tc")) {
						const cell_blocks = walk(tc);
						cells.push(strip(cell_blocks.filter((b) => b instanceof Paragraph).map((b) => b.text).join(" ")));
						row_images.push(...cell_blocks.filter((b) => b instanceof Image));
					}
					const row = cells.filter((c) => c).join(" | ");
					if (row) out.push(new Paragraph([new Run(row)]));
					out.push(...row_images);
				}
			} else if (el.localName === "sdt") {
				const content = child(el, "sdtContent");
				if (content !== null) out.push(...walk(content));
			}
		}
		return out;
	};

	const body = child(root.documentElement, "body");
	const blocks = body ? walk(body) : [];
	let coreTitle = "";
	try {
		const core = zip.file("docProps/core.xml");
		if (core) {
			const cd = new DOMParser().parseFromString(await core.async("string"), "application/xml");
			const t = cd.getElementsByTagNameNS("http://purl.org/dc/elements/1.1/", "title")[0];
			coreTitle = t ? t.textContent : "";
		}
	} catch { /* sem propriedades */ }
	const title = strip(coreTitle || "") || _first_heading(blocks) || splitext(basename(path))[0];
	const exam = new Exam({ title, source: path, kind: "generic", blocks });
	exam.warnings.push(...[...new Set(warnings)].sort());
	return exam;
}

function _docx_image(blobs, run_el, rid) {
	if (!rid) return null;
	const part = blobs.get(rid);
	if (!part) return null;
	const blob = part.data;
	const ctype = part.ctype || "";
	let cx = null, cy = null;
	const ext = byTag(run_el, WP_NS, "extent")[0];
	if (ext) {
		cx = parseInt(ext.getAttribute("cx"), 10);
		cy = parseInt(ext.getAttribute("cy"), 10);
	}
	let w, h, fmt, data;
	try {
		const im = new env.mupdf.Image(blob);
		w = im.getWidth();
		h = im.getHeight();
		const isPng = blob[0] === 0x89 && blob[1] === 0x50 && blob[2] === 0x4e && blob[3] === 0x47;
		const isJpeg = blob[0] === 0xff && blob[1] === 0xd8;
		if (ctype.includes("png") || isPng) {
			fmt = "png";
			data = blob;
		} else if (ctype.includes("jpeg") || isJpeg) {
			fmt = "jpeg";
			data = blob;
		} else {
			fmt = "png";
			data = im.toPixmap().asPNG();
		}
	} catch {
		return null;
	}
	const pt_w = cx ? cx / EMU_PER_PT : w * 0.75;
	const pt_h = cy ? cy / EMU_PER_PT : h * 0.75;
	return new Image(data, fmt, w, h, pt_w, pt_h, `d${rid}`);
}
