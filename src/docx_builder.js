// Monta o caderno .docx com o visual girlie a partir das provas já interpretadas.
import * as T from "./theme.js";
import { env } from "./env.js";
import { Image, MissingFigure, Paragraph, Run } from "./models.js";
import { one_line, xml_safe } from "./textutils.js";
import { imageInfo } from "./imageinfo.js";
import { Raw, el, put, getOrAdd, Pt, Cm, Inches, twips, halfPoints } from "./ooxml.js";
import { BE, BS, hasKey, pyRound, strip } from "./py.js";

const TEXT_WIDTH_CM = 17.0;
const MAX_IMG_W_CM = 15.5;
const MAX_IMG_H_CM = 11.0;
const QUESTIONS_PER_PART = 9;
const TRUNCATED_FIGURE_TEXT = "Esta figura já está incompleta no PDF original: a imagem não terminou de carregar quando a página foi salva. A parte cinza vem do arquivo de origem.";
const MISSING_FIGURE_TEXT = "Figura referida no enunciado não aparece no PDF original (espaço em branco na revisão da tentativa). Não foi possível incluí-la aqui.";
const ROMAN = ["I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X", "XI", "XII", "XIII", "XIV", "XV", "XVI", "XVII", "XVIII", "XIX", "XX"];

const CENTER = "center", RIGHT = "right", JUSTIFY = "both";
const PROLOG = "<?xml version='1.0' encoding='UTF-8' standalone='yes'?>\n";
const NS_DOC = 'xmlns:wpc="http://schemas.microsoft.com/office/word/2010/wordprocessingCanvas" xmlns:mo="http://schemas.microsoft.com/office/mac/office/2008/main" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" xmlns:mv="urn:schemas-microsoft-com:mac:vml" xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:wp14="http://schemas.microsoft.com/office/word/2010/wordprocessingDrawing" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:w10="urn:schemas-microsoft-com:office:word" xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml" xmlns:wpg="http://schemas.microsoft.com/office/word/2010/wordprocessingGroup" xmlns:wpi="http://schemas.microsoft.com/office/word/2010/wordprocessingInk" xmlns:wne="http://schemas.microsoft.com/office/word/2006/wordml" xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape" mc:Ignorable="w14 wp14"';
const NS_HDR = 'xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" xmlns:mo="http://schemas.microsoft.com/office/mac/office/2008/main" xmlns:mv="urn:schemas-microsoft-com:mac:vml" xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w10="urn:schemas-microsoft-com:office:word" xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml" xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:wne="http://schemas.microsoft.com/office/word/2006/wordml" xmlns:wp14="http://schemas.microsoft.com/office/word/2010/wordprocessingDrawing" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:wpc="http://schemas.microsoft.com/office/word/2010/wordprocessingCanvas" xmlns:wpg="http://schemas.microsoft.com/office/word/2010/wordprocessingGroup" xmlns:wpi="http://schemas.microsoft.com/office/word/2010/wordprocessingInk" xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape" mc:Ignorable="w14 wp14"';
const SECT_PR = '<w:sectPr w:rsidR="00FC693F" w:rsidRPr="0006063C" w:rsidSect="00034616"><w:headerReference w:type="default" r:id="rId9"/><w:footerReference w:type="default" r:id="rId10"/><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1247" w:right="1134" w:bottom="1134" w:left="1134" w:header="567" w:footer="510" w:gutter="0"/><w:cols w:space="720"/><w:docGrid w:linePitch="360"/></w:sectPr>';
const RT = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/";
const BASE_RELS = [
	["rId3", RT + "styles", "styles.xml"],
	["rId4", "http://schemas.microsoft.com/office/2007/relationships/stylesWithEffects", "stylesWithEffects.xml"],
	["rId5", RT + "settings", "settings.xml"],
	["rId6", RT + "webSettings", "webSettings.xml"],
	["rId7", RT + "fontTable", "fontTable.xml"],
	["rId8", RT + "theme", "theme/theme1.xml"],
	["rId1", RT + "customXml", "../customXml/item1.xml"],
	["rId2", RT + "numbering", "numbering.xml"],
	["rId9", RT + "header", "header1.xml"],
	["rId10", RT + "footer", "footer1.xml"],
];

// ---------------------------------------------------------------------------
// Um "python-docx" mínimo

function hashBytes(b) {
	let h = 0x811c9dc5;
	for (let i = 0; i < b.length; i++) h = Math.imul(h ^ b[i], 0x01000193);
	return `${b.length}:${h >>> 0}`;
}
function sameBytes(a, b) {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
	return true;
}

class RunW {
	constructor(r) {
		this.r = r;
	}
	rPr() {
		let rp = this.r.find("w:rPr");
		if (!rp) rp = this.r.insert(0, el("w:rPr"));
		return rp;
	}
	set size(pt) { put(this.rPr(), el("w:sz", [["w:val", halfPoints(Pt(pt))]])); }
	set bold(v) { put(this.rPr(), v ? el("w:b") : el("w:b", [["w:val", "0"]])); }
	set italic(v) { put(this.rPr(), v ? el("w:i") : el("w:i", [["w:val", "0"]])); }
	set color(hex) { put(this.rPr(), el("w:color", [["w:val", hex]])); }
	set subscript(v) { if (v) put(this.rPr(), el("w:vertAlign", [["w:val", "subscript"]])); }
	set superscript(v) { if (v) put(this.rPr(), el("w:vertAlign", [["w:val", "superscript"]])); }
}

