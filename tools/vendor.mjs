// Copia as bibliotecas do node_modules para vendor/ (o site não usa bundler).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const copies = [
	["node_modules/mupdf/dist/mupdf.js", "vendor/mupdf/mupdf.js"],
	["node_modules/mupdf/dist/mupdf-wasm.js", "vendor/mupdf/mupdf-wasm.js"],
	["node_modules/mupdf/dist/mupdf-wasm.wasm", "vendor/mupdf/mupdf-wasm.wasm"],
	["node_modules/mupdf/LICENSE", "vendor/mupdf/LICENSE"],
	["node_modules/jszip/dist/jszip.min.js", "vendor/jszip.min.js"],
	["node_modules/jszip/LICENSE.markdown", "vendor/jszip.LICENSE.md"],
];
for (const [from, to] of copies) {
	fs.mkdirSync(path.dirname(path.join(root, to)), { recursive: true });
	fs.copyFileSync(path.join(root, from), path.join(root, to));
	console.log(to);
}
