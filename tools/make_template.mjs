// Empacota as partes fixas do .docx (template_src/) em assets/template.zip.
// As partes vêm do modelo padrão do python-docx já com os estilos do Provas Girlie.
import fs from "node:fs";
import path from "node:path";
import JSZip from "jszip";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..");
const src = path.join(root, "template_src");
const zip = new JSZip();
(function add(dir) {
	for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
		const p = path.join(dir, f.name);
		if (f.isDirectory()) add(p);
		else zip.file(path.relative(src, p).split(path.sep).join("/"), fs.readFileSync(p));
	}
})(src);
const buf = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE", compressionOptions: { level: 9 } });
fs.writeFileSync(path.join(root, "assets", "template.zip"), buf);
console.log(`assets/template.zip: ${buf.length} bytes`);