function appendRunText(r, text) {
	let buf = "";
	const flush = () => {
		if (!buf) return;
		const t = el("w:t");
		t.text = buf;
		if (strip(buf).length < buf.length) t.set("xml:space", "preserve");
		r.append(t);
		buf = "";
	};
	for (const ch of text) {
		if (ch === "\t") { flush(); r.append(el("w:tab")); }
		else if (ch === "\r" || ch === "\n") { flush(); r.append(el("w:br")); }
		else buf += ch;
	}
	flush();
}

class Para {
	constructor(p, doc) {
		this.p = p;
		this.doc = doc;
	}
	pPr() {
		let pp = this.p.find("w:pPr");
		if (!pp) pp = this.p.insert(0, el("w:pPr"));
		return pp;
	}
	set alignment(v) { put(this.pPr(), el("w:jc", [["w:val", v]])); }
	set style(id) { put(this.pPr(), el("w:pStyle", [["w:val", id]])); }
	spacing(attrs) {
		const sp = getOrAdd(this.pPr(), "w:spacing");
		for (const [k, v] of attrs) sp.set(k, v);
	}
	keepNext() { getOrAdd(this.pPr(), "w:keepNext"); }
	indent(leftEmu, firstEmu) {
		const ind = getOrAdd(this.pPr(), "w:ind");
		ind.set("w:left", twips(leftEmu));
		if (firstEmu < 0) { ind.set("w:hanging", twips(-firstEmu)); ind.unset("w:firstLine"); }
		else { ind.set("w:firstLine", twips(firstEmu)); ind.unset("w:hanging"); }
	}
	add_run(text = "") {
		const r = this.p.append(el("w:r"));
		if (text) appendRunText(r, text);
		return new RunW(r);
	}
	get runs() {
		return this.p.findAll("w:r").map((r) => new RunW(r));
	}
}

class Cell {
	constructor(tc, doc) {
		this.tc = tc;
		this.doc = doc;
	}
	tcPr() {
		return this.tc.find("w:tcPr");
	}
	get paragraphs() {
		return this.tc.findAll("w:p").map((p) => new Para(p, this.doc));
	}
	add_paragraph() {
		return new Para(this.tc.append(el("w:p")), this.doc);
	}
	set width(emu) {
		this.tcPr().find("w:tcW").set("w:w", twips(emu));
	}
	add_table(rows, cols) {
		const t = newTable(rows, cols, this.doc);
		this.tc.append(t.tbl);
		return t;
	}
}

class Table {
	constructor(tbl, doc) {
		this.tbl = tbl;
		this.doc = doc;
	}
	get rows() {
		return this.tbl.findAll("w:tr").map((tr) => ({ tr, cells: tr.findAll("w:tc").map((tc) => new Cell(tc, this.doc)) }));
	}
}

function newTable(rows, cols, doc) {
	const block = Cm(21.0) - 2 * Cm(2.0);
	const colW = twips(Math.floor(block / cols));
	const tbl = el("w:tbl");
	const tblPr = tbl.append(el("w:tblPr"));
	tblPr.append(el("w:tblW", [["w:type", "auto"], ["w:w", "0"]]));
	tblPr.append(el("w:tblLook", [["w:firstColumn", "1"], ["w:firstRow", "1"], ["w:lastColumn", "0"], ["w:lastRow", "0"], ["w:noHBand", "0"], ["w:noVBand", "1"], ["w:val", "04A0"]]));
	const grid = tbl.append(el("w:tblGrid"));
	for (let c = 0; c < cols; c++) grid.append(el("w:gridCol", [["w:w", colW]]));
	for (let r = 0; r < rows; r++) {
		const tr = tbl.append(el("w:tr"));
		for (let c = 0; c < cols; c++) {
			const tc = tr.append(el("w:tc"));
			const tcPr = tc.append(el("w:tcPr"));
			tcPr.append(el("w:tcW", [["w:type", "dxa"], ["w:w", colW]]));
			tc.append(el("w:p"));
		}
	}
	return new Table(tbl, doc);
}

class Doc {
	constructor() {
		this.body = el("w:body");
		this.rels = BASE_RELS.map((r) => [...r]);
		this.media = []; // {partname, rId, data, key}
		this.pictures = 0;
		this.core = {};
	}
	add_paragraph(style = null) {
		const p = new Para(this.body.append(el("w:p")), this);
		if (style) p.style = style;
		return p;
	}
	add_table(rows, cols) {
		const t = newTable(rows, cols, this);
		this.body.append(t.tbl);
		return t;
	}
	add_page_break() {
		const p = this.add_paragraph();
		const r = p.p.append(el("w:r"));
		r.append(el("w:br", [["w:type", "page"]]));
	}
	// run.add_picture(dados, width=...)
	add_picture(run, data, widthEmu) {
		const info = imageInfo(data);
		if (!info) throw new Error("imagem não reconhecida");
		const key = hashBytes(data);
		let part = this.media.find((m) => m.key === key && sameBytes(m.data, data));
		if (!part) {
			const n = this.media.length + 1;
			part = { key, data, partname: `media/image${n}.${info.ext}`, rId: `rId${this.rels.length + 1}` };
			this.media.push(part);
			this.rels.push([part.rId, RT + "image", part.partname]);
		}
		const nativeW = Inches(info.width / info.hdpi);
		const nativeH = Inches(info.height / info.vdpi);
		const cx = widthEmu;
		const cy = Math.trunc(pyRound(nativeH * (cx / nativeW)));
		const id = ++this.pictures;
		const name = `image.${info.ext}`;
		run.r.append(new Raw(
			`<w:drawing><wp:inline xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><wp:extent cx="${cx}" cy="${cy}"/><wp:docPr id="${id}" name="Picture ${id}"/><wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="0" name="${name}"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="${part.rId}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"/></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing>`,
		));
	}
}

