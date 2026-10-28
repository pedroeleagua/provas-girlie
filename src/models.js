// Modelo de dados neutro: o parser preenche, o gerador de DOCX consome.

export class Run {
	constructor(text, bold = false, italic = false, sub = false, sup = false) {
		this.text = text;
		this.bold = bold;
		this.italic = italic;
		this.sub = sub;
		this.sup = sup;
	}
}

export class Paragraph {
	constructor(runs = [], heading = false) {
		this.runs = runs;
		this.heading = heading;
	}
	get text() {
		return this.runs.map((r) => r.text).join("");
	}
}

export class Image {
	constructor(data, ext, px_width, px_height, pt_width, pt_height, key = "", truncated = false) {
		this.data = data; // Uint8Array
		this.ext = ext; // "png" | "jpeg"
		this.px_width = px_width;
		this.px_height = px_height;
		this.pt_width = pt_width;
		this.pt_height = pt_height;
		this.key = key;
		this.truncated = truncated;
	}
}

// Marca o lugar onde o enunciado cita uma figura que não veio no arquivo.
export class MissingFigure {}

export class Option {
	constructor(label, blocks = [], selected = false, mark = null, feedback = []) {
		this.label = label;
		this.blocks = blocks;
		this.selected = selected;
		this.mark = mark;
		this.feedback = feedback;
	}
	get text() {
		return this.blocks.filter((b) => b instanceof Paragraph).map((b) => b.text).join(" ").trim();
	}
}

export class Question {
	constructor(number) {
		this.number = number;
		this.status = "";
		this.grade = "";
		this.stem = [];
		this.options = [];
		this.feedback = [];
		this.right_answer = null;
		this.correct_labels = [];
		this.topic = "";
		this.figure = "none";
	}
	get selected_labels() {
		return this.options.filter((o) => o.selected).map((o) => o.label);
	}
	get images() {
		const out = this.stem.filter((b) => b instanceof Image);
		for (const o of this.options) out.push(...o.blocks.filter((b) => b instanceof Image));
		return out;
	}
}

export class Exam {
	constructor({ title, source, kind = "moodle", info = [], questions = [], blocks = [], warnings = [], content_width = 400.0 }) {
		this.title = title;
		this.source = source;
		this.kind = kind;
		this.info = info;
		this.questions = questions;
		this.blocks = blocks;
		this.warnings = warnings;
		this.content_width = content_width;
	}
}
