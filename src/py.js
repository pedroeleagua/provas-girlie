// Pequenos equivalentes de funções do Python, para o porte se comportar igual ao original.

// Classes de caracteres "Unicode" como no módulo re do Python (str patterns).
export const W = "[\\p{L}\\p{N}_]"; // \w
export const NW = "[^\\p{L}\\p{N}_]"; // \W
export const D = "\\p{Nd}"; // \d
// \b do Python, sem lookbehind (o Safari só aceita lookbehind a partir do 16.4):
// BS = fronteira antes de uma palavra (consome o caractere anterior, se houver);
// BE = fronteira depois de uma palavra.
export const BS = "(?:^|[^\\p{L}\\p{N}_])";
export const BE = `(?!${W})`;

export function hasKey(obj, key) {
	return Object.prototype.hasOwnProperty.call(obj, key);
}

// str.strip / lstrip / rstrip (sem argumento: espaços Unicode)
function isSpace(ch) {
	return /\s/u.test(ch) || /[\x1c-\x1f\x85]/.test(ch);
}
export function lstrip(s, chars) {
	let i = 0;
	const test = chars === undefined ? isSpace : (c) => chars.includes(c);
	while (i < s.length && test(s[i])) i++;
	return s.slice(i);
}
export function rstrip(s, chars) {
	let j = s.length;
	const test = chars === undefined ? isSpace : (c) => chars.includes(c);
	while (j > 0 && test(s[j - 1])) j--;
	return s.slice(0, j);
}
export function strip(s, chars) {
	return rstrip(lstrip(s, chars), chars);
}

// str.title()
export function title(s) {
	let out = "";
	let prevCased = false;
	for (const ch of s) {
		const cased = ch.toLowerCase() !== ch.toUpperCase();
		if (cased) {
			out += prevCased ? ch.toLowerCase() : ch.toUpperCase();
			prevCased = true;
		} else {
			out += ch;
			prevCased = false;
		}
	}
	return out;
}

// round(x, nd) com arredondamento "half-even" como o Python
export function pyRound(x, nd = 0) {
	const m = 10 ** nd;
	const s = x * m;
	const f = Math.floor(s);
	const diff = s - f;
	let r;
	if (diff > 0.5) r = f + 1;
	else if (diff < 0.5) r = f;
	else r = f % 2 === 0 ? f : f + 1;
	return r / m;
}

// Counter.most_common(1)[0][0]: o primeiro maior, na ordem de inserção
export function mostCommonKey(map) {
	let best, bestN = -Infinity;
	for (const [k, n] of map) if (n > bestN) { best = k; bestN = n; }
	return best;
}

export function median(values) {
	const v = [...values].sort((a, b) => a - b);
	const n = v.length;
	if (n % 2 === 1) return v[(n - 1) / 2];
	return (v[n / 2 - 1] + v[n / 2]) / 2;
}

// Comparação de tuplas
export function cmpTuple(a, b) {
	for (let i = 0; i < Math.min(a.length, b.length); i++) {
		if (a[i] < b[i]) return -1;
		if (a[i] > b[i]) return 1;
	}
	return a.length - b.length;
}

// difflib.SequenceMatcher(None, a, b).ratio()
export function seqRatio(aStr, bStr) {
	const a = Array.from(aStr);
	const b = Array.from(bStr);
	const b2j = new Map();
	b.forEach((elt, i) => {
		if (!b2j.has(elt)) b2j.set(elt, []);
		b2j.get(elt).push(i);
	});
	const n = b.length;
	if (n >= 200) {
		const ntest = Math.floor(n / 100) + 1;
		for (const [elt, idxs] of [...b2j]) if (idxs.length > ntest) b2j.delete(elt);
	}
	const nothing = [];
	function findLongestMatch(alo, ahi, blo, bhi) {
		let besti = alo, bestj = blo, bestsize = 0;
		let j2len = new Map();
		for (let i = alo; i < ahi; i++) {
			const newj2len = new Map();
			for (const j of b2j.get(a[i]) || nothing) {
				if (j < blo) continue;
				if (j >= bhi) break;
				const k = (j2len.get(j - 1) || 0) + 1;
				newj2len.set(j, k);
				if (k > bestsize) { besti = i - k + 1; bestj = j - k + 1; bestsize = k; }
			}
			j2len = newj2len;
		}
		while (besti > alo && bestj > blo && a[besti - 1] === b[bestj - 1]) { besti--; bestj--; bestsize++; }
		while (besti + bestsize < ahi && bestj + bestsize < bhi && a[besti + bestsize] === b[bestj + bestsize]) bestsize++;
		return [besti, bestj, bestsize];
	}
	const queue = [[0, a.length, 0, b.length]];
	let matches = 0;
	while (queue.length) {
		const [alo, ahi, blo, bhi] = queue.pop();
		const [i, j, k] = findLongestMatch(alo, ahi, blo, bhi);
		if (k) {
			matches += k;
			if (alo < i && blo < j) queue.push([alo, i, blo, j]);
			if (i + k < ahi && j + k < bhi) queue.push([i + k, ahi, j + k, bhi]);
		}
	}
	const length = a.length + b.length;
	return length ? (2.0 * matches) / length : 1.0;
}

// os.path.basename / splitext para nomes de arquivo vindos do navegador
export function basename(p) {
	return String(p).split(/[\\/]/).pop();
}
export function splitext(name) {
	const i = name.lastIndexOf(".");
	if (i <= 0) return [name, ""];
	return [name.slice(0, i), name.slice(i)];
}