// ---------------------------------------------------------------------------
// Funções auxiliares (mesmos nomes do original)

function _shade_cell(cell, fill) {
	put(cell.tcPr(), el("w:shd", [["w:val", "clear"], ["w:color", "auto"], ["w:fill", fill]]));
}

function _cell_borders(cell, sides) {
	const tcb = el("w:tcBorders");
	for (const side of ["top", "left", "bottom", "right"]) {
		const spec = sides[side];
		if (spec === undefined) tcb.append(el(`w:${side}`, [["w:val", "nil"]]));
		else tcb.append(el(`w:${side}`, [["w:val", "single"], ["w:sz", spec[0]], ["w:space", 0], ["w:color", spec[1]]]));
	}
	put(cell.tcPr(), tcb);
}

function _cell_margins(cell, top = 80, left = 140, bottom = 80, right = 140) {
	const mar = el("w:tcMar");
	for (const [side, v] of [["top", top], ["left", left], ["bottom", bottom], ["right", right]]) mar.append(el(`w:${side}`, [["w:w", v], ["w:type", "dxa"]]));
	put(cell.tcPr(), mar);
}

function _cell_valign(cell, val = "center") {
	put(cell.tcPr(), el("w:vAlign", [["w:val", val]]));
}

function _table_borders(table, color, sz = 4) {
	const tblPr = table.tbl.find("w:tblPr");
	const b = el("w:tblBorders");
	for (const side of ["top", "left", "bottom", "right", "insideH", "insideV"]) {
		if (color === null) b.append(el(`w:${side}`, [["w:val", "nil"]]));
		else b.append(el(`w:${side}`, [["w:val", "single"], ["w:sz", sz], ["w:space", 0], ["w:color", color]]));
	}
	put(tblPr, b);
}

function _table_setup(table, widths_cm, borders = T.BORDER) {
	const tblPr = table.tbl.find("w:tblPr");
	put(tblPr, el("w:jc", [["w:val", "center"]]));
	put(tblPr, el("w:tblLayout", [["w:type", "fixed"]]));
	const total = widths_cm.reduce((a, b) => a + b, 0);
	put(tblPr, el("w:tblW", [["w:w", Math.trunc(total * 567)], ["w:type", "dxa"]]));
	put(tblPr, el("w:tblLayout", [["w:type", "fixed"]]));
	_table_borders(table, borders);
	const gridCols = table.tbl.find("w:tblGrid").findAll("w:gridCol");
	const rows = table.rows;
	widths_cm.forEach((w, i) => {
		gridCols[i].set("w:w", twips(Cm(w)));
		for (const row of rows) row.cells[i].width = Cm(w);
	});
}

function _row_props(row, header = false, cant_split = true) {
	let trPr = row.tr.find("w:trPr");
	if (!trPr) trPr = row.tr.insert(0, el("w:trPr"));
	if (cant_split) put(trPr, el("w:cantSplit"));
	if (header) put(trPr, el("w:tblHeader"));
}

function _para_border_bottom(p, color, sz = 8, space = 4) {
	const pbdr = el("w:pBdr");
	pbdr.append(el("w:bottom", [["w:val", "single"], ["w:sz", sz], ["w:space", space], ["w:color", color]]));
	put(p.pPr(), pbdr);
}

function _keep_next(p) {
	p.keepNext();
}

function _spacing(p, before = 0, after = 0, line = null) {
	p.spacing([["w:before", twips(Pt(before))], ["w:after", twips(Pt(after))]]);
	if (line) p.spacing([["w:line", Math.trunc(line * 240)], ["w:lineRule", "auto"]]);
}

function _style_run(run, { size = null, bold = null, italic = null, color = null } = {}) {
	if (size !== null) run.size = size;
	if (bold !== null) run.bold = bold;
	if (italic !== null) run.italic = italic;
	if (color !== null) run.color = color;
	return run;
}

function _add_text(p, text, fmt = {}) {
	return _style_run(p.add_run(xml_safe(text)), fmt);
}

class _Bookmarks {
	constructor() {
		this.next_id = 1;
	}
	wrap(p, name) {
		const start = el("w:bookmarkStart", [["w:id", this.next_id], ["w:name", name]]);
		const end = el("w:bookmarkEnd", [["w:id", this.next_id]]);
		this.next_id += 1;
		const ppr = p.p.find("w:pPr");
		if (ppr) ppr.addnext(start);
		else p.p.insert(0, start);
		p.p.append(end);
	}
}

function _add_link(p, text, anchor, { color = T.TEXT, bold = false, size = null } = {}) {
	const h = el("w:hyperlink", [["w:anchor", anchor], ["w:history", 1]]);
	const r = el("w:r");
	const rpr = el("w:rPr");
	if (bold) put(rpr, el("w:b"));
	put(rpr, el("w:color", [["w:val", color]]));
	if (size) {
		put(rpr, el("w:sz", [["w:val", Math.trunc(size * 2)]]));
		put(rpr, el("w:szCs", [["w:val", Math.trunc(size * 2)]]));
	}
	r.append(rpr);
	const t = el("w:t");
	t.text = xml_safe(text);
	t.set("xml:space", "preserve");
	r.append(t);
	h.append(r);
	p.p.append(h);
}

