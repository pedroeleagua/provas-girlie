// Dependências externas, injetadas pelo navegador (app.js) ou pelos testes (Node).
import { setMupdf } from "./pdf_extract.js";

export const env = { mupdf: null, JSZip: null, DOMParser: null, today: () => new Date() };

export function init({ mupdf, JSZip, DOMParser, today }) {
	env.mupdf = mupdf;
	env.JSZip = JSZip;
	env.DOMParser = DOMParser;
	if (today) env.today = today;
	setMupdf(mupdf);
}
