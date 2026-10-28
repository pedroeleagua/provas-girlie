// Interpreta a página "Revisão da tentativa" do Moodle impressa em PDF.
//
// Cada questão é dividida em três zonas pela geometria da página:
// enunciado (antes da alternativa "a."), alternativas (com o comentário que o
// Moodle põe ao lado da alternativa escolhida) e feedback (a caixa de baixo,
// com "A resposta correta é: ...").
import { BlockBuilder, item_key, paragraphs } from "./blocks.js";
import { Exam, MissingFigure, Option, Paragraph, Question, Run } from "./models.js";
import { Line, Span, body_size, content_width } from "./pdf_extract.js";
import { options } from "./options.js";
import { clean_exam_title, guess_topic, match_answer } from "./textutils.js";
import { BE, BS, D, W, basename, cmpTuple, hasKey, mostCommonKey, pyRound, rstrip, splitext, strip } from "./py.js";

const QUESTION_RE = new RegExp(`^(?:Questão|Questao|Question|Pergunta)\\s+(${D}+)\\s*$`, "iu");
const STATUS_RE = /^(Correto|Incorreto|Parcialmente correto|Não respondid[ao]|Não foi respondida|Completo|Incompleto|Resposta salva|Respondida|Não avaliada|Correct|Incorrect|Partially correct|Not answered|Complete|Answer saved|Not yet answered)\.?$/iu;
const GRADE_RE = /^(Atingiu\s+\S+\s+de\s+\S+|Vale\s+\S+\s+ponto\(?s?\)?\.?|Mark\s+\S+\s+out of\s+\S+|Marked out of\s+\S+|Pontuação\s+\S+\s+de\s+\S+)$/iu;
const INFO_JUNK_RE = /^(Marcar questão|Remover marcação|Sinalizar questão|Flag question|Remove flag|Texto da questão|Question text|Enunciado da questão|\.{3}|…)$/iu;
const NAV_JUNK_RE = new RegExp(`^(Terminar revisão|Finish review|Navegação do questionário|Quiz navigation|Mostrar uma página|Show one page|Pular navegação|Skip quiz navigation|Seguir para${BE}|Jump to${BE})`, "iu");
const LABEL_RE = /^([a-zA-Z])[.)]$/u;
const LABEL_INLINE_RE = /^([a-zA-Z])[.)]\s+\S/u;
const RIGHT_RE = /^(A resposta correta é|A resposta correta foi|As respostas corretas são|The correct answer is|The correct answers are)\s*:?\s*/iu;
const OUTCOME_RE = /^(Sua resposta está (correta|incorreta|parcialmente correta)|Your answer is)/iu;
// "fig." termina em ponto: no Python o \b depois dele exige uma letra/dígito em seguida.
const FIGURE_RE = new RegExp(`${BS}(?:(?:setas?|esquemas?|figuras?|imagens?|ilustra${W}*|observe|marcad[ao]s?|apontad[ao]s?|indicad[ao]s?|destacad[ao]s?|fotografia|foto|radiografia|tomografia|corte)${BE}|fig\\.(?=${W}))`, "iu");
const NUMBERED_LABEL_RE = new RegExp(`(?:^|[^\\p{L}\\p{N}_/,])${D}{1,2}[a-z]?\\*?\\s*=\\s*${W}`, "gu");

const INFO_LABELS = {
	"iniciado em": "Iniciado",
	"estado": "Situação",
	"concluída em": "Concluído",
	"concluido em": "Concluído",
	"tempo empregado": "Duração",
	"notas": "Notas",
	"avaliar": "Nota",
	"nota": "Nota",
	"comentários": "Comentários",
	"feedback": "Comentários",
	"started on": "Iniciado",
	"state": "Situação",
	"completed on": "Concluído",
	"time taken": "Duração",
	"marks": "Notas",
	"grade": "Nota",
};

// Rótulos da tabela do topo, para quando o PDF não guarda o negrito (Safari do iOS
// grava a fonte do sistema sempre como "Regular").
const INFO_WORDS = new Set([...Object.keys(INFO_LABELS), ...Object.values(INFO_LABELS).map((v) => v.toLowerCase()), "tempo", "empregado"]);

const keyLE = (a, b) => cmpTuple(a, b) <= 0;
const keyLT = (a, b) => cmpTuple(a, b) < 0;