function _add_field(p, instr, fmt) {
	const run_with = (child) => {
		const r = p.add_run();
		_style_run(r, fmt);
		r.r.append(child);
		return r;
	};
	run_with(el("w:fldChar", [["w:fldCharType", "begin"]]));
	const instr_el = el("w:instrText");
	instr_el.set("xml:space", "preserve");
	instr_el.text = ` ${instr} `;
	run_with(instr_el);
	run_with(el("w:fldChar", [["w:fldCharType", "separate"]]));
	_add_text(p, "1", fmt);
	run_with(el("w:fldChar", [["w:fldCharType", "end"]]));
}

function _status_color(status) {
	const k = strip(status).toLowerCase();
	return hasKey(T.STATUS_COLORS, k) ? T.STATUS_COLORS[k] : T.MUTED;
}

function _status_symbol(status) {
	const s = strip(status).toLowerCase();
	if (s.startsWith("correto") || s.startsWith("correct")) return "✓ ";
	if (s.startsWith("incorreto") || s.startsWith("incorrect")) return "✗ ";
	if (s.startsWith("parcial") || s.startsWith("partial")) return "◐ ";
	return "";
}

const _CITATION = new RegExp(`\\(\\s*[A-ZÀ-Ý][\\p{L}\\p{N}_À-ÿ.]+(?:\\s+(?:et al\\.?|e\\s+[A-ZÀ-Ý][\\p{L}\\p{N}_À-ÿ]+))?,?\\s*\\p{Nd}{4}\\s*\\)|${BS}[A-ZÀ-Ý][a-zà-ÿ]+\\s*\\(\\p{Nd}{4}\\)`, "u");
const _WRONG = new RegExp(`${BS}(ERRAD[AO]S?|INCORRET[AO]S?|FALS[AO]S?)${BE}|${BS}(errad[ao]s?|incorret[ao]s?)${BE}`, "u");
const _OUTCOME = /Sua resposta está (correta|incorreta|parcialmente correta)\.?/giu;

export function classify_feedback(text) {
	const rest = strip(text.replace(_OUTCOME, ""));
	if (!rest) return /incorreta/iu.test(text) ? "atencao" : "nota";
	if (_WRONG.test(rest)) return "atencao";
	if (_CITATION.test(rest)) return "definicao";
	return "nota";
}

export function split_parts(questions, per_part = QUESTIONS_PER_PART) {
	const n = questions.length;
	if (n === 0) return [];
	let parts = Math.max(1, Math.ceil(n / per_part));
	if (n <= per_part + 1) parts = 1;
	const base = Math.floor(n / parts), extra = n % parts;
	let i = 0;
	const out = [];
	for (let k = 0; k < parts; k++) {
		const size = base + (k < extra ? 1 : 0);
		out.push(questions.slice(i, i + size));
		i += size;
	}
	return out;
}

export function exam_score(exam) {
	const st = exam.questions.map((q) => strip(q.status).toLowerCase());
	return {
		total: st.length,
		correct: st.filter((s) => s.startsWith("correto") || s.startsWith("correct")).length,
		wrong: st.filter((s) => s.startsWith("incorreto") || s.startsWith("incorrect")).length,
		partial: st.filter((s) => s.startsWith("parcial") || s.startsWith("partial")).length,
	};
}

function _info_value(exam, ...labels) {
	for (const [lbl, val] of exam.info) if (labels.includes(lbl.toLowerCase())) return val;
	return "";
}

const sliceChars = (s, n) => Array.from(s).slice(0, n).join("");

// ---------------------------------------------------------------------------

export class DocxBuilder {
	constructor(header_text, cover_title, cover_subtitle, split_in_parts = true, coverPng) {
		this.header_text = one_line(header_text);
		this.cover_title = one_line(cover_title) || "PROVAS";
		this.cover_subtitle = one_line(cover_subtitle);
		this.split_in_parts = split_in_parts;
		this.coverPng = coverPng;
		this.doc = new Doc();
		this.bm = new _Bookmarks();
		this.warnings = [];
	}

	_para(text = "", align = null, before = 0, after = 4, fmt = {}) {
		const p = this.doc.add_paragraph();
		if (align !== null) p.alignment = align;
		_spacing(p, before, after);
		if (text) _add_text(p, text, fmt);
		return p;
	}

	_spacer(pt = 4, container = null) {
		const p = (container || this.doc).add_paragraph();
		_spacing(p, 0, 0);
		p.spacing([["w:line", twips(Pt(pt))], ["w:lineRule", "exact"]]);
		const r = p.add_run("");
		r.size = Math.max(1, pt - 1);
		return p;
	}

	_page_break() {
		this.doc.add_page_break();
	}

	_runs_into(p, runs, size = null, color = null) {
		for (const r of runs) {
			const run = p.add_run(xml_safe(r.text));
			if (r.bold) run.bold = true;
			if (r.italic) run.italic = true;
			if (r.sub) run.subscript = true;
			if (r.sup) run.superscript = true;
			if (size) run.size = size;
			if (color) run.color = color;
		}
	}

	band(title, subtitle = "", color = T.PINK, big = false, bookmark = "") {
		const t = this.doc.add_table(1, 1);
		_table_setup(t, [TEXT_WIDTH_CM], null);
		const cell = t.rows[0].cells[0];
		_shade_cell(cell, color);
		_cell_margins(cell, big ? 150 : 110, 220, big ? 150 : 110, 220);
		_row_props(t.rows[0]);
		const p = cell.paragraphs[0];
		p.style = "Heading1";
		_spacing(p, 0, 1);
		_keep_next(p);
		_add_text(p, title, { size: big ? 22 : 15, bold: true, color: T.WHITE });
		if (bookmark) this.bm.wrap(p, bookmark);
		if (subtitle) {
			const p2 = cell.add_paragraph();
			_spacing(p2, 0, 0);
			_keep_next(p2);
			_add_text(p2, subtitle, { size: big ? 10.5 : 9.5, color: T.WHITE });
		}
		this._spacer(6);
		return t;
	}

