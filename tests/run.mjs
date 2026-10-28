// Teste de paridade: gera os .docx com o porte em JavaScript e compara com a saída
// do ProvasGirlie.exe original (testdata/golden). Uso: node tests/run.mjs [caso]
import fs from "node:fs";
import path from "node:path";
import * as mupdf from "mupdf";
import JSZip from "jszip";
import { DOMParser } from "@xmldom/xmldom";
import { init } from "../src/env.js";
import { options } from "../src/options.js";
import { generate } from "../src/pipeline.js";

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const root = path.resolve(here, "..");
const data = path.resolve(root, "..", "testdata");

init({ mupdf, JSZip, DOMParser, today: () => new Date(2026, 9, 28) });
options.compat = true; // paridade com o .exe original
const coverPng = new Uint8Array(fs.readFileSync(path.join(root, "assets", "cover.png")));
const templateZip = new Uint8Array(fs.readFileSync(path.join(root, "assets", "template.zip")));

// "known": partes que diferem por motivo aceito. A figura que não terminou de
// carregar é regravada em JPEG — o original usa o codificador do Pillow e aqui é
// o do MuPDF; a imagem é a mesma, os bytes não.
// O nome do cabeçalho é lido do próprio .docx de referência (word/header1.xml).
const CASES = {
	golden1: { files: ["moodle1.pdf"] },
	golden2: { files: ["moodle2.pdf"], known: ["word/media/image2.jpg"] },
	golden3: { files: ["generico.pdf"] },
	golden_multi: { files: ["moodle1.pdf", "moodle2.pdf", "generico.pdf"], known: ["word/media/image4.jpg"] },
};

async function goldenHeader(zip) {
	const xml = await zip.file("word/header1.xml").async("string");
	const m = /<w:t(?: [^>]*)?>([^<]*)<\/w:t>/.exec(xml);
	return m ? m[1].replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">") : "";
}

function lines(xml) {
	return xml.replace(/></g, ">\n<").split("\n");
}

function diffXml(a, b, label, max = 6) {
	if (a === b) return 0;
	const la = lines(a), lb = lines(b);
	let shown = 0, count = 0;
	const n = Math.max(la.length, lb.length);
	for (let i = 0; i < n; i++) {
		if (la[i] !== lb[i]) {
			count++;
			if (shown < max) {
				console.log(`  ${label} linha ${i}:\n    esperado: ${String(lb[i]).slice(0, 220)}\n    obtido:   ${String(la[i]).slice(0, 220)}`);
				shown++;
			}
			if (la.length !== lb.length && count > 3) break;
		}
	}
	console.log(`  ${label}: ${count}+ diferenças (linhas ${la.length} vs ${lb.length})`);
	return count || 1;
}

const only = process.argv[2];
let failures = 0;
for (const [name, cfg] of Object.entries(CASES)) {
	if (only && name !== only) continue;
	const files = cfg.files.map((f) => ({ name: f, data: new Uint8Array(fs.readFileSync(path.join(data, f))) }));
	const exp = await JSZip.loadAsync(fs.readFileSync(path.join(data, "golden", `${name}.docx`)));
	const t0 = Date.now();
	const res = await generate(files, { header: await goldenHeader(exp), coverPng, templateZip });
	fs.mkdirSync(path.join(data, "out"), { recursive: true });
	fs.writeFileSync(path.join(data, "out", `${name}.docx`), res.data);
	const got = await JSZip.loadAsync(res.data);
	console.log(`== ${name}: ${res.exams.map((e) => `${e.title} (${e.questions.length}q)`).join(", ")} em ${Date.now() - t0} ms`);
	for (const w of res.warnings) console.log(`  aviso: ${w}`);
	const names = new Set([...Object.keys(got.files), ...Object.keys(exp.files)].filter((n) => !n.endsWith("/")));
	let caseFail = 0;
	for (const n of [...names].sort()) {
		const a = got.file(n), b = exp.file(n);
		if (!a || !b) {
			console.log(`  parte ${n}: ${a ? "sobrando" : "faltando"}`);
			caseFail++;
			continue;
		}
		if (/\.(xml|rels)$/.test(n)) {
			caseFail += diffXml(await a.async("string"), await b.async("string"), n) ? 1 : 0;
		} else {
			const x = await a.async("uint8array"), y = await b.async("uint8array");
			if ((cfg.known || []).includes(n)) {
				console.log(`  (diferença conhecida e aceita: ${n})`);
				continue;
			}
			if (Buffer.compare(Buffer.from(x), Buffer.from(y)) !== 0) {
				console.log(`  binário diferente: ${n} (${x.length} vs ${y.length} bytes)`);
				caseFail++;
			}
		}
	}
	console.log(caseFail ? `  ✗ ${caseFail} parte(s) com diferença` : "  ✓ idêntico ao original");
	failures += caseFail;
}
process.exitCode = failures ? 1 : 0;
