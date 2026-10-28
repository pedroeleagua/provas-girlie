// Converte linhas e imagens posicionadas em parágrafos e figuras, na ordem do documento.
import { Image, Paragraph, Run } from "./models.js";
import { PageImage, load_image } from "./pdf_extract.js";
import { clean_runs } from "./textutils.js";
import { options } from "./options.js";
import { cmpTuple, rstrip } from "./py.js";

const _ENUM_START = /^\(?([IVX]{1,5}|\p{Nd}{1,2}|[a-z])[.)\-–]\s/u;
const GAP_PT = 60.0;

export function item_key(it) {
	return [it.page, it.y0, it.x0];
}

export function cmpItems(a, b) {
	return cmpTuple(item_key(a), item_key(b));
}

const ENDS_SENTENCE = [".", ":", "?", "!", ";"];
// marcador sozinho na linha ("II." à esquerda e o texto noutra coluna, como no Word)
const _ENUM_ALONE = /^\(?([IVX]{1,5}|\p{Nd}{1,2}|[a-z])[.)\-–]$/u;

function _starts_new_paragraph(prev, cur, first_line = false, right = null) {
	if (cur.page !== prev.page) return ENDS_SENTENCE.some((e) => rstrip(prev.text).endsWith(e));
	const dy = cur.y0 - prev.y0;
	if (Math.abs(dy) <= 2.0) return false;
	if (dy > Math.max(prev.size, cur.size) * 1.75) return options.compat || !_wide_spaced_continuation(prev, cur, dy, right);
	// título grande seguido de texto (ex.: "M2 - Avaliação de Anatomia" e a questão 1)
	if (!options.compat && Math.max(prev.size, cur.size) > 1.3 * Math.min(prev.size, cur.size)) return true;
	if (cur.x0 > prev.x0 + 8) return options.compat || !(first_line && _hanging_continuation(prev, cur));
	const t = cur.text.trim();
	if ((_ENUM_START.test(t) || (!options.compat && _ENUM_ALONE.test(t))) && ENDS_SENTENCE.some((e) => rstrip(prev.text).endsWith(e))) return true;
	return false;
}

// Texto colado com entrelinha grande (1,5–2): a linha cheia que não fecha a frase
// continua na de baixo ("… importantes no" / "recém-nato, observado …").
function _wide_spaced_continuation(prev, cur, dy, right) {
	const size = Math.max(prev.size, cur.size);
	if (right === null || dy > 2.6 * size || Math.abs(cur.x0 - prev.x0) > 2 || prev.x1 < right - 4 * size) return false;
	const p = rstrip(prev.text);
	const t = cur.text.trim();
	if (!p || ENDS_SENTENCE.some((e) => p.endsWith(e)) || _ENUM_START.test(t) || _ENUM_ALONE.test(t)) return false;
	return /^[(["“'«]?\p{Ll}/u.test(t) || /[-,(/=]$/u.test(p);
}

// Recuo deslocado: "I.  Do ponto de vista … relacionadas com" e a linha seguinte
// ("a sensibilidade …") começa mais à direita, alinhada ao texto e não ao marcador.
function _hanging_continuation(prev, cur) {
	if (cur.x0 - prev.x0 > 4.5 * Math.max(prev.size, cur.size)) return false;
	const p = rstrip(prev.text);
	const t = cur.text.trim();
	if (!p || ENDS_SENTENCE.some((e) => p.endsWith(e)) || _ENUM_START.test(t) || _ENUM_ALONE.test(t)) return false;
	return /^[(["“'«]?\p{Ll}/u.test(t) || /[-,(/=]$/u.test(p);
}

function _line_runs(line) {
	return line.spans.map((s) => new Run(s.text, s.bold, s.italic, s.sub, s.sup));
}

// Monta blocos; evita repetir a mesma imagem quando ela foi cortada entre páginas.
export class BlockBuilder {
	constructor(content, heading_size = null) {
		this.content = content;
		this.heading_size = heading_size;
		this.seen_images = new Set();
	}

	build(items) {
		const blocks = [];
		const gaps = [];
		let cur_runs = [];
		let cur_lines = [];
		let prev_item = null;

		const flush = () => {
			const runs = clean_runs(cur_runs);
			if (runs.length) {
				const heading = Boolean(
					this.heading_size && cur_lines.length &&
					Math.min(...cur_lines.map((ln) => ln.size)) >= this.heading_size &&
					runs.map((r) => r.text).join("").length < 140,
				);
				blocks.push(new Paragraph(runs, heading));
			}
			cur_runs = [];
			cur_lines = [];
		};

		// margem direita do texto em cada página (para saber se uma linha está cheia)
		const right = new Map();
		if (!options.compat) for (const it of items) if (!(it instanceof PageImage)) right.set(it.page, Math.max(right.get(it.page) ?? 0, it.x1));

		for (const it of [...items].sort(cmpItems)) {
			if (prev_item !== null && it.page === prev_item.page && it.y0 - prev_item.y1 > GAP_PT) {
				flush();
				gaps.push(blocks.length);
			}
			if (it instanceof PageImage) {
				flush();
				const img = load_image(this.content, it);
				if (img !== null && !this.seen_images.has(img.key)) {
					this.seen_images.add(img.key);
					blocks.push(img);
				}
				prev_item = it;
				continue;
			}
			if (cur_lines.length && _starts_new_paragraph(cur_lines[cur_lines.length - 1], it, cur_lines.length === 1, right.get(it.page) ?? null)) flush();
			if (cur_runs.length) {
				const last = cur_runs[cur_runs.length - 1].text;
				if (!(last.endsWith("-") && !last.endsWith(" -")) && !last.endsWith(" ")) cur_runs.push(new Run(" "));
			}
			cur_runs.push(..._line_runs(it));
			cur_lines.push(it);
			prev_item = it;
		}
		flush();
		return [blocks, gaps];
	}
}

export function paragraphs(blocks) {
	return blocks.filter((b) => b instanceof Paragraph);
}

export function images(blocks) {
	return blocks.filter((b) => b instanceof Image);
}
