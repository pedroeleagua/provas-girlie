// Leitura de baixo nível do PDF (mupdf.js, o mesmo motor do PyMuPDF).
//
// Entrega, por página, linhas de texto com formatação por trecho, imagens com
// posição, ícones de correção (✓/✗ em fontes de ícones) e marcações de
// alternativa (o "radio" preenchido). Cabeçalhos/rodapés impressos pelo
// navegador são removidos e subscritos/sobrescritos soltos são reencaixados
// na linha a que pertencem (ex.: O + ₂).
import { Image } from "./models.js";
import { options } from "./options.js";
import { D, basename, cmpTuple, median, mostCommonKey, pyRound, splitext, strip, rstrip } from "./py.js";

let mupdf = null;
export function setMupdf(m) {
	mupdf = m;
}

const PUA = /^[-]/u;
const CONTROL = /^[\x00-\x08\x0b\x0c\x0e-\x1f\x7f￾￿]/u;
const ICON_FONT = /awesome|glyphicons|material.?icons|icomoon|bootstrap-icons|(^|\+)fa-/i;

// Mesmas opções do TEXTFLAGS_RAWDICT do PyMuPDF, sem preservar imagens.
const STEXT_OPTIONS = "preserve-ligatures,preserve-whitespace,clip,use-cid-for-unknown-unicode";

// Erro amigável para mostrar ao usuário.
export class PdfError extends Error {}

export class Span {
	constructor(text, bold, italic, size, color, x0, x1, origin_y, chars = [], sub = false, sup = false) {
		Object.assign(this, { text, bold, italic, size, color, x0, x1, origin_y, chars, sub, sup });
	}
}

export class Line {
	constructor(page, x0, y0, x1, y1, spans) {
		Object.assign(this, { page, x0, y0, x1, y1, spans });
	}
	get text() {
		return this.spans.map((s) => s.text).join("");
	}
	get size() {
		const weights = new Map();
		for (const s of this.spans) {
			if (s.sub || s.sup) continue;
			const k = pyRound(s.size, 1);
			weights.set(k, (weights.get(k) || 0) + (strip(s.text).length || 1));
		}
		return weights.size ? mostCommonKey(weights) : this.spans[0].size;
	}
	get color() {
		const weights = new Map();
		for (const s of this.spans) weights.set(s.color, (weights.get(s.color) || 0) + (strip(s.text).length || 1));
		return mostCommonKey(weights);
	}
	get key() {
		return [this.page, this.y0, this.x0];
	}
}

export class PageImage {
	constructor(page, x0, y0, x1, y1, xref, image = null, info = null) {
		Object.assign(this, { page, x0, y0, x1, y1, xref, image, info });
	}
	get key() {
		return [this.page, this.y0, this.x0];
	}
}

export class Icon {
	constructor(page, x0, y0, x1, y1, color) {
		Object.assign(this, { page, x0, y0, x1, y1, color });
	}
	get kind() {
		const b = this.color & 255, g = (this.color >> 8) & 255, r = (this.color >> 16) & 255;
		if (g > r + 30 && g > b) return "correct";
		if (r > g + 60 && r > b + 40) return "incorrect";
		if (r > 150 && g > 100 && b < 100) return "partial";
		return "other";
	}
}

export class Mark {
	constructor(page, cx, cy) {
		Object.assign(this, { page, cx, cy });
	}
}

export class PageContent {
	constructor(number, width, height) {
		Object.assign(this, { number, width, height, lines: [], images: [], icons: [], marks: [] });
	}
}

export class PdfContent {
	constructor(path, title, pages, doc, header_title = "") {
		Object.assign(this, { path, title, pages, doc, header_title });
	}
	all_lines() {
		return this.pages.flatMap((p) => p.lines);
	}
	close() {
		try { this.doc?.destroy?.(); } catch { /* já liberado */ }
		this.doc = null;
	}
}

export function open_pdf(data) {
	let doc;
	try {
		doc = mupdf.Document.openDocument(data, "application/pdf");
	} catch (exc) {
		throw new PdfError(`Não consegui abrir o arquivo como PDF (${exc?.message || exc}).`);
	}
	if (doc.needsPassword() && !doc.authenticatePassword("")) {
		throw new PdfError("O PDF está protegido por senha. Salve uma cópia sem senha e tente de novo.");
	}
	if (doc.countPages() === 0) throw new PdfError("O PDF não tem páginas.");
	return doc;
}

// ---------------------------------------------------------------------------
// Texto no formato "rawdict" do PyMuPDF

