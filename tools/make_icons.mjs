// Gera os ícones do app (o mesmo desenho do ícone do ProvasGirlie.exe: gradiente,
// coração rosa e brilhos). Uso: node tools/make_icons.mjs
import fs from "node:fs";
import * as mupdf from "mupdf";

const PINK_SOFT = [255, 209, 230], LILAC_SOFT = [226, 205, 246], MINT_SOFT = [196, 241, 226];
const PINK = [231, 84, 128], MINT = [63, 166, 134];

const lerp = (a, b, t) => a.map((v, i) => Math.trunc(v + (b[i] - v) * t));

// Gradiente 64×64 do original, amostrado com interpolação bilinear.
const G = 64;
const grad = [];
for (let y = 0; y < G; y++) {
	for (let x = 0; x < G; x++) {
		const t = x / (G - 1);
		const base = t < 0.5 ? lerp(PINK_SOFT, LILAC_SOFT, t * 2) : lerp(LILAC_SOFT, MINT_SOFT, (t - 0.5) * 2);
		const k = 1 + 0.06 * (1 - y / G);
		grad.push(base.map((c) => Math.min(255, Math.trunc(c * k))));
	}
}
function gradAt(u, v) {
	const x = Math.min(G - 1, Math.max(0, u * G - 0.5)), y = Math.min(G - 1, Math.max(0, v * G - 0.5));
	const x0 = Math.floor(x), y0 = Math.floor(y), x1 = Math.min(G - 1, x0 + 1), y1 = Math.min(G - 1, y0 + 1);
	const fx = x - x0, fy = y - y0;
	const c = (xx, yy) => grad[yy * G + xx];
	return [0, 1, 2].map((i) => (c(x0, y0)[i] * (1 - fx) + c(x1, y0)[i] * fx) * (1 - fy) + (c(x0, y1)[i] * (1 - fx) + c(x1, y1)[i] * fx) * fy);
}

function heart(cx, cy, size) {
	const pts = [];
	for (let i = 0; i < 80; i++) {
		const t = (2 * Math.PI * i) / 80;
		const x = 16 * Math.sin(t) ** 3;
		const y = 13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t);
		pts.push([cx + (x * size) / 32, cy - (y * size) / 32]);
	}
	return pts;
}
function sparkle(cx, cy, r) {
	const pts = [];
	for (let i = 0; i < 8; i++) {
		const ang = (Math.PI / 4) * i - Math.PI / 2;
		const rad = i % 2 === 0 ? r : r * 0.22;
		pts.push([cx + rad * Math.cos(ang), cy + rad * Math.sin(ang)]);
	}
	return pts;
}
function inPoly(pts, x, y) {
	let inside = false;
	for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
		const [xi, yi] = pts[i], [xj, yj] = pts[j];
		if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
	}
	return inside;
}
const over = (dst, src, a) => dst.map((d, i) => d * (1 - a) + src[i] * a);

// rounded: cantos arredondados com transparência; senão, quadrado cheio (iOS e "maskable").
// scale: tamanho do desenho dentro do quadrado (para a zona segura dos ícones maskable).
function render(size, { rounded, scale = 1 }) {
	const SS = 4;
	const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, size, size], true);
	const out = pix.getPixels();
	const off = (1 - scale) / 2;
	const H = heart(0.5, 0.54, 0.72).map(([x, y]) => [off + x * scale, off + y * scale]);
	const S1 = sparkle(0.79, 0.21, 0.15).map(([x, y]) => [off + x * scale, off + y * scale]);
	const S2 = sparkle(0.79, 0.21, 0.09).map(([x, y]) => [off + x * scale, off + y * scale]);
	const ell = { cx: off + 0.32 * scale, cy: off + 0.38 * scale, r: 0.05 * scale };
	const rad = 0.23;
	for (let py = 0; py < size; py++) {
		for (let px = 0; px < size; px++) {
			let acc = [0, 0, 0, 0];
			for (let sy = 0; sy < SS; sy++) {
				for (let sx = 0; sx < SS; sx++) {
					const u = (px + (sx + 0.5) / SS) / size, v = (py + (sy + 0.5) / SS) / size;
					let alpha = 1;
					if (rounded) {
						const dx = Math.max(rad - u, 0, u - (1 - rad)), dy = Math.max(rad - v, 0, v - (1 - rad));
						if (dx * dx + dy * dy > rad * rad) alpha = 0;
					}
					let c = gradAt(u, v);
					if (inPoly(H, u, v)) c = PINK;
					if ((u - ell.cx) ** 2 + (v - ell.cy) ** 2 <= ell.r ** 2) c = over(c, [255, 255, 255], 170 / 255);
					if (inPoly(S1, u, v)) c = [255, 255, 255];
					if (inPoly(S2, u, v)) c = MINT;
					acc = [acc[0] + c[0] * alpha, acc[1] + c[1] * alpha, acc[2] + c[2] * alpha, acc[3] + alpha];
				}
			}
			const i = (py * size + px) * 4;
			const a = acc[3] / (SS * SS);
			// pixmap com alfa do MuPDF usa cor pré-multiplicada
			out[i] = Math.round(acc[0] / (SS * SS));
			out[i + 1] = Math.round(acc[1] / (SS * SS));
			out[i + 2] = Math.round(acc[2] / (SS * SS));
			out[i + 3] = Math.round(a * 255);
		}
	}
	return pix.asPNG();
}

const dir = new URL("../assets/icons/", import.meta.url);
fs.mkdirSync(dir, { recursive: true });
const jobs = [
	["icon-192.png", 192, { rounded: true }],
	["icon-512.png", 512, { rounded: true }],
	["icon-maskable-512.png", 512, { rounded: false, scale: 0.8 }],
	["apple-touch-icon.png", 180, { rounded: false, scale: 0.9 }],
	["favicon-32.png", 32, { rounded: true }],
];
for (const [name, size, opts] of jobs) {
	fs.writeFileSync(new URL(name, dir), render(size, opts));
	console.log(name);
}
