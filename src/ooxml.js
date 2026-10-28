// Árvore XML mínima, com a mesma ordem de elementos e a mesma serialização do python-docx/lxml.
import { pyRound } from "./py.js";

// Caracteres proibidos no XML 1.0. Todo texto passa por aqui ao ser escrito,
// então nenhum campo consegue gerar um .docx que o Word recuse.
const XML_INVALID = /[\x00-\x08\x0b\x0c\x0e-\x1f\ud800-\udfff￾￿]/gu;

function escText(s) {
	return String(s).replace(XML_INVALID, "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\r/g, "&#13;");
}
function escAttr(s) {
	return escText(s).replace(/"/g, "&quot;").replace(/\n/g, "&#10;").replace(/\t/g, "&#9;");
}

export class El {
	constructor(tag, attrs = []) {
		this.tag = tag;
		this.attrs = new Map(attrs.map(([k, v]) => [k, String(v)]));
		this.kids = [];
		this.text = null;
		this.parent = null;
	}
	set(k, v) {
		this.attrs.set(k, String(v));
		return this;
	}
	unset(k) {
		this.attrs.delete(k);
		return this;
	}
	append(c) {
		c.parent = this;
		this.kids.push(c);
		return c;
	}
	insert(i, c) {
		c.parent = this;
		this.kids.splice(i, 0, c);
		return c;
	}
	remove(c) {
		const i = this.kids.indexOf(c);
		if (i >= 0) this.kids.splice(i, 1);
		c.parent = null;
	}
	find(tag) {
		return this.kids.find((k) => k.tag === tag) || null;
	}
	findAll(tag) {
		return this.kids.filter((k) => k.tag === tag);
	}
	addnext(c) {
		const p = this.parent;
		p.insert(p.kids.indexOf(this) + 1, c);
	}
	toXML() {
		let s = `<${this.tag}`;
		for (const [k, v] of this.attrs) s += ` ${k}="${escAttr(v)}"`;
		const hasText = this.text !== null && this.text !== "";
		if (!hasText && !this.kids.length) return s + "/>";
		s += ">";
		if (hasText) s += escText(this.text);
		for (const k of this.kids) s += k.toXML();
		return s + `</${this.tag}>`;
	}
}

export class Raw {
	constructor(xml) {
		this.xml = xml;
		this.parent = null;
		this.tag = "#raw";
	}
	toXML() {
		return this.xml;
	}
}

export function el(tag, attrs = []) {
	return new El(tag, attrs);
}

// Ordem dos filhos (esquema WordprocessingML), como o python-docx insere.
const ORDER = {
	"w:pPr": ["w:pStyle", "w:keepNext", "w:keepLines", "w:pageBreakBefore", "w:framePr", "w:widowControl", "w:numPr", "w:suppressLineNumbers", "w:pBdr", "w:shd", "w:tabs", "w:suppressAutoHyphens", "w:kinsoku", "w:wordWrap", "w:overflowPunct", "w:topLinePunct", "w:autoSpaceDE", "w:autoSpaceDN", "w:bidi", "w:adjustRightInd", "w:snapToGrid", "w:spacing", "w:ind", "w:contextualSpacing", "w:mirrorIndents", "w:suppressOverlap", "w:jc", "w:textDirection", "w:textAlignment", "w:textboxTightWrap", "w:outlineLvl", "w:divId", "w:cnfStyle", "w:rPr", "w:sectPr", "w:pPrChange"],
	"w:rPr": ["w:rStyle", "w:rFonts", "w:b", "w:bCs", "w:i", "w:iCs", "w:caps", "w:smallCaps", "w:strike", "w:dstrike", "w:outline", "w:shadow", "w:emboss", "w:imprint", "w:noProof", "w:snapToGrid", "w:vanish", "w:webHidden", "w:color", "w:spacing", "w:w", "w:kern", "w:position", "w:sz", "w:szCs", "w:highlight", "w:u", "w:effect", "w:bdr", "w:shd", "w:fitText", "w:vertAlign", "w:rtl", "w:cs", "w:em", "w:lang", "w:eastAsianLayout", "w:specVanish", "w:oMath"],
	"w:tcPr": ["w:cnfStyle", "w:tcW", "w:gridSpan", "w:hMerge", "w:vMerge", "w:tcBorders", "w:shd", "w:noWrap", "w:tcMar", "w:textDirection", "w:tcFitText", "w:vAlign", "w:hideMark"],
	"w:tblPr": ["w:tblStyle", "w:tblpPr", "w:tblOverlap", "w:bidiVisual", "w:tblStyleRowBandSize", "w:tblStyleColBandSize", "w:tblW", "w:jc", "w:tblCellSpacing", "w:tblInd", "w:tblBorders", "w:shd", "w:tblLayout", "w:tblCellMar", "w:tblLook", "w:tblCaption", "w:tblDescription"],
	"w:trPr": ["w:cnfStyle", "w:divId", "w:gridBefore", "w:gridAfter", "w:wBefore", "w:wAfter", "w:cantSplit", "w:trHeight", "w:tblHeader", "w:tblCellSpacing", "w:jc", "w:hidden"],
};

// Insere (substituindo) um filho na posição correta, como o _put do original.
export function put(parent, child) {
	const order = ORDER[parent.tag];
	for (const old of parent.findAll(child.tag)) parent.remove(old);
	const later = new Set(order.slice(order.indexOf(child.tag) + 1));
	const i = parent.kids.findIndex((k) => later.has(k.tag));
	if (i >= 0) parent.insert(i, child);
	else parent.append(child);
	return child;
}

// Obtém ou cria um filho na posição correta (get_or_add_* do python-docx).
export function getOrAdd(parent, tag) {
	return parent.find(tag) || put(parent, el(tag));
}

// Unidades (mesmas conversões inteiras do python-docx)
export const Pt = (x) => Math.trunc(x * 12700);
export const Cm = (x) => Math.trunc(x * 360000);
export const Inches = (x) => Math.trunc(x * 914400);
export const twips = (emu) => pyRound(emu / 635);
export const halfPoints = (emu) => Math.trunc((emu / 12700) * 2);