function _is_bold(line) {
	const parts = line.spans.filter((s) => strip(s.text));
	return parts.length > 0 && parts.every((s) => s.bold);
}

function _split_label_value(ln, value_col) {
	const spans = ln.spans;
	let idx = spans.findIndex((s) => strip(s.text) && !s.bold);
	if (idx < 0) idx = null;
	if (!idx || !spans.slice(0, idx).filter((s) => strip(s.text)).some((s) => s.bold)) return [ln];
	const bold_end = Math.max(...spans.slice(0, idx).filter((s) => strip(s.text)).map((s) => s.x1));
	let first = null;
	outer: for (const s of spans.slice(idx)) {
		for (const [c, cx0] of s.chars) {
			if (strip(c)) { first = cx0; break outer; }
		}
	}
	if (first === null) return [ln];
	const at_column = value_col !== null && Math.abs(first - value_col) < 1.5 && ln.x0 < value_col - 2;
	if (first - bold_end <= ln.size * 0.6 && !at_column) return [ln];
	return [new Line(ln.page, ln.x0, ln.y0, bold_end, ln.y1, spans.slice(0, idx)), new Line(ln.page, first, ln.y0, ln.x1, ln.y1, spans.slice(idx))];
}

function _parse_info(lines) {
	if (!lines.length) return [];
	const plain_x = new Map();
	for (const ln of lines) {
		if (ln.spans.filter((s) => strip(s.text)).some((s) => s.bold)) continue;
		const k = pyRound(ln.x0, 1);
		plain_x.set(k, (plain_x.get(k) || 0) + 1);
	}
	const value_col = plain_x.size ? mostCommonKey(plain_x) : null;
	lines = lines.flatMap((ln) => _split_label_value(ln, value_col));
	const plain = lines.filter((ln) => !_is_bold(ln));
	const value_x = plain.length ? Math.min(...plain.map((ln) => ln.x0)) : null;
	let labels = [], values = [];
	for (const ln of lines) {
		if (_is_bold(ln) && (value_x === null || ln.x1 < value_x + 1)) labels.push(ln);
		else values.push(ln);
	}
	let rowTol = 3;
	if (!labels.length && !options.compat) {
		// Sem negrito no PDF: reconhece os rótulos pelo nome.
		labels = lines.filter((ln) => INFO_WORDS.has(strip(ln.text).toLowerCase()));
		values = lines.filter((ln) => !labels.includes(ln));
		rowTol = 4;
	}
	const rows = [];
	const used = new Set();
	for (const lab of labels) {
		const same = values.filter((v) => v.page === lab.page && Math.abs(v.y0 - lab.y0) < rowTol && !used.has(v));
		const txt = strip(lab.text);
		if (same.length) {
			for (const v of same) used.add(v);
			rows.push([txt, same.map((v) => strip(v.text)).join(" "), lab]);
		} else if (rows.length && isLower(txt.slice(0, 1))) {
			rows[rows.length - 1][0] = rows[rows.length - 1][0] + " " + txt;
		} else {
			rows.push([txt, "", lab]);
		}
	}
	for (const v of values) {
		if (used.has(v)) continue;
		const prev = rows.filter((r) => keyLE(item_key(r[2]), item_key(v)));
		if (prev.length) {
			const last = prev[prev.length - 1];
			last[1] = strip(last[1] + " " + strip(v.text));
		}
	}
	const out = [];
	for (const [label, value0] of rows) {
		const value = strip(value0.replace(/\s+/gu, " "));
		if (!value) continue;
		const key = strip(label.replace(/\s+/gu, " ")).toLowerCase();
		const nice = hasKey(INFO_LABELS, key) ? INFO_LABELS[key] : strip(label);
		out.push([nice, value]);
	}
	return out;
}

// str.islower() para um caractere
function isLower(s) {
	return s !== "" && s === s.toLowerCase() && s !== s.toUpperCase();
}