const fontCache = new Map();
function fontInfo(font) {
	let fi = fontCache.get(font.pointer);
	if (!fi) {
		let name = font.getName();
		const plus = name.indexOf("+");
		if (plus === 6) name = name.slice(7); // PyMuPDF remove o prefixo de subconjunto
		fi = { name, flags: (font.isItalic() ? 2 : 0) + (font.isSerif() ? 4 : 0) + (font.isMono() ? 8 : 0) + (font.isBold() ? 16 : 0) };
		fontCache.set(font.pointer, fi);
	}
	return fi;
}

function quadRect(q) {
	const xs = [q[0], q[2], q[4], q[6]], ys = [q[1], q[3], q[5], q[7]];
	return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

function overlaps(a, b) {
	return !(a[0] >= b[2] || a[1] >= b[3] || a[2] <= b[0] || a[3] <= b[1]);
}

function rgbInt(color) {
	const c = color || [0, 0, 0];
	return (Math.round(c[0] * 255) << 16) | (Math.round(c[1] * 255) << 8) | Math.round(c[2] * 255);
}

// Agrupa os caracteres de uma linha em trechos como o PyMuPDF faz.
function rawLine(chars, dir, wmode, pageRect) {
	if (!chars.length) return null;
	const firstOriginY = chars[0].origin[1];
	const horizontal = wmode === 0 && dir[0] === 1 && dir[1] === 0;
	const spans = [];
	let cur = null;
	let lineRect = null;
	for (const ch of chars) {
		const r = quadRect(ch.quad);
		if (!overlaps(pageRect, r)) continue;
		const fi = fontInfo(ch.font);
		const sup = horizontal && ch.origin[1] < firstOriginY - ch.size * 0.1 ? 1 : 0;
		const flags = fi.flags + sup;
		const color = rgbInt(ch.color);
		if (!cur || cur.size !== ch.size || cur.flags !== flags || cur.color !== color || cur.font !== fi.name || cur.bidi !== ch.bidi) {
			cur = { font: fi.name, flags, color, size: ch.size, bidi: ch.bidi, origin: ch.origin, chars: [], bbox: null };
			spans.push(cur);
		}
		cur.chars.push({ c: ch.c, bbox: r, origin: ch.origin });
		cur.bbox = cur.bbox ? [Math.min(cur.bbox[0], r[0]), Math.min(cur.bbox[1], r[1]), Math.max(cur.bbox[2], r[2]), Math.max(cur.bbox[3], r[3])] : r;
		lineRect = lineRect ? [Math.min(lineRect[0], r[0]), Math.min(lineRect[1], r[1]), Math.max(lineRect[2], r[2]), Math.max(lineRect[3], r[3])] : r;
	}
	if (!spans.length) return null;
	return { bbox: lineRect, spans };
}

function rawdictLines(page, pageRect) {
	// O mupdf reaproveita endereços de fontes entre documentos: o cache vale só para esta página.
	fontCache.clear();
	const st = page.toStructuredText(STEXT_OPTIONS);
	const lines = [];
	let chars = null, dir = null, wmode = 0;
	st.walk({
		beginLine(bbox, wm, d) { chars = []; dir = d; wmode = wm; },
		onChar(c, origin, font, size, quad, color, bidi) { chars.push({ c, origin, font, size, quad, color, bidi }); },
		endLine() {
			const ln = rawLine(chars, dir, wmode, pageRect);
			if (ln) lines.push(ln);
			chars = null;
		},
	});
	st.destroy?.();
	return lines;
}

function saturated(color) {
	const r = (color >> 16) & 255, g = (color >> 8) & 255, b = color & 255;
	return Math.max(r, g, b) - Math.min(r, g, b) >= 50;
}

function _span_from_raw(raw) {
	const font = raw.font || "";
	const flags = raw.flags || 0;
	const color = raw.color || 0;
	const size = raw.size || 0.0;
	const is_icon_font = ICON_FONT.test(font);
	const chars = [];
	const icons = [];
	for (const ch of raw.chars || []) {
		const c = ch.c;
		const [x0, y0, x1, y1] = ch.bbox;
		if ((c === "\ufffd" || c === "\u0000") && !options.compat) {
			// Glifo sem caractere (PDFs do PDFium): vem como "\ufffd" ou, com a opção de CID,
			// como U+0000. Colorido é o ✓/✗ do Moodle; cinza é enfeite e não entra no texto.
			if (saturated(color)) icons.push(new Icon(0, x0, y0, x1, y1, color));
			continue;
		}
		if (PUA.test(c) || (is_icon_font && strip(c))) {
			icons.push(new Icon(0, x0, y0, x1, y1, color));
			continue;
		}
		if (is_icon_font || CONTROL.test(c)) continue;
		chars.push([c, x0, x1]);
	}
	if (!chars.length) return [null, icons];
	const bold = Boolean(flags & 16) || /bold|black|heavy|semibold/i.test(font);
	const italic = Boolean(flags & 2) || /italic|oblique/i.test(font);
	const span = new Span(chars.map((c) => c[0]).join(""), bold, italic, size, color, chars[0][1], chars[chars.length - 1][2], (raw.origin || [0, 0])[1], chars);
	return [span, icons];
}

function _split_line_on_gaps(page_no, bbox, spans) {
	const groups = [[]];
	let prev_x1 = null;
	for (const s of spans) {
		if (prev_x1 !== null && s.x0 - prev_x1 > Math.max(2.5 * s.size, 14)) groups.push([]);
		groups[groups.length - 1].push(s);
		prev_x1 = s.x1;
	}
	const lines = [];
	for (const g of groups) {
		if (!g.length || !strip(g.map((s) => s.text).join(""))) continue;
		lines.push(new Line(page_no, Math.min(...g.map((s) => s.x0)), bbox[1], Math.max(...g.map((s) => s.x1)), bbox[3], g));
	}
	return lines;
}

function _extract_lines(page, page_no, pageRect) {
	const lines = [];
	const icons = [];
	for (const ln of rawdictLines(page, pageRect)) {
		const spans = [];
		for (const rs of ln.spans) {
			const [span, ics] = _span_from_raw(rs);
			for (const ic of ics) ic.page = page_no;
			icons.push(...ics);
			if (span !== null) spans.push(span);
		}
		if (!spans.length) continue;
		lines.push(..._split_line_on_gaps(page_no, ln.bbox, spans));
	}
	return [lines, icons];
}

function _merge_script_fragments(lines) {
	if (lines.length < 2) return lines;
	const keep = [];
	for (const frag of lines) {
		const txt = strip(frag.text);
		if (!txt || txt.length > 4) {
			keep.push(frag);
			continue;
		}
		let host = null;
		let best = 0.0;
		for (const cand of lines) {
			if (cand === frag || strip(cand.text).length <= 4) continue;
			const ratio = frag.size / Math.max(cand.size, 0.1);
			if (!(0.5 <= ratio && ratio <= 0.85)) continue;
			if (!(cand.x0 - 1 <= frag.x0 && frag.x0 <= cand.x1 + 1.5)) continue;
			const overlap = Math.min(frag.y1, cand.y1) - Math.max(frag.y0, cand.y0);
			const h = Math.max(frag.y1 - frag.y0, 0.1);
			if (overlap / h > best && overlap / h >= 0.3) {
				host = cand;
				best = overlap / h;
			}
		}
		if (host === null) {
			keep.push(frag);
			continue;
		}
		let biggest = host.spans[0];
		for (const s of host.spans) if (s.text.length > biggest.text.length) biggest = s;
		const base = biggest.origin_y;
		const fy = frag.spans[0].origin_y;
		const is_sub = fy > base + 0.5;
		for (const fs of frag.spans) {
			fs.sub = is_sub;
			fs.sup = !is_sub;
		}
		_insert_spans(host, frag.spans);
	}
	return keep;
}

function _insert_spans(host, new_spans) {
	const x = new_spans[0].x0;
	const out = [];
	let inserted = false;
	for (const s of host.spans) {
		if (inserted || x >= s.x1 - 0.5) {
			out.push(s);
			continue;
		}
		if (x <= s.x0 + 0.5) {
			out.push(...new_spans);
			out.push(s);
			inserted = true;
			continue;
		}
		let cut = s.chars.findIndex(([, cx0]) => cx0 >= x - 0.5);
		if (cut < 0) cut = s.chars.length;
		const left = s.chars.slice(0, cut), right = s.chars.slice(cut);
		if (left.length) out.push(_span_with_chars(s, left));
		out.push(...new_spans);
		if (right.length) out.push(_span_with_chars(s, right));
		inserted = true;
	}
	if (!inserted) out.push(...new_spans);
	host.spans = out;
	host.x1 = Math.max(host.x1, Math.max(...new_spans.map((s) => s.x1)));
}

function _span_with_chars(s, chars) {
	return new Span(chars.map((c) => c[0]).join(""), s.bold, s.italic, s.size, s.color, chars[0][1], chars[chars.length - 1][2], s.origin_y, [...chars], s.sub, s.sup);
}

// Alguns navegadores separam "Questão" e o número em linhas diferentes: junta de volta.
const LONE_QWORD_RE = /^(?:Questão|Questao|Question|Pergunta)$/iu;
function _merge_split_headers(lines, page_no) {
	const removed = new Set();
	let changed = false;
	const out = lines.map((ln) => {
		if (removed.has(ln) || !LONE_QWORD_RE.test(strip(ln.text))) return ln;
		const num = lines.find((o) => o !== ln && !removed.has(o) && /^\p{Nd}+$/u.test(strip(o.text)) &&
			o.x0 >= ln.x1 - 3 && o.x0 <= ln.x1 + 15 &&
			Math.min(o.y1, ln.y1) - Math.max(o.y0, ln.y0) > 0.3 * Math.min(o.y1 - o.y0, ln.y1 - ln.y0));
		if (!num) return ln;
		removed.add(num);
		changed = true;
		const spans = [...ln.spans];
		if (!/\s$/u.test(ln.text)) {
			const s = spans[spans.length - 1];
			spans.push(new Span(" ", s.bold, s.italic, s.size, s.color, s.x1, s.x1, s.origin_y, [[" ", s.x1, s.x1]]));
		}
		return new Line(page_no, ln.x0, Math.min(ln.y0, num.y0), Math.max(ln.x1, num.x1), Math.max(ln.y1, num.y1), [...spans, ...num.spans]);
	});
	return changed ? out.filter((ln) => !removed.has(ln)) : lines;
}

// "Questão N", "Correto", "Atingiu…" no topo da página não são cabeçalho do navegador,
// mesmo repetidos em todas as páginas.
const QUIZ_LINE_RE = /^(?:(?:Questão|Questao|Question|Pergunta)\s+\p{Nd}+|Correto|Incorreto|Parcialmente correto|Correct|Incorrect|Partially correct|Não respondid[ao]|Atingiu\s.+|Vale\s.+|Mark\s.+)\.?$/iu;

const _BOILER = new RegExp(`^(https?://\\S+|www\\.\\S+|${D}{1,2}/${D}{1,2}/${D}{2,4},?\\s+${D}{1,2}:${D}{2}(\\s*[AP]M)?|${D}+\\s*/\\s*${D}+|(p[áa]gina|page)\\s+${D}+(\\s+(de|of)\\s+${D}+)?)$`, "iu");
const DIGITS = new RegExp(`${D}+`, "gu");

function _strip_running_heads(pages) {
	const n = pages.length;
	const band = (p, ln) => (ln.y1 < p.height * 0.06 || ln.y0 > p.height * 0.94) && (options.compat || !QUIZ_LINE_RE.test(strip(ln.text)));
	const counts = new Map();
	for (const p of pages) {
		const seen = new Set();
		for (const ln of p.lines) {
			if (!band(p, ln)) continue;
			const k = strip(ln.text).replace(DIGITS, "#");
			if (!seen.has(k)) {
				counts.set(k, (counts.get(k) || 0) + 1);
				seen.add(k);
			}
		}
	}
	const threshold = Math.max(2, Math.trunc(n * 0.5 + 0.5));
	let header_title = "";
	for (const p of pages) {
		const kept = [];
		for (const ln of p.lines) {
			const t = strip(ln.text);
			if (band(p, ln)) {
				const k = t.replace(DIGITS, "#");
				const repeated = n >= 2 && (counts.get(k) || 0) >= threshold;
				if (repeated || _BOILER.test(t)) {
					if (repeated && !_BOILER.test(t) && t.length > header_title.length) header_title = t;
					continue;
				}
			}
			kept.push(ln);
		}
		p.lines = kept;
	}
	return header_title;
}

// ---------------------------------------------------------------------------
// Desenhos (o "radio" marcado) e imagens, por um dispositivo de captura

function toRGB(colorspace, color) {
	if (!color) return null;
	const n = color.length;
	if (n === 1) return [color[0], color[0], color[0]];
	if (n === 3) return color;
	if (n === 4) {
		const [c, m, y, k] = color;
		return [(1 - c) * (1 - k), (1 - m) * (1 - k), (1 - y) * (1 - k)];
	}
	return null;
}

function rectFromCtm(ctm) {
	const [a, b, c, d, e, f] = ctm;
	const xs = [e, a + e, c + e, a + c + e], ys = [f, b + f, d + f, b + d + f];
	return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

function scanPage(page) {
	const drawings = [];
	const placements = [];
	const dev = new mupdf.Device({
		fillPath(path, evenOdd, ctm, colorspace, color) {
			drawings.push({ rect: path.getBounds(null, ctm), fill: toRGB(colorspace, color) });
		},
		strokePath(path, stroke, ctm) {
			drawings.push({ rect: path.getBounds(null, ctm), fill: null });
		},
		fillImage(image, ctm) {
			placements.push({ image, bbox: rectFromCtm(ctm) });
		},
	});
	try {
		page.run(dev, mupdf.Matrix.identity);
	} finally {
		try { dev.close(); } catch { /* ok */ }
	}
	return { drawings, placements };
}

function _extract_marks(drawings, page_no) {
	const small = [];
	for (const d of drawings) {
		const r = d.rect;
		if (!r) continue;
		const w = r[2] - r[0], h = r[3] - r[1];
		if (w > 16 || h > 16 || w < 1.5) continue;
		small.push(d);
	}
	const clusters = [];
	for (const d of small) {
		const c = [(d.rect[0] + d.rect[2]) / 2, (d.rect[1] + d.rect[3]) / 2];
		let placed = false;
		for (const cl of clusters) {
			const r0 = cl[0].rect;
			const c0 = [(r0[0] + r0[2]) / 2, (r0[1] + r0[3]) / 2];
			if (Math.abs(c[0] - c0[0]) < 2.5 && Math.abs(c[1] - c0[1]) < 2.5) {
				cl.push(d);
				placed = true;
				break;
			}
		}
		if (!placed) clusters.push([d]);
	}
	const marks = [];
	for (const cl of clusters) {
		if (cl.length < 2) continue;
		const wmax = Math.max(...cl.map((d) => d.rect[2] - d.rect[0]));
		for (const d of cl) {
			const fill = d.fill;
			if (fill === null || d.rect[2] - d.rect[0] > 0.75 * wmax) continue;
			if ((fill[0] + fill[1] + fill[2]) / 3 < 0.85) {
				const r = d.rect;
				marks.push(new Mark(page_no, (r[0] + r[2]) / 2, (r[1] + r[3]) / 2));
				break;
			}
		}
	}
	return marks;
}

// Imagens (XObject) alcançáveis a partir dos recursos da página, com o xref.
function pageImageObjects(page) {
	const found = [];
	const visited = new Set();
	function walk(resources) {
		if (!resources || resources.isNull()) return;
		const xobjs = resources.get("XObject");
		if (!xobjs || xobjs.isNull() || !xobjs.isDictionary()) return;
		xobjs.forEach((val) => {
			const xref = val.isIndirect() ? val.asIndirect() : 0;
			if (xref && visited.has(xref)) return;
			if (xref) visited.add(xref);
			const subtype = val.get("Subtype");
			const st = subtype && !subtype.isNull() ? subtype.asName() : "";
			if (st === "Image") found.push({ xref, obj: val });
			else if (st === "Form") walk(val.get("Resources"));
		});
	}
	try {
		walk(page.getObject().getInheritable("Resources"));
	} catch { /* sem recursos */ }
	return found;
}

function imageInfo(doc, obj, xref) {
	const filter = obj.get("Filter");
	let filters = [];
	if (filter && !filter.isNull()) {
		if (filter.isArray()) for (let i = 0; i < filter.length; i++) filters.push(filter.get(i).asName());
		else filters.push(filter.asName());
	}
	const smask = obj.get("SMask");
	return {
		xref,
		obj,
		dct: filters.length === 1 && filters[0] === "DCTDecode",
		jpx: filters.includes("JPXDecode"),
		smask: smask && !smask.isNull() ? smask : null,
	};
}

function _extract_page_images(doc, page, page_no, placements, pageRect) {
	const out = [];
	let objs = null;
	const byPointer = new Map();
	for (const pl of placements) {
		const [bx0, by0, bx1, by1] = pl.bbox;
		const vis = [Math.max(bx0, pageRect[0]), Math.max(by0, pageRect[1]), Math.min(bx1, pageRect[2]), Math.min(by1, pageRect[3])];
		const vw = vis[2] - vis[0], vh = vis[3] - vis[1];
		if (vw <= 0 || vh <= 0 || (vw < 24 && vh < 24)) continue;
		// faixas finas (a coluna de bolinhas das alternativas, linhas) também não são figuras
		if (!options.compat && (vw < 24 || vh < 24)) continue;
		if (objs === null) {
			objs = pageImageObjects(page);
			for (const o of objs) {
				try {
					const img = doc.loadImage(o.obj);
					byPointer.set(img.pointer, imageInfo(doc, o.obj, o.xref));
				} catch { /* imagem ilegível */ }
			}
		}
		const info = byPointer.get(pl.image.pointer) || null;
		if (!options.compat && isDecoration(pl.image, info, vis, pageRect)) continue;
		out.push(new PageImage(page_no, vis[0], vis[1], vis[2], vis[3], info ? info.xref : 0, pl.image, info));
	}
	out.sort((a, b) => cmpTuple([a.y0, a.x0], [b.y0, b.x0]));
	return out;
}

// Fundos, molduras e sombras que alguns navegadores (PDFium) gravam como imagem:
// largas, quase sem dados comprimidos e praticamente brancas. Não são figuras.
function isDecoration(image, info, vis, pageRect) {
	try {
		if (vis[2] - vis[0] < 0.6 * (pageRect[2] - pageRect[0])) return false;
		if (!info || info.dct || info.jpx) return false;
		const w = image.getWidth(), h = image.getHeight();
		if (w * h < 40000) return false;
		if (info.obj.readRawStream().getLength() / (w * h) > 0.05) return false;
		const base = image.toPixmap();
		const mask = image.getMask() ? image.getMask().toPixmap() : null;
		const n = base.getNumberOfComponents(), bs = n + base.getAlpha();
		if (n !== 1 && n !== 3) return false;
		const bw = base.getWidth(), bh = base.getHeight();
		const mw = mask ? mask.getWidth() : 0, mh = mask ? mask.getHeight() : 0;
		const ms = mask ? mask.getNumberOfComponents() + mask.getAlpha() : 0;
		const px = base.getPixels();
		const mp = mask ? mask.getPixels() : null;
		const step = Math.max(1, Math.floor(Math.sqrt((bw * bh) / 40000)));
		let ink = 0, total = 0;
		for (let y = 0; y < bh; y += step) {
			for (let x = 0; x < bw; x += step) {
				const i = (y * bw + x) * bs;
				let v = n === 1 ? px[i] : Math.min(px[i], px[i + 1], px[i + 2]);
				if (mp) {
					const a = mp[(Math.floor((y * mh) / bh) * mw + Math.floor((x * mw) / bw)) * ms] / 255;
					v = v * a + 255 * (1 - a);
				}
				if (v < 200) ink++;
				total++;
			}
		}
		return total > 0 && ink / total < 0.02;
	} catch {
		return false;
	}
}

// Um JPEG completo termina com o marcador EOI (FF D9).
function jpegComplete(data) {
	let j = data.length;
	while (j > 2 && (data[j - 1] === 0x00 || data[j - 1] === 0x0a || data[j - 1] === 0x0d || data[j - 1] === 0x20)) j--;
	return j >= 2 && data[j - 2] === 0xff && data[j - 1] === 0xd9;
}

function _validated(data, ext) {
	try {
		const im = new mupdf.Image(data);
		if (ext !== "jpeg" || jpegComplete(data)) return [data, ext, false, im.getWidth(), im.getHeight()];
		// Figura que não terminou de carregar: regrava como JPEG e avisa.
		let pix = im.toPixmap();
		const cs = pix.getColorSpace();
		if (!cs || !(cs.isRGB() || cs.isGray()) || pix.getAlpha()) pix = pix.convertToColorSpace(mupdf.ColorSpace.DeviceRGB, false);
		return [pix.asJPEG(92, false), "jpeg", true, pix.getWidth(), pix.getHeight()];
	} catch {
		return null;
	}
}

function _display_size(w_pt, h_pt, iw, ih) {
	if (iw <= 0 || ih <= 0) return [w_pt, h_pt];
	return [w_pt, (w_pt * ih) / iw];
}

function pixmapWithMask(base, mask) {
	const w = base.getWidth(), h = base.getHeight();
	if (mask.getWidth() !== w || mask.getHeight() !== h) throw new Error("máscara de tamanho diferente");
	const out = new mupdf.Pixmap(base.getColorSpace(), [0, 0, w, h], true);
	const src = base.getPixels(), a = mask.getPixels(), dst = out.getPixels();
	const n = base.getNumberOfComponents();
	const sn = base.getNumberOfComponents() + base.getAlpha(), mn = mask.getNumberOfComponents() + mask.getAlpha();
	for (let i = 0, p = 0; p < w * h; p++) {
		for (let k = 0; k < n; k++) dst[i++] = src[p * sn + k];
		dst[i++] = a[p * mn];
	}
	return out;
}

export function load_image(content, pim) {
	const doc = content.doc;
	const width_pt = pim.x1 - pim.x0, height_pt = pim.y1 - pim.y0;
	try {
		if (pim.xref && pim.info) {
			try {
				const info = pim.info;
				const img = pim.image;
				const cs = img.getColorSpace();
				const ncomp = cs ? cs.getNumberOfComponents() : 3;
				if (!info.jpx && !info.smask && (ncomp === 1 || ncomp === 3)) {
					const ext = info.dct ? "jpeg" : "png";
					// asUint8Array() é só uma janela na memória do WebAssembly: copia antes que ela seja reaproveitada
					let raw = info.dct ? info.obj.readRawStream().asUint8Array().slice() : pngFromImage(img);
					let rawExt = ext;
					if (!options.compat && !info.dct && raw.length > 300000) {
						// Foto guardada sem compressão de foto (PDFium): em JPEG o caderno fica bem menor.
						const jpg = jpegFromImage(img);
						if (jpg && jpg.length < raw.length * 0.6) {
							raw = jpg;
							rawExt = "jpeg";
						}
					}
					const checked = _validated(raw, rawExt);
					if (checked !== null) {
						const [data, fmt, truncated, iw, ih] = checked;
						const [pw, ph] = _display_size(width_pt, height_pt, iw, ih);
						return new Image(data, fmt, iw, ih, pw, ph, `x${pim.xref}`, truncated);
					}
				}
				let pix = img.toPixmap();
				if (info.smask) {
					const mask = img.getMask();
					if (mask) pix = pixmapWithMask(pix, mask.toPixmap());
				}
				const pcs = pix.getColorSpace();
				if (pcs && !(pcs.isRGB() || pcs.isGray())) pix = pix.convertToColorSpace(mupdf.ColorSpace.DeviceRGB, Boolean(pix.getAlpha()));
				const [pw, ph] = _display_size(width_pt, height_pt, pix.getWidth(), pix.getHeight());
				return new Image(pix.asPNG(), "png", pix.getWidth(), pix.getHeight(), pw, ph, `x${pim.xref}`);
			} catch {
				// cai para a renderização do recorte
			}
		}
		const page = doc.loadPage(pim.page);
		const zoom = 200 / 72;
		const ir = [Math.floor(pim.x0 * zoom + 0.001), Math.floor(pim.y0 * zoom + 0.001), Math.ceil(pim.x1 * zoom - 0.001), Math.ceil(pim.y1 * zoom - 0.001)];
		const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, ir, false);
		pix.clear(255);
		const dev = new mupdf.DrawDevice(mupdf.Matrix.identity, pix);
		page.run(dev, mupdf.Matrix.scale(zoom, zoom));
		dev.close();
		return new Image(pix.asPNG(), "png", pix.getWidth(), pix.getHeight(), width_pt, height_pt, `r${pim.page}-${pim.y0.toFixed(0)}-${pim.x0.toFixed(0)}`);
	} catch {
		return null;
	}
}

function jpegFromImage(img) {
	try {
		let pix = img.toPixmap();
		const cs = pix.getColorSpace();
		if (!cs || !(cs.isRGB() || cs.isGray()) || pix.getAlpha()) pix = pix.convertToColorSpace(mupdf.ColorSpace.DeviceRGB, false);
		return pix.asJPEG(90, false);
	} catch {
		return null;
	}
}

function pngFromImage(img) {
	let pix = img.toPixmap();
	if (pix.getAlpha()) pix = pix.convertToColorSpace(pix.getColorSpace() || mupdf.ColorSpace.DeviceRGB, false);
	return pix.asPNG();
}

// ---------------------------------------------------------------------------

// Cede a vez ao navegador entre páginas, para a barra de progresso andar.
const yieldUI = () => new Promise((r) => setTimeout(r, 0));

export async function read_pdf(data, path, onPage = null) {
	const doc = open_pdf(data);
	const pages = [];
	const count = doc.countPages();
	for (let i = 0; i < count; i++) {
		if (onPage) onPage(i + 1, count);
		await yieldUI();
		const page = doc.loadPage(i);
		const b = page.getBounds();
		const pageRect = [b[0], b[1], b[2], b[3]];
		const pc = new PageContent(i, b[2] - b[0], b[3] - b[1]);
		const [lines, icons] = _extract_lines(page, i, pageRect);
		pc.lines = _merge_script_fragments(lines);
		if (!options.compat) pc.lines = _merge_split_headers(pc.lines, i);
		pc.icons = icons;
		let scan = { drawings: [], placements: [] };
		try {
			scan = scanPage(page);
		} catch { /* página sem conteúdo desenhável */ }
		try {
			pc.images = _extract_page_images(doc, page, i, scan.placements, pageRect);
		} catch {
			pc.images = [];
		}
		pc.marks = _extract_marks(scan.drawings, i);
		if (!options.compat) pc.fonts = pageFontXrefs(page);
		pages.push(pc);
	}
	let title = "";
	try {
		title = doc.getMetaData("info:Title") || "";
	} catch { /* sem metadados */ }
	const groups = options.compat ? [pages] : split_documents(pages);
	if (groups.length === 1) {
		const header_title = _strip_running_heads(pages);
		for (const p of pages) p.lines = sort_reading_order(p.lines);
		return new PdfContent(path, title || header_title, pages, doc, header_title);
	}
	// Vários PDFs juntados num só: cada parte vira uma prova, com os próprios cabeçalhos.
	const whole = new PdfContent(path, title, pages, doc, "");
	const [stem] = splitext(basename(path));
	whole.segments = groups.map((seg, k) => {
		const header_title = _strip_running_heads(seg);
		for (const p of seg) p.lines = sort_reading_order(p.lines);
		const part = new PdfContent(`${stem} (parte ${k + 1} de ${groups.length}).pdf`, header_title, seg, doc, header_title);
		part.close = () => {};
		return part;
	});
	return whole;
}

// Fontes de sistema que aparecem em documentos de qualquer origem: não ajudam a separar.
const COMMON_FONT_RE = /^(arial|helvetica|times|courier|symbol|zapfdingbats|liberation|dejavu)/i;

// Fontes usadas pela página (objetos do PDF e nomes "de marca"), inclusive dentro de formulários.
function pageFontXrefs(page) {
	const out = new Set();
	out.names = new Set();
	const seen = new Set();
	const walk = (res) => {
		if (!res || res.isNull()) return;
		const fonts = res.get("Font");
		if (fonts && fonts.isDictionary()) {
			fonts.forEach((f) => {
				if (f.isIndirect()) out.add(f.asIndirect());
				const base = f.get("BaseFont");
				const name = base && !base.isNull() ? base.asName().replace(/^[A-Z]{6}\+/, "") : "";
				if (name && !COMMON_FONT_RE.test(name)) out.names.add(name);
			});
		}
		const xobjs = res.get("XObject");
		if (!xobjs || !xobjs.isDictionary()) return;
		xobjs.forEach((x) => {
			const id = x.isIndirect() ? x.asIndirect() : 0;
			if (id && seen.has(id)) return;
			if (id) seen.add(id);
			const st = x.get("Subtype");
			if (st && !st.isNull() && st.asName() === "Form") walk(x.get("Resources"));
		});
	};
	try {
		walk(page.getObject().getInheritable("Resources"));
	} catch { /* sem recursos */ }
	return out;
}

// Começo de uma "Revisão da tentativa": a tabela "Iniciado / Situação" no alto da página.
const REVIEW_START_RE = /^(Iniciado|Iniciado em|Started on)$/iu;
const QUIZ_HEADER_RE = /^(?:Questão|Questao|Question|Pergunta)\s+\p{Nd}+$/iu;

// Um PDF montado juntando outros (ex.: "PDFs_Mesclados") muda de fontes de uma vez:
// a parte nova não reusa nenhum objeto de fonte da anterior, os anteriores não voltam
// e menos da metade das fontes "de marca" já tinham aparecido. (O PDFium cria objetos
// de fonte novos a cada página, mas com os mesmos nomes; por isso a regra dos nomes.)
// Duas revisões do mesmo navegador juntadas se separam pela tabela do começo.
export function split_documents(pages) {
	const last = new Map();
	pages.forEach((p, i) => { for (const f of p.fonts || []) last.set(f, i); });
	const groups = [];
	let cur = [];
	let curFonts = new Set();
	let curNames = new Set();
	let curHasQuestions = false;
	pages.forEach((p, i) => {
		const fonts = p.fonts || new Set();
		const names = fonts.names || new Set();
		const disjoint = fonts.size > 0 && curFonts.size > 0 && [...fonts].every((f) => !curFonts.has(f));
		const oldGone = [...curFonts].every((f) => last.get(f) < i);
		const known = names.size ? [...names].filter((n) => curNames.has(n)).length / names.size : 1;
		const newFonts = disjoint && oldGone && curNames.size > 0 && known < 0.5;
		const newReview = curHasQuestions && p.lines.some((ln) => ln.y0 < p.height * 0.4 && REVIEW_START_RE.test(strip(ln.text)));
		if (cur.length && (newFonts || newReview)) {
			groups.push(cur);
			cur = [];
			curFonts = new Set();
			curNames = new Set();
			curHasQuestions = false;
		}
		cur.push(p);
		for (const f of fonts) curFonts.add(f);
		for (const n of names) curNames.add(n);
		if (p.lines.some((ln) => QUIZ_HEADER_RE.test(strip(ln.text)))) curHasQuestions = true;
	});
	if (cur.length) groups.push(cur);
	return groups;
}

export function sort_reading_order(lines) {
	lines = [...lines].sort((a, b) => cmpTuple([a.page, a.y0, a.x0], [b.page, b.y0, b.x0]));
	const rows = [];
	for (const ln of lines) {
		const last = rows[rows.length - 1];
		if (last && last[0].page === ln.page && Math.abs(last[0].y0 - ln.y0) <= 2.0) last.push(ln);
		else rows.push([ln]);
	}
	return rows.flatMap((row) => [...row].sort((a, b) => a.x0 - b.x0));
}

export function content_width(lines) {
	const long = lines.filter((ln) => strip(ln.text).length > 40);
	if (!long.length) return 400.0;
	const x0 = Math.min(...long.map((ln) => ln.x0));
	const x1s = long.map((ln) => ln.x1).sort((a, b) => a - b);
	const x1 = x1s[Math.max(0, Math.trunc(x1s.length * 0.95) - 1)];
	return Math.max(200.0, x1 - x0);
}

export function body_size(lines) {
	const sizes = lines.filter((ln) => strip(ln.text).length > 20).map((ln) => ln.size);
	return sizes.length ? median(sizes) : 10.0;
}

export { rstrip };