	callout(kind, blocks, title_suffix = "", container = null) {
		const [title, symbol, fill, border, title_color] = T.CALLOUTS[kind];
		const t = (container || this.doc).add_table(1, 1);
		_table_setup(t, [TEXT_WIDTH_CM], null);
		const cell = t.rows[0].cells[0];
		_shade_cell(cell, fill);
		_cell_borders(cell, { left: [24, border] });
		_cell_margins(cell, 90, 180, 90, 180);
		const p = cell.paragraphs[0];
		_spacing(p, 0, 2);
		_keep_next(p);
		_add_text(p, `${symbol}  ${title}${title_suffix}`, { size: 9.5, bold: true, color: title_color });
		for (const b of blocks) {
			if (b instanceof Paragraph) {
				const bp = cell.add_paragraph();
				_spacing(bp, 0, 2);
				this._runs_into(bp, b.runs, 10);
			} else if (b instanceof Image) {
				const ip = cell.add_paragraph();
				ip.alignment = CENTER;
				this._picture(ip, b, TEXT_WIDTH_CM - 1.5);
			} else if (typeof b === "string") {
				const bp = cell.add_paragraph();
				_spacing(bp, 0, 2);
				_add_text(bp, b, { size: 10 });
			}
		}
		this._spacer(5, container);
		return t;
	}

	_picture(p, img, max_w_cm = MAX_IMG_W_CM, ref_width = 400.0) {
		let ratio = ref_width ? img.pt_width / ref_width : 1.0;
		ratio = Math.min(Math.max(ratio, 0.3), 1.0);
		let w_cm = MAX_IMG_W_CM * ratio;
		w_cm = Math.min(w_cm, max_w_cm);
		const aspect = img.px_width ? img.px_height / img.px_width : 0.75;
		if (w_cm * aspect > MAX_IMG_H_CM) w_cm = MAX_IMG_H_CM / aspect;
		try {
			this.doc.add_picture(p.add_run(), img.data, Cm(w_cm));
			return;
		} catch {
			// o python-docx não reconheceu: converte para PNG e tenta de novo
			p.p.kids = p.p.kids.filter((k) => k.tag !== "w:r" || k.kids.length);
		}
		try {
			const im = new env.mupdf.Image(img.data);
			let pix = im.toPixmap();
			const cs = pix.getColorSpace();
			if (cs && !(cs.isRGB() || cs.isGray())) pix = pix.convertToColorSpace(env.mupdf.ColorSpace.DeviceRGB, Boolean(pix.getAlpha()));
			this.doc.add_picture(p.add_run(), pix.asPNG(), Cm(w_cm));
		} catch {
			p.p.kids = p.p.kids.filter((k) => k.tag !== "w:r");
			_add_text(p, "[esta figura do arquivo original está corrompida e não pôde ser incluída]", { size: 9, italic: true, color: T.ROSE });
			this.warnings.push("Uma figura corrompida no arquivo original não pôde ser incluída.");
		}
	}

	_table(header, rows, widths, first_bold = true, header_fill = T.PINK) {
		const t = this.doc.add_table(1 + rows.length, header.length);
		_table_setup(t, widths, T.BORDER);
		const trs = t.rows;
		const hdr = trs[0];
		_row_props(hdr, true);
		header.forEach((h, i) => {
			const c = hdr.cells[i];
			_shade_cell(c, header_fill);
			_cell_margins(c, 70, 120, 70, 120);
			_cell_valign(c);
			const p = c.paragraphs[0];
			_spacing(p, 0, 0);
			_add_text(p, h, { size: 9.5, bold: true, color: T.WHITE });
		});
		rows.forEach((row, r_i) => {
			const tr = trs[r_i + 1];
			_row_props(tr);
			const fill = T.ROW_FILLS[r_i % T.ROW_FILLS.length];
			row.forEach((val, c_i) => {
				const c = tr.cells[c_i];
				_shade_cell(c, fill);
				_cell_margins(c, 60, 120, 60, 120);
				_cell_valign(c);
				const p = c.paragraphs[0];
				_spacing(p, 0, 0);
				if (typeof val === "function") {
					val(p);
					return;
				}
				_add_text(p, String(val), { size: 9.5, bold: first_bold && c_i === 0 });
			});
		});
		return t;
	}