function _find_labels(lines) {
	const chains = (cands) => {
		const found = [];
		cands.forEach(([ln, letter], i) => {
			if (letter.toLowerCase() !== "a") return;
			const chain = [ln];
			let expect = "b";
			for (const [ln2, l2] of cands.slice(i + 1)) {
				if (l2.toLowerCase() === expect && Math.abs(ln2.x0 - ln.x0) < 3) {
					chain.push(ln2);
					expect = String.fromCharCode(expect.charCodeAt(0) + 1);
				}
			}
			if (chain.length >= 2) found.push(chain);
		});
		return found;
	};
	let cands = [];
	for (const ln of lines) {
		const m = LABEL_RE.exec(strip(ln.text));
		if (m) cands.push([ln, m[1]]);
	}
	let found = chains(cands);
	if (found.length) {
		const chain = found[found.length - 1];
		const text_lines = new Map();
		const extended = !options.compat && _extend_chain(chain, lines, text_lines);
		return [chain, text_lines, extended];
	}
	cands = [];
	for (const ln of lines) {
		const m = LABEL_INLINE_RE.exec(strip(ln.text));
		if (m) cands.push([ln, m[1]]);
	}
	found = chains(cands);
	if (found.length) {
		const chain = found[found.length - 1];
		const text_lines = new Map();
		for (const ln of chain) text_lines.set(ln, _strip_inline_label(ln));
		const extended = !options.compat && _extend_chain(chain, lines, text_lines);
		return [chain, text_lines, extended];
	}
	if (options.compat) return [[], new Map(), false];
	// PDFs do Safari (iOS) e do PDFium: a letra vem colada no texto ("a.2=Tálamo",
	// "a.a) …"), às vezes só na primeira alternativa. Junta as duas formas.
	cands = [];
	const glued = new Set();
	const weak = new Set(); // "a.2=…" sem separação visível: só vale junto de letras claras
	for (const ln of lines) {
		const t = strip(ln.text);
		let m = LABEL_RE.exec(t);
		if (m) {
			cands.push([ln, m[1]]);
			continue;
		}
		m = LABEL_INLINE_RE.exec(t);
		let letter = m ? m[1] : _glued_label(ln);
		if (!letter && /^[a-zA-Z][.)]\S/u.test(t)) {
			letter = t[0];
			weak.add(ln);
		}
		if (letter) {
			cands.push([ln, letter]);
			glued.add(ln);
		}
	}
	found = chains(cands).filter((ch) => ch.some((ln) => !weak.has(ln)));
	if (!found.length) return [[], new Map(), false];
	const chain = found[found.length - 1];
	const text_lines = new Map();
	for (const ln of chain) if (glued.has(ln)) text_lines.set(ln, _strip_inline_label(ln, true));
	return [chain, text_lines, true];
}

// Depois de "a." e "b." sozinhos, as letras seguintes às vezes vêm coladas no texto
// ("c.Núcleo…", "d. Núcleo…"): continua a sequência na mesma coluna.
function _extend_chain(chain, lines, text_lines) {
	const x0 = chain[0].x0;
	const next = (ch) => String.fromCharCode(ch.toLowerCase().charCodeAt(0) + 1);
	let expect = next(strip(chain[chain.length - 1].text)[0]);
	let extended = false;
	for (const ln of lines.slice(lines.indexOf(chain[chain.length - 1]) + 1)) {
		// a bolinha marcada às vezes empurra a letra alguns pontos para a direita
		if (ln.x0 < x0 - 3 || ln.x0 > x0 + 20) continue;
		const t = strip(ln.text);
		if (!new RegExp(`^${expect}[.)]`, "iu").test(t)) continue;
		chain.push(ln);
		if (!LABEL_RE.test(t)) text_lines.set(ln, _strip_inline_label(ln, true));
		expect = next(expect);
		extended = true;
	}
	return extended;
}

// "a." no começo da linha, separado do resto por um espaço visual (sem caractere de
// espaço) ou desenhado por cima do texto (o texto "volta" para trás, como no Safari).
function _glued_label(ln) {
	const chars = ln.spans.flatMap((s) => s.chars).filter(([c]) => strip(c));
	if (chars.length < 3) return null;
	const [[c0], [c1, , x1], [, x2]] = chars;
	if (!/^[a-zA-Z]$/u.test(c0) || !".)".includes(c1)) return null;
	return x2 - x1 >= 2.0 || x2 < x1 - 1.0 ? c0 : null;
}

