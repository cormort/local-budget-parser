import { getDocument } from 'pdfjs-dist/legacy/build/pdf.js';
import { init as pdfiumInit } from '@embedpdf/pdfium';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
const html = await readFile(new URL('./index.html', import.meta.url), 'utf8');
const js = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)].at(-1)[1].replace(/pdfjsLib\.GlobalWorkerOptions\.workerSrc\s*=\s*[^;]+;?/g, '');
const stub = { files: { length: 0 }, style: {}, value: '', textContent: '', innerHTML: '', addEventListener() {}, click() {}, setAttribute() {}, getBoundingClientRect: () => ({ height: 30 }) };
const mk = () => { const c = { console, document: { getElementById: () => stub, createElement: () => ({ ...stub }), querySelector: () => null }, window: {}, pdfjsLib: { GlobalWorkerOptions: {} }, URL: { createObjectURL: () => '', revokeObjectURL() {} }, Blob: function () {}, setTimeout, clearTimeout, Uint8Array, ArrayBuffer, Map, Set }; c.globalThis = c; vm.createContext(c); vm.runInContext(js, c); return c; };
let lib = null;
const F = [['臺北市','examples/taipei-116.pdf'],['臺中市','examples/taichung-115.pdf'],['高雄市','examples/kaohsiung-115.pdf','pdfium'],['新北市','examples/newtaipei-115.pdf','pdfium'],['臺北市新工處','examples/taipei-newworks-116.pdf'],['新北市社會局','examples/newtaipei-social-115.pdf','pdfium'],['臺北市社會局','examples/taipei-social-116.pdf']];
for (const [nm, f, eng] of F) {
  const ctx = mk();
  const data = new Uint8Array(await readFile(new URL(f, import.meta.url)));
  let pdf;
  if (eng === 'pdfium') { if (!lib) { lib = await pdfiumInit(); lib.PDFiumExt_Init(); } pdf = ctx._pdfiumFakeDoc(lib, data); }
  else pdf = await getDocument({ data }).promise;
  const rows = await ctx.parseLocalDoc(pdf);
  const ag = await ctx.parseAgencyPlanTable(pdf);
  const c = ag.pages ? ctx.crossCheckAgencyPlans(rows, ag) : null;
  console.log(`${nm}: { pages: ${ag.pages}, total: ${c?.total}, checked: ${c?.checked}, issues: ${c?.issues.length} }`);
  (c?.issues || []).forEach(x => console.log(`    ${x.kind}｜${x.code}｜機關別「${x.a}」vs 本表「${x.b}」`));
  if (pdf?.destroy) await pdf.destroy();
}
