// Prova impressa (feita no Word e salva em PDF ou .docx): "1) enunciado",
// alternativas "a) …" e, de preferência, um "Gabarito" no fim ("1 – D").
// Trabalha sobre os parágrafos e figuras que o modo genérico já montou.
import { paragraphs } from "./blocks.js";
import { Exam, Option, Paragraph, Question, Run } from "./models.js";
import { guess_topic } from "./textutils.js";
import { strip } from "./py.js";

const QSTART_RE = /^(\p{Nd}{1,3})\s*[).]\s+\S/u;
const OPT_RE = /^\(?([a-eA-E])\s*[).]\s+\S/u;
const Q_PREFIX = /^\s*\p{Nd}{1,3}\s*[).]\s*/u;
const OPT_PREFIX = /^\s*\(?[a-eA-E]\s*[).]\s*/u;
const GABARITO_RE = /^gabarito\b/iu;
const ANSWER_RE = /(\p{Nd}{1,3})\s*[-–—:.)]\s*([a-eA-E])(?![\p{L}\p{N}])/gu;

const nextLetter = (c) => String.fromCharCode(c.charCodeAt(0) + 1);

// Tira o "1) " ou "a) " do começo do parágrafo, preservando a formatação do resto.
function stripPrefix(par, re) {
	const m = re.exec(par.text);
	let cut = m ? m[0].length : 0;
	const runs = [];
	for (const r of par.runs) {
		if (cut >= r.text.length) {
			cut -= r.text.length;
			continue;
		}
		runs.push(new Run(r.text.slice(cut), r.bold, r.italic, r.sub, r.sup));
		cut = 0;
	}
	return new Paragraph(runs, false);
}

export function parse_printed(generic) {
	const blocks = generic.blocks;
	const answers = new Map();
	let body = blocks;
	const g = blocks.findIndex((b) => b instanceof Paragraph && GABARITO_RE.test(strip(b.text)));
	if (g >= 0) {
		for (const b of blocks.slice(g)) {
			if (!(b instanceof Paragraph)) continue;
			for (const m of b.text.matchAll(ANSWER_RE)) if (!answers.has(m[1])) answers.set(m[1], m[2].toLowerCase());
		}
		body = blocks.slice(0, g);
	}

	// "1)", "2)", … em sequência; a próxima questão só vale depois de a anterior ter
	// alternativas (assim itens "1) 2) 3)" dentro de um enunciado não viram questões).
	const starts = [];
	let expect = 1;
	let optionSeen = true;
	body.forEach((b, i) => {
		if (!(b instanceof Paragraph)) return;
		const t = strip(b.text);
		const m = QSTART_RE.exec(t);
		if (m && parseInt(m[1], 10) === expect && optionSeen) {
			starts.push(i);
			expect++;
			optionSeen = false;
			return;
		}
		if (starts.length && OPT_RE.test(t)) optionSeen = true;
	});
	if (starts.length < 3) return null;

	const questions = [];
	starts.forEach((s, k) => {
		const e = k + 1 < starts.length ? starts[k + 1] : body.length;
		const items = body.slice(s + 1, e);
		const optAt = [];
		let want = "a";
		items.forEach((b, j) => {
			if (!(b instanceof Paragraph)) return;
			const m = OPT_RE.exec(strip(b.text));
			if (m && m[1].toLowerCase() === want) {
				optAt.push(j);
				want = nextLetter(want);
			}
		});
		const q = new Question(String(k + 1));
		const first = stripPrefix(body[s], Q_PREFIX);
		if (optAt.length < 2) {
			q.stem = [first, ...items];
		} else {
			q.stem = [first, ...items.slice(0, optAt[0])];
			q.options = optAt.map((j, n) => {
				const end = n + 1 < optAt.length ? optAt[n + 1] : items.length;
				const label = String.fromCharCode(97 + n);
				return new Option(label, [stripPrefix(items[j], OPT_PREFIX), ...items.slice(j + 1, end)]);
			});
		}
		const right = answers.get(q.number);
		if (right && q.options.some((o) => o.label === right)) q.correct_labels = [right];
		q.figure = q.images.length ? "yes" : "none";
		const opt = q.options.find((o) => o.label === q.correct_labels[0]);
		q.topic = guess_topic(paragraphs(q.stem), opt ? opt.text : "");
		questions.push(q);
	});

	const preamble = body.slice(0, starts[0]);
	const heading = preamble.find((b) => b instanceof Paragraph && b.heading && strip(b.text).length >= 3 && strip(b.text).length <= 90);
	const exam = new Exam({
		title: heading ? strip(heading.text) : generic.title,
		source: generic.source,
		kind: "prova",
		questions,
		blocks: preamble.filter((b) => b !== heading),
		content_width: generic.content_width,
	});
	exam.warnings.push(...generic.warnings);
	if (!answers.size) exam.warnings.push("Não encontrei o gabarito no fim do arquivo (ex.: “1 – D”); as respostas corretas ficaram em branco.");
	else {
		const missing = questions.filter((q) => !q.correct_labels.length).map((q) => q.number);
		if (missing.length) exam.warnings.push(`O gabarito não traz a resposta das questões: ${missing.join(", ")}.`);
	}
	return exam;
}