function _strip_inline_label(ln, dedupe = false) {
	const spans = ln.spans.map((s) => Object.assign(Object.create(Object.getPrototypeOf(s)), s));
	while (spans.length && !strip(spans[0].text)) spans.shift();
	const m = /^\s*([a-zA-Z])[.)]\s*/u.exec(spans[0].text);
	spans[0].text = m ? spans[0].text.slice(m[0].length) : spans[0].text;
	if (!spans[0].text) spans.shift();
	if (dedupe && m && spans.length) {
		// a professora também escreveu uma letra no texto ("b. a) …"): fica só a do Moodle
		const again = /^\s*[a-eA-E][.)]\s+/u.exec(spans[0].text);
		if (again) {
			spans[0].text = spans[0].text.slice(again[0].length);
			if (!spans[0].text) spans.shift();
		}
	}
	return new Line(ln.page, ln.x0 + 1, ln.y0, ln.x1, ln.y1, spans);
}

function _row_index(labels, it, tol = 1.5) {
	let idx = 0;
	labels.forEach((lab, k) => {
		if (keyLE([lab.page, lab.y0 - tol], [it.page, it.y0])) idx = k;
	});
	return idx;
}

class _QuestionParser {
	constructor(content, builder, fb_colors) {
		this.content = content;
		this.builder = builder;
		this.fb_colors = fb_colors;
	}

	parse(header, lines, imgs, icons, marks, left_limit, is_last) {
		const q = new Question(QUESTION_RE.exec(strip(header.text))[1]);
		const body = [];
		// "Questão N" no pé da página: o "Correto / Atingiu…" foi para o topo da seguinte.
		const spill = options.compat ? null : _spills_to_next_page(header, lines);
		for (const ln of lines) {
			const t = strip(ln.text);
			const near_header = (ln.page === header.page && -2 <= ln.y0 - header.y1 && ln.y0 - header.y1 < 60) ||
				(spill !== null && ln.page === header.page + 1 && ln.y0 - spill < 60);
			if (ln.x0 < left_limit) continue;
			if (near_header && STATUS_RE.test(t)) {
				q.status = q.status || rstrip(t, ".");
				continue;
			}
			if (near_header && GRADE_RE.test(t)) {
				q.grade = q.grade || t;
				continue;
			}
			if (INFO_JUNK_RE.test(t)) continue;
			if (is_last && NAV_JUNK_RE.test(t)) break;
			body.push(ln);
		}
		if (is_last) {
			const nav = lines.find((ln) => NAV_JUNK_RE.test(strip(ln.text)));
			const limit = nav ? item_key(nav) : null;
			if (limit) imgs = imgs.filter((im) => keyLT(item_key(im), limit));
		}
		const [labels, inline_text, relaxed] = _find_labels(body);
		let stem_items, fb_items;
		// Em PDFs do Safari/PDFium o texto da alternativa fica alguns pontos acima da
		// letra: a tolerância acompanha a altura da letra (o original usa 1,5 pt fixo).
		let tol = 1.5;
		if (!options.compat && labels.length) {
			const hs = labels.map((l) => l.y1 - l.y0).sort((a, b) => a - b);
			tol = Math.max(relaxed ? 3.0 : 1.5, 0.45 * hs[Math.floor(hs.length / 2)]);
		}
		if (labels.length) [stem_items, fb_items] = this._split_with_options(q, body, imgs, icons, marks, labels, inline_text, tol);
		else [stem_items, fb_items] = this._split_without_options(body, imgs);
		let gaps;
		[q.stem, gaps] = this.builder.build(stem_items);
		if (labels.length && stem_items.length) {
			let last = stem_items[0];
			for (const it of stem_items) if (cmpTuple(item_key(it), item_key(last)) > 0) last = it;
			const first = labels[0];
			if (last.page === first.page && first.y0 - last.y1 > 60) gaps.push(q.stem.length);
		}
		[q.feedback] = this.builder.build(fb_items);
		this._extract_right_answer(q);
		this._resolve_answers(q);
		this._detect_figure(q, gaps);
		let answer_text = "";
		if (q.correct_labels.length && q.correct_labels.length === 1) {
			const opt = q.options.find((o) => o.label === q.correct_labels[0]);
			answer_text = opt.text;
		} else if (q.right_answer !== null) {
			answer_text = strip(q.right_answer.text).replace(RIGHT_RE, "");
		}
		q.topic = guess_topic(paragraphs(q.stem), answer_text);
		return q;
	}