	cover(exams) {
		const p = this._para("", CENTER, 0, 10);
		this.doc.add_picture(p.add_run(), this.coverPng, Cm(TEXT_WIDTH_CM));
		this._para(this.cover_title, CENTER, 14, 2, { size: 40, bold: true, color: T.PINK_DARK });
		if (this.cover_subtitle) this._para(this.cover_subtitle, CENTER, 0, 6, { size: 16, bold: true, color: T.LILAC_DARK });
		const nq = exams.reduce((a, e) => a + e.questions.length, 0);
		const bits = [];
		if (exams.length > 1) bits.push(`${exams.length} provas`);
		if (nq) bits.push(`${nq} questões`);
		if (exams.some((e) => e.questions.some((q) => q.images.length)) || exams.some((e) => e.blocks.some((b) => b instanceof Image))) bits.push("figuras originais");
		if (nq) bits.push("gabarito comentado");
		if (bits.length) this._para("♡  " + bits.join("  ·  ") + "  ♡", CENTER, 0, 18, { size: 10.5, color: T.MINT_DARK });
		if (exams.length === 1 && exams[0].info.length) {
			this._table(["Dados da prova", "Informação"], exams[0].info.map(([k, v]) => [k, v]), [5.0, 12.0]);
		} else if (exams.length > 1) {
			const rows = exams.map((e, idx) => {
				const sc = exam_score(e);
				const nota = _info_value(e, "notas") || (sc.total ? `${sc.correct}/${sc.total}` : "—");
				return [String(idx + 1), e.title, e.questions.length ? String(e.questions.length) : "—", nota];
			});
			this._table(["Prova", "Título", "Questões", "Notas"], rows, [1.6, 10.2, 2.2, 3.0]);
		}
		const d = env.today();
		const dd = String(d.getDate()).padStart(2, "0"), mm = String(d.getMonth() + 1).padStart(2, "0");
		this._para(`Gerado em ${dd}/${mm}/${d.getFullYear()}`, CENTER, 14, 4, { size: 8.5, italic: true, color: T.MUTED });
	}

	summary(exams) {
		this._page_break();
		this.band("Sumário", "Ordem das questões e onde estão as figuras", T.PINK);
		const multi = exams.length > 1;
		const header = ["Questão", "Tema", "Figura"];
		const widths = [2.2, 11.3, 3.5];
		const rows = [];
		const group_rows = [];
		exams.forEach((e, idx) => {
			const k = idx + 1;
			const prefix = `p${k}`;
			if (multi) {
				group_rows.push(rows.length);
				rows.push([`Prova ${k} · ${e.title}`, "", ""]);
			}
			if (e.kind === "generic" || !e.questions.length) {
				rows.push(["—", DocxBuilder._link_cell(multi ? "Conteúdo completo" : e.title, `${prefix}_inicio`), e.blocks.some((b) => b instanceof Image) ? "Sim" : "—"]);
				return;
			}
			e.questions.forEach((q, i) => {
				const fig = { yes: "Sim", missing: "Não no PDF", none: "—" }[q.figure];
				rows.push([q.number, DocxBuilder._link_cell(q.topic || "—", `${prefix}_q${i}`), fig]);
			});
			rows.push(["G", DocxBuilder._link_cell("Gabaritos comentados (ao final da prova)", `${prefix}_gab`), "—"]);
		});
		const t = this._table(header, rows, widths);
		const trs = t.rows;
		group_rows.forEach((r_i, gi) => {
			const tr = trs[r_i + 1];
			const cells = tr.cells;
			const first = cells[0];
			const w = cells.reduce((a, c) => a + parseInt(c.tcPr().find("w:tcW").attrs.get("w:w"), 10), 0);
			first.tcPr().find("w:tcW").set("w:w", w);
			put(first.tcPr(), el("w:gridSpan", [["w:val", cells.length]]));
			for (const c of cells.slice(1)) tr.tr.remove(c.tc);
			for (const extra of first.tc.findAll("w:p").slice(1)) first.tc.remove(extra);
			_shade_cell(first, T.BAND_COLORS[gi % T.BAND_COLORS.length]);
			for (const r of first.paragraphs[0].runs) {
				r.color = T.WHITE;
				r.bold = true;
			}
		});
	}

	static _link_cell(text, anchor) {
		return (p) => _add_link(p, text, anchor, { color: T.TEXT, size: 9.5 });
	}

	question(q, anchor, ref_width) {
		const h = this.doc.add_paragraph("Heading2");
		_spacing(h, 12, 2);
		_keep_next(h);
		_add_text(h, "♡  ", { color: T.PINK });
		_add_text(h, `Questão ${q.number}`, { color: T.PINK_DARK });
		_add_text(h, "  ♡", { color: T.PINK });
		_para_border_bottom(h, T.LILAC_LINE, 8, 3);
		this.bm.wrap(h, anchor);
		if (q.status || q.grade) {
			const sp = this._para("", null, 0, 6);
			_keep_next(sp);
			if (q.status) _add_text(sp, q.status, { size: 8.5, italic: true, color: _status_color(q.status) });
			if (q.status && q.grade) _add_text(sp, "  ·  ", { size: 8.5, color: T.MUTED });
			if (q.grade) _add_text(sp, q.grade, { size: 8.5, italic: true, color: T.MUTED });
		}
		this._blocks(q.stem, ref_width, true);
		for (const opt of q.options) {
			let first = true;
			for (const b of opt.blocks.length ? opt.blocks : [new Paragraph([new Run("")])]) {
				if (b instanceof Paragraph) {
					const p = this.doc.add_paragraph();
					p.indent(Cm(0.9), first ? Cm(-0.6) : Cm(0));
					_spacing(p, 0, 3);
					if (first) _add_text(p, `${opt.label}) `, { bold: true, color: T.PINK });
					this._runs_into(p, b.runs);
					first = false;
				} else if (b instanceof Image) {
					const p = this._para("", CENTER, 0, 4);
					this._picture(p, b, TEXT_WIDTH_CM - 1, ref_width);
				}
			}
		}
		this._spacer(4);
	}

