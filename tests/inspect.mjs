// Mostra o que o conversor entendeu de um ou mais arquivos e grava o .docx.
// Uso: node tests/inspect.mjs saida.docx arquivo1.pdf [arquivo2.pdf ...]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as mupdf from "mupdf";
import JSZip from "jszip";
import { DOMParser } from "@xmldom/xmldom";
import { init } from "../src/env.js";
import { generate } from "../src/pipeline.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
init({ mupdf, JSZip, DOMParser });
const [out, ...inputs] = process.argv.slice(2);
const files = inputs.map((f) => ({ name: path.basename(f), data: new Uint8Array(fs.readFileSync(f)) }));
const t0 = Date.now();
const res = await generate(files, {
	header: "Nome de Teste",
	coverPng: new Uint8Array(fs.readFileSync(path.join(root, "assets", "cover.png"))),
	templateZip: new Uint8Array(fs.readFileSync(path.join(root, "assets", "template.zip"))),
	progress: () => {},
});
fs.writeFileSync(out, res.data);
for (const e of res.exams) {
	console.log(`# ${e.title} [${e.kind}] — ${e.questions.length} questões, info: ${JSON.stringify(e.info)}`);
	for (const q of e.questions) {
		const opts = q.options.map((o) => `${o.label}${o.selected ? "*" : ""}${o.mark ? "(" + o.mark[0] + ")" : ""}${o.feedback.length ? "+fb" : ""}`).join(" ");
		console.log(`Q${q.number} ${q.status} | ${q.grade} | opts: ${opts} | certa: ${q.correct_labels.join(",") || "—"} | fig: ${q.figure}/${q.images.length} | stem: ${q.stem.length} | fb: ${q.feedback.length} | tema: ${q.topic}`);
	}
}
for (const w of res.warnings) console.log("AVISO:", w);
console.log(`${res.data.length} bytes em ${Date.now() - t0} ms`);