	_split_with_options(q, body, imgs, icons, marks, labels, inline_text, tol = 1.5) {
		const label_ids = new Set(labels);
		const first = labels[0], last = labels[labels.length - 1];
		const label_x = first.x0;
		const row_text = body.filter((ln) => ln.page === first.page && Math.abs(ln.y0 - first.y0) < 2 && ln.x0 > first.x1 && !label_ids.has(ln));
		let text_x = row_text.length ? Math.min(...row_text.map((ln) => ln.x0)) : first.x1 + 4;
		if (inline_text.size) text_x = first.x0 + 1;
		const opt_color = row_text.length ? row_text[0].color : null;
		let fb_start = null;
		for (const ln of body) {
			if (keyLE(item_key(ln), item_key(last)) || label_ids.has(ln)) continue;
			if (ln.x0 < label_x - 2 || (this.fb_colors.has(ln.color) && ln.color !== opt_color && _row_index(labels, ln, tol) === labels.length - 1 && ln.y0 > last.y1 + 4)) {
				fb_start = item_key(ln);
				break;
			}
		}
		const in_options = (it) => {
			const k = item_key(it);
			return keyLE([first.page, first.y0], [it.page, it.y0 + tol]) && (fb_start === null || keyLT(k, fb_start));
		};
		const toFeedback = (it) => fb_start !== null && !keyLT(item_key(it), fb_start);
		const opts = labels.map((lab) => new Option(strip(lab.text)[0].toLowerCase()));
		const opt_items = labels.map(() => []);
		const side_items = labels.map(() => []);
		const stem_items = [];
		const fb_items = [];
		const opt_icons = labels.map(() => []);
		for (const ic of icons) if (in_options(ic)) opt_icons[_row_index(labels, ic, tol)].push(ic);
		for (const ln of body) {
			if (label_ids.has(ln)) {
				if (inline_text.has(ln)) opt_items[labels.indexOf(ln)].push(inline_text.get(ln));
				continue;
			}
			if (!in_options(ln)) {
				(toFeedback(ln) ? fb_items : stem_items).push(ln);
				continue;
			}
			const k = _row_index(labels, ln, tol);
			if (_QuestionParser._is_side(ln, k, opt_icons[k], text_x, body, labels, tol)) side_items[k].push(ln);
			else opt_items[k].push(ln);
		}
		for (const im of imgs) {
			if (!in_options(im)) {
				(toFeedback(im) ? fb_items : stem_items).push(im);
				continue;
			}
			const k = _row_index(labels, im, tol);
			(im.x0 > text_x + 40 && opt_icons[k].length ? side_items[k] : opt_items[k]).push(im);
		}
		opts.forEach((opt, k) => {
			[opt.blocks] = this.builder.build(opt_items[k]);
			[opt.feedback] = this.builder.build(side_items[k]);
			const lab = labels[k];
			const cy = (lab.y0 + lab.y1) / 2;
			for (const mk of marks) {
				if (mk.page === lab.page && lab.x0 - 22 < mk.cx && mk.cx < lab.x0 && Math.abs(mk.cy - cy) < 6) opt.selected = true;
			}
			for (const ic of opt_icons[k]) {
				opt.selected = true;
				const kind = ic.kind;
				if (kind === "correct" || kind === "incorrect" || kind === "partial") opt.mark = kind;
			}
		});
		q.options = opts;
		return [stem_items, fb_items];
	}

	static _is_side(ln, k, icons, text_x, body, labels, tol = 1.5) {
		for (const ic of icons) {
			if (ic.page === ln.page && ln.x0 >= ic.x1 - 1 && ln.y0 >= ic.y0 - 4) return true;
		}
		if (ln.x0 > text_x + 40) {
			for (const other of body) {
				if (other === ln || other.page !== ln.page || Math.abs(other.x0 - text_x) > 3) continue;
				if (_row_index(labels, other, tol) === k && Math.min(other.y1, ln.y1) - Math.max(other.y0, ln.y0) > 1) return true;
			}
		}
		return false;
	}

	_split_without_options(body, imgs) {
		let start = null;
		for (const ln of body) {
			const t = strip(ln.text);
			if (OUTCOME_RE.test(t) || RIGHT_RE.test(t) || this.fb_colors.has(ln.color)) {
				start = item_key(ln);
				break;
			}
		}
		const all = [...body, ...imgs];
		const stem = all.filter((it) => start === null || keyLT(item_key(it), start));
		const fb = all.filter((it) => start !== null && !keyLT(item_key(it), start));
		return [stem, fb];
	}

