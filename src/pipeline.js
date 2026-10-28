// Orquestra: arquivos de entrada → provas interpretadas → caderno .docx.
import { DocxBuilder, save_docx } from "./docx_builder.js";
import { parse_docx, parse_generic_pdf } from "./generic_parser.js";
import { parse_moodle } from "./moodle_parser.js";
import { PdfError, read_pdf } from "./pdf_extract.js";
import { suggest_cover } from "./textutils.js";
import { splitext } from "./py.js";

export const SUPPORTED = [".pdf", ".docx"];
export const DEFAULT_OUTPUT = "Caderno de Provas.docx";

// Problema que a pessoa consegue resolver (arquivo corrompido, formato errado...).
export class UserError extends Error {}

export function natural_key(name) {
	return name.toLowerCase().split(/(\d+)/).map((t) => (/^\d+$/.test(t) ? parseInt(t, 10) : t));
}

export function compareNatural(a, b) {
	const ka = natural_key(a), kb = natural_key(b);
	for (let i = 0; i < Math.min(ka.length, kb.length); i++) {
		const x = ka[i], y = kb[i];
		if (x === y) continue;
		if (typeof x === typeof y) return x < y ? -1 : 1;
		return typeof x === "number" ? -1 : 1;
	}
	return ka.length - kb.length;
}

// file: { name, data: Uint8Array }
export async function load_exam(file, details, onPage) {
	const ext = splitext(file.name)[1].toLowerCase();
	const name = file.name;
	if (ext === ".pdf") {
		let content;
		try {
			content = await read_pdf(file.data, name, onPage);
		} catch (exc) {
			if (exc instanceof PdfError) throw new UserError(`${name}: ${exc.message}`);
			throw exc;
		}
		try {
			let exam;
			try {
				exam = parse_moodle(content);
			} catch (exc) {
				details?.push(`${name}: falha no modo Moodle\n${exc?.stack || exc}`);
				exam = parse_generic_pdf(content);
				exam.warnings.push("Não consegui separar as questões e o gabarito deste PDF; o conteúdo entrou completo, em texto corrido.");
				return exam;
			}
			if (exam) return exam;
			return parse_generic_pdf(content);
		} finally {
			content.close();
		}
	}
	if (ext === ".docx") {
		try {
			return await parse_docx(file.data, name);
		} catch (exc) {
			throw new UserError(`${name}: ${exc.message}`);
		}
	}
	throw new UserError(`${name}: formato não suportado (use PDF ou DOCX).`);
}

export async function generate(files, { header = "", title = "", subtitle = "", split_in_parts = true, progress = null, coverPng, templateZip }) {
	if (!files.length) throw new UserError("Escolha pelo menos um arquivo de prova.");
	const step = (msg, frac) => progress && progress(msg, frac);
	const exams = [];
	const details = [];
	const n = files.length;
	for (let i = 0; i < n; i++) {
		const f = files[i];
		const base = 0.05 + (0.55 * i) / n;
		step(`Lendo ${f.name}…`, base);
		try {
			exams.push(await load_exam(f, details, (pg, total) => step(`Lendo ${f.name}… página ${pg} de ${total}`, base + (0.55 / n) * (pg / total))));
		} catch (exc) {
			if (exc instanceof UserError) throw exc;
			exc.notes = [...(exc.notes || []), `Arquivo: ${f.name}`];
			throw exc;
		}
	}
	const [auto_title, auto_sub] = suggest_cover(exams.map((e) => e.title));
	const builder = new DocxBuilder(header, title || auto_title, subtitle ? subtitle : auto_sub, split_in_parts, coverPng);
	step("Montando o documento…", 0.65);
	let current = "";
	try {
		builder.build(exams, (msg) => {
			current = msg;
			step(msg, 0.75);
		});
	} catch (exc) {
		exc.notes = [...(exc.notes || []), `Etapa: ${current || "montagem do documento"}`];
		throw exc;
	}
	step("Salvando…", 0.92);
	const data = await save_docx(builder, templateZip);
	const warnings = [];
	for (const e of exams) for (const w of e.warnings) warnings.push(`${e.title}: ${w}`);
	warnings.push(...new Set(builder.warnings));
	step("Pronto!", 1.0);
	return { data, exams, warnings, details };
}