	_blocks(blocks, ref_width, justify = false) {
		for (const b of blocks) {
			if (b instanceof Paragraph) {
				if (b.heading) {
					const p = this.doc.add_paragraph("Heading3");
					_spacing(p, 10, 3);
					_keep_next(p);
					_add_text(p, "♡  ", { color: T.PINK });
					this._runs_into(p, b.runs, null, T.LILAC_DARK);
				} else {
					const p = this.doc.add_paragraph();
					if (justify) p.alignment = JUSTIFY;
					_spacing(p, 0, 5);
					this._runs_into(p, b.runs);
				}
			} else if (b instanceof Image) {
				const p = this._para("", CENTER, 2, 6);
				this._picture(p, b, MAX_IMG_W_CM, ref_width);
				if (b.truncated) this.callout("atencao", [TRUNCATED_FIGURE_TEXT]);
			} else if (b instanceof MissingFigure) {
				this.callout("atencao", [MISSING_FIGURE_TEXT]);
			}
		}
	}

	answer_key(exam, prefix, label) {
		this._page_break();
		this.band(`Gabaritos comentados${label}`, "Resposta correta, sua resposta e correções de cada questão", T.GABARITO_BAND, false, `${prefix}_gab`);
		const sc = exam_score(exam);
		if (sc.total) {
			const p = this._para("", CENTER, 0, 8);
			_add_text(p, "♡  Resultado: ", { size: 10, bold: true, color: T.PINK_DARK });
			const parts = [`${sc.correct} corretas`, `${sc.wrong} incorretas`];
			if (sc.partial) parts.push(`${sc.partial} parcialmente corretas`);
			const nota = _info_value(exam, "notas");
			if (nota) parts.push(`notas ${nota}`);
			_add_text(p, parts.join("  ·  "), { size: 10, color: T.TEXT });
		}
		const rows = exam.questions.map((q) => {
			const correct = q.correct_labels.map((l) => `${l})`).join(", ") || "—";
			const mine = q.selected_labels.map((l) => `${l})`).join(", ") || "—";
			const status = q.status || "—";
			const status_cell = (p) => _add_text(p, _status_symbol(status) + status, { size: 9.5, bold: true, color: _status_color(status) });
			return [q.number, correct, mine, status_cell];
		});
		this._table(["Questão", "Correta", "Sua resposta", "Situação"], rows, [2.6, 3.6, 4.0, 6.8]);
		this._spacer(8);
		exam.questions.forEach((q, i) => this._answer_block(q, `${prefix}_g${i}`));
	}

	_answer_block(q, anchor) {
		const h = this.doc.add_paragraph("Heading3");
		_spacing(h, 10, 2);
		_keep_next(h);
		_add_text(h, "♡  ", { color: T.PINK });
		_add_text(h, `Gabarito · Questão ${q.number}`, { color: T.LILAC_DARK });
		_add_text(h, "  ♡", { color: T.PINK });
		_para_border_bottom(h, T.LILAC_LINE, 6, 2);
		this.bm.wrap(h, anchor);
		const line = this._para("", null, 0, 5);
		_keep_next(line);
		const correct = q.correct_labels.map((l) => `${l})`).join(", ") || "—";
		const mine = q.selected_labels.map((l) => `${l})`).join(", ") || "—";
		_add_text(line, "Alternativa correta: ", { size: 9.5, color: T.MUTED });
		_add_text(line, correct, { size: 9.5, bold: true, color: T.MINT_DARK });
		_add_text(line, "   ·   Sua resposta: ", { size: 9.5, color: T.MUTED });
		_add_text(line, mine, { size: 9.5, bold: true, color: T.PINK_DARK });
		if (q.status) {
			_add_text(line, "   ·   ", { size: 9.5, color: T.MUTED });
			_add_text(line, _status_symbol(q.status) + q.status, { size: 9.5, bold: true, color: _status_color(q.status) });
		}
		if (q.right_answer !== null) this.callout("ideia", [q.right_answer]);
		else if (q.correct_labels.length) {
			const texts = q.options.filter((o) => q.correct_labels.includes(o.label)).map((o) => new Paragraph([new Run(`${o.label}) `, true), new Run(o.text)]));
			this.callout("ideia", texts);
		}
		for (const opt of q.options) {
			if (opt.feedback.length) {
				const text = opt.feedback.filter((b) => b instanceof Paragraph).map((b) => b.text).join(" ");
				this.callout(classify_feedback(text), opt.feedback, ` · comentário da alternativa ${opt.label})`);
			}
		}
		if (q.feedback.length) {
			const text = q.feedback.filter((b) => b instanceof Paragraph).map((b) => b.text).join(" ");
			this.callout(classify_feedback(text), q.feedback);
		}
	}