	_extract_right_answer(q) {
		for (let i = 0; i < q.feedback.length; i++) {
			const b = q.feedback[i];
			if (!(b instanceof Paragraph) || !RIGHT_RE.test(strip(b.text))) continue;
			let para = b;
			const rest = strip(b.text).replace(RIGHT_RE, "");
			const nxt = i + 1 < q.feedback.length ? q.feedback[i + 1] : null;
			if (!strip(rest) && nxt instanceof Paragraph) {
				para = new Paragraph([...b.runs, new Run(" "), ...nxt.runs]);
				q.feedback.splice(i + 1, 1);
			}
			q.right_answer = para;
			q.feedback.splice(i, 1);
			return;
		}
	}

	_resolve_answers(q) {
		if (q.right_answer !== null && q.options.length) {
			const txt = strip(q.right_answer.text);
			const plural = /^(As respostas corretas|The correct answers)/iu.test(txt);
			q.correct_labels = match_answer(txt.replace(RIGHT_RE, ""), q.options, plural);
		}
		if (!q.correct_labels.length) q.correct_labels = q.options.filter((o) => o.mark === "correct").map((o) => o.label);
		const st = q.status.toLowerCase();
		if (!q.correct_labels.length && (st.startsWith("correto") || st.startsWith("correct"))) q.correct_labels = q.selected_labels;
	}

	_detect_figure(q, gaps) {
		if (q.images.length) {
			q.figure = "yes";
			return;
		}
		const text = paragraphs(q.stem).map((p) => p.text).join(" ") + " " + q.options.map((o) => o.text).join(" ");
		const cites = FIGURE_RE.test(text) || (text.match(NUMBERED_LABEL_RE) || []).length >= 2;
		if (!(cites || gaps.length)) {
			q.figure = "none";
			return;
		}
		q.figure = "missing";
		let pos;
		if (gaps.length) pos = gaps[0];
		else {
			pos = q.stem.length;
			for (let i = 0; i < q.stem.length; i++) {
				const b = q.stem[i];
				if (b instanceof Paragraph && FIGURE_RE.test(b.text)) {
					pos = i + 1;
					break;
				}
			}
		}
		q.stem.splice(pos, 0, new MissingFigure());
	}
}

function _has_status_below(header, lines) {
	for (const ln of lines) {
		if (ln.page === header.page && -2 <= ln.y0 - header.y1 && ln.y0 - header.y1 < 60) {
			const t = strip(ln.text);
			if (STATUS_RE.test(t) || GRADE_RE.test(t)) return true;
		}
	}
	return false;
}

// Se "Questão N" é a última linha da página, devolve o topo da página seguinte
// (onde o Moodle continua com "Correto / Atingiu…"); senão, null.
function _spills_to_next_page(header, lines) {
	if (lines.some((o) => o !== header && o.page === header.page && o.y0 > header.y0 + 1)) return null;
	const next = lines.filter((o) => o.page === header.page + 1);
	return next.length ? Math.min(...next.map((o) => o.y0)) : null;
}

function _has_status_on_next_page(header, lines) {
	const top = _spills_to_next_page(header, lines);
	if (top === null) return false;
	return lines.some((ln) => ln.page === header.page + 1 && ln.y0 - top < 60 && (STATUS_RE.test(strip(ln.text)) || GRADE_RE.test(strip(ln.text))));
}

// "Questão" sem número (o número caiu dentro de outro texto, em PDFs com trechos
// sobrepostos) mas com "Atingiu…" logo abaixo: é a questão seguinte da sequência.
function _recover_numberless_headers(headers, lines) {
	const x0 = headers[0].x0;
	const lone = lines.filter((ln) => /^(?:Questão|Questao|Question|Pergunta)$/iu.test(strip(ln.text)) &&
		Math.abs(ln.x0 - x0) < 3 && _has_status_below(ln, lines));
	if (!lone.length) return headers;
	const all = [...headers, ...lone].sort((a, b) => cmpTuple(item_key(a), item_key(b)));
	let prev = 0;
	for (const h of all) {
		if (lone.includes(h)) {
			const s = h.spans[h.spans.length - 1];
			const num = String(prev + 1);
			const sp = /\s$/u.test(h.text) ? "" : " ";
			h.spans.push(new Span(sp + num, s.bold, s.italic, s.size, s.color, s.x1, s.x1, s.origin_y, []));
			h.recovered = true;
		}
		prev = parseInt(QUESTION_RE.exec(strip(h.text))[1], 10);
	}
	return all;
}

