// Funções de texto: normalização, comparação de respostas, temas e títulos.
import { Run } from "./models.js";
import { options } from "./options.js";
import { BE as B, BS, D, strip, rstrip, lstrip, title as pyTitle, seqRatio } from "./py.js";

const _WS = /[ \t\xa0 -​  　]+/gu;
const _XML_SPACE = /[\x0b\x0c]/g;
const _XML_BAD = /[\x00-\x08\x0b\x0c\x0e-\x1f\ud800-\udfff￾￿]/gu;

export function xml_safe(text) {
	return (text || "").replace(_XML_SPACE, " ").replace(_XML_BAD, "");
}

export function one_line(text) {
	return strip(collapse_ws(xml_safe(text).replace(/[\r\n]+/g, " ")));
}

export function collapse_ws(text) {
	return text.replace(_WS, " ");
}

export function norm(text) {
	text = text.normalize("NFKD");
	text = Array.from(text).filter((c) => !/\p{Mn}/u.test(c)).join("");
	text = strip(collapse_ws(text).toLowerCase());
	text = text.replace(/\s+([.,;:!?/)])/gu, "$1");
	text = text.replace(/([(/])\s+/gu, "$1");
	return strip(text, " .;:'\"“”‘’");
}

export function clean_runs(runs) {
	let merged = [];
	for (const r of runs) {
		const t = collapse_ws(xml_safe(r.text));
		if (!t) continue;
		const last = merged[merged.length - 1];
		if (last && last.bold === r.bold && last.italic === r.italic && last.sub === r.sub && last.sup === r.sup) {
			last.text = last.text + t;
		} else {
			merged.push(new Run(t, r.bold, r.italic, r.sub, r.sup));
		}
	}
	for (let i = 1; i < merged.length; i++) {
		if (merged[i - 1].text.endsWith(" ") && merged[i].text.startsWith(" ")) merged[i].text = lstrip(merged[i].text, " ");
	}
	merged = merged.filter((r) => r.text);
	if (merged.length) {
		merged[0].text = lstrip(merged[0].text);
		merged[merged.length - 1].text = rstrip(merged[merged.length - 1].text);
	}
	return merged.filter((r) => r.text);
}

export function match_answer(answer, options, plural = false) {
	const ans = norm(answer);
	if (!ans || !options.length) return [];
	const texts = new Map(options.map((o) => [o.label, norm(o.text)]));
	const exact = [...texts].filter(([, t]) => t && t === ans).map(([l]) => l);
	if (exact.length) return exact;
	const contained = [...texts].filter(([, t]) => t && t.length >= 2 && ans.includes(t)).map(([l]) => l);
	if (contained.length) {
		if (plural || contained.length === 1) return contained;
		let best = contained[0];
		for (const l of contained) if (texts.get(l).length > texts.get(best).length) best = l;
		return [best];
	}
	const scored = [...texts].filter(([, t]) => t).map(([l, t]) => [seqRatio(t, ans), l]);
	scored.sort((x, y) => (y[0] - x[0]) || (y[1] < x[1] ? -1 : y[1] > x[1] ? 1 : 0));
	if (scored.length && scored[0][0] >= 0.8) return [scored[0][1]];
	return [];
}

const _COUNT_ANSWER = new RegExp(`^(apenas${B}|somente${B}|todas?${B}|nenhuma${B}|${D}+\\s+afirmativ|i{1,3}v?${B}|iv${B}|v${B}|verdadeir|fals|\\(?[ivx]+[,)\\s])`, "iu");
const _GENERIC_START = new RegExp(`^(qual|quais|assinale|marque|analise|avalie|observe|considere|sobre|com o conhecimento|com base|de acordo|segundo|leia|identifique)${B}`, "iu");

const _GENERIC_TAIL = /^(pode-se afirmar|podemos afirmar|é correto afirmar|est(á|ão) corret[ao]s?|escolha uma|selecione|select one|responda)\b[^.?!]{0,40}[:?]?$/iu;

function _first_sentence(text, limit = 70) {
	text = strip(collapse_ws(text));
	const m = /(.+?[.?!:])(\s|$)/u.exec(text);
	let s = m ? m[1] : text;
	if (Array.from(s).length > limit) {
		const cut = rsplitFirst(Array.from(s).slice(0, limit).join(""));
		s = rstrip(cut, ",;:") + "…";
	}
	return rstrip(s, ".:");
}

// s.rsplit(' ', 1)[0]
function rsplitFirst(s) {
	const i = s.lastIndexOf(" ");
	return i < 0 ? s : s.slice(0, i);
}

export function guess_topic(stem_paragraphs, answer_text) {
	let ans = rstrip(strip(collapse_ws(answer_text || "")), ".");
	const n = Array.from(ans).length;
	if (ans && n <= 130 && !_COUNT_ANSWER.test(ans)) {
		if (n > 75) ans = rstrip(rsplitFirst(Array.from(ans).slice(0, 72).join("")), ",;:/") + "…";
		const chars = Array.from(ans);
		return chars[0].toUpperCase() + chars.slice(1).join("");
	}
	const paras = stem_paragraphs.filter((p) => strip(p.text)).map((p) => strip(collapse_ws(p.text)));
	for (const p of paras) {
		if (_GENERIC_START.test(p) || /^[IVX]+[.)]/.test(p)) continue;
		// "Pode-se afirmar que:", "Escolha uma opção:" não dizem o assunto
		if (!options.compat && _GENERIC_TAIL.test(p)) continue;
		return _first_sentence(p);
	}
	if (paras.length) return _first_sentence(paras[0]);
	return "—";
}

export function clean_exam_title(raw) {
	let t = strip(collapse_ws(raw || ""));
	t = t.replace(/\s*[:|–-]\s*Revis[ãa]o da tentativa.*$/iu, "");
	t = t.replace(/\s*:\s*Review of attempt.*$/iu, "");
	t = t.includes("|") ? t.replace(/\s*\|\s*[^|]+$/u, "") : t;
	return strip(t, " -:|");
}

export function suggest_cover(titles) {
	const modules = new Set();
	const subjects = [];
	for (const t of titles) {
		const m = new RegExp(`${BS}M(${D}{1,2})${B}|P${D}+M(${D}{1,2})`, "iu").exec(t);
		if (m) modules.add(m[1] || m[2]);
		const s = /Prova\s+(?:de|da|do)\s+([^\-–:|]+)/iu.exec(t);
		if (!s) continue;
		let subj = pyTitle(strip(s[1]));
		subj = subj.replace(new RegExp(`\\s+${D}{4}(\\.${D})?$`, "u"), "");
		if (subj && !subjects.includes(subj)) subjects.push(subj);
	}
	const base = titles.length <= 1 ? "PROVA" : "PROVAS";
	const title = modules.size === 1 ? `${base} M${[...modules][modules.size - 1]}` : base;
	const subtitle = subjects.length ? subjects.join(" · ") : "";
	return [title, subtitle];
}