	build(exams, progress = null) {
		const tick = (msg) => progress && progress(msg);
		for (const exam of exams) exam.title = one_line(exam.title) || "Prova";
		tick("Montando a capa…");
		this.cover(exams);
		tick("Montando o sumário…");
		this.summary(exams);
		const multi = exams.length > 1;
		exams.forEach((exam, idx) => {
			const k = idx + 1;
			const prefix = `p${k}`;
			tick(`Escrevendo a prova ${k} de ${exams.length}: ${exam.title}`);
			const color0 = T.BAND_COLORS[(k - 1) % T.BAND_COLORS.length];
			if (multi || exam.kind === "generic") {
				this._page_break();
				const nq = exam.questions.length;
				const sub = exam.title + (nq ? `  ·  ${nq} questões` : "");
				this.band(multi ? `Prova ${k}` : exam.title, multi ? sub : "", color0, true, `${prefix}_inicio`);
				if (multi && exam.info.length) {
					this._table(["Dados da prova", "Informação"], exam.info.map(([a, b]) => [a, b]), [5.0, 12.0]);
					this._spacer(8);
				}
			}
			if (exam.kind === "generic" || !exam.questions.length) {
				this._blocks(exam.blocks, exam.content_width);
				return;
			}
			const groups = this.split_in_parts ? split_parts(exam.questions) : [exam.questions];
			const index = new Map(exam.questions.map((q, i) => [q, i]));
			groups.forEach((group, g_i) => {
				if (g_i > 0 || !multi) this._page_break();
				const first = group[0].number, last = group[group.length - 1].number;
				const rng = first !== last ? `Questões ${first} a ${last}` : `Questão ${first}`;
				const title = groups.length > 1 ? `Parte ${g_i < ROMAN.length ? ROMAN[g_i] : g_i + 1} · ${rng}` : rng;
				const sub = multi ? `Prova ${k} · ${exam.title}` : exam.title;
				this.band(title, sub, T.BAND_COLORS[(g_i + (k - 1)) % T.BAND_COLORS.length]);
				for (const q of group) this.question(q, `${prefix}_q${index.get(q)}`, exam.content_width);
			});
			this.answer_key(exam, prefix, multi ? ` · Prova ${k}` : "");
		});
		this.doc.core = {
			title: sliceChars(xml_safe(this.cover_title + (this.cover_subtitle ? ` — ${this.cover_subtitle}` : "")), 250),
			author: sliceChars(xml_safe(this.header_text || "Provas Girlie"), 250),
			subject: "Caderno de provas com gabarito comentado",
			keywords: "provas; gabarito; estudo",
			comments: "Gerado pelo Provas Girlie",
		};
		return this.doc;
	}
}

// ---------------------------------------------------------------------------
// Empacotamento (.docx)

function esc(s) {
	const t = el("x");
	t.text = String(s);
	return t.toXML().slice(3, -4);
}

function headerXml(header_text) {
	const p = new Para(el("w:p"), null);
	p.style = "Header";
	p.alignment = RIGHT;
	if (header_text) _add_text(p, header_text, { size: 9, bold: true, color: T.PINK_DARK });
	return `${PROLOG}<w:hdr ${NS_HDR}>${p.p.toXML()}</w:hdr>`;
}

function coreXml(c) {
	return `${PROLOG}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${esc(c.title)}</dc:title><dc:subject>${esc(c.subject)}</dc:subject><dc:creator>${esc(c.author)}</dc:creator><cp:keywords>${esc(c.keywords)}</cp:keywords><dc:description>${esc(c.comments)}</dc:description><cp:lastModifiedBy/><cp:revision>1</cp:revision><dcterms:created xsi:type="dcterms:W3CDTF">2013-12-23T23:15:00Z</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">2013-12-23T23:15:00Z</dcterms:modified><cp:category/></cp:coreProperties>`;
}

function contentTypesXml(doc) {
	const exts = new Set(["jpeg", "png", "rels", "xml"]);
	for (const m of doc.media) exts.add(m.partname.split(".").pop());
	const defaults = {
		jpeg: "image/jpeg", jpg: "image/jpeg", png: "image/png",
		rels: "application/vnd.openxmlformats-package.relationships+xml", xml: "application/xml",
	};
	const d = [...exts].sort().map((e) => `<Default Extension="${e}" ContentType="${defaults[e]}"/>`).join("");
	const o = [
		["/customXml/itemProps1.xml", "application/vnd.openxmlformats-officedocument.customXmlProperties+xml"],
		["/docProps/app.xml", "application/vnd.openxmlformats-officedocument.extended-properties+xml"],
		["/docProps/core.xml", "application/vnd.openxmlformats-package.core-properties+xml"],
		["/word/document.xml", "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"],
		["/word/fontTable.xml", "application/vnd.openxmlformats-officedocument.wordprocessingml.fontTable+xml"],
		["/word/footer1.xml", "application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"],
		["/word/header1.xml", "application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"],
		["/word/numbering.xml", "application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"],
		["/word/settings.xml", "application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"],
		["/word/styles.xml", "application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"],
		["/word/stylesWithEffects.xml", "application/vnd.ms-word.stylesWithEffects+xml"],
		["/word/theme/theme1.xml", "application/vnd.openxmlformats-officedocument.theme+xml"],
		["/word/webSettings.xml", "application/vnd.openxmlformats-officedocument.wordprocessingml.webSettings+xml"],
	].map(([p, t]) => `<Override PartName="${p}" ContentType="${t}"/>`).join("");
	return `${PROLOG}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">${d}${o}</Types>`;
}

function relsXml(doc) {
	const rels = doc.rels.map(([id, type, target]) => `<Relationship Id="${id}" Type="${type}" Target="${target}"/>`).join("");
	return `${PROLOG}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels}</Relationships>`;
}

export function documentXml(doc) {
	return `${PROLOG}<w:document ${NS_DOC}><w:body>${doc.body.kids.map((k) => k.toXML()).join("")}${SECT_PR}</w:body></w:document>`;
}

// Gera o .docx (Uint8Array) a partir do template estático.
export async function save_docx(builder, templateZipData) {
	const { JSZip } = env;
	const zip = await JSZip.loadAsync(templateZipData);
	const doc = builder.doc;
	zip.file("[Content_Types].xml", contentTypesXml(doc));
	zip.file("docProps/core.xml", coreXml(doc.core));
	zip.file("word/document.xml", documentXml(doc));
	zip.file("word/header1.xml", headerXml(builder.header_text));
	zip.file("word/_rels/document.xml.rels", relsXml(doc));
	for (const m of doc.media) zip.file(`word/${m.partname}`, m.data);
	return zip.generateAsync({ type: "uint8array", compression: "DEFLATE", compressionOptions: { level: 6 }, mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" });
}
