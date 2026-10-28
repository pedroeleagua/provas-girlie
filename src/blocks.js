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

function _starts_new_paragraph(prev, cur) {
	if (cur.page !== prev.page) return ENDS_SENTENCE.some((e) => rstrip(prev.text).endsWith(e));
	const dy = cur.y0 - prev.y0;
	if (Math.abs(dy) <= 2.0) return false;
	if (dy > Math.max(prev.size, cur.size) * 1.75) return true;
	// título grande seguido de texto (ex.: "M2 - Avaliação de Anatomia" e a questão 1)
	if (!options.compat && Math.max(prev.size, cur.size) > 1.3 * Math.min(prev.size, cur.size)) return true;
	if (cur.x0 > prev.x0 + 8) return true;
	if (_ENUM_START.test(cur.text.trim()) && ENDS_SENTENCE.some((e) => rstrip(prev.text).endsWith(e))) return true;
	return false;
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
			if (cur_lines.length && _starts_new_paragraph(cur_lines[cur_lines.length - 1], it)) flush();
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