export function parse_moodle(content) {
	const lines = content.all_lines();
	if (!lines.length) return null;
	const bsize = body_size(lines);
	const candidates = lines.filter((ln) => QUESTION_RE.test(strip(ln.text)));
	let headers = candidates.filter((ln) => ln.size >= bsize * 1.1);
	if (!headers.length) {
		headers = candidates.filter((h) => _has_status_below(h, lines));
		if (headers.length && !options.compat) {
			// títulos no pé da página, com o status no topo da próxima (Safari do iOS)
			const x0 = headers[0].x0;
			headers = candidates.filter((h) => headers.includes(h) || (Math.abs(h.x0 - x0) < 3 && _has_status_on_next_page(h, lines)));
		}
	}
	if (!headers.length) return null;
	if (!options.compat) headers = _recover_numberless_headers(headers, lines);
	const fb_colors = new Set();
	for (const ln of lines) {
		const t = strip(ln.text);
		if (RIGHT_RE.test(t) || OUTCOME_RE.test(t)) fb_colors.add(ln.color);
	}
	const looks_like_quiz = fb_colors.size > 0 ||
		lines.some((ln) => LABEL_RE.test(strip(ln.text)) || LABEL_INLINE_RE.test(strip(ln.text))) ||
		headers.some((h) => _has_status_below(h, lines));
	if (!looks_like_quiz) return null;
	const images = content.pages.flatMap((p) => p.images);
	const icons = content.pages.flatMap((p) => p.icons);
	const marks = content.pages.flatMap((p) => p.marks);
	const left_limit = Math.min(...headers.map((h) => h.x0)) - 8;
	const title = clean_exam_title(content.title || content.header_title) || splitext(basename(content.path))[0];
	const exam = new Exam({ title, source: content.path, kind: "moodle", content_width: content_width(lines) });
	const first_key = item_key(headers[0]);
	exam.info = _parse_info(lines.filter((ln) => keyLT(item_key(ln), first_key) && ln.x0 >= left_limit));
	const builder = new BlockBuilder(content);
	const qp = new _QuestionParser(content, builder, fb_colors);
	headers.forEach((h, i) => {
		const start = item_key(h);
		const end = i + 1 < headers.length ? item_key(headers[i + 1]) : [1e9, 0, 0];
		const inside = (it) => keyLE(start, item_key(it)) && keyLT(item_key(it), end);
		const q = qp.parse(
			h,
			lines.filter((ln) => inside(ln) && ln !== h),
			images.filter(inside),
			icons.filter(inside),
			marks.filter((mk) => keyLE(start, [mk.page, mk.cy, mk.cx]) && keyLT([mk.page, mk.cy, mk.cx], end)),
			left_limit,
			i === headers.length - 1,
		);
		exam.questions.push(q);
	});
	_collect_warnings(exam);
	return exam;
}

function _collect_warnings(exam) {
	const missing = exam.questions.filter((q) => q.figure === "missing").map((q) => q.number);
	if (missing.length) exam.warnings.push(`${missing.length} questão(ões) citam figura que não veio no PDF: ${missing.join(", ")}.`);
	const truncated = exam.questions.filter((q) => q.images.some((im) => im.truncated)).map((q) => q.number);
	if (truncated.length) exam.warnings.push(`Figuras incompletas já no PDF original: questões ${truncated.join(", ")}.`);
	if (missing.length || truncated.length) exam.warnings.push("Dica: na revisão do Moodle, role a página até o fim (para todas as figuras carregarem) antes de salvar o PDF.");
	const no_key = exam.questions.filter((q) => q.options.length && !q.correct_labels.length).map((q) => q.number);
	if (no_key.length) exam.warnings.push(`Não identifiquei a alternativa correta nas questões: ${no_key.join(", ")}.`);
	const nums = exam.questions.filter((q) => /^\p{Nd}+$/u.test(q.number)).map((q) => parseInt(q.number, 10));
	if (nums.length && nums.some((n, i) => n !== nums[0] + i)) exam.warnings.push("A numeração das questões tem saltos; confira se o PDF está completo.");
}
