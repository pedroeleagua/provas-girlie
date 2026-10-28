// Leitura do cabeçalho de PNG/JPEG como o python-docx faz (tamanho em pixels e DPI).
// Retorna null quando o python-docx não reconheceria a imagem.

const be16 = (b, i) => (b[i] << 8) | b[i + 1];
const be32 = (b, i) => ((b[i] << 24) >>> 0) + (b[i + 1] << 16) + (b[i + 2] << 8) + b[i + 3];

function pngInfo(b) {
	const w = be32(b, 16), h = be32(b, 20);
	let hdpi = 72, vdpi = 72;
	let i = 8;
	while (i + 8 <= b.length) {
		const len = be32(b, i);
		const type = String.fromCharCode(b[i + 4], b[i + 5], b[i + 6], b[i + 7]);
		if (type === "pHYs" && len >= 9) {
			const xp = be32(b, i + 8), yp = be32(b, i + 12), unit = b[i + 16];
			if (unit === 1 && xp) hdpi = Math.round(xp * 0.0254);
			if (unit === 1 && yp) vdpi = Math.round(yp * 0.0254);
			break;
		}
		if (type === "IDAT" || type === "IEND") break;
		i += 12 + len;
	}
	return { ext: "png", width: w, height: h, hdpi, vdpi };
}

function exifDpi(seg) {
	// seg começa em "Exif\0\0" + TIFF
	try {
		const t = 6;
		const le = seg[t] === 0x49;
		const u16 = (i) => (le ? seg[t + i] | (seg[t + i + 1] << 8) : (seg[t + i] << 8) | seg[t + i + 1]);
		const u32 = (i) => (le ? (seg[t + i] | (seg[t + i + 1] << 8) | (seg[t + i + 2] << 16)) + seg[t + i + 3] * 16777216 : seg[t + i] * 16777216 + ((seg[t + i + 1] << 16) | (seg[t + i + 2] << 8) | seg[t + i + 3]));
		const ifd = u32(4);
		const n = u16(ifd);
		const tags = new Map();
		for (let k = 0; k < n; k++) {
			const e = ifd + 2 + k * 12;
			const tag = u16(e), type = u16(e + 2);
			if (type === 5) {
				const off = u32(e + 8);
				tags.set(tag, u32(off) / u32(off + 4));
			} else if (type === 3) tags.set(tag, u16(e + 8));
			else if (type === 4) tags.set(tag, u32(e + 8));
		}
		const dpi = (tag) => {
			if (!tags.has(tag)) return 72;
			const unit = tags.has(0x128) ? tags.get(0x128) : 2;
			if (unit === 1) return 72;
			return Math.round(tags.get(tag) * (unit === 2 ? 1 : 2.54));
		};
		return [dpi(0x11a), dpi(0x11b)];
	} catch {
		return [72, 72];
	}
}

function jpegInfo(b, kind) {
	let i = 2;
	let w = null, h = null, hdpi = 72, vdpi = 72;
	while (i + 4 <= b.length) {
		if (b[i] !== 0xff) { i++; continue; }
		const m = b[i + 1];
		if (m === 0xff) { i++; continue; }
		if (m === 0xd9 || m === 0xda) break;
		if ((m >= 0xd0 && m <= 0xd7) || m === 0x01) { i += 2; continue; }
		const len = be16(b, i + 2);
		const seg = b.subarray(i + 4, i + 2 + len);
		if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc && w === null) {
			h = be16(seg, 1);
			w = be16(seg, 3);
		} else if (m === 0xe0 && kind === "jfif") {
			const units = seg[7], xd = be16(seg, 8), yd = be16(seg, 10);
			const f = (d) => (units === 1 ? d : units === 2 ? Math.round(d * 2.54) : 72);
			hdpi = f(xd);
			vdpi = f(yd);
		} else if (m === 0xe1 && kind === "exif") {
			[hdpi, vdpi] = exifDpi(seg);
		}
		i += 2 + len;
	}
	if (w === null || !hdpi || !vdpi) return null;
	return { ext: "jpg", width: w, height: h, hdpi, vdpi };
}

export function imageInfo(b) {
	const sig = (off, s) => s.split("").every((c, k) => b[off + k] === c.charCodeAt(0));
	if (b.length > 24 && b[0] === 0x89 && sig(1, "PNG")) return pngInfo(b);
	if (b.length > 12 && b[0] === 0xff && b[1] === 0xd8) {
		if (sig(6, "JFIF")) return jpegInfo(b, "jfif");
		if (sig(6, "Exif")) return jpegInfo(b, "exif");
	}
	return null;
}
