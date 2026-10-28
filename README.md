# Provas Girlie ♡ (versão web)

Transforma os PDFs da **“Revisão da tentativa” do Moodle** em um caderno **.docx**
bonito e organizado — capa ilustrada, sumário com links, questões com as figuras
originais e **gabarito comentado** — direto no navegador, inclusive no **Safari do iPad**.

**Abrir o app:** https://pedroeleagua.github.io/provas-girlie/

Tudo acontece no seu aparelho: os PDFs **não são enviados** para nenhum servidor.

Criado por **[Pedro Guarilha](https://github.com/pedroeleagua)**.

---

## Como usar (iPad)

1. Abra o link acima no **Safari**.
2. Toque em **＋ Adicionar provas** e escolha os PDFs (em geral ficam em *Arquivos › Downloads*).
3. Use **▲ / ▼** para deixar as provas na ordem desejada.
4. Confira o **Nome no cabeçalho**. Título e subtítulo da capa são automáticos, mas dá para escrever outros.
5. Toque em **✦ Gerar meu caderno .docx** e depois em **Abrir no Word / Compartilhar**
   (ou **Baixar .docx**).

Dica: no Safari, *Compartilhar › Adicionar à Tela de Início* cria um ícone do app.
Depois do primeiro acesso ele funciona até sem internet.

**Para as figuras virem no PDF:** o Moodle só carrega as imagens quando você rola a página.
Antes de salvar a revisão em PDF, role a página inteira até o fim e espere as figuras
aparecerem. Se alguma figura não vier, o caderno mostra uma caixa “Atenção” no lugar dela.

Também aceita arquivos **.docx** e PDFs que não são do Moodle (listas, simulados): o
conteúdo entra completo, com as imagens, no mesmo visual.

## Como foi feito

Esta é a versão web do programa para Windows **ProvasGirlie.exe 1.0.2** (Python 3.15
empacotado com PyInstaller, usando PyMuPDF para ler o PDF, python-docx + lxml para
escrever o Word, Pillow e Tkinter). A lógica foi portada para JavaScript, módulo a módulo:

| Original (Python)            | Web (JavaScript)                         |
|------------------------------|------------------------------------------|
| `pdf_extract.py` (PyMuPDF)   | `src/pdf_extract.js` ([mupdf.js](https://mupdf.com/) — o mesmo motor MuPDF, em WebAssembly) |
| `moodle_parser.py`, `blocks.py`, `generic_parser.py`, `textutils.py` | `src/*.js` equivalentes |
| `docx_builder.py` (python-docx) | `src/docx_builder.js` + `src/ooxml.js` (gera o OOXML direto) |
| `art.py` (capa gerada com Pillow) | `assets/cover.png` (a mesma imagem; ela é determinística) |
| `gui.py` (Tkinter)           | `index.html`, `styles.css`, `app.js`     |

O resultado é conferido contra o programa original: `npm test` gera os cadernos a partir
de PDFs de teste e compara cada parte do `.docx` com a saída do `.exe`. Os documentos saem
idênticos — a única diferença aceita é a regravação de uma figura que já estava
incompleta no PDF (o original usa o codificador JPEG do Pillow; aqui é o do MuPDF).

## Desenvolvimento

O site é estático (sem bundler). Para rodar localmente:

```bash
npm install
npm run vendor          # copia mupdf.js e JSZip para vendor/
python -m http.server 8642
```

e abra http://localhost:8642.

- `npm test` — teste de paridade com o `.exe` (precisa da pasta `../testdata` com os PDFs
  de teste e os `.docx` de referência, que não ficam no repositório).
- `npm run build:template` — refaz `assets/template.zip` a partir de `template_src/`.
- `npm run build:icons` — refaz os ícones em `assets/icons/`.

Ao publicar uma versão nova, mude `CACHE` em `sw.js` para os aparelhos baixarem os arquivos novos.

## Licença

© Pedro Guarilha. Distribuído sob a **GNU AGPL-3.0** (veja `LICENSE`), a mesma licença do
MuPDF, do qual este app depende. Componentes de terceiros estão listados em `NOTICE.md`.
